// Guardian camera loop: webcam -> 32x24 grid (in memory) -> seizure detector -> level sent to main.
// Only the level, progress and a few numbers leave this window. Pixels never do.
import { createSeizureDetector, SEIZURE_DEFAULTS } from '../engine/seizure.js';

const FPS = 15;
const { gridW: W, gridH: H } = SEIZURE_DEFAULTS;
const shield = window.shield;

const video = document.getElementById('cam');
const canvas = new OffscreenCanvas(W, H);
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let detector = createSeizureDetector();
let lastSent = 0;
let lastLevel = '';

let configKey = '';
shield.onGuardianConfig((config) => {
  // minDurationSec plus the tuning sliders; rebuild only when something changed (a rebuild re-warms the history)
  const key = JSON.stringify(config);
  if (key !== configKey) (configKey = key), (detector = createSeizureDetector(config));
});
shield.onGuardianReset(() => detector.reset());

function report(s, force = false) {
  const now = performance.now();
  if (!force && s.level === lastLevel && now - lastSent < 500) return;
  lastSent = now;
  lastLevel = s.level;
  shield.sendGuardianState({ camera: 'ok', level: s.level, progress: s.progress, freqHz: s.freqHz, dark: s.dark, motion: s.motion, rhythm: s.rhythm, path: s.path });
}

try {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, frameRate: { ideal: FPS } }, audio: false });
  video.srcObject = stream;
  await video.play();
  stream.getVideoTracks()[0].addEventListener('ended', () => shield.sendGuardianState({ camera: 'unavailable', level: 'normal', progress: 0, dark: false }));
  console.log(`camera on: ${video.videoWidth}x${video.videoHeight}`);
  setInterval(() => {
    if (video.readyState < 2) return;
    ctx.drawImage(video, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    report(detector.push({ data, tMs: performance.now() }));
  }, 1000 / FPS);
} catch (err) {
  const denied = err?.name === 'NotAllowedError';
  console.warn(`camera unavailable: ${err?.name} ${err?.message}`);
  shield.sendGuardianState({ camera: denied ? 'denied' : 'unavailable', level: 'normal', progress: 0, dark: false });
}
