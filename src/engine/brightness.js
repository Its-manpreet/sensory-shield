// Sudden brightness jumps ("flashbang": a white page after a dark screen). Pure JS, no DOM.
// Painful for people sensitive to bright light and a migraine trigger, even when it happens only once
// (the flash detector needs repetition, so it ignores a single jump on purpose).
//
// Per region (4x4), the mean linear-light luminance is tracked. A jump is a rise of at least `minRise`
// to at least `minRatio` times the darkest level of the last `windowMs`, starting from a dim screen.
// The response eases the change in: a dark veil that first matches the old brightness, then fades out
// over `easeMs`. Regions that jump in the same frame share one veil so there are no visible seams.

export const DEFAULT_BRIGHTNESS_CONFIG = Object.freeze({
  gridW: 64,
  gridH: 36,
  regionsX: 4,
  regionsY: 4,
  minRise: 0.25, // linear luminance (0..1): dark grey -> light grey or brighter
  minRatio: 3, // and at least 3x brighter than before (perceived as a jump, not a gentle change)
  fromBelow: 0.2, // only from a dim starting point
  windowMs: 250, // the rise must happen within this time
  easeMs: 1000, // how long the change is eased in
  maxVeil: 0.85,
});

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** smooth ease-out: fast at first, gentle at the end */
const easeOut = (x) => 1 - (1 - x) ** 3;

/**
 * @param {Partial<typeof DEFAULT_BRIGHTNESS_CONFIG>} [config]
 * @returns {{ push(frame: {data: Uint8ClampedArray, tMs: number}): {rect: {x:number,y:number,w:number,h:number}, strength: number}[], reset(): void }}
 */
export function createBrightnessGuard(config = {}) {
  const cfg = { ...DEFAULT_BRIGHTNESS_CONFIG, ...config };
  const { gridW, gridH, regionsX, regionsY } = cfg;
  const nRegions = regionsX * regionsY;
  const cellRegion = new Uint16Array(gridW * gridH);
  const cellsPer = new Uint16Array(nRegions);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const r = Math.min(regionsY - 1, Math.floor((y * regionsY) / gridH)) * regionsX + Math.min(regionsX - 1, Math.floor((x * regionsX) / gridW));
      cellRegion[y * gridW + x] = r;
      cellsPer[r]++;
    }
  }
  const sums = new Float64Array(nRegions);
  /** recent [t, mean] samples per region, for the darkest level within windowMs */
  let history = Array.from({ length: nRegions }, () => []);
  /** active ease per region: { t0, alpha0 } */
  let easing = new Array(nRegions).fill(null);

  function regionRect(r) {
    const rx = r % regionsX, ry = (r / regionsX) | 0;
    return { x: rx / regionsX, y: ry / regionsY, w: 1 / regionsX, h: 1 / regionsY };
  }

  return {
    push({ data, tMs: t }) {
      sums.fill(0);
      for (let i = 0, p = 0; i < gridW * gridH; i++, p += 4) {
        sums[cellRegion[i]] += 0.2126 * LINEAR[data[p]] + 0.7152 * LINEAR[data[p + 1]] + 0.0722 * LINEAR[data[p + 2]];
      }
      const jumped = [];
      for (let r = 0; r < nRegions; r++) {
        const mean = sums[r] / cellsPer[r];
        const h = history[r];
        while (h.length && t - h[0][0] > cfg.windowMs) h.shift();
        let darkest = mean;
        for (const [, m] of h) if (m < darkest) darkest = m;
        h.push([t, mean]);
        const isJump = darkest < cfg.fromBelow && mean - darkest >= cfg.minRise && mean >= darkest * cfg.minRatio;
        if (isJump && !easing[r]) {
          // veil so the screen first looks about as bright as before, then ease toward the real brightness
          const alpha0 = Math.min(cfg.maxVeil, Math.max(0, 1 - (darkest + 0.05) / mean));
          jumped.push([r, alpha0]);
        }
      }
      if (jumped.length) {
        const shared = Math.max(...jumped.map(([, a]) => a)); // same veil for regions that jumped together
        for (const [r] of jumped) easing[r] = { t0: t, alpha0: shared };
      }

      const events = [];
      for (let r = 0; r < nRegions; r++) {
        const e = easing[r];
        if (!e) continue;
        const k = (t - e.t0) / cfg.easeMs;
        if (k >= 1) {
          easing[r] = null;
          history[r] = []; // the new brightness is the baseline now
          continue;
        }
        events.push({ rect: regionRect(r), strength: e.alpha0 * (1 - easeOut(k)) });
      }
      return events;
    },
    reset() {
      history = Array.from({ length: nRegions }, () => []);
      easing = new Array(nRegions).fill(null);
    },
  };
}
