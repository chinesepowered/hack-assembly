// Records the demo video: drives the real app in headless Chromium (demo mode),
// captures CDP screencast frames with wall-clock timestamps, and records the app's
// master audio bus in-page. Narration is AssemblyAI TTS (voice "jane").
// Usage: npm start (other shell), then: node scripts/record-demo.mjs [outDir]
//        node scripts/build-video.mjs <outDir>/<take>
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ROOT_OUT = path.resolve(process.argv[2] || 'demo/build');
const TAKE = path.join(ROOT_OUT, `take-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const FRAMES = path.join(TAKE, 'frames');
fs.mkdirSync(FRAMES, { recursive: true });

const NARRATION = {
  intro: "Every actor needs a scene partner to run lines with. Meet Scene Partner: a whole cast of AI actors who come in on cue, built on AssemblyAI's new streaming text-to-speech.",
  cast: "Paste any scene, and every character gets a voice from AssemblyAI's voice library, streaming back with first audio in about a hundred milliseconds.",
  table: "Here's the table read.",
  rehearse: 'Now I rehearse as Maya, off-book. Scene Partner listens with Universal-3.6 Pro streaming speech-to-text. It knows the script, so it knows the instant my line is done. For this recording, a stand-in voice plays me.',
  report: "After the run, I get a report card: word accuracy, cue timing, every paraphrase, and notes from my director, written by AssemblyAI's LLM Gateway and read back with TTS.",
  arch: 'Under the hood: the mic streams to Universal-3.6 Pro. A script aligner tracks my place and sends force endpoint the moment my line ends. Every voice, prompt and note is AssemblyAI streaming TTS.',
  outro: 'Scene Partner. Always off-book, always on cue. And yes, this narration is AssemblyAI TTS too.',
};

const SLIDES = {
  title: `<div class="kicker">AssemblyAI Voice Hackathon · Hack into Speech</div>
    <h1>Scene <span class="accent">Partner</span></h1>
    <p class="sub">Rehearse any scene with AI scene partners who come in on cue.</p>
    <div class="logos">Built on <b>AssemblyAI Streaming TTS</b> · <b>Universal-3.6 Pro</b> streaming STT · <b>LLM Gateway</b></div>`,
  arch: `<div class="kicker">How it works</div>
    <h1 style="font-size:66px">Script-aware endpointing</h1>
    <div class="arch">
      <div class="box you"><b>🎙 Your mic</b>16 kHz PCM from an AudioWorklet, gated while partners speak</div>
      <div class="box aai"><b>Universal-3.6 Pro</b>Streaming partials + finals, keyterms pulled from the script<br><span class="tagline">AssemblyAI STT</span></div>
      <div class="box"><b>Script aligner</b>Fuzzy word alignment tracks your place, sends <b style="display:inline;font-size:inherit;color:var(--you)">ForceEndpoint</b> when the line ends</div>
      <div class="box aai"><b>Streaming TTS</b>13 voices, ~110 ms to first audio: partners, prompts, notes<br><span class="tagline">AssemblyAI TTS</span></div>
      <div class="box aai"><b>LLM Gateway</b>Director's notes, grounded in what you actually said<br><span class="tagline">AssemblyAI LLM</span></div>
    </div>`,
  outro: `<h1>Scene <span class="accent">Partner</span></h1>
    <p class="sub">Always off-book. Always on cue.</p>
    <div class="logos">AssemblyAI Streaming TTS · Universal-3.6 Pro · LLM Gateway<br>
    <span style="font-size:17px;color:var(--faint)">All voices and narration in this video: AssemblyAI TTS</span></div>`,
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
page.on('console', (m) => { if (['error', 'warning', 'info'].includes(m.type())) log(`[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => log('[pageerror]', e.message));

await page.goto(`${BASE}/?demo=1`);
await page.waitForFunction(() => window.sceneReady === true, null, { timeout: 30000 });
await page.waitForFunction(() => /ready/.test(document.querySelector('#renderText').textContent), null, { timeout: 300000 });
log('scene ready:', await page.textContent('#renderText'));

// Pre-render narration, then make sure the narrator/prompter voice has a warm session
// (prompts and director's notes are rendered live during the take).
await page.evaluate(async (lines) => { await window.demo.prepareNarration(lines); }, Object.values(NARRATION));
log('narration ready');
await page.evaluate(async () => {
  const st = window.demo.app().state;
  await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: st.cast.NARRATOR, text: 'Places, please.', fresh: true }) });
});
log('narrator session warm');

