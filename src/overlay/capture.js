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
      video: { frameRate: 60 }, // every frame of a flash counts: 60 fps halves the wait for the next one
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false }); // video only
  }
  video.srcObject = new MediaStream(stream.getVideoTracks()); // the <video> stays silent
  await video.play();
  return stream;
}

/**
 * Loudness of the captured system audio, pushed every ~10 ms by an audio worklet: onLevel(cb(levelDb, tMs)).
 * Analysed only: the audio goes into a silent gain node, never to the speakers. Memory only.
 * @param {MediaStream} stream
 */
export async function createSoundMeter(stream) {
  const tracks = stream.getAudioTracks();
  if (!tracks.length) return null;
  const ac = new AudioContext({ latencyHint: 'interactive' });
  await ac.audioWorklet.addModule(new URL('./level-worklet.js', import.meta.url));
  const node = new AudioWorkletNode(ac, 'level-meter');
  const mute = ac.createGain();
  mute.gain.value = 0; // keeps the graph running without making any sound
  ac.createMediaStreamSource(new MediaStream(tracks)).connect(node).connect(mute).connect(ac.destination);
  return {
    onLevel(cb) {
      node.port.onmessage = (e) => cb(e.data, performance.now());
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


  return {
    /** @returns {Uint8ClampedArray} RGBA gridW*gridH*4 of the latest frame */
    sample() {
      mctx.drawImage(video, 0, 0, mid.width, mid.height);
      ctx.drawImage(mid, 0, 0, gridW, gridH);
      return ctx.getImageData(0, 0, gridW, gridH).data;
    },
  };
}
