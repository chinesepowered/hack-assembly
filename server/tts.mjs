// AssemblyAI streaming TTS client.
//
// Protocol (wss://streaming-tts.assemblyai.com/v1/ws):
//   connect with ?voice=&language=&sample_rate=&encoding=  (Authorization header)
//   <- Begin {configuration}
//   -> {"type":"Generate","text":"..."}   (buffers text)
//   -> {"type":"Flush"}                   (synthesizes everything buffered)
//   <- Audio {audio: base64 PCM} ...      (streamed chunks)
//   <- FlushDone {flush_id, audio_duration_ms}
//   <- WordBoundaries {flush_id, audio_start_ms, words:[{word,start,end}]}
//   -> {"type":"Terminate"}
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { API_KEY, ROOT, wsAgent } from './env.mjs';

const TTS_URL = 'wss://streaming-tts.assemblyai.com/v1/ws';
const CACHE_VERSION = 'v2'; // bump to invalidate cached clips
const debug = (...a) => { if (process.env.TTS_DEBUG) console.log(new Date().toISOString().slice(11, 23), '[tts]', ...a); };
const CACHE_DIR = path.join(ROOT, 'cache', 'tts');
fs.mkdirSync(CACHE_DIR, { recursive: true });

export const VOICES = {
  english: ['alba', 'anna', 'charles', 'eve', 'george', 'iris', 'jane', 'jean', 'mary', 'michael', 'paul', 'reid', 'vera'],
  french: ['estelle'], german: ['juergen'], italian: ['giovanni'], portuguese: ['rafael'], spanish: ['lola'],
};

/** Open a TTS session. Resolves once the server sends Begin. */
export function openSession({ voice = 'jane', language = 'english', sampleRate = 24000 } = {}) {
  const qs = new URLSearchParams({ voice, language, sample_rate: String(sampleRate), encoding: 'pcm_s16le' });
  const ws = new WebSocket(`${TTS_URL}?${qs}`, { headers: { Authorization: API_KEY }, agent: wsAgent });
  const session = { ws, voice, sampleRate, pending: [], current: null, openedAt: Date.now() };
  // Idle sessions are closed by the server, and a closed session keeps counting against
  // the account's concurrency limit for ~a minute, so keep warm sessions alive instead.
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 8000);
  ws.once('close', (code, reason) => {
    clearInterval(keepAlive);
    debug(`close ${voice} code=${code} ${reason} after ${((Date.now() - session.openedAt) / 1000).toFixed(0)}s`);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const job = session.current;
    switch (msg.type) {
      case 'Audio':
        if (job) {
          const chunk = Buffer.from(msg.audio, 'base64');
          if (!job.firstAudioAt) job.firstAudioAt = Date.now();
          job.chunks.push(chunk);
          job.onChunk?.(chunk);
        }
        break;
      case 'FlushDone':
        if (job) job.durationMs = msg.audio_duration_ms;
        break;
      case 'WordBoundaries':
        if (job) {
          // Word times are cumulative over the session; make them clip-relative.
          const base = msg.audio_start_ms || 0;
          job.words = (msg.words || []).map((w) => ({ word: w.word, start: w.start - base, end: w.end - base }));
          finishJob(session, null);
        }
        break;
      case 'Error':
        finishJob(session, new Error(`TTS error ${msg.error_code}: ${msg.error}`));
        break;
    }
  });

  return new Promise((resolve, reject) => {
    const onBegin = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'Begin') { ws.off('message', onBegin); debug(`open ${voice}`); resolve(session); }
        else if (msg.type === 'Error') reject(new Error(`TTS error ${msg.error_code}: ${msg.error}`));
      } catch { /* binary */ }
    };
    ws.on('message', onBegin);
    ws.on('error', (e) => { reject(e); finishJob(session, e); });
    ws.once('close', (code, reason) => {
      reject(new Error(`TTS socket closed (${code}) ${reason}`));
      finishJob(session, new Error(`TTS socket closed (${code}) ${reason}`));
      for (const j of session.pending.splice(0)) j.reject(new Error('TTS socket closed'));
    });
  });
}

function finishJob(session, err) {
  const job = session.current;
  if (!job) return;
  session.current = null;
  if (err) job.reject(err);
  else {
    const pcm = Buffer.concat(job.chunks);
    job.resolve({
      pcm,
      words: job.words || [],
      durationMs: job.durationMs ?? Math.round((pcm.length / 2 / session.sampleRate) * 1000),
      ttfaMs: job.firstAudioAt ? job.firstAudioAt - job.startedAt : null,
      sampleRate: session.sampleRate,
    });
  }
  pump(session);
}

function pump(session) {
  if (session.current || !session.pending.length) return;
  const job = session.pending.shift();
  session.current = job;
  job.startedAt = Date.now();
  session.ws.send(JSON.stringify({ type: 'Generate', text: job.text }));
  session.ws.send(JSON.stringify({ type: 'Flush' }));
}

