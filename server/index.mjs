// Scene Partner server: static UI, TTS rendering/cache, STT relay, director's notes.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { API_KEY, PORT, ROOT, requireKey } from './env.mjs';
import { VOICES, synthesizeCached, closeAll } from './tts.mjs';
import { attachSttRelay } from './stt-relay.mjs';
import { directorNotes } from './llm.mjs';

requireKey();

const PUBLIC = path.join(ROOT, 'public');
const SCENES = path.join(ROOT, 'scenes');
const CACHE = path.join(ROOT, 'cache', 'tts');
const RECORDINGS = path.join(ROOT, 'recordings');

// Measured on the live API (median F0 of a sample line); accents per AssemblyAI's voice docs.
const VOICE_INFO = {
  alba: { gender: 'f', accent: 'US', pitchHz: 151 },
  anna: { gender: 'f', accent: 'UK', pitchHz: 207 },
  charles: { gender: 'm', accent: 'UK', pitchHz: 90 },
  eve: { gender: 'f', accent: 'US', pitchHz: 214 },
  george: { gender: 'm', accent: 'US', pitchHz: 133 },
  iris: { gender: 'f', accent: null, pitchHz: 214 },
  jane: { gender: 'f', accent: 'US', pitchHz: 207 },
  jean: { gender: 'm', accent: 'US', pitchHz: 110 },
  mary: { gender: 'f', accent: 'US', pitchHz: 197 },
  michael: { gender: 'm', accent: 'US', pitchHz: 107 },
  paul: { gender: 'm', accent: 'UK', pitchHz: 112 },
  reid: { gender: 'm', accent: null, pitchHz: 145 },
  vera: { gender: 'f', accent: 'UK', pitchHz: 183 },
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function listScenes() {
  return fs.readdirSync(SCENES).filter((f) => f.endsWith('.txt')).sort().map((f) => {
    const id = f.replace(/\.txt$/, '');
    const text = fs.readFileSync(path.join(SCENES, f), 'utf8');
    const title = (text.match(/^TITLE:\s*(.+)$/m) || [, id])[1].trim();
    return { id, title };
  });
}

const routes = {
  'GET /api/health': async () => ({ ok: true, hasKey: Boolean(API_KEY) }),
  'GET /api/voices': async () => ({
    voices: VOICES.english.map((id) => ({ id, ...VOICE_INFO[id] })),
    other: Object.fromEntries(Object.entries(VOICES).filter(([l]) => l !== 'english')),
  }),
  'GET /api/scenes': async () => ({ scenes: listScenes() }),
  'POST /api/tts': async (req) => {
    const { text, voice = 'jane', language = 'english', fresh = false } = JSON.parse((await readBody(req)).toString() || '{}');
    if (!text || typeof text !== 'string' || text.length > 2000) throw Object.assign(new Error('text required (<=2000 chars)'), { status: 400 });
    if (!VOICES[language]?.includes(voice)) throw Object.assign(new Error(`unknown voice ${voice}`), { status: 400 });
    const t0 = Date.now();
    const r = await synthesizeCached({ text, voice, language, fresh: Boolean(fresh) });
    return { id: r.id, url: `/audio/${r.id}.wav`, words: r.words, durationMs: r.durationMs, ttfaMs: r.ttfaMs ?? null, cached: r.cached, ms: Date.now() - t0 };
  },
  'POST /api/notes': async (req) => directorNotes(JSON.parse((await readBody(req)).toString())),
  'POST /api/recording': async (req) => {
    // Demo recorder upload: raw WAV body, metadata in headers.
    fs.mkdirSync(RECORDINGS, { recursive: true });
    const name = (req.headers['x-name'] || `take-${Date.now()}`).replace(/[^\w.-]/g, '');
    fs.writeFileSync(path.join(RECORDINGS, `${name}.wav`), await readBody(req, 500 * 1024 * 1024));
    fs.writeFileSync(path.join(RECORDINGS, `${name}.json`), req.headers['x-meta'] || '{}');
    return { ok: true, name };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname}`];
  try {
    if (handler) return send(res, 200, await handler(req, url));
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    let m;
    if ((m = url.pathname.match(/^\/audio\/([a-f0-9]{20})\.wav$/))) return serveFile(res, path.join(CACHE, `${m[1]}.wav`));
    if ((m = url.pathname.match(/^\/api\/scenes\/([\w-]+)$/))) {
      const txt = path.join(SCENES, `${m[1]}.txt`);
      if (!fs.existsSync(txt)) return send(res, 404, { error: 'no such scene' });
      const demo = path.join(SCENES, `${m[1]}.demo.json`);
      return send(res, 200, { id: m[1], text: fs.readFileSync(txt, 'utf8'), demo: fs.existsSync(demo) ? JSON.parse(fs.readFileSync(demo, 'utf8')) : null });
    }

    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
    return serveFile(res, file);
  } catch (e) {
    console.error(`${req.method} ${url.pathname}:`, e.message);
    send(res, e.status || 500, { error: e.message });
  }
});

attachSttRelay(server);
server.listen(PORT, () => console.log(`Scene Partner on http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await closeAll(); process.exit(0); });
}
