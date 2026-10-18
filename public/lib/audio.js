// Web Audio engine: TTS clip playback (with radio / prompter FX), the mic bus that
// feeds speech-to-text, and an optional master-bus recorder for demo videos.

export class AudioEngine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    // Everything routed here is what the transcriber hears.
    this.micBus = this.ctx.createGain();
    // Silent sink that keeps worklets pulled by the render graph.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.ctx.destination);
    this.buffers = new Map();
    this.onPcm = null;
    this.onLevel = null;
  }

  async init() {
    await this.ctx.audioWorklet.addModule('/worklets/capture.js');
    await this.ctx.audioWorklet.addModule('/worklets/recorder.js');
    this.capture = new AudioWorkletNode(this.ctx, 'capture');
    this.capture.port.onmessage = ({ data }) => {
      this.onPcm?.(data.pcm);
      this.onLevel?.(data.level, data.gate);
    };
    this.micBus.connect(this.capture);
    this.capture.connect(this.sink);
    this.noise = this.makeNoise();
  }

  resume() { return this.ctx.state === 'running' ? Promise.resolve() : this.ctx.resume(); }

  /** Open/close the path from the mic bus to speech-to-text. */
  gate(open) { this.capture.port.postMessage({ gate: open }); }

  async useMicrophone() {
    if (this.micStream) return;
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx.createMediaStreamSource(this.micStream).connect(this.micBus);
  }

  load(url) {
    if (!this.buffers.has(url)) {
      this.buffers.set(url, fetch(url).then((r) => {
        if (!r.ok) throw new Error(`audio ${r.status}`);
        return r.arrayBuffer();
      }).then((b) => this.ctx.decodeAudioData(b)));
    }
    return this.buffers.get(url);
  }

  /**
   * Play a buffer. fx: 'radio' | 'prompt' | null. toMic: also feed the transcriber
   * (used by the simulated actor in demo mode).
   */
  play(buffer, { gain = 1, fx = null, toMic = false, delay = 0 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const out = ctx.createGain();
    out.gain.value = gain;
    let head = src;
    if (fx === 'radio') head = this.radioChain(src);
    if (fx === 'prompt') {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 260;
      src.connect(hp);
      head = hp;
    }
    head.connect(out);
    out.connect(this.master);
    if (toMic) out.connect(this.micBus);
    const startAt = ctx.currentTime + 0.02 + delay;
    if (fx === 'radio') this.squelch(startAt - 0.12, 0.14);
    src.start(startAt);
    const ended = new Promise((res) => { src.onended = res; });
    if (fx === 'radio') ended.then(() => this.squelch(ctx.currentTime, 0.18));
    return {
      startAt,
      duration: buffer.duration,
      ended,
      stop: () => { try { src.stop(); } catch { /* not started */ } },
    };
  }

  radioChain(src) {
    const ctx = this.ctx;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 450;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
    const peak = ctx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 1700; peak.gain.value = 6;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = (i / 511.5) - 1; curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); }
    shaper.curve = curve;
    src.connect(hp).connect(lp).connect(peak).connect(shaper);
    return shaper;
  }

  makeNoise() {
    const len = this.ctx.sampleRate;
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  squelch(at, dur) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.7;
    const g = ctx.createGain();
    const t = Math.max(at, ctx.currentTime);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.01);
    g.gain.setValueAtTime(0.09, t + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(bp).connect(g).connect(this.master);
    n.start(t, Math.random() * 0.5, dur + 0.02);
  }

  // ---------- demo recorder ----------

  startRecording() {
    this.rec = { chunks: [], startedCtx: null, epochOfCtx0: null };
    this.recorder = new AudioWorkletNode(this.ctx, 'recorder');
    this.master.connect(this.recorder);
    this.recorder.connect(this.sink);
    return new Promise((resolve) => {
      this.recorder.port.onmessage = ({ data }) => {
        if (data.started !== undefined) {
          // Map context time -> wall clock the same way the UI sees it (currentTime, not output time).
          const offs = [];
          for (let i = 0; i < 5; i++) offs.push(performance.timeOrigin + performance.now() - this.ctx.currentTime * 1000);
          offs.sort((a, b) => a - b);
          this.rec.startedCtx = data.started;
          this.rec.epochMs = offs[2] + data.started * 1000;
          resolve(this.rec.epochMs);
        } else if (data.samples) this.rec.chunks.push(data.samples);
        else if (data.done) this.rec.resolveStop?.();
      };
      this.recorder.port.postMessage({ cmd: 'start' });
    });
  }

  async stopRecording(name) {
    const done = new Promise((r) => { this.rec.resolveStop = r; });
    this.recorder.port.postMessage({ cmd: 'stop' });
    await done;
    const total = this.rec.chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let k = 0;
    for (const c of this.rec.chunks) for (let i = 0; i < c.length; i++) pcm[k++] = Math.max(-1, Math.min(1, c[i])) * 0x7fff;
    const wav = encodeWav(pcm, this.ctx.sampleRate);
    const meta = { epochMs: this.rec.epochMs, sampleRate: this.ctx.sampleRate, seconds: total / this.ctx.sampleRate };
    await fetch('/api/recording', { method: 'POST', headers: { 'x-name': name, 'x-meta': JSON.stringify(meta) }, body: wav });
    return meta;
  }
}

function encodeWav(pcm, sampleRate) {
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}
