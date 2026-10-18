import { parseScript } from './lib/parse.js';
import { tokenize, spokenTokens, align, extractCalls, scoreLine } from './lib/align.js';
import { AudioEngine } from './lib/audio.js';
import { Stt } from './lib/stt.js';
import { DemoDirector } from './lib/demo.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (name, detail = {}) => window.dispatchEvent(new CustomEvent(`sp:${name}`, { detail }));
const PALETTE = ['#6fd3ff', '#b49bff', '#6ee7a8', '#ff8fb8', '#7aa2ff', '#ffd166'];
const DEMO = new URLSearchParams(location.search).has('demo');
const VOICE_LEVEL = 0.012; // RMS above which the mic bus counts as speech

const audio = new AudioEngine();
const state = {
  scenes: [], voices: [], scene: null, demoData: null, cast: {}, fx: {}, colors: {}, role: null,
  offBook: true, directions: true, renders: new Map(), renderToken: 0, run: null, lastRun: null,
};
let demo = null;

// ---------------------------------------------------------------- api / tts

async function api(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${url} → HTTP ${res.status}`);
  return json;
}

/** Render text with an AssemblyAI TTS voice (server caches to disk). */
function render(voice, text, { fresh = false } = {}) {
  if (fresh) return api('/api/tts', { voice, text, fresh: true });
  const key = `${voice}|${text}`;
  if (!state.renders.has(key)) {
    const p = api('/api/tts', { voice, text });
    p.catch(() => state.renders.delete(key));
    state.renders.set(key, p);
  }
  return state.renders.get(key);
}

function speechFor(it) {
  if (it.type === 'heading') {
    return it.text.replace(/^INT\.?\s*/i, 'Interior. ').replace(/^EXT\.?\s*/i, 'Exterior. ')
      .replace(/\s+[—–-]\s+/g, '. ').toLowerCase().replace(/(^|\.\s+)([a-z])/g, (m) => m.toUpperCase()) + '.';
  }
  return it.speech;
}

function voiceFor(it) { return it.type === 'line' ? state.cast[it.character] : state.cast.NARRATOR; }

function spokenItems() {
  return state.scene.items.filter((it) => it.type === 'line' || (state.directions && (it.type === 'action' || it.type === 'heading')));
}

// ---------------------------------------------------------------- casting

const F_TITLES = /^(LADY|MRS|MS|MISS|QUEEN|MOTHER|SISTER|AUNT|DAME|PRINCESS|DUCHESS)\b/;
const M_TITLES = /^(LORD|MR|SIR|KING|FATHER|BROTHER|UNCLE|PRINCE|DUKE)\b/;
const F_NAMES = new Set('maya mary anna jane sarah emma olivia ava sophia mia rosa gwendolen juliet cecily nora alice kate beth lucy ruth grace ella zoe chloe hannah laura lily eve iris vera'.split(' '));
const M_NAMES = new Set('danny jack john james tom sam david michael george romeo hamlet algernon paul peter mark ben joe frank harry bill charles reid lane ernest'.split(' '));

function guessGender(name, items) {
  if (F_TITLES.test(name)) return 'f';
  if (M_TITLES.test(name)) return 'm';
  const first = name.split(' ')[0].toLowerCase();
  if (F_NAMES.has(first)) return 'f';
  if (M_NAMES.has(first)) return 'm';
  const re = new RegExp(`\\b${name}\\b[^.]*?\\b(she|her|he|his|him)\\b`, 'i');
  for (const it of items) {
    const m = it.type === 'action' && it.text.match(re);
    if (m) return /^(she|her)$/i.test(m[1]) ? 'f' : 'm';
  }
  return null;
}

function autoCast(characters, meta, items) {
  const cast = {};
  const used = new Set(Object.values(meta.cast));
  const voices = state.voices;
  characters.forEach((c, i) => {
    if (meta.cast[c]) { cast[c] = meta.cast[c]; return; }
    const g = guessGender(c, items) || (i % 2 ? 'f' : 'm');
    const pick = voices.find((v) => v.gender === g && !used.has(v.id)) || voices.find((v) => !used.has(v.id)) || voices[0];
    cast[c] = pick.id;
    used.add(pick.id);
  });
  cast.NARRATOR = meta.cast.NARRATOR || (voices.find((v) => !used.has(v.id) && v.accent === 'UK' && v.gender === 'm') || voices[0]).id;
  return cast;
}

function keytermsFor(scene) {
  const STOP = new Set('I The A An It He She You We They My Your His Her Our Their Oh Yes No Well Wait Then Please Hello Okay Like On In At For To Of And But So Kid Sorry Left Start Ten Engine Gate Pier'.split(' '));
  const terms = new Set(scene.characters.map((c) => c.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())));
  for (const it of scene.items) {
    if (it.type !== 'line') continue;
    for (const m of it.speech.matchAll(/\b([A-Z][a-z]+ (?:\d+|[A-Z]))\b/g)) terms.add(m[1]); // "Pier 6", "Gate C"
    for (const m of it.speech.matchAll(/(?:[a-z,;]\s+)([A-Z][a-zA-Z'’]{2,}(?:\s[A-Z][a-zA-Z'’]+)*)/g)) if (!STOP.has(m[1])) terms.add(m[1]);
  }
  return [...terms].filter((t) => t.length <= 50).slice(0, 100);
}

// ---------------------------------------------------------------- scene / UI

async function loadScene(id) {
  const data = await api(`/api/scenes/${id}`);
  $('#sceneSelect').value = id;
  setScene(parseScript(data.text), data.demo);
}

function setScene(parsed, demoData = null) {
  stop();
  state.scene = parsed;
  state.demoData = demoData;
  state.cast = autoCast(parsed.characters, parsed.meta, parsed.items);
  state.fx = parsed.meta.fx || {};
  state.role = demoData?.role && parsed.characters.includes(demoData.role) ? demoData.role : parsed.characters[0];
  state.colors = Object.fromEntries(parsed.characters.map((c, i) => [c, PALETTE[i % PALETTE.length]]));
  demo?.setScene(demoData);
  renderCast();
  renderRole();
  renderScript();
  prerender();
}

function colorOf(c) { return c === state.role ? 'var(--you)' : state.colors[c]; }

function renderCast() {
  const voiceOpts = (sel) => state.voices.map((v) =>
    `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${v.id} · ${v.gender === 'f' ? '♀' : '♂'}${v.accent ? ' ' + v.accent : ''}</option>`).join('');
  const rows = [...state.scene.characters, 'NARRATOR'].map((c) => {
    const initials = c.split(' ').map((w) => w[0]).join('').slice(0, 2);
    const fx = state.fx[c] === 'radio' ? ' 📻' : '';
    const count = state.scene.items.filter((x) => x.character === c).length;
    const sub = c === 'NARRATOR' ? 'directions · prompter' : c === state.role ? `<span class="you-badge">you</span> · ${count} lines` : `${count} line${count === 1 ? '' : 's'}${fx}`;
    return `<li class="${c === state.role ? 'you' : ''}" data-c="${esc(c)}">
      <div class="avatar" style="--c:${c === 'NARRATOR' ? '#8b93a7' : colorOf(c)}">${esc(initials)}</div>
      <div class="name">${esc(c)}<small>${sub}</small></div>
      <select aria-label="Voice for ${esc(c)}">${voiceOpts(state.cast[c])}</select>
      <button class="icon-btn" title="Audition">▶</button>
    </li>`;
  });
  $('#cast').innerHTML = rows.join('');
  $$('#cast li').forEach((li) => {
    const c = li.dataset.c;
    $('select', li).onchange = (e) => { state.cast[c] = e.target.value; renderScript(); prerender(); };
    $('button', li).onclick = () => audition(c);
  });
}

async function audition(c) {
  await audio.resume();
  const it = state.scene.items.find((x) => x.character === c) || state.scene.items.find((x) => x.type === 'action');
  const text = it ? speechFor(it) : `This is ${state.cast[c]}.`;
  const r = await render(state.cast[c], text);
  audio.play(await audio.load(r.url), { fx: state.fx[c] || null });
}

function renderRole() {
  $('#rolePick').innerHTML = state.scene.characters.map((c) =>
    `<button class="${c === state.role ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  $$('#rolePick button').forEach((b) => { b.onclick = () => { state.role = b.dataset.c; renderCast(); renderRole(); renderScript(); prerender(); }; });
  $('#roleName').textContent = state.role || '—';
}

