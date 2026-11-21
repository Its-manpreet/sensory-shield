// OWNER: Agent B. Flash detector. Contract: docs/INTERFACES.md section 1.
// Pure JS: no DOM, no Electron, no network. Runs in Node (tests) and in the overlay / a worker.
//
// How it works (WCAG 2.x "general flash" and "red flash", simplified; see docs/DECISIONS.md):
// - Every grid cell keeps its own transition tracker on linear-light relative luminance and on the
//   WCAG red value. A transition is a swing of >= 0.1 luminance (darker side below 0.8), or a swing
//   of > 20 in the red value. A flash is a pair of opposing transitions.
// - A cell is "flashing" when it had >= maxFlashesPerSec flashes in the last second.
// - Protection starts only when flashing cells cover >= minAreaFraction of the screen. Each region
//   then reports the bounding box of its flashing cells, and keeps reporting it for holdMs.
// Reduces exposure to known triggers; it does not claim to prevent seizures.

export const DEFAULT_FLASH_CONFIG = Object.freeze({
  gridW: 64,
  gridH: 36,
  regionsX: 4,
  regionsY: 4,
  maxFlashesPerSec: 3,
  minAreaFraction: 0.25,
  holdMs: 1500,
  detectRed: true,
});

const LUM_DELTA = 0.1; // WCAG: change of 10% of max relative luminance
const LUM_DARK_MAX = 0.8; // WCAG: darker state must be below 0.80
const RED_DELTA = 20; // WCAG red flash: (R-G-B)*320 changes by more than 20
const RED_SATURATION = 0.8; // WCAG: R/(R+G+B) >= 0.8
const WINDOW_MS = 1000;
const RING = 32; // transition timestamps kept per cell and channel; only >= 2*maxFlashesPerSec matter

// sRGB 0..255 -> linear light 0..1
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Hysteresis transition tracker for one channel over n cells. */
function createTracker(n, delta, darkMax) {
  const dir = new Int8Array(n); // 0 none yet, 1 last transition was up, -1 down
  const ext = new Float32Array(n); // running peak (dir 1) or valley (dir -1)
  const lo = new Float32Array(n).fill(Infinity); // dir 0: min seen
  const hi = new Float32Array(n).fill(-Infinity); // dir 0: max seen
  const times = new Float64Array(n * RING).fill(-Infinity);
  const head = new Uint8Array(n);

  function record(i, t) {
    times[i * RING + head[i]] = t;
    head[i] = (head[i] + 1) % RING;
  }

  return {
    /** @returns {boolean} true when this sample completed a transition */
    step(i, v, t) {
      const d = dir[i];
      if (d === 0) {
        if (v < lo[i]) lo[i] = v;
        if (v > hi[i]) hi[i] = v;
        if (hi[i] - v >= delta && v < darkMax) dir[i] = -1;
        else if (v - lo[i] >= delta && lo[i] < darkMax) dir[i] = 1;
        else return false;
      } else if (d === 1) {
        if (v > ext[i]) return (ext[i] = v), false;
        if (ext[i] - v < delta || v >= darkMax) return false;
        dir[i] = -1;
      } else {
        if (v < ext[i]) return (ext[i] = v), false;
        if (v - ext[i] < delta || ext[i] >= darkMax) return false;
        dir[i] = 1;
      }
      ext[i] = v;
      record(i, t);
      return true;
    },
    /** flashes (pairs of opposing transitions) in the window ending at t */
    flashes(i, t) {
      let count = 0;
      const from = t - WINDOW_MS;
      for (let k = i * RING, end = k + RING; k < end; k++) if (times[k] >= from) count++;
      return count >> 1;
    },
    /** cheap pre-check: any transition inside the window? */
    recent(i, t) {
      const last = times[i * RING + ((head[i] + RING - 1) % RING)];
      return last >= t - WINDOW_MS;
    },
    reset() {
      dir.fill(0);
      lo.fill(Infinity);
      hi.fill(-Infinity);
      times.fill(-Infinity);
      head.fill(0);
    },
  };
}

/**
 * @param {Partial<import('../shared/types.js').FlashConfig>} [config]
 * @returns {{ push(frame: import('../shared/types.js').FrameInput): import('../shared/types.js').FlashEvent[], reset(): void }}
 */
