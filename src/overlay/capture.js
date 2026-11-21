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
  let current = new Uint8ClampedArray(gridW * gridH * 4);
  let lastChecked = null;

  return {
    /** @returns {Uint8ClampedArray} RGBA gridW*gridH*4 of the latest frame */
    sample() {
      ctx.drawImage(video, 0, 0, gridW, gridH);
      current = ctx.getImageData(0, 0, gridW, gridH).data;
      return current;
    },
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