function wordsHtml(text) {
  return text.split(/\s+/).filter(Boolean).map((w, i) => `<span class="w" data-i="${i}">${esc(w)}</span>`).join(' ');
}

function renderScript() {
  const { meta, items } = state.scene;
  const html = [`<div class="title-block"><h2>${esc(meta.title)}</h2>${meta.author ? `<p>${esc(meta.author)}</p>` : ''}</div>`];
  for (const it of items) {
    if (it.type === 'heading') html.push(`<div class="item heading" id="${it.id}"><p class="text">${wordsHtml(it.text)}</p></div>`);
    else if (it.type === 'action') html.push(`<div class="item action" id="${it.id}"><p class="text">${wordsHtml(it.text)}</p></div>`);
    else {
      const mine = it.character === state.role;
      html.push(`<div class="item line${mine ? ' mine' : ''}" id="${it.id}" style="--c:${colorOf(it.character)}">
        <div class="who">${esc(it.character)}<span class="voice">${mine ? '' : esc(state.cast[it.character])}</span></div>
        ${it.note ? `<div class="paren">(${esc(it.note)})</div>` : ''}
        <p class="text">${wordsHtml(it.speech)}</p><div class="live"></div><div class="chips"></div></div>`);
    }
  }
  $('#script').innerHTML = html.join('');
}

