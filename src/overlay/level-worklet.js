// OWNER: Agent A. Audio worklet: loudness of the captured system audio every ~10 ms (RMS in dBFS).
// Runs on the audio thread, so readings come 5x more often than a 50 ms timer and react faster.
class LevelMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.count = 0;
    this.block = Math.round(sampleRate / 100); // 10 ms
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) this.sum += ch[i] * ch[i];
      this.count += ch.length;
    } else this.count += 128; // no input yet: silence
    if (this.count >= this.block) {
      this.port.postMessage(10 * Math.log10(this.sum / this.count + 1e-12));
      this.sum = 0;
      this.count = 0;
    }
    return true;
  }
}
registerProcessor('level-meter', LevelMeter);
