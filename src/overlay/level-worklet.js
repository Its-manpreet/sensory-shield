// OWNER: Agent A. Audio worklet: measures the captured system audio on the audio thread. Memory only.
// Every ~10 ms it posts { levelDb, toneDb, toneShareDb, toneSharpDb, toneHz }:
//   - levelDb: perceived loudness (K-weighted mean square, as in ITU-R BS.1770 / LUFS), all channels.
//     K-weighting cuts rumble and lifts the 2-8 kHz range where the ear is most sensitive, so a level of
//     -24 means roughly the same loudness for speech, music and ads, unlike plain RMS.
//   - toneDb / toneShareDb / toneHz: the strongest narrow peak above 2.5 kHz (from a 1024-point FFT every
//     ~21 ms): its level, and how much of ALL the sound it makes up. A whistle, feedback squeal, alarm beep
//     or mosquito tone is one sharp peak holding most of the energy (share near 0 dB); hi-hats, "s" sounds
//     and music spread their energy wide (share around -15 to -30 dB).

const FFT_N = 1024;
const TONE_MIN_HZ = 2500;

/** biquad coefficients for one channel state: y = b0 x + b1 x1 + b2 x2 - a1 y1 - a2 y2 */
function kWeighting(fs) {
  // libebur128's sample-rate independent derivation of the BS.1770 filters
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  const Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** 0.4996667741545416, Q1 = 0.7071752369554196;
  let a0 = 1 + K / Q1 + K * K;
  const shelf = [(Vh + (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0];
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0];
  return [shelf, hp];
}

class LevelMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.filters = kWeighting(sampleRate);
    this.state = []; // per channel: [x1, x2, y1, y2] for each of the 2 filters
    this.sum = 0;
    this.count = 0;
    this.block = Math.round(sampleRate / 100); // 10 ms
    // tone analysis on a mono mix
    this.buf = new Float32Array(FFT_N);
    this.pos = 0;
    this.re = new Float32Array(FFT_N);
    this.im = new Float32Array(FFT_N);
    this.win = Float32Array.from({ length: FFT_N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N));
    this.tone = { toneDb: -120, toneShareDb: -120, toneSharpDb: -120, toneHz: 0 };
  }

  kSample(ch, x) {
    const st = (this.state[ch] ??= [new Float64Array(4), new Float64Array(4)]);
    for (let f = 0; f < 2; f++) {
      const [b0, b1, b2, a1, a2] = this.filters[f], s = st[f];
      const y = b0 * x + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3];
      s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
      x = y;
    }
    return x;
  }

  analyseTone() {
    const N = FFT_N, re = this.re, im = this.im;
    let ms = 0;
    for (let i = 0; i < N; i++) {
      const v = this.buf[(this.pos + i) % N];
      ms += v * v;
      re[i] = v * this.win[i];
      im[i] = 0;
    }
    ms /= N;
    if (ms < 1e-9) return void (this.tone = { toneDb: -120, toneShareDb: -120, toneSharpDb: -120, toneHz: 0 });
    // in-place radix-2 FFT
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
        }
      }
    }
    let total = 0, peak = 0, peakBin = 0;
    const p = (k) => re[k] * re[k] + im[k] * im[k];
    for (let k = 1; k < N / 2; k++) total += p(k);
    const from = Math.ceil((TONE_MIN_HZ * N) / sampleRate);
    for (let k = Math.max(2, from); k < N / 2 - 1; k++) {
      const e = p(k - 1) + p(k) + p(k + 1); // a windowed sine spreads over ~3 bins
      if (e > peak) (peak = e), (peakBin = k);
    }
    const share = peak / (total + 1e-20);
    // how sharp the peak is: its 3 bins against the 25 bins around it (~1.2 kHz at 48 kHz). A whistle or beep
    // is ~0 dB; a hiss band, like "s" and "sh" in speech, spreads over many bins (-4 dB and lower).
    let near = 0;
    for (let k = Math.max(1, peakBin - 12); k <= Math.min(N / 2 - 1, peakBin + 12); k++) near += p(k);
    this.tone = {
      toneShareDb: 10 * Math.log10(share + 1e-12),
      toneSharpDb: 10 * Math.log10(peak / (near + 1e-20) + 1e-12),
      toneDb: 10 * Math.log10(ms * share + 1e-12), // the tone's own level (dBFS mean square)
      toneHz: (peakBin * sampleRate) / N,
    };
  }

  process(inputs) {
    const chans = inputs[0] ?? [];
    const n = chans[0]?.length ?? 128;
    if (chans.length) {
      let sq = 0;
      for (let c = 0; c < chans.length; c++) {
        const ch = chans[c];
        for (let i = 0; i < ch.length; i++) {
          const y = this.kSample(c, ch[i]);
          sq += y * y;
        }
      }
      // BS.1770 sums the channels' mean squares; average instead so mono and stereo read the same
      this.sum += sq / chans.length;
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let c = 0; c < chans.length; c++) m += chans[c][i];
        this.buf[this.pos] = m / chans.length;
        this.pos = (this.pos + 1) % FFT_N;
        if (this.pos === 0) this.analyseTone(); // every 1024 samples (~21 ms at 48 kHz)
      }
    }
    this.count += n;
    if (this.count >= this.block) {
      this.port.postMessage({ levelDb: -0.691 + 10 * Math.log10(this.sum / this.count + 1e-12), ...this.tone });
      this.sum = 0;
      this.count = 0;
    }
    return true;
  }
}
registerProcessor('level-meter', LevelMeter);