export function createFlashDetector(config = {}) {
  const cfg = { ...DEFAULT_FLASH_CONFIG, ...config };
  const { gridW, gridH, regionsX, regionsY, maxFlashesPerSec, minAreaFraction, holdMs, detectRed } = cfg;
  const n = gridW * gridH;
  const lum = createTracker(n, LUM_DELTA, LUM_DARK_MAX);
  const red = createTracker(n, RED_DELTA, Infinity);
  const nRegions = regionsX * regionsY;
  const cellRegion = new Uint16Array(n);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const rx = Math.min(regionsX - 1, Math.floor((x * regionsX) / gridW));
      const ry = Math.min(regionsY - 1, Math.floor((y * regionsY) / gridH));
      cellRegion[y * gridW + x] = ry * regionsX + rx;
    }
  }

  // per-region scratch and hold state
  const minX = new Int16Array(nRegions), minY = new Int16Array(nRegions);
  const maxX = new Int16Array(nRegions), maxY = new Int16Array(nRegions);
  const peak = new Float32Array(nRegions);
  const redCells = new Uint16Array(nRegions), cells = new Uint16Array(nRegions);
  /** @type {({rect: any, severity: number, kind: 'luminance'|'red', until: number} | null)[]} */
  let held = new Array(nRegions).fill(null);

  function push(frame) {
    const { data, tMs: t } = frame;
    if (data.length < n * 4) throw new Error(`flash: expected ${n * 4} bytes (gridW*gridH*4), got ${data.length}`);

    minX.fill(gridW); minY.fill(gridH); maxX.fill(-1); maxY.fill(-1);
    peak.fill(0); redCells.fill(0); cells.fill(0);
    let flashingCells = 0;

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = LINEAR[data[p]], g = LINEAR[data[p + 1]], b = LINEAR[data[p + 2]];
      lum.step(i, 0.2126 * r + 0.7152 * g + 0.0722 * b, t);
      if (detectRed) {
        const sum = r + g + b;
        const redValue = sum > 0 && r / sum >= RED_SATURATION ? Math.max(0, (r - g - b) * 320) : 0;
        red.step(i, redValue, t);
      }

      let f = lum.recent(i, t) ? lum.flashes(i, t) : 0;
      let isRed = false;
      if (detectRed && red.recent(i, t)) {
        const fr = red.flashes(i, t);
        if (fr >= maxFlashesPerSec && fr >= f) (f = fr), (isRed = true);
      }
      if (f < maxFlashesPerSec) continue;

      flashingCells++;
      const reg = cellRegion[i];
      const x = i % gridW, y = (i / gridW) | 0;
      if (x < minX[reg]) minX[reg] = x;
      if (x > maxX[reg]) maxX[reg] = x;
      if (y < minY[reg]) minY[reg] = y;
      if (y > maxY[reg]) maxY[reg] = y;
      if (f > peak[reg]) peak[reg] = f;
      cells[reg]++;
      if (isRed) redCells[reg]++;
    }

    const areaOk = flashingCells / n >= minAreaFraction;
    /** @type {import('../shared/types.js').FlashEvent[]} */
    const events = [];
    for (let reg = 0; reg < nRegions; reg++) {
      if (areaOk && cells[reg] > 0) {
        // one cell of margin so the dim fully covers the edge of the flashing area
        const x0 = Math.max(0, minX[reg] - 1), y0 = Math.max(0, minY[reg] - 1);
        const x1 = Math.min(gridW, maxX[reg] + 2), y1 = Math.min(gridH, maxY[reg] + 2);
        const rect = { x: x0 / gridW, y: y0 / gridH, w: (x1 - x0) / gridW, h: (y1 - y0) / gridH };
        const severity = Math.min(1, peak[reg] / (2 * maxFlashesPerSec));
        /** @type {'luminance'|'red'} */
        const kind = redCells[reg] * 2 > cells[reg] ? 'red' : 'luminance';
        held[reg] = { rect, severity, kind, until: t + holdMs };
        events.push({ rect, severity, kind, active: true });
      } else if (held[reg] && t < held[reg].until) {
        const h = held[reg];
        events.push({ rect: h.rect, severity: h.severity, kind: h.kind, active: false });
      } else {
        held[reg] = null;
      }
    }
    return events;
  }

  return {
    push,
    reset() {
      lum.reset();
      red.reset();
      held = new Array(nRegions).fill(null);
    },
  };
}
