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
 */
export function createSampler(video, { gridW = 64, gridH = 36 } = {}) {
  const c = new OffscreenCanvas(gridW, gridH);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
  // Two-step downscale: one 46x jump samples only a few pixels per cell, so scrolling text and photos
  // shimmer (aliasing) and can look like flicker. A 4x-grid intermediate with high-quality smoothing
  // gives true area averages, which keeps motion looking like motion to the flash detector.
  const mid = new OffscreenCanvas(gridW * 4, gridH * 4);
  const mctx = /** @type {OffscreenCanvasRenderingContext2D} */ (mid.getContext('2d'));
  mctx.imageSmoothingQuality = 'high';
  ctx.imageSmoothingQuality = 'high';

  return {
    /** @returns {Uint8ClampedArray} RGBA gridW*gridH*4 of the latest frame */
    sample() {
      mctx.drawImage(video, 0, 0, mid.width, mid.height);
      ctx.drawImage(mid, 0, 0, gridW, gridH);
      return ctx.getImageData(0, 0, gridW, gridH).data;
    },
  };
}
