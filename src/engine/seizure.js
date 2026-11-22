// Guardian: notices sustained, rhythmic, large movement in front of the webcam (what convulsive
// seizures look like to a camera) so the app can ask "Are you OK?" and, with no answer, alert a trusted person.
// Pure JavaScript. No DOM, no Electron: runs in Node (tests) and in the guardian window.
//
// It does NOT diagnose anything. It sees only rhythmic whole-body-sized movement while the person is in view.
// It will miss absence and focal seizures and anything off camera, and it can be fooled by rhythmic activity
// (exercise, rocking). That is why every detection is followed by a human check before an alert goes out.
//
// How: the camera is downsampled to a tiny gray grid (default 32x24). Each cell keeps a few seconds of
// brightness. A cell is "rhythmic" when its brightness swings strongly AND its autocorrelation shows a clear
// period of 1.2 to 6 Hz (a dip at half the period, then a peak). Slow drift, a single movement or random
// fidgeting has no such dip-then-peak. When enough of the frame, spread over more than one area, is
// rhythmic for minDurationSec (short gaps allowed: real jerking is irregular), the state becomes 'suspect'.

/**
 * @typedef {{
 *   gridW: number, gridH: number,
 *   windowSec: number,        // history per cell used for the rhythm test
 *   minHz: number, maxHz: number,
 *   minStd: number,           // brightness swing (0..255) a cell needs; camera noise is ~1-3
 *   minCorr: number,          // autocorrelation at the period
 *   maxDip: number,           // autocorrelation must fall to this (or lower) before the period
 *   fundamentalHz: number,    // slowest movement the harmonic check looks for
 *   harmonicMargin: number,   // a longer-lag peak this much stronger = slower movement, not rhythmic
 *   minAreaFraction: number,  // share of cells that must be rhythmic together
 *   minRegions: number,       // of a 3x3 split of the frame, how many must hold rhythmic cells
 *   minDurationSec: number,   // rhythmic this long -> 'suspect'
 *   gapSec: number            // a pause this short does not restart the count
 * }} SeizureConfig
 *
 * @typedef {{ data: Uint8ClampedArray, tMs: number }} CameraFrame  // RGBA, gridW*gridH*4
 *
 * @typedef {{
 *   level: 'warming'|'normal'|'rhythmic'|'suspect',
 *   progress: number,        // 0..1 toward 'suspect'
 *   rhythmicFraction: number,
 *   freqHz: number,          // median rhythm of the rhythmic cells (0 when none)
 *   sinceMs: number,         // how long the current rhythmic stretch has lasted
 *   dark: boolean,           // too dark to see anything useful
 *   motion: number, rhythm: number,  // whole-frame motion energy and its rhythm score (0..1)
 *   path: 'cells'|'energy'|null      // which signal saw rhythmic movement this frame
 * }} GuardianState
 */

export const SEIZURE_DEFAULTS = {
  gridW: 32,
  gridH: 24,
  windowSec: 5,
  minHz: 1.2,
  maxHz: 6,
  fundamentalHz: 0.4, // how slow a movement the harmonic check looks for (lowered with minHz)
  harmonicMargin: 0.2,
  minStd: 7,
  minCorr: 0.3,
  maxDip: -0.25,
  minAreaFraction: 0.05,
  minRegions: 2,
  // second signal, ported from shake_proxy_detector.py: whole-frame "motion energy" (mean frame difference)
  // and how much of its spectrum sits in one peak. Energy swings twice per back-and-forth, so 2-8 Hz of
  // energy = 1-4 Hz of movement. It sees jerking that does not swing a cell's brightness evenly (plain
  // clothes, blur), but it cannot tell WHERE things move, so it only counts when the moving cells also
  // pass the same area and spread checks as the cell path.
  energyDiffMin: 3, // per-cell differences below this are sensor noise (set to 0)
  energyBand: null, // [lo, hi] Hz of motion energy; null = [min(2, 2*minHz), max(8, 2*maxHz)]
  minMotion: 1.2, // mean energy over the window (0..255 scale); below this nothing counts, on either path
  minRhythm: 0.4, // peak power / power above 0.5 Hz
  minDurationSec: 10,
  gapSec: 1.5,
  // 'rhythm' = the checks above. 'threshold' = plain mode: motion (the readout) at or over motionThreshold
  // counts, nothing else is checked (no rhythm, area or spread). In BOTH modes motion over motionThreshold
  // counts: very violent movement is blurred and irregular and can stop looking rhythmic, and must not drop out.
  mode: 'rhythm',
  motionThreshold: 25,
};

