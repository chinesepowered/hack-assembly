// Records the master bus (everything the app plays) for demo videos.
// Posts mono Float32 chunks; the first message carries the context time of sample 0.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.chunk = new Float32Array(16384);
    this.k = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') {
        this.on = true;
        this.port.postMessage({ started: currentTime });
      } else if (e.data.cmd === 'stop') {
        this.on = false;
        this.flush();
        this.port.postMessage({ done: true });
      }
    };
  }

  flush() {
    if (!this.k) return;
    const out = this.chunk.slice(0, this.k);
    this.port.postMessage({ samples: out }, [out.buffer]);
    this.k = 0;
  }

  process(inputs) {
    if (!this.on) return true;
    const input = inputs[0] || [];
    const l = input[0], r = input[1] || input[0];
    for (let i = 0; i < 128; i++) {
      this.chunk[this.k++] = l ? (l[i] + r[i]) * 0.5 : 0;
      if (this.k === this.chunk.length) this.flush();
    }
    return true;
  }
}

registerProcessor('recorder', Recorder);