async function prerender() {
  const token = ++state.renderToken;
  const jobs = new Map();
  for (const it of spokenItems()) jobs.set(`${voiceFor(it)}|${speechFor(it)}`, [voiceFor(it), speechFor(it)]);
  // Narrator voice is also the prompter; warm the actor stand-in voice in demo mode.
  for (const [v, t] of demo?.actorClips(state.scene, state.role) || []) jobs.set(`${v}|${t}`, [v, t]);
  const list = [...jobs.values()];
  let done = 0;
  const ttfa = [];
  let audioMs = 0;
  const paint = () => {
    if (token !== state.renderToken) return;
    $('#renderBar').style.width = `${(done / list.length) * 100}%`;
    const avg = ttfa.length ? Math.round(ttfa.reduce((a, b) => a + b, 0) / ttfa.length) : null;
    $('#renderText').innerHTML = done < list.length
      ? `Rendering <b>${done}/${list.length}</b> lines with AssemblyAI TTS…`
      : `<b>${list.length}</b> clips ready · <b>${(audioMs / 1000).toFixed(0)}s</b> of audio${avg ? ` · first audio in <b>${avg} ms</b>` : ' · cached'}`;
  };
  paint();
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < list.length) {
      const [voice, text] = list[next++];
      try {
        const r = await render(voice, text);
        if (r.ttfaMs) ttfa.push(r.ttfaMs);
        audioMs += r.durationMs;
        audio.load(r.url).catch(() => {});
      } catch (e) { toast(`TTS failed: ${e.message}`); }
      done++;
      paint();
    }
  }));
}

// ---------------------------------------------------------------- live UI helpers

function status(html) { $('#liveStatus').innerHTML = html; }
function liveText(text) { $('#liveText').textContent = text || ''; }
function setBar(mode) { $('#livebar').className = `livebar ${mode || ''}`; }

