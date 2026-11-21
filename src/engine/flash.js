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
// - Motion is not flashing. Scrolling a photo grid makes every cell alternate bright/dark, but the new
//   frame is just the old one shifted. Each block of cells is matched against the previous frame at
//   shifts of up to MAX_DY x MAX_DX cells; if a shift explains the change far better than no shift,
//   the block is "moving" for a short while and its transitions are not counted. A real flash changes
//   in place, so no shift explains it.
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
const BLOCK_W = 8; // motion blocks, in cells
const BLOCK_H = 6;
const MAX_DX = 4; // motion search range, in cells per frame (about 100 px sideways)
const MAX_DY = 8; // about 210 px per frame vertically: covers flick-scrolling at 30 fps
const MOTION_MIN_CHANGE = 0.012; // mean |change| below this: nothing moved, skip the search
const MOTION_RATIO = 0.6; // moving when the best shift leaves <= 60% of the unshifted difference
const MOTION_HOLD_MS = 250; // a block stays "moving" this long after the last moving frame
// Motion needs structure: content that moves by m cells changes each cell by at most about m times the
// local gradient. A flat block (the inside of a flashing area) or a change far larger than its edges
// could cause (a flash next to a dark page) cannot be motion, however well some shift happens to match.
const MOTION_GRADIENT_SLACK = 2;

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
    /**
     * @param {boolean} [count] false: follow the value (motion) but do not record a transition
     * @returns {boolean} true when this sample completed a counted transition
     */
    step(i, v, t, count = true) {
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
      if (!count) return false;
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

  // motion: previous frame luminance and per-block "moving until" time
  const cur = new Float32Array(n);
  const prev = new Float32Array(n);
  let havePrev = false;
  const blocksX = Math.max(1, Math.round(gridW / BLOCK_W));
  const blocksY = Math.max(1, Math.round(gridH / BLOCK_H));
  const movingUntil = new Float64Array(blocksX * blocksY);
  const cellBlock = new Uint16Array(n);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const bx = Math.min(blocksX - 1, Math.floor((x * blocksX) / gridW));
      const by = Math.min(blocksY - 1, Math.floor((y * blocksY) / gridH));
      cellBlock[y * gridW + x] = by * blocksX + bx;
    }
  }

  /** mean |cur - prev shifted by (dx, dy)| over block cells that stay on screen; Infinity if too few */
  function blockDiff(x0, y0, x1, y1, dx, dy, limit) {
    let sum = 0, count = 0;
    for (let y = y0; y < y1; y++) {
      const py = y + dy;
      if (py < 0 || py >= gridH) continue;
      const row = y * gridW, prow = py * gridW;
      for (let x = x0; x < x1; x++) {
        const px = x + dx;
        if (px < 0 || px >= gridW) continue;
        sum += Math.abs(cur[row + x] - prev[prow + px]);
        count++;
      }
      if (sum > limit * (x1 - x0) * (y1 - y0)) return Infinity; // already worse than the best: stop early
    }
    return count * 2 >= (x1 - x0) * (y1 - y0) ? sum / count : Infinity;
  }

  /** mean spatial gradient |dx| + |dy| of the current frame inside a block */
  function blockGradient(x0, y0, x1, y1) {
    let sum = 0, count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * gridW + x;
        if (x + 1 < gridW) sum += Math.abs(cur[i] - cur[i + 1]);
        if (y + 1 < gridH) sum += Math.abs(cur[i] - cur[i + gridW]);
        count++;
      }
    }
    return sum / count;
  }

  function updateMotion(t) {
    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        const x0 = Math.floor((bx * gridW) / blocksX), x1 = Math.floor(((bx + 1) * gridW) / blocksX);
        const y0 = Math.floor((by * gridH) / blocksY), y1 = Math.floor(((by + 1) * gridH) / blocksY);
        const d0 = blockDiff(x0, y0, x1, y1, 0, 0, Infinity);
        if (d0 < MOTION_MIN_CHANGE) continue;
        const grad = blockGradient(x0, y0, x1, y1);
        if (d0 > (MAX_DY + 1) * grad * MOTION_GRADIENT_SLACK) continue; // too little structure to explain it
        let best = Infinity, bestShift = 0;
        for (let dy = -MAX_DY; dy <= MAX_DY; dy++) {
          for (let dx = -MAX_DX; dx <= MAX_DX; dx++) {
            if (dx === 0 && dy === 0) continue;
            const d = blockDiff(x0, y0, x1, y1, dx, dy, Math.min(best, d0 * MOTION_RATIO));
            if (d < best) (best = d), (bestShift = Math.max(Math.abs(dx), Math.abs(dy)));
          }
        }
        const explainable = d0 <= (bestShift + 1) * grad * MOTION_GRADIENT_SLACK;
        if (best <= d0 * MOTION_RATIO && explainable) movingUntil[by * blocksX + bx] = t + MOTION_HOLD_MS;
      }
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
      cur[i] = 0.2126 * LINEAR[data[p]] + 0.7152 * LINEAR[data[p + 1]] + 0.0722 * LINEAR[data[p + 2]];
    }
    if (havePrev) updateMotion(t);

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const still = t >= movingUntil[cellBlock[i]];
      lum.step(i, cur[i], t, still);
      if (detectRed) {
        const r = LINEAR[data[p]], g = LINEAR[data[p + 1]], b = LINEAR[data[p + 2]];
        const sum = r + g + b;
        const redValue = sum > 0 && r / sum >= RED_SATURATION ? Math.max(0, (r - g - b) * 320) : 0;
        red.step(i, redValue, t, still);
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

    prev.set(cur);
    havePrev = true;

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
      havePrev = false;
      movingUntil.fill(0);
      held = new Array(nRegions).fill(null);
    },
  };
}
