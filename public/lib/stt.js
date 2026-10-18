// Universal-3.6 Pro streaming client (via the local relay at /stt).
// Emits 'Begin', 'SpeechStarted', 'Turn', 'Termination', 'Error', 'close' events.

export class Stt extends EventTarget {
  constructor(params = {}) {
    super();
    this.params = params;
    this.streamStart = null; // performance.now() at audio t=0
    this.sentMs = 0;
  }

  connect() {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(this.params)) if (v !== undefined && v !== null) qs.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/stt?${qs}`);
    this.ws.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      this.ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        const msg = JSON.parse(e.data);
        if (msg.type === 'Begin') { this.begin = msg; resolve(msg); }
        if (msg.type === 'Error') reject(new Error(msg.error || 'STT error'));
        this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
      };
      this.ws.onerror = () => reject(new Error('Could not reach the speech-to-text relay'));
      this.ws.onclose = (e) => this.dispatchEvent(new CustomEvent('close', { detail: { code: e.code, reason: e.reason } }));
    });
  }

  get open() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  /** pcm: ArrayBuffer of 50 ms PCM16 @ 16 kHz */
  send(pcm) {
    if (!this.open) return;
    if (this.streamStart === null) this.streamStart = performance.now() - 50;
    this.ws.send(pcm);
    this.sentMs += 50;
  }

  /** Wall-clock (performance.now) time of an audio-stream timestamp in ms. */
  wallTime(streamMs) { return this.streamStart === null ? null : this.streamStart + streamMs; }

  forceEndpoint() { if (this.open) this.ws.send(JSON.stringify({ type: 'ForceEndpoint' })); }

  update(config) { if (this.open) this.ws.send(JSON.stringify({ type: 'UpdateConfiguration', ...config })); }

  close() {
    if (!this.ws) return;
    if (this.open) this.ws.send(JSON.stringify({ type: 'Terminate' }));
    setTimeout(() => this.ws.close(), 1500);
  }
}
