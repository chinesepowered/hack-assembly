// Mic bus -> 16 kHz PCM16, 50 ms chunks (what Universal-3.6 Pro streaming expects).
// While the gate is closed (a scene partner is speaking) it sends silence, so the
// stream clock keeps running but echo never reaches the transcriber.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.phase = 0;
    this.acc = 0;
    this.accN = 0;
    this.out = new Int16Array(800);
    this.k = 0;
    this.gate = false;
    this.rawSq = 0;
    this.rawN = 0;
    this.port.onmessage = (e) => {
      if (e.data && 'gate' in e.data) this.gate = e.data.gate;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    for (let i = 0; i < 128; i++) {
      const raw = ch ? ch[i] : 0;
      this.rawSq += raw * raw;
      this.rawN++;
      // Box-filter decimation to 16 kHz (cheap anti-aliasing, fine for speech).
      this.acc += this.gate ? raw : 0;
      this.accN++;
      this.phase += 1;
      if (this.phase >= this.step) {
        this.phase -= this.step;
        const v = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        this.out[this.k++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
        if (this.k === this.out.length) {
          const level = Math.sqrt(this.rawSq / this.rawN);
          this.rawSq = 0;
          this.rawN = 0;
          this.port.postMessage({ pcm: this.out.buffer, level, gate: this.gate }, [this.out.buffer]);
          this.out = new Int16Array(800);
          this.k = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', Capture);
