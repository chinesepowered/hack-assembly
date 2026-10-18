// Demo mode (?demo): a simulated actor for recordings + overlay helpers.
//
// The stand-in actor's voice is played into the mic bus, so it goes through exactly
// the same path as a real microphone: 16 kHz PCM -> relay -> Universal-3.6 Pro
// streaming -> script alignment. Nothing about cue detection is faked.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DemoDirector {
  constructor({ audio, render, api }) {
    this.audio = audio;
    this.render = render;
    this.app = api;
    this.data = null;
    this.promptWaiters = [];
    this.layer = document.getElementById('demoLayer');
    this.layer.hidden = false;
    this.cursorEl = document.createElement('div');
    this.cursorEl.className = 'cursor';
    this.cursorEl.style.left = '70%';
    this.cursorEl.style.top = '60%';
    this.cursorEl.hidden = true;
    document.body.append(this.cursorEl);
  }

  setScene(data) { this.data = data; }

  segments(it, ordinal) {
    return this.data?.performances?.[String(ordinal)] || [{ say: it.speech }];
  }

  /** [voice, text] pairs to pre-render for the stand-in actor. */
  actorClips(scene, role) {
    if (!this.data || this.data.role !== role) return [];
    const out = [];
    let n = 0;
    for (const it of scene.items) {
      if (it.type !== 'line' || it.character !== role) continue;
      for (const seg of this.segments(it, ++n)) if (seg.say) out.push([this.data.actorVoice, seg.say]);
    }
    return out;
  }

  async perform(it, L, ordinal) {
    const voice = this.data?.actorVoice || 'eve';
    await sleep(420);
    for (const seg of this.segments(it, ordinal)) {
      if (L.done) return;
      if (seg.say) {
        const clip = await this.render(voice, seg.say);
        const h = this.audio.play(await this.audio.load(clip.url), { toMic: true });
        await h.ended;
      } else if (seg.pause) await sleep(seg.pause);
      else if (seg.await === 'prompt') await new Promise((r) => this.promptWaiters.push(r));
    }
  }

  promptDone() { this.promptWaiters.splice(0).forEach((r) => r()); }

  // ---------- overlays ----------

  slide(html) {
    this.hideCursor();
    this.clearSlide(true);
    const el = document.createElement('div');
    el.className = 'slide';
    el.innerHTML = `<div class="inner">${html}</div>`;
    this.layer.append(el);
    this.slideEl = el;
  }

  async clearSlide(instant = false) {
    const el = this.slideEl;
    this.slideEl = null;
    if (!el) return;
    if (instant) return el.remove();
    el.classList.add('out');
    await sleep(500);
    el.remove();
  }

  callout(html, ms = 0) {
    this.hideCallout(true);
    const el = document.createElement('div');
    el.className = 'callout';
    el.innerHTML = html;
    this.layer.append(el);
    this.calloutEl = el;
    if (ms) setTimeout(() => { if (this.calloutEl === el) this.hideCallout(); }, ms);
  }

  async hideCallout(instant = false) {
    const el = this.calloutEl;
    this.calloutEl = null;
    if (!el) return;
    if (instant) return el.remove();
    el.classList.add('out');
    await sleep(350);
    el.remove();
  }

  /** Speak narration with AssemblyAI TTS (also shown as a caption). */
  async narrate(text, { voice = 'jane', caption = true } = {}) {
    const clip = await this.render(voice, text);
    const buf = await this.audio.load(clip.url);
    if (caption) this.callout(text);
    const h = this.audio.play(buf, { gain: 1 });
    await h.ended;
    if (caption) await this.hideCallout();
    return clip;
  }

  async prepareNarration(lines, voice = 'jane') {
    for (const t of lines) await this.render(voice, t);
  }

  // ---------- fake cursor ----------

  async moveTo(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no element ${selector}`);
    const r = el.getBoundingClientRect();
    this.cursorEl.hidden = false;
    this.cursorEl.style.left = `${r.left + r.width / 2}px`;
    this.cursorEl.style.top = `${r.top + r.height / 2}px`;
    await sleep(700);
    return el;
  }

  async click(selector) {
    const el = await this.moveTo(selector);
    this.cursorEl.classList.add('down');
    await sleep(140);
    this.cursorEl.classList.remove('down');
    el.click();
    await sleep(200);
  }

  /** Animate a click on selector, then run fn instead of the element's own handler. */
  async press(selector, fn) {
    await this.moveTo(selector);
    this.cursorEl.classList.add('down');
    await sleep(140);
    this.cursorEl.classList.remove('down');
    return fn();
  }

  hideCursor() { this.cursorEl.hidden = true; }

  // ---------- recording ----------

  startRecording() { return this.audio.startRecording(); }
  stopRecording(name) { return this.audio.stopRecording(name); }
}