/** Queue text on an open session; resolves with {pcm, words, durationMs, ttfaMs}. */
export function speak(session, text, onChunk) {
  return new Promise((resolve, reject) => {
    session.pending.push({ text, onChunk, chunks: [], resolve, reject });
    pump(session);
  });
}

/** Graceful close: Terminate, then wait for the server to hang up (frees the concurrency slot). */
export function closeSession(session) {
  const ws = session.ws;
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { ws.terminate(); resolve(); }, 3000);
    ws.once('close', () => { clearTimeout(t); resolve(); });
    try { ws.send(JSON.stringify({ type: 'Terminate' })); } catch { ws.terminate(); }
  });
}

// ---------- WAV + cache helpers ----------

export function wavHeader(dataBytes, sampleRate, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function cacheKey(voice, text, sampleRate = 24000, language = 'english') {
  return crypto.createHash('sha1').update(`${CACHE_VERSION}|${voice}|${language}|${sampleRate}|${text}`).digest('hex').slice(0, 20);
}

// ---------- Session pool ----------
// The account allows 4 concurrent TTS sessions and a session is bound to one voice,
// so keep at most MAX_SESSIONS warm sessions and recycle the least-recently-used idle
// one when a different voice is needed.
const MAX_SESSIONS = Number(process.env.TTS_MAX_SESSIONS || 4);
const slots = []; // {key, session: Promise, busy, lastUsed}
const waiters = [];

async function withSession(voice, language, sampleRate, fn) {
  const key = `${voice}|${language}|${sampleRate}`;
  const slot = await acquire(key, () => openSession({ voice, language, sampleRate }));
  try {
    return await fn(await slot.session);
  } catch (e) {
    dropSlot(slot); // never reuse a session that errored
    throw e;
  } finally {
    slot.busy = false;
    slot.lastUsed = Date.now();
    wake();
  }
}

function acquire(key, open) {
  return new Promise((resolve) => {
    waiters.push({ key, open, resolve });
    wake();
  });
}

function wake() {
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    // One session per voice: lines for a voice queue on its session (~200 ms each)
    // rather than opening more sessions and starving other voices.
    const own = slots.find((s) => s.key === w.key);
    let slot = own && !own.busy ? own : null;
    if (own) {
      // busy: wait for it
    } else if (slots.length < MAX_SESSIONS) {
      slot = newSlot(w.key, w.open);
    } else {
      // Only evict an idle session that no queued job wants.
      const idle = slots.filter((s) => !s.busy && !waiters.some((o) => o.key === s.key))
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle) { dropSlot(idle); slot = newSlot(w.key, w.open); }
    }
    if (slot) {
      slot.busy = true;
      waiters.splice(i--, 1);
      w.resolve(slot);
    }
  }
}

function newSlot(key, open) {
  const slot = { key, busy: false, lastUsed: Date.now(), session: open() };
  slot.session.then(
    (s) => s.ws.once('close', () => dropSlot(slot)),
    () => dropSlot(slot),
  );
  slots.push(slot);
  return slot;
}

function dropSlot(slot) {
  const i = slots.indexOf(slot);
  if (i === -1) return;
  slots.splice(i, 1);
  slot.session.then(closeSession, () => {});
  setImmediate(wake);
}

/**
 * Synthesize with disk cache. Returns {id, wavPath, words, durationMs, cached, ttfaMs}.
 * Retries on dropped sessions / transient concurrency errors.
 */
export async function synthesizeCached({ text, voice = 'jane', language = 'english', sampleRate = 24000, fresh = false }) {
  const id = cacheKey(voice, text, sampleRate, language);
  const wavPath = path.join(CACHE_DIR, `${id}.wav`);
  const metaPath = path.join(CACHE_DIR, `${id}.json`);
  if (!fresh && fs.existsSync(wavPath) && fs.existsSync(metaPath)) {
    return { id, wavPath, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')), cached: true };
  }
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await withSession(voice, language, sampleRate, (s) => speak(s, text));
      break;
    } catch (e) {
      // 3009 = account concurrency limit: wait for a slot to free up.
      const busy = /3009/.test(e.message);
      debug(`retry ${attempt} ${voice}: ${e.message}`);
      if (attempt >= (busy ? 24 : 3)) throw e;
      await new Promise((r) => setTimeout(r, Math.min(5000, 400 * 2 ** attempt)));
    }
  }
  fs.writeFileSync(wavPath, Buffer.concat([wavHeader(result.pcm.length, sampleRate), result.pcm]));
  const meta = { text, voice, language, sampleRate, words: result.words, durationMs: result.durationMs };
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  return { id, wavPath, ...meta, cached: false, ttfaMs: result.ttfaMs };
}

export function closeAll() {
  return Promise.all(slots.splice(0).map((s) => s.session.then(closeSession, () => {})));
}
