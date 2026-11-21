// Constant motion (vestibular trigger: dizziness, nausea). Pure JS, no DOM.
//
// A 96x54 luminance grid (~15 screen px per cell) is cut into 8x6-cell blocks. Each frame, a block counts as
// "moving" when it differs from the frame `strideFrames` ago (~100 ms): slow drifts move only a few pixels per
// frame, so comparing further apart makes them measurable. A block that keeps moving in most frames of the
// last `constantMs` (an animated background, an auto-playing animation) is flagged. A still screen gives a
// difference of exactly zero, so nothing static is ever flagged. Off by default in settings: videos are
// constant motion too.
// The response caps the region's frame rate (shown at ~2 fps, crossfaded), which removes the sense of
// movement without hiding the content.

export const DEFAULT_MOTION_CONFIG = Object.freeze({
  gridW: 96,
  gridH: 54,
  blockW: 8,
  blockH: 6,
  strideFrames: 3, // compare with the frame ~100 ms ago (at 30 fps)
  minChange: 0.0025, // mean |difference| (linear luminance) for a block to count as moving
  constantMs: 3000,
  constantShare: 0.8, // moving in 80% of the frames of constantMs
  holdMs: 800, // keep the region calmed this long after the motion stops
});

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * @param {Partial<typeof DEFAULT_MOTION_CONFIG>} [config]
 * @returns {{ push(frame: {data: Uint8ClampedArray, tMs: number}): {rect: {x:number,y:number,w:number,h:number}, kind: 'constant'}[], reset(): void }}
 */
export function createMotionDetector(config = {}) {
  const cfg = { ...DEFAULT_MOTION_CONFIG, ...config };
  const { gridW, gridH } = cfg;
  const bx = Math.max(1, Math.round(gridW / cfg.blockW)), by = Math.max(1, Math.round(gridH / cfg.blockH));
  const nb = bx * by;
  const n = gridW * gridH;
  // ring of the last strideFrames + 1 frames: the oldest is strideFrames ago
  const ring = Array.from({ length: cfg.strideFrames + 1 }, () => new Float32Array(n));
  let ringPos = 0, ringFill = 0;
  const movingTimes = Array.from({ length: nb }, () => []);
  const frameTimes = [];
  const flaggedUntil = new Float64Array(nb);

  const bounds = (b) => {
    const x = b % bx, y = (b / bx) | 0;
    return [Math.floor((x * gridW) / bx), Math.floor((y * gridH) / by), Math.floor(((x + 1) * gridW) / bx), Math.floor(((y + 1) * gridH) / by)];
  };

  return {
    push({ data, tMs: t }) {
      if (data.length < n * 4) throw new Error(`motion: expected ${n * 4} bytes (gridW*gridH*4), got ${data.length}`);
      const cur = ring[ringPos];
      for (let i = 0, p = 0; i < n; i++, p += 4) cur[i] = 0.2126 * LINEAR[data[p]] + 0.7152 * LINEAR[data[p + 1]] + 0.0722 * LINEAR[data[p + 2]];
      ringFill = Math.min(ring.length, ringFill + 1);
      const old = ring[(ringPos + 1) % ring.length];
      ringPos = (ringPos + 1) % ring.length;

      if (ringFill === ring.length) {
        frameTimes.push(t);
        while (frameTimes.length && t - frameTimes[0] > cfg.constantMs) frameTimes.shift();
        const full = t - frameTimes[0] >= cfg.constantMs * 0.9; // enough history to judge "constant"
        for (let b = 0; b < nb; b++) {
          const [x0, y0, x1, y1] = bounds(b);
          let sum = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += Math.abs(cur[y * gridW + x] - old[y * gridW + x]);
          const mt = movingTimes[b];
          if (sum / ((x1 - x0) * (y1 - y0)) >= cfg.minChange) mt.push(t);
          while (mt.length && t - mt[0] > cfg.constantMs) mt.shift();
          if (full && mt.length >= frameTimes.length * cfg.constantShare) flaggedUntil[b] = t + cfg.holdMs;
        }
      }

      // merged rects: bounding box of each group of touching flagged blocks
      const events = [];
      const seen = new Uint8Array(nb);
      for (let b = 0; b < nb; b++) {
        if (t >= flaggedUntil[b] || seen[b]) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        const stack = [b];
        seen[b] = 1;
        while (stack.length) {
          const k = stack.pop();
          const [ax0, ay0, ax1, ay1] = bounds(k);
          x0 = Math.min(x0, ax0); y0 = Math.min(y0, ay0); x1 = Math.max(x1, ax1); y1 = Math.max(y1, ay1);
          const kx = k % bx, ky = (k / bx) | 0;
          for (const [nx, ny] of [[kx + 1, ky], [kx - 1, ky], [kx, ky + 1], [kx, ky - 1]]) {
            if (nx < 0 || ny < 0 || nx >= bx || ny >= by) continue;
            const j = ny * bx + nx;
            if (t < flaggedUntil[j] && !seen[j]) (seen[j] = 1), stack.push(j);
          }
        }
        events.push({ rect: { x: x0 / gridW, y: y0 / gridH, w: (x1 - x0) / gridW, h: (y1 - y0) / gridH }, kind: 'constant' });
      }
      return events;
    },
    reset() {
      ringFill = 0;
      flaggedUntil.fill(0);
      for (const mt of movingTimes) mt.length = 0;
      frameTimes.length = 0;
    },
  };
}
