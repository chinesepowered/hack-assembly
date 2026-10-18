// End-to-end check: run a full rehearsal in headless Chromium with the simulated
// actor (demo mode) against the live AssemblyAI APIs, and print what happened.
// Usage: npm start (in another shell), then: node scripts/e2e-demo.mjs [--shots dir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > -1 ? process.argv[shotsArg + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
page.on('console', (m) => { if (['error', 'warning', 'info'].includes(m.type())) console.log(stamp(), `[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log(stamp(), '[pageerror]', e.message));

await page.goto(`${BASE}/?demo=1`);
await page.waitForFunction(() => window.sceneReady === true, null, { timeout: 30000 });
await page.waitForFunction(() => /ready/.test(document.querySelector('#renderText').textContent), null, { timeout: 240000 });
console.log(stamp(), 'render:', await page.textContent('#renderText'));
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '1-loaded.png') });

// Watch status changes while rehearsing.
await page.exposeFunction('logStatus', (s) => console.log(stamp(), 'status:', s));
await page.evaluate(() => {
  let last = '';
  new MutationObserver(() => {
    const s = document.querySelector('#liveStatus').textContent.trim();
    if (s !== last && !/^‖ Holding your cue — \d/.test(s)) { last = s; window.logStatus(s); }
    if (/^‖ Holding/.test(s) && !/Holding/.test(last)) { last = s; window.logStatus(s); }
  }).observe(document.querySelector('#liveStatus'), { childList: true, subtree: true, characterData: true });
});

page.evaluate(() => window.demo.app().rehearse());
let shot = 2;
const timer = SHOTS ? setInterval(() => page.screenshot({ path: path.join(SHOTS, `${shot++}-run.png`) }).catch(() => {}), 6000) : null;
await page.waitForSelector('#report:not([hidden])', { timeout: 300000 });
await page.waitForFunction(() => !/writing notes/.test(document.querySelector('#notesText').textContent), null, { timeout: 30000 });
if (timer) clearInterval(timer);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'z-report.png') });

const report = await page.evaluate(() => ({
  kpis: [...document.querySelectorAll('#kpis .kpi')].map((k) => k.innerText.replace(/\n/g, ' ')),
  notes: document.querySelector('#notesText').textContent,
  notesSrc: document.querySelector('#notesSrc').textContent,
  lines: [...document.querySelectorAll('#reportLines li')].map((li) => li.innerText.replace(/\n+/g, ' | ')),
}));
console.log(JSON.stringify(report, null, 2));
await browser.close();