function activate(it, kind) {
  $$('#script .item.active').forEach((el) => el.classList.remove('active', 'partner', 'you', 'narrator'));
  const el = $(`#${it.id}`);
  el.classList.add('active', kind);
  const wrap = $('.page-wrap');
  wrap.scrollTo({ top: el.offsetTop - wrap.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' });
}

function retire(it) {
  const el = $(`#${it.id}`);
  el.classList.remove('active', 'partner', 'you', 'narrator');
  el.classList.add('done');
}

function chip(it, cls, text) {
  const c = document.createElement('span');
  c.className = `chip ${cls}`;
  c.textContent = text;
  $(`#${it.id} .chips`)?.append(c);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 5000);
}

/** Light words up in time with the TTS word boundaries. */
function karaoke(it, words, startAt) {
  const spans = $$(`#${it.id} .text .w`);
  const n = spans.length;
  const times = spans.map((_, i) => {
    const w = words.length === n ? words[i] : words[Math.floor((i * words.length) / Math.max(1, n))];
    return w ? w.start : 0;
  });
  let alive = true;
  const tick = () => {
    if (!alive) return;
    const t = (audio.ctx.currentTime - startAt) * 1000;
    spans.forEach((s, i) => s.classList.toggle('spoken', t >= times[i]));
    requestAnimationFrame(tick);
  };
  tick();
  return () => { alive = false; spans.forEach((s) => s.classList.add('spoken')); };
}

// ---------------------------------------------------------------- runs

function beginRun(mode) {
  stop();
  const run = { mode, cancelled: false, handles: new Set(), lines: [], turnOwner: new Map(), active: null, stt: null, startedAt: performance.now() };
  state.run = run;
  $('#script').classList.add('running');
  $$('#script .item').forEach((el) => el.classList.remove('done', 'active', 'partner', 'you', 'narrator', 'offbook'));
  $$('#script .chips, #script .live').forEach((el) => { el.innerHTML = ''; });
  $$('#script .prompt-bubble').forEach((el) => el.remove());
  $$('#script .w').forEach((el) => { el.className = 'w'; delete el.dataset.said; });
  $('#tableBtn').disabled = $('#rehearseBtn').disabled = true;
  $('#stopBtn').hidden = false;
  $('#liveChips').innerHTML = '';
  return run;
}

function endRun(run) {
  if (state.run === run) state.run = null;
  audio.onPcm = null;
  audio.gate(false);
  run.stt?.close();
  $('#script').classList.remove('running');
  $$('#script .item.active').forEach((el) => el.classList.remove('active', 'partner', 'you', 'narrator'));
  $('#tableBtn').disabled = $('#rehearseBtn').disabled = false;
  $('#stopBtn').hidden = true;
  setBar('');
}

function stop() {
  const run = state.run;
  if (!run) return;
  run.cancelled = true;
  for (const h of run.handles) h.stop();
  run.active?.resolve?.(null);
  endRun(run);
  status('Stopped.');
  liveText('');
}

async function speak(it, run, onStart) {
  const voice = voiceFor(it);
  const r = await render(voice, speechFor(it));
  const buf = await audio.load(r.url);
  if (run.cancelled) return null;
  const kind = it.type === 'line' ? 'partner' : 'narrator';
  activate(it, kind);
  const fx = it.type === 'line' ? state.fx[it.character] || null : null;
  const h = audio.play(buf, { fx, gain: kind === 'narrator' ? 0.85 : 1 });
  run.handles.add(h);
  onStart?.(h);
  emit('partner', { id: it.id, character: it.character || 'NARRATOR', voice, fx, mode: run.mode });
  setBar('partner');
  status(it.type === 'line'
    ? `<span class="p">${esc(it.character)}</span> · AssemblyAI TTS · voice <b>${esc(voice)}</b>${fx === 'radio' ? ' · 📻 radio FX' : ''}`
    : `<span class="p">Stage directions</span> · voice <b>${esc(voice)}</b>`);
  liveText('');
  const stopKaraoke = karaoke(it, r.words, h.startAt);
  await h.ended;
  stopKaraoke();
  run.handles.delete(h);
  retire(it);
  return h;
}

async function tableRead({ maxItems = Infinity } = {}) {
  await audio.resume();
  const run = beginRun('table');
  let count = 0;
  for (const it of spokenItems()) {
    if (run.cancelled || count++ >= maxItems) break;
    await speak(it, run);
    await sleep(it.type === 'line' ? 140 : 260);
  }
  if (!run.cancelled) { status('Table read finished.'); endRun(run); }
}

async function rehearse() {
  await audio.resume();
  const run = beginRun('rehearse');
  const stt = (run.stt = new Stt({ keyterms_prompt: keytermsFor(state.scene), interruption_delay: 0 }));
  stt.addEventListener('Turn', (e) => onTurn(run, e.detail));
  stt.addEventListener('close', (e) => { if (!run.cancelled && state.run === run && e.detail.code !== 1000) toast(`Speech-to-text closed (${e.detail.code}) ${e.detail.reason || ''}`); });
  status('Connecting to Universal-3.6 Pro…');
  try {
    if (!DEMO) await audio.useMicrophone();
    await stt.connect();
  } catch (e) {
    toast(e.message.includes('Permission') ? 'Microphone permission is needed to rehearse.' : e.message);
    endRun(run);
    return;
  }
  audio.onPcm = (pcm) => stt.send(pcm);
  audio.onLevel = (lvl, gate) => onLevel(run, lvl, gate);
  audio.gate(false);

  let pending = null; // user line awaiting its cue measurement
  let ordinal = 0;
  for (const it of spokenItems()) {
    if (run.cancelled) break;
    if (it.type === 'line' && it.character === state.role) {
      if (pending) recordCue(run, pending, null);
      pending = await userLine(run, it, ++ordinal);
      if (!pending) break;
    } else {
      await speak(it, run, (h) => { if (pending) { recordCue(run, pending, h); pending = null; } });
      await sleep(it.type === 'line' ? 60 : 200);
    }
  }
  if (run.cancelled) return;
  status('Scene complete — scoring your run…');
  await sleep(900); // let the last ForceEndpoint finals arrive
  state.lastRun = run;
  endRun(run);
  showReport(run);
}

// ---------------------------------------------------------------- your lines

function userLine(run, it, ordinal) {
  return new Promise((resolve) => {
    const { display, tokens } = tokenize(it.speech);
    const L = {
      it, ordinal, display, tokens, E: tokens.map((t) => t.t), order: [], turns: new Map(), calls: 0, prompts: [],
      prompting: false, done: false, resolve, startedAt: performance.now(), voiced: false, lastVoiceAt: null,
      pauseStart: null, longestPause: 0, last: { progress: 0, ops: [], matched: 0, lastMatch: -1 },
    };
    run.active = L;
    run.lines.push(L);
    activate(it, 'you');
    if (state.offBook) $(`#${it.id}`).classList.add('offbook');
    paintWords(L, L.last);
    setBar('listening');
    status(`🎙 <b>Your line</b> — listening · Universal-3.6 Pro streaming`);
    liveText('');
    audio.gate(true);
    emit('your-line', { ordinal, id: it.id });
    if (DEMO) demo.perform(it, L, ordinal);
  });
}

function saidText(L) { return L.order.map((o) => L.turns.get(o)?.transcript || '').join(' ').replace(/\s+/g, ' ').trim(); }

function onTurn(run, msg) {
  let L = run.turnOwner.get(msg.turn_order);
  if (!L) {
    L = run.active;
    if (!L || L.done) return;
    run.turnOwner.set(msg.turn_order, L);
    L.order.push(msg.turn_order);
  }
  L.turns.set(msg.turn_order, msg);
  if (L.done) return; // a late final for a finished line: kept for scoring
  evaluate(run, L, msg);
}

function evaluate(run, L, msg) {
  const said = saidText(L);
  $(`#${L.it.id} .live`).textContent = said;
  liveText(said);
  const { tokens: S, calls } = extractCalls(L.E, spokenTokens(said));
  if (calls > L.calls) { L.calls = calls; promptLine(run, L, S); }
  const r = align(L.E, S);
  L.last = r;
  paintWords(L, r);
  const n = L.E.length;
  const complete = n === 0
    || (r.progress === n && r.lastTouched >= n - 1 && r.matched >= Math.ceil(n * 0.5))
    || (msg.end_of_turn && r.progress >= n - 1 && r.matched >= Math.ceil(n * 0.6));
  if (complete && !L.prompting) {
    L.via = `${msg.end_of_turn ? 'final' : 'partial'}${L.forced ? '+forced' : ''}`;
    finishLine(run, L);
  }
}

function onLevel(run, level, gate) {
  $('#micRing').style.transform = `scale(${1 + Math.min(level * 14, 0.9)})`;
  const L = run.active;
  if (!L || L.done || !gate || L.prompting) return;
  const now = performance.now();
  if (level > VOICE_LEVEL) {
    if (L.pauseStart && L.voiced) {
      const p = now - L.pauseStart;
      if (p > 1200 && L.last.progress < L.E.length) { L.longestPause = Math.max(L.longestPause, p); chip(L.it, 'hold', `‖ held a ${(p / 1000).toFixed(1)}s pause — no cue`); emit('hold', { ordinal: L.ordinal, ms: p }); }
      if (p > 1000) status(`🎙 <b>Your line</b> — listening · Universal-3.6 Pro streaming`);
    }
    L.pauseStart = null;
    L.voiced = true;
    L.forced = false;
    L.lastVoiceAt = now;
  } else if (L.voiced && !L.pauseStart) L.pauseStart = now;
  // Script-aware endpointing: we know the line, so once the actor goes quiet near its end,
  // ask Universal-3.6 Pro to finalize the turn now instead of waiting out its silence timer.
  if (L.pauseStart && !L.forced && now - L.pauseStart > 200 && L.last.progress >= L.E.length - 2 && L.last.matched > 0) {
    L.forced = true;
    run.stt.forceEndpoint();
  }
  if (L.pauseStart && now - L.pauseStart > 1000 && L.last.progress < L.E.length && L.last.matched > 0) {
    if (L.holdingFor !== L.pauseStart) { L.holdingFor = L.pauseStart; emit('holding', { ordinal: L.ordinal }); }
    const left = L.E.length - L.last.progress;
    status(`<span class="y">‖ Holding your cue</span> — ${((now - L.pauseStart) / 1000).toFixed(1)}s pause, ${left} word${left > 1 ? 's' : ''} still to go`);
  }
}

function finishLine(run, L) {
  L.done = true;
  run.active = null;
  audio.gate(false);
  run.stt.forceEndpoint();
  L.speechEnd = L.lastVoiceAt ?? performance.now();
  L.detectedAt = performance.now();
  const el = $(`#${L.it.id}`);
  el.classList.remove('offbook');
  paintWords(L, L.last, { final: true });
  retire(L.it);
  const sc = scoreLine(L.it.speech, saidText(L));
  if (sc.swapped.length) chip(L.it, 'flub', `✎ “${sc.swapped[0][0]}” for “${sc.swapped[0][1]}”`);
  emit('line', { ordinal: L.ordinal, accuracy: sc.accuracy, swapped: sc.swapped });
  L.resolve(L);
}

function recordCue(run, L, h) {
  if (!h) return;
  const startWall = performance.now() + (h.startAt - audio.ctx.currentTime) * 1000;
  L.cueMs = Math.max(0, Math.round(startWall - L.speechEnd));
  console.info(`[cue] line ${L.ordinal}: speech end -> detected ${Math.round(L.detectedAt - L.speechEnd)} ms (${L.via || 'manual'}) -> partner ${L.cueMs} ms`);
  emit('cue', { ordinal: L.ordinal, ms: L.cueMs, via: L.via });
  chip(L.it, 'cue', `⚡ cue in ${(L.cueMs / 1000).toFixed(2)}s`);
  status(`<span class="g">⚡ Cue</span> — partner came in <b>${(L.cueMs / 1000).toFixed(2)}s</b> after your last word`);
  const cues = run.lines.filter((x) => x.cueMs !== undefined).map((x) => x.cueMs);
  const avg = cues.reduce((a, b) => a + b, 0) / cues.length;
  $('#liveChips').innerHTML = `<div class="kpi-mini"><b>${(avg / 1000).toFixed(2)}s</b><span>avg cue</span></div>
    <div class="kpi-mini"><b>${run.lines.length}</b><span>lines run</span></div>`;
}

function paintWords(L, r, { final = false } = {}) {
  const spans = $$(`#${L.it.id} .text .w`);
  const st = new Array(L.E.length).fill(null);
  const said = {};
  for (const o of r.ops) {
    if (o.type === 'ok') st[o.e] = 'ok';
    else if (o.type === 'sub') {
      st[o.e] = 'sub';
      said[o.e] = o.s;
      if (o.e2 !== undefined) st[o.e2] = 'sub';
    } else if (o.type === 'del' && final) st[o.e] = 'del';
  }
  if (final) for (let k = r.progress; k < st.length; k++) if (!st[k]) st[k] = 'del';
  spans.forEach((sp, di) => {
    const idx = L.tokens.map((t, k) => (t.src === di ? k : -1)).filter((k) => k >= 0);
    const s = idx.map((k) => st[k]);
    const cls = !s.length ? (final ? 'ok' : '')
      : s.every((x) => x === 'ok') ? 'ok'
        : s.some((x) => x === 'sub') ? 'sub'
          : s.some((x) => x === 'ok') ? 'ok'
            : s.every((x) => x === 'del') ? 'del' : '';
    sp.className = `w${cls ? ` ${cls}` : ''}`;
    if (cls === 'sub') sp.dataset.said = idx.map((k) => said[k]).filter(Boolean).join(' ');
    else delete sp.dataset.said;
  });
  if (!final) {
    const nextTok = L.tokens[r.progress];
    if (nextTok) spans[nextTok.src]?.classList.add('next');
  }
}

async function promptLine(run, L, S) {
  if (L.prompting || L.done) return;
  L.prompting = true;
  audio.gate(false);
  const r = align(L.E, S);
  const di = L.tokens[Math.min(r.progress, L.tokens.length - 1)]?.src ?? 0;
  const rest = L.display.slice(di);
  const text = (rest.length <= 6 ? rest : rest.slice(0, 4)).join(' ').replace(/[,;:—–-]+$/, '');
  const bubble = document.createElement('div');
  bubble.className = 'prompt-bubble';
  bubble.textContent = `💬 Prompter: “${text}”`;
  $(`#${L.it.id} .live`).after(bubble);
  status(`<span class="p">💬 Line called</span> — fetching your next words…`);
  try {
    const t0 = performance.now();
    const clip = await render(state.cast.NARRATOR, text, { fresh: true });
    const buf = await audio.load(`${clip.url}?t=${Date.now()}`);
    const ms = Math.round(performance.now() - t0);
    const h = audio.play(buf, { fx: 'prompt', gain: 0.9 });
    run.handles.add(h);
    chip(L.it, 'prompt', `💬 prompted in ${ms} ms`);
    run.prompts = [...(run.prompts || []), { text, ms, ttfaMs: clip.ttfaMs }];
    emit('prompt', { ordinal: L.ordinal, text, ms });
    status(`<span class="p">💬 Prompter</span> — “${esc(text)}” · rendered live in <span class="g">${ms} ms</span>`);
    await h.ended;
    run.handles.delete(h);
  } catch (e) {
    toast(`Prompt failed: ${e.message}`);
  } finally {
    L.prompts.push(text);
    L.prompting = false;
    if (!L.done && state.run === run) { audio.gate(true); status(`🎙 <b>Your line</b> — listening · Universal-3.6 Pro streaming`); }
    demo?.promptDone();
  }
}

// ---------------------------------------------------------------- report

async function showReport(run) {
  const rows = run.lines.map((L) => ({ L, said: saidText(L), sc: scoreLine(L.it.speech, saidText(L)) }));
  const totalWords = rows.reduce((n, r) => n + r.sc.words.length, 0);
  const okWords = rows.reduce((n, r) => n + r.sc.words.filter((w) => w.st === 'ok').length, 0);
  const perfect = rows.filter((r) => r.sc.accuracy >= 0.999).length;
  const cues = rows.map((r) => r.L.cueMs).filter((x) => x !== undefined);
  const avgCue = cues.length ? cues.reduce((a, b) => a + b, 0) / cues.length : null;
  const called = rows.reduce((n, r) => n + r.L.calls, 0);

  $('#reportTitle').textContent = `${state.scene.meta.title} — ${state.role}`;
  $('#kpis').innerHTML = [
    [`${Math.round((okWords / Math.max(1, totalWords)) * 100)}%`, 'word accuracy', 'good'],
    [`${perfect}/${rows.length}`, 'lines word-perfect', ''],
    [avgCue !== null ? `${avgCue.toFixed(0)} ms` : '—', 'avg cue pickup', 'good'],
    [`${called}`, `line${called === 1 ? '' : 's'} called`, ''],
  ].map(([v, l, c]) => `<div class="kpi ${c}"><b>${v}</b><span>${l}</span></div>`).join('');

  $('#reportLines').innerHTML = rows.map(({ L, said, sc }) => {
    const acc = Math.round(sc.accuracy * 100);
    const words = sc.words.map((w) => `<span class="w ${w.st}"${w.said ? ` data-said="${esc(w.said)}"` : ''}>${esc(w.w)}</span>`).join(' ');
    const chips = [
      L.cueMs !== undefined ? `<span class="chip cue">⚡ ${(L.cueMs / 1000).toFixed(2)}s cue</span>` : '',
      L.calls ? `<span class="chip prompt">💬 called</span>` : '',
      L.longestPause > 900 ? `<span class="chip hold">‖ ${(L.longestPause / 1000).toFixed(1)}s pause held</span>` : '',
      sc.swapped.length ? `<span class="chip flub">✎ ${sc.swapped.map(([s, e]) => `“${esc(s)}” for “${esc(e)}”`).join(', ')}</span>` : '',
    ].join('');
    return `<li><div class="script-line">${words}</div><div class="meta"><span class="acc ${acc >= 95 ? 'hi' : acc >= 75 ? 'mid' : 'lo'}">${acc}%</span>${chips}</div>
      <div class="said">You said: “${esc(said || '—')}”</div></li>`;
  }).join('');

  $('#notesText').textContent = 'Your director is writing notes…';
  $('#notesSrc').textContent = '';
  $('#report').hidden = false;
  emit('report');
  const results = rows.map(({ L, said, sc }) => ({
    character: state.role, expected: L.it.speech, spoken: said, accuracy: sc.accuracy, dropped: sc.dropped,
    swapped: sc.swapped, called: L.calls > 0, pauseMs: Math.round(L.longestPause), cueMs: L.cueMs,
  }));
  try {
    const n = await api('/api/notes', { title: state.scene.meta.title, character: state.role, results });
    run.notes = n.notes;
    $('#notesText').textContent = n.notes;
    $('#notesSrc').textContent = n.source === 'llm' ? `Written by ${n.model} via AssemblyAI LLM Gateway` : 'Rule-based notes (LLM Gateway unavailable)';
    emit('notes', { source: n.source });
  } catch (e) {
    $('#notesText').textContent = 'Could not fetch notes.';
  }
  return run;
}

async function playNotes() {
  const text = state.lastRun?.notes;
  if (!text) return null;
  await audio.resume();
  const r = await render(state.cast.NARRATOR, text);
  const h = audio.play(await audio.load(r.url));
  $('#notes').classList.add('speaking');
  await h.ended;
  $('#notes').classList.remove('speaking');
  return h;
}

// ---------------------------------------------------------------- boot

async function boot() {
  const [{ scenes }, { voices }] = await Promise.all([api('/api/scenes'), api('/api/voices')]);
  state.scenes = scenes;
  state.voices = voices;
  await audio.init();
  if (DEMO) {
    demo = new DemoDirector({ audio, render, api: () => ({ loadScene, tableRead, rehearse, stop, showReport, playNotes, state }) });
    window.demo = demo;
  }
  $('#sceneSelect').innerHTML = scenes.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
  $('#sceneSelect').onchange = (e) => loadScene(e.target.value);
  $('#offBook').onchange = (e) => { state.offBook = e.target.checked; };
  $('#directions').onchange = (e) => { state.directions = e.target.checked; prerender(); };
  $('#tableBtn').onclick = () => tableRead();
  $('#rehearseBtn').onclick = () => rehearse();
  $('#stopBtn').onclick = () => stop();
  $('#closeReport').onclick = () => { $('#report').hidden = true; };
  $('#playNotes').onclick = () => playNotes();
  $('#pasteBtn').onclick = () => {
    const text = $('#pasteBox').value.trim();
    if (!text) return;
    const parsed = parseScript(text);
    if (!parsed.characters.length) return toast('No dialogue found. Use "NAME: line" or a screenplay/play format.');
    setScene(parsed);
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('textarea, input, select')) return;
    if (e.key === 'Escape') stop();
    // Space: "I'm done with my line" (manual cue) while rehearsing.
    if (e.code === 'Space' && state.run?.active) { e.preventDefault(); finishLine(state.run, state.run.active); }
  });
  await loadScene(scenes[0].id);
  window.sceneReady = true;
}

boot().catch((e) => { console.error(e); toast(e.message); });