// Callouts driven by app events during the rehearsal.
await page.evaluate(() => {
  const d = window.demo;
  const on = (n, f) => window.addEventListener(`sp:${n}`, (e) => f(e.detail));
  on('your-line', (x) => { if (x.ordinal === 1) d.callout('🎙 <b>You’re MAYA, off-book.</b> Your words appear as Universal-3.6 Pro hears them.'); });
  on('cue', (x) => {
    if (x.ordinal === 1) d.callout(`⚡ <b>Script-aware endpointing:</b> line finished → <b>ForceEndpoint</b> → DANNY comes in <b>${(x.ms / 1000).toFixed(2)} s</b> after your last word`, 5200);
  });
  on('holding', (x) => { if (x.ordinal === 3) d.callout('‖ <b>A dramatic pause isn’t a cue.</b> Your line isn’t finished, so your partner holds.', 4200); });
  on('prompt', (x) => d.callout(`💬 <b>“Line?”</b> The prompter feeds your next words, rendered live by AssemblyAI TTS in <b>${x.ms} ms</b>`, 5000));
  on('partner', (x) => { if (x.fx === 'radio' && x.mode === 'rehearse') d.callout('📻 <span class="p">RADIO</span> is an AssemblyAI voice with a radio effect in Web Audio', 4000); });
  on('line', (x) => { if (x.swapped?.length) d.callout(`✎ <b>Paraphrase caught:</b> you said “${x.swapped[0][0]}”, the script says “${x.swapped[0][1]}”`, 4800); });
});

// ---------- capture ----------
const cdp = await context.newCDPSession(page);
const frames = [];
let firstFrameWall = null;
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const file = path.join(FRAMES, `f${String(frames.length).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file: path.basename(file), t: metadata.timestamp });
  if (firstFrameWall === null) firstFrameWall = Date.now() / 1000;
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
const audioEpochMs = await page.evaluate(() => window.demo.startRecording());
log('recording; audio epoch', audioEpochMs);

const run = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);

// 1. Title
await run((html) => { window.demo.slide(html); }, SLIDES.title);
await sleep(600);
await run(async (t) => { await window.demo.narrate(t, {}); }, NARRATION.intro);
await sleep(400);
await run(async () => { await window.demo.clearSlide(); });
await sleep(500);

// 2. Cast
await run(async () => { await window.demo.moveTo('#cast li:nth-child(2)'); });
await run(async (t) => { await window.demo.narrate(t); }, NARRATION.cast);

// 3. Table read (first few items)
await run(async (t) => { await window.demo.narrate(t); }, NARRATION.table);
await run(async () => { await window.demo.press('#tableBtn', () => window.demo.app().tableRead({ maxItems: 4 })); });
await sleep(500);
await run(() => { window.demo.app().stop(); });
log('table read done');

// 4. Rehearse (stage directions off to keep it tight)
await run(async () => { await window.demo.click('#directions'); });
await run(async () => { await window.demo.moveTo('#rehearseBtn'); });
await run(async (t) => { await window.demo.narrate(t); }, NARRATION.rehearse);
const reportShown = page.waitForFunction(() => !document.querySelector('#report').hidden, null, { timeout: 300000 });
await run(async () => { await window.demo.press('#rehearseBtn', () => { window.demo.app().rehearse(); }); });
await run(() => { window.demo.hideCursor(); });
await reportShown;
log('report shown');
await page.waitForFunction(() => !/writing notes/.test(document.querySelector('#notesText').textContent), null, { timeout: 30000 });
await sleep(1200);

// 5. Report + spoken director's notes
await run(async (t) => { await window.demo.narrate(t); }, NARRATION.report);
await run(async () => { await window.demo.press('#playNotes', async () => { await window.demo.app().playNotes(); }); });
await sleep(900);

// 6. Architecture + outro
await run(() => { document.querySelector('#report').hidden = true; });
await run((html) => {
  const run = window.demo.app().state.lastRun;
  const cues = run.lines.map((l) => l.cueMs).filter(Number.isFinite);
  const avg = Math.round(cues.reduce((a, b) => a + b, 0) / cues.length);
  const p = run.prompts?.[0];
  const words = run.lines.reduce((n, l) => n + l.E.length, 0);
  const metrics = `<div class="metrics">
    <div class="metric"><b>${avg} ms</b><span>avg cue pickup, this take</span></div>
    ${p ? `<div class="metric"><b>${p.ms} ms</b><span>live prompt${p.ttfaMs ? ` · first audio ${p.ttfaMs} ms` : ''}</span></div>` : ''}
    <div class="metric"><b>${run.lines.length} lines</b><span>${words} words aligned live</span></div></div>`;
  window.demo.slide(html + metrics);
}, SLIDES.arch);
await sleep(500);
await run(async (t) => { await window.demo.narrate(t, {}); }, NARRATION.arch);
await sleep(700);
await run((html) => { window.demo.slide(html); }, SLIDES.outro);
await sleep(400);
await run(async (t) => { await window.demo.narrate(t, {}); }, NARRATION.outro);
await sleep(1500);

// ---------- finish ----------
const audioMeta = await page.evaluate(() => window.demo.stopRecording('demo-audio'));
await cdp.send('Page.stopScreencast');
await sleep(300);
const wav = path.resolve('recordings/demo-audio.wav');
fs.copyFileSync(wav, path.join(TAKE, 'audio.wav'));
fs.writeFileSync(path.join(TAKE, 'take.json'), JSON.stringify({ frames, audio: audioMeta, audioEpochMs, firstFrameWall }, null, 1));
log(`saved ${frames.length} frames + ${audioMeta.seconds.toFixed(1)}s audio to ${TAKE}`);
await browser.close();
console.log(TAKE);
