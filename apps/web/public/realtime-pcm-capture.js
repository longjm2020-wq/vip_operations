// Local microphone processing only. Produce 20 ms mono PCM16 frames at 16 kHz.
// Worklet sampleRate follows the actual device context (commonly 44.1/48 kHz).
class RealtimePcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.ratio = sampleRate / 16000;
    this.reset();
    this.port.onmessage = (event) => {
      this.active = event.data?.active === true;
      this.reset();
    };
  }
  reset() {
    this.frame = new ArrayBuffer(640);
    this.view = new DataView(this.frame);
    this.offset = 0;
    this.weight = 0;
    this.sum = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!this.active || !channel) return true;
    // Weighted integration preserves timing across blocks, including 44.1 kHz.
    for (const sample of channel) {
      let left = 1;
      while (left > 1e-8) {
        const take = Math.min(left, this.ratio - this.weight);
        this.sum += sample * take;
        this.weight += take;
        left -= take;
        if (this.weight >= this.ratio - 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.view.setInt16(
            this.offset * 2,
            Math.round(value * (value < 0 ? 32768 : 32767)),
            true,
          );
          this.offset++;
          this.weight = 0;
          this.sum = 0;
          if (this.offset === 320) {
            this.port.postMessage(this.frame, [this.frame]);
            this.frame = new ArrayBuffer(640);
            this.view = new DataView(this.frame);
            this.offset = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("xuti-realtime-pcm", RealtimePcmCapture);
