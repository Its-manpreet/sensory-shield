// OWNER: Agent A. Screen capture for the overlay. Frames stay in memory, are never saved or sent anywhere.

/**
 * Start capturing the primary display into `video` (main.js answers getDisplayMedia without a picker).
 * @param {HTMLVideoElement} video
 */
export async function startCapture(video) {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  video.srcObject = stream;
  await video.play();
  return stream;
}

/**
 * Small-frame sampler: draws the current video frame into a gridW x gridH canvas and returns its RGBA.
 * Also tracks which content tiles changed since the last call to `changedTiles()`.
 */
export function createSampler(video, { gridW = 64, gridH = 36, tilesX = 4, tilesY = 3, changeThreshold = 6 } = {}) {
  const c = new OffscreenCanvas(gridW, gridH);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
  // Two-step downscale: one 46x jump samples only a few pixels per cell, so scrolling text and photos
  // shimmer (aliasing) and can look like flicker. A 4x-grid intermediate with high-quality smoothing
  // gives true area averages, which keeps motion looking like motion to the flash detector.
  const mid = new OffscreenCanvas(gridW * 4, gridH * 4);
  const mctx = /** @type {OffscreenCanvasRenderingContext2D} */ (mid.getContext('2d', { willReadFrequently: true }));
  let gray = new Uint8Array(mid.width * mid.height); // for keeping blurs on moving content (box-motion.js)
  mctx.imageSmoothingQuality = 'high';
  ctx.imageSmoothingQuality = 'high';
  let current = new Uint8ClampedArray(gridW * gridH * 4);
  let lastChecked = null;

  return {
    /** @returns {Uint8ClampedArray} RGBA gridW*gridH*4 of the latest frame */
    sample() {
      mctx.drawImage(video, 0, 0, mid.width, mid.height);
      ctx.drawImage(mid, 0, 0, gridW, gridH);
      current = ctx.getImageData(0, 0, gridW, gridH).data;
      const m = mctx.getImageData(0, 0, mid.width, mid.height).data;
      gray = new Uint8Array(mid.width * mid.height);
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (54 * m[p] + 183 * m[p + 1] + 19 * m[p + 2]) >> 8;
      return current;
    },
    /** grayscale of the latest frame at 4x the grid (256x144), memory only */
    gray() {
      return gray;
    },
    grayWidth: mid.width,
    grayHeight: mid.height,
    /**
     * Mean absolute difference per tile vs. the frame at the previous content check.
     * @returns {boolean[]} row-major tilesX*tilesY; all true on the first call
     */
    changedTiles() {
      const out = new Array(tilesX * tilesY).fill(true);
      if (lastChecked) {
        const sums = new Float64Array(tilesX * tilesY);
        const counts = new Uint32Array(tilesX * tilesY);
        for (let y = 0; y < gridH; y++) {
          const ty = Math.min(tilesY - 1, Math.floor((y * tilesY) / gridH));
          for (let x = 0; x < gridW; x++) {
            const tx = Math.min(tilesX - 1, Math.floor((x * tilesX) / gridW));
            const p = (y * gridW + x) * 4;
            const t = ty * tilesX + tx;
            sums[t] += Math.abs(current[p] - lastChecked[p]) + Math.abs(current[p + 1] - lastChecked[p + 1]) + Math.abs(current[p + 2] - lastChecked[p + 2]);
            counts[t] += 3;
          }
        }
        for (let t = 0; t < out.length; t++) out[t] = sums[t] / counts[t] > changeThreshold;
      }
      lastChecked = current.slice();
      return out;
    },
  };
}