/** The settings a user can tune (Settings > Guardian > Detection), and a preset for small movements. */
export const SEIZURE_TUNABLE = ['minMotion', 'minAreaFraction', 'minRegions', 'minStd', 'minCorr', 'minRhythm', 'minHz', 'maxHz', 'harmonicMargin', 'windowSec', 'gapSec'];
export const SEIZURE_PRESETS = {
  default: Object.fromEntries(SEIZURE_TUNABLE.map((k) => [k, SEIZURE_DEFAULTS[k]])),
  // a head nodding or shaking: one small area, little whole-picture motion, can be slower than whole-body jerking
  // (8 s of history lets the harmonic check see slow sway, which would otherwise pass at these settings)
  small: { minMotion: 0.1, minAreaFraction: 0.01, minRegions: 1, minStd: 4, minCorr: 0.35, minRhythm: 0.3, minHz: 0.7, maxHz: 6, harmonicMargin: 0.1, windowSec: 8, gapSec: 2 },
};

/** @param {Partial<SeizureConfig>} [config] */
export function createSeizureDetector(config = {}) {
  const c = { ...SEIZURE_DEFAULTS, ...config };
  c.energyBand ??= [Math.min(2, 2 * c.minHz), Math.max(8, 2 * c.maxHz)];
  if (!('fundamentalHz' in config)) c.fundamentalHz = Math.min(SEIZURE_DEFAULTS.fundamentalHz, c.minHz / 2, 2 / c.windowSec);
  const cells = c.gridW * c.gridH;
  const MAXN = 256; // ring capacity per cell (5 s at up to 50 fps)
  const ring = new Float32Array(cells * MAXN);
  const times = new Float64Array(MAXN);
  let head = 0; // next write slot
  let count = 0;
  let runStart = -1;
  let lastRhythmic = -1;
  const energy = new Float32Array(MAXN); // motion energy per frame, same ring slots as `times`
  const x = new Float32Array(MAXN);
  const r = new Float32Array(64);

  function reset() {
    head = 0;
    count = 0;
    runStart = -1;
    lastRhythmic = -1;
  }

  /** @param {CameraFrame} frame @returns {GuardianState} */
  function push(frame) {
    const { data, tMs } = frame;
    let sum = 0;
    let diffSum = 0;
    const prevSlot = (head - 1 + MAXN) % MAXN;
    for (let i = 0; i < cells; i++) {
      const p = i * 4;
      const y = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      if (count > 0) {
        const d = Math.abs(y - ring[i * MAXN + prevSlot]);
        if (d >= c.energyDiffMin) diffSum += d;
      }
      ring[i * MAXN + head] = y;
      sum += y;
    }
    energy[head] = diffSum / cells;
    times[head] = tMs;
    head = (head + 1) % MAXN;
    count = Math.min(count + 1, MAXN);
    const dark = sum / cells < 18;

    // frames inside the analysis window
    let n = 0;
    while (n < count && tMs - times[(head - 1 - n + MAXN) % MAXN] <= c.windowSec * 1000) n++;
    const spanMs = tMs - times[(head - n + MAXN) % MAXN];
    if (n < 16 || spanMs < c.windowSec * 1000 * 0.9) return state('warming', 0, 0, 0, 0, dark, {});
    const fps = ((n - 1) * 1000) / spanMs;
    const lagMin = Math.max(2, Math.floor(fps / c.maxHz));
    const lagMax = Math.min(Math.ceil(fps / c.minHz), n >> 1, r.length - 2);
    // look further than minHz too: a slow sway over a textured shirt makes brightness swing at 2x or 3x its
    // rate, and only the longer lag shows the true (slow) period
    const lagFar = Math.min(Math.ceil(fps / c.fundamentalHz), n >> 1, r.length - 2);

    let rhythmic = 0;
    let moving = 0;
    const movingRegions = new Set();
    const regions = new Set();
    const freqs = [];
    for (let i = 0; i < cells; i++) {
      // copy this cell's window oldest -> newest
      const base = i * MAXN;
      let mean = 0;
      for (let k = 0; k < n; k++) {
        const v = ring[base + ((head - n + k + MAXN) % MAXN)];
        x[k] = v;
        mean += v;
      }
      mean /= n;
      let v2 = 0;
      for (let k = 0; k < n; k++) {
        x[k] -= mean;
        v2 += x[k] * x[k];
      }
      const variance = v2 / n;
      if (variance < c.minStd * c.minStd) continue;
      const gx = Math.min(2, Math.floor(((i % c.gridW) * 3) / c.gridW));
      const gy = Math.min(2, Math.floor((Math.floor(i / c.gridW) * 3) / c.gridH));
      moving++;
      movingRegions.add(gy * 3 + gx);
      // normalized autocorrelation for lags 1..lagMax+1
      for (let L = 1; L <= lagFar + 1; L++) {
        let s = 0;
        for (let k = 0; k + L < n; k++) s += x[k] * x[k + L];
        r[L] = s / ((n - L) * variance);
      }
      // first local peak in range, after a dip
      let dip = 1;
      let found = 0;
      for (let L = 1; L <= lagMax; L++) {
        if (r[L] < dip) dip = r[L];
        if (L >= lagMin && r[L] >= r[L - 1] && r[L] >= r[L + 1] && r[L] >= c.minCorr && dip <= c.maxDip) {
          found = L;
          break;
        }
      }
      if (!found) continue;
      // a clearly stronger peak at a longer lag means the real movement is slower (harmonic): not rhythmic
      let slower = false;
      for (let L = found + 2; L <= lagFar; L++) {
        if (r[L] >= r[L - 1] && r[L] >= r[L + 1] && r[L] > r[found] + c.harmonicMargin) slower = true;
      }
      if (slower) continue;
      rhythmic++;
      freqs.push(fps / found);
      regions.add(gy * 3 + gx);
    }

    const fraction = rhythmic / cells;
    freqs.sort((a, b) => a - b);
    const freqHz = freqs.length ? freqs[freqs.length >> 1] : 0;
    const e = energyRhythm(n, fps);
    const energyPath = e.motion >= c.minMotion && e.rhythm >= c.minRhythm && moving / cells >= c.minAreaFraction && movingRegions.size >= c.minRegions;
    const cellPath = fraction >= c.minAreaFraction && regions.size >= c.minRegions;
    // minMotion gates both paths: whole-frame movement weaker than this never counts (user setting)
    const over = e.motion >= c.motionThreshold;
    const now = over || (c.mode !== 'threshold' && e.motion >= c.minMotion && (cellPath || energyPath));
    if (now) {
      if (runStart < 0 || tMs - lastRhythmic > c.gapSec * 1000) runStart = tMs;
      lastRhythmic = tMs;
    } else if (runStart >= 0 && tMs - lastRhythmic > c.gapSec * 1000) {
      runStart = -1;
    }
    const since = runStart >= 0 ? lastRhythmic - runStart : 0;
    const progress = Math.min(1, since / (c.minDurationSec * 1000));
    const level = progress >= 1 ? 'suspect' : runStart >= 0 ? 'rhythmic' : 'normal';
    return state(level, progress, fraction, freqHz || (energyPath ? e.peakHz / 2 : 0), since, dark, { ...e, path: over ? 'threshold' : c.mode === 'threshold' ? null : cellPath ? 'cells' : energyPath ? 'energy' : null });
  }

  /**
   * shake_proxy_detector.py, ported: Hann-windowed spectrum of the motion-energy series (a plain DFT: the
   * window holds ~75 values). rhythm = strongest in-band bin / all power above 0.5 Hz.
   */
  function energyRhythm(n, fps) {
    // newest n-1 energies (the oldest one in the window has no previous frame inside it)
    const m = n - 1;
    let mean = 0;
    for (let k = 0; k < m; k++) mean += (x[k] = energy[(head - m + k + MAXN) % MAXN]);
    mean /= m;
    for (let k = 0; k < m; k++) x[k] = (x[k] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (m - 1)));
    let total = 1e-9;
    let best = 0;
    let peakHz = 0;
    const hi = Math.min(c.energyBand[1], fps / 2);
    for (let b = 1; b <= m >> 1; b++) {
      const hz = (b * fps) / m;
      if (hz < 0.5) continue;
      let re = 0;
      let im = 0;
      for (let k = 0; k < m; k++) {
        const a = (2 * Math.PI * b * k) / m;
        re += x[k] * Math.cos(a);
        im -= x[k] * Math.sin(a);
      }
      const pw = re * re + im * im;
      total += pw;
      if (hz >= c.energyBand[0] && hz <= hi && pw > best) (best = pw), (peakHz = hz);
    }
    return { motion: mean, rhythm: best / total, peakHz };
  }

  const state = (level, progress, rhythmicFraction, freqHz, sinceMs, dark, e) => ({
    level,
    progress,
    rhythmicFraction,
    freqHz,
    sinceMs,
    dark,
    motion: e.motion ?? 0, // the Python script's readout: motion energy, rhythm 0..1, energy peak Hz
    rhythm: e.rhythm ?? 0,
    path: e.path ?? null, // which signal saw it: 'cells' | 'energy' | null
  });

  return { push, reset, config: c };
}
