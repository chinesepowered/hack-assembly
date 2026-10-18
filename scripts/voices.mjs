// Render one sample line per English voice and report timing.
// Usage: npm run voices [-- "custom text"]
import { requireKey } from '../server/env.mjs';
import { VOICES, synthesizeCached, closeAll } from '../server/tts.mjs';

requireKey();
const text = process.argv[2] || "Wait. You're telling me the ferry left at 6:45 — with my sister on it?";
const rows = await Promise.all(VOICES.english.map(async (voice) => {
  const t0 = Date.now();
  const r = await synthesizeCached({ text, voice });
  return { voice, ms: Date.now() - t0, ttfaMs: r.ttfaMs, durationMs: r.durationMs, cached: r.cached, wav: r.wavPath };
}));
console.log(JSON.stringify(rows, null, 1));
await closeAll();
