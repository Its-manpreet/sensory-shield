// OWNER: Agent A. Overlay renderer: capture -> flash detector (every frame) -> regions -> effects.
// Frames live in memory only. (Content detection is removed for now; see git tag vision-v1.)
import { createFlashDetector } from '../engine/flash.js';
import { activeProfile } from '../shared/profiles.js';
import { getSettings, onChange } from '../shared/store.js';
import { createEffects } from './effects.js';
import { toRegions } from './regions.js';
import { startCapture, createSampler } from './capture.js';

const video = /** @type {HTMLVideoElement} */ (document.getElementById('capture'));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fx'));
const params = new URLSearchParams(location.search);
const selftest = params.has('selftest');
const debug = params.has('debug');
const log = (...a) => console.log('[shield]', ...a);

let settings = await getSettings();
let profile = activeProfile(settings);
const effects = createEffects(canvas, video, { fadeMs: profile.response.fadeMs, ...settings.appearance });
effects.setLabelsVisible(profile.response.showLabel);
let flash = createFlashDetector({ ...profile.flash });
const sampler = createSampler(video);
let captureState = 'starting'; // 'starting' | 'ok' | 'denied'

function applySettings(s) {
  const prevFlash = JSON.stringify(profile.flash);
  settings = s;
  profile = activeProfile(s);
  if (JSON.stringify(profile.flash) !== prevFlash) flash = createFlashDetector({ ...profile.flash });
  effects.setStyle({ fadeMs: profile.response.fadeMs, ...s.appearance });
  effects.setLabelsVisible(profile.response.showLabel);
  if (!s.enabled) effects.clear();
}
onChange(applySettings);
window.shield?.onReveal(({ ms }) => effects.revealAll(ms));
window.shield?.onToggle(({ enabled }) => applySettings({ ...settings, enabled }));

// --- stats (counts only) ---
const stats = { frames: 0, flashMs: 0, since: performance.now() };
setInterval(() => {
  const now = performance.now();
  const secs = (now - stats.since) / 1000;
  const out = {
    fps: stats.frames / secs,
    flashMs: stats.frames ? stats.flashMs / stats.frames : 0,
    modelMs: 0, // no content model for now
    modelHz: 0,
    device: 'off',
    capture: captureState,
  };
  window.shield?.sendStats(out);
  if (selftest) log('stats', JSON.stringify(out));
  // `npm run app:debug`: what the flash detector saw this second (numbers only, never pixels)
  if (debug && flash.diagnostics) {
    const d = flash.diagnostics();
    log(`flash fps=${out.fps.toFixed(0)} maxFlashes/s=${d.maxFlashes} flashingArea=${(100 * d.maxFlashingFraction).toFixed(1)}% (needs ${100 * d.minAreaFraction}%) motion=${(100 * d.movingShare).toFixed(0)}% regions=${flashEvents.length}`);
  }
  Object.assign(stats, { frames: 0, flashMs: 0, since: now });
}, 1000);

// --- per-frame loop ---
let flashEvents = [];
let lastRegions = [];
let lastFrameAt = 0;
// If the capture delivers no new frame (some capturers pause on a static screen, e.g. the dark gap of a
// strobe), keep the last protection this long, like the detector's own still rule, then let it go.
const NO_FRAME_KEEP_MS = 400;

function onFrame(now) {
  video.requestVideoFrameCallback(onFrame);
  if (!settings.enabled) return;
  stats.frames++;
  const data = sampler.sample();
  const t0 = performance.now();
  flashEvents = profile.flash.enabled ? flash.push({ data, tMs: now }) : [];
  stats.flashMs += performance.now() - t0;
  lastRegions = toRegions(flashEvents, profile);
  lastFrameAt = now;
  effects.setRegions(lastRegions, now);
}

// Effects redraw on every display frame so fades stay smooth even when the capture is idle.
function onAnimationFrame(now) {
  requestAnimationFrame(onAnimationFrame);
  const sinceFrame = now - lastFrameAt;
  if (settings.enabled && lastRegions.length && sinceFrame > 50 && sinceFrame < NO_FRAME_KEEP_MS) effects.setRegions(lastRegions, now);
  effects.draw(now);
}

try {
  await startCapture(video);
  captureState = 'ok';
  log(`capture started ${video.videoWidth}x${video.videoHeight}, window ${innerWidth}x${innerHeight} @${devicePixelRatio}x`);
  video.requestVideoFrameCallback(onFrame);
  requestAnimationFrame(onAnimationFrame);
} catch (err) {
  captureState = 'denied';
  log(`capture failed: ${err?.name} ${err?.message}`);
}

if (selftest) {
  log(`window ${screenX},${screenY} ${innerWidth}x${innerHeight} vs screen ${screen.width}x${screen.height} @${devicePixelRatio}x`);
  log(`SELFTEST overlay ok: profile=${settings.activeProfileId}`);
}
if (params.has('spike')) (await import('./spike.js')).runSpike(video, canvas, log);
