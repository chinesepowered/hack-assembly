// TTS proofreading: transcribe rendered clips with AssemblyAI pre-recorded STT
// (Universal-3.5 Pro) and score them against the text they were meant to say.
// Usage: node scripts/qa-clips.mjs [--fix] [--only voice] [--extra "voice|text" ...]
//   --fix   re-render (fresh) clips under 90% and check them again
import fs from 'node:fs';
import path from 'node:path';
import { API_KEY, ROOT, requireKey } from '../server/env.mjs';
import { cacheKey, synthesizeCached, closeAll } from '../server/tts.mjs';
import { scoreLine } from '../public/lib/align.js';

requireKey();
const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const extras = args.flatMap((a, i) => (args[i - 1] === '--extra' ? [a.split('|')] : []));
const CACHE = path.join(ROOT, 'cache', 'tts');
const H = { Authorization: API_KEY };

// Current (non-stale) cached clips + any extra phrases to test.
const clips = fs.readdirSync(CACHE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')))
  .filter((m) => fs.existsSync(path.join(CACHE, `${cacheKey(m.voice, m.text, m.sampleRate, m.language)}.json`)))
  .filter((m) => !only || m.voice === only);
for (const [voice, text] of extras) clips.push({ voice, text, extra: true });

async function transcribe(wavPath, keyterms) {
  const up = await (await fetch('https://api.assemblyai.com/v2/upload', { method: 'POST', headers: H, body: fs.readFileSync(wavPath) })).json();
  const job = await (await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: up.upload_url, speech_models: ['universal-3-pro'], ...(keyterms.length ? { keyterms_prompt: keyterms } : {}) }),
  })).json();
  if (!job.id) throw new Error(JSON.stringify(job));
  for (;;) {
    const r = await (await fetch(`https://api.assemblyai.com/v2/transcript/${job.id}`, { headers: H })).json();
    if (r.status === 'completed') return r.text || '';
    if (r.status === 'error') throw new Error(r.error);
    await new Promise((res) => setTimeout(res, 1200));
  }
}

const keytermsOf = (text) => [...new Set(text.match(/\b[A-Z][a-z]+(?: \d+| [A-Z]\b)?/g) || [])].filter((t) => t.length > 3).slice(0, 20);

async function check(c) {
  const r = await synthesizeCached({ voice: c.voice, text: c.text, fresh: c.fresh || false });
  const heard = await transcribe(r.wavPath, keytermsOf(c.text));
  const sc = scoreLine(c.text, heard);
  return { ...c, heard, accuracy: sc.accuracy, swapped: sc.swapped, dropped: sc.dropped };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => ({ ...items[k], error: e.message })); } }));
  return out;
}

let results = await pool(clips, 6, check);
const show = (rs) => rs.forEach((r) => console.log(
  `${r.error ? ' ERR' : `${Math.round(r.accuracy * 100)}%`.padStart(4)}  ${r.voice.padEnd(8)} ${r.text.slice(0, 70)}` +
  (r.error ? `\n      ${r.error}` : r.accuracy < 0.999 ? `\n      heard: ${r.heard}` : '')));
show(results);

if (FIX) {
  const bad = results.filter((r) => !r.error && !r.extra && r.accuracy < 0.9);
  console.log(`\nre-rendering ${bad.length} clip(s)…`);
  for (let round = 0; round < 3 && bad.length; round++) {
    const again = await pool(bad.map((b) => ({ voice: b.voice, text: b.text, fresh: true })), 3, check);
    show(again);
    bad.splice(0, bad.length, ...again.filter((r) => !r.error && r.accuracy < 0.9));
  }
}
await closeAll();
