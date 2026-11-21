// OWNER: Agent A. Screen capture for the overlay. Frames stay in memory, are never saved or sent anywhere.

/**
 * Start capturing the primary display into `video` (main.js answers getDisplayMedia without a picker).
 * @param {HTMLVideoElement} video
 */
export async function startCapture(video) {
  let stream;
  try {
    // with the sound of whatever is playing (system loopback), for sound protection. Chromium's voice-call
    // processing would distort loudness readings, so it is all off.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false }); // video only
  }
  video.srcObject = new MediaStream(stream.getVideoTracks()); // the <video> stays silent
  await video.play();
  return stream;
}

/**
 * Loudness of the captured system audio: `levelDb()` = RMS of the last ~43 ms in dBFS. Memory only.
 * @param {MediaStream} stream
 */
export function createSoundMeter(stream) {
  const tracks = stream.getAudioTracks();
  if (!tracks.length) return null;
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 2048;
  ac.createMediaStreamSource(new MediaStream(tracks)).connect(an); // analysed only, never played back
  const buf = new Float32Array(an.fftSize);
  return {
    levelDb() {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      return 10 * Math.log10(s / buf.length + 1e-12);
    },
    close() {
      ac.close();
    },
  };
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

  const motionCanvas = new OffscreenCanvas(96, 54); // finer grid for the motion detector
  const mo = /** @type {OffscreenCanvasRenderingContext2D} */ (motionCanvas.getContext('2d', { willReadFrequently: true }));
  mo.imageSmoothingQuality = 'high';

  return {
    /** RGBA 96x54 of the latest sample (motion detector; call after sample()) */
    sampleMotion() {
      mo.drawImage(mid, 0, 0, 96, 54);
      return mo.getImageData(0, 0, 96, 54).data;
    },
    /** @returns {Uint8ClampedArray} RGBA gridW*gridH*4 of the latest frame */
    sample() {
      mctx.drawImage(video, 0, 0, mid.width, mid.height);
      ctx.drawImage(mid, 0, 0, gridW, gridH);
      return ctx.getImageData(0, 0, gridW, gridH).data;
    },
  };
}
