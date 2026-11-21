// OWNER: Agent A. Overlay renderer: capture -> sensory detectors -> regions -> effects. Frames live in memory only.
//   every frame: flashes + red flashes + red/blue colour flicker (64x36)
//   every 50 ms: loudness of the sound playing (system audio) -> system volume turned down when needed
// (Content detection is removed for now; see git tag vision-v1.)
import { createFlashDetector } from '../engine/flash.js';
import { createLoudnessGuard } from '../engine/loudness.js';
import { activeProfile } from '../shared/profiles.js';
import { getSettings, onChange } from '../shared/store.js';
import { createEffects } from './effects.js';
import { toRegions } from './regions.js';
import { startCapture, createSampler, createSoundMeter } from './capture.js';

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
const flashConfig = (p, s) => ({ ...p.flash, colorFlicker: s.sensory?.colorFlicker ?? true });
let flash = createFlashDetector(flashConfig(profile, settings));
const sampler = createSampler(video);
let captureState = 'starting'; // 'starting' | 'ok' | 'denied'

function applySettings(s) {
  const prevFlash = JSON.stringify(flashConfig(profile, settings));
  settings = s;
  profile = activeProfile(s);
  if (JSON.stringify(flashConfig(profile, s)) !== prevFlash) flash = createFlashDetector(flashConfig(profile, s));
  effects.setStyle({ fadeMs: profile.response.fadeMs, ...s.appearance });
  effects.setLabelsVisible(profile.response.showLabel);
  if (!s.enabled) effects.clear();
}
onChange(applySettings);
window.shield?.onReveal(({ ms }) => effects.revealAll(ms));
window.shield?.onToggle(({ enabled }) => applySettings({ ...settings, enabled }));

// --- stats (counts only) ---
const stats = { frames: 0, flashMs: 0, engineMs: 0, since: performance.now() };
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
    sound: soundState, // 'off' | 'on' | 'unavailable'
    soundCutDb: lastGainDb, // how far below the user's volume right now (0 = untouched)
    engineMs: stats.frames ? stats.engineMs / stats.frames : 0, // all sensory detectors, per frame
  };
  window.shield?.sendStats(out);
  if (selftest) log('stats', JSON.stringify(out));
  // `npm run app:debug`: what the flash detector saw this second (numbers only, never pixels)
  if (debug && flash.diagnostics) {
    const d = flash.diagnostics();
    log(`flash fps=${out.fps.toFixed(0)} maxFlashes/s=${d.maxFlashes} flashingArea=${(100 * d.maxFlashingFraction).toFixed(1)}% (needs ${100 * d.minAreaFraction}%) motion=${(100 * d.movingShare).toFixed(0)}% regions=${flashEvents.length}`);
  }
  Object.assign(stats, { frames: 0, flashMs: 0, engineMs: 0, since: now });
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
  const frame = { data, tMs: now };
  const sens = settings.sensory ?? {};
  // one detector serves three independent switches: flashing, red flashes, red/blue colour flicker
  const flashOn = profile.flash.enabled || profile.flash.detectRed || sens.colorFlicker;
  flashEvents = flashOn ? flash.push(frame) : [];
  stats.flashMs += performance.now() - t0;
  stats.engineMs += performance.now() - t0;
  lastRegions = toRegions(flashEvents, profile, sens);
  lastFrameAt = now;
  // new protection is drawn right here, in the frame that detected it, instead of on the next display frame
  if (effects.setRegions(lastRegions, now)) effects.draw(performance.now());
}

// Effects redraw on every display frame so fades stay smooth even when the capture is idle.
function onAnimationFrame(now) {
  requestAnimationFrame(onAnimationFrame);
  const sinceFrame = now - lastFrameAt;
  if (settings.enabled && lastRegions.length && sinceFrame > 50 && sinceFrame < NO_FRAME_KEEP_MS) effects.setRegions(lastRegions, now);
  effects.draw(now);
}

// --- sound: loudness of what is playing -> how far to turn the system volume down (main applies it) ---
let soundState = 'off';
let lastGainDb = 0;
const loudnessConfig = (s) => ({ limiter: !!s.sensory?.loudLimiter, leveling: !!s.sensory?.loudLeveling, softStart: !!s.sensory?.softStart });
let loudness = createLoudnessGuard(loudnessConfig(settings));
let loudnessKey = JSON.stringify(loudnessConfig(settings));
async function startSound(stream) {
  let meter = null;
  try {
    meter = await createSoundMeter(stream);
  } catch (err) {
    log(`sound meter unavailable: ${err?.message ?? err}`);
  }
  if (!meter) return void (soundState = 'unavailable');
  soundState = 'on';
  let lastSent = 0;
  meter.onLevel((levelNow, now) => {
    const key = JSON.stringify(loudnessConfig(settings));
    if (key !== loudnessKey) (loudness = createLoudnessGuard(loudnessConfig(settings))), (loudnessKey = key);
    const anyOn = settings.enabled && (settings.sensory?.loudLimiter || settings.sensory?.loudLeveling || settings.sensory?.softStart);
    const { gainDb } = anyOn ? loudness.push({ levelDb: levelNow, tMs: now }) : { gainDb: 0 };
    // send on a real change (0.5 dB), and at least twice a second while turned down
    if (Math.abs(gainDb - lastGainDb) >= 0.5 || (gainDb < 0 && now - lastSent > 500) || (gainDb === 0 && lastGainDb !== 0)) {
      window.shield?.sendAudioGain(gainDb);
      if ((selftest || debug) && Math.abs(gainDb - lastGainDb) >= 0.5) log(`sound: level ${levelNow.toFixed(0)} dBFS -> volume ${gainDb < 0 ? `down ${(-gainDb).toFixed(1)} dB` : 'back to yours'}`);
      lastSent = now;
      lastGainDb = gainDb;
    }
  });
}

try {
  const stream = await startCapture(video);
  startSound(stream); // async: the audio worklet loads in the background
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
