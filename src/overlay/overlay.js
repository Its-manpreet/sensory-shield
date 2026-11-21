// OWNER: Agent A. Overlay renderer: capture -> flash detector (every frame) + content detector (2-4 Hz,
// changed tiles only) -> regions -> effects. Frames live in memory only.
import { createFlashDetector } from '../engine/flash.js';
import { createContentDetector, triggersForProfile } from '../engine/content.js';
import { activeProfile } from '../shared/profiles.js';
import { getSettings, onChange } from '../shared/store.js';
import { createEffects } from './effects.js';
import { toRegions } from './regions.js';
import { startCapture, createSampler } from './capture.js';

const CONTENT_INTERVAL_MS = 333; // about 3 checks per second
const TILES = { tilesX: 4, tilesY: 3 };

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
const sampler = createSampler(video, TILES);

// --- content detector: optional. If it fails, flash protection keeps running. ---
let content = null;
let contentInfo = { device: 'loading', modelId: '', loadMs: 0 };
let captureState = 'starting'; // 'starting' | 'ok' | 'denied'
let lastTiles = [];
let contentBusy = false;
let lastContentAt = 0;
let forceAllTiles = false;

async function loadContent() {
  try {
    const det = await createContentDetector({ ...TILES });
    contentInfo = await det.init();
    await det.setTriggers(triggersForProfile(profile));
    content = det;
    log(`content detector ready: ${contentInfo.device} ${contentInfo.modelId} in ${Math.round(contentInfo.loadMs)} ms`);
  } catch (err) {
    contentInfo = { device: 'failed', modelId: '', loadMs: 0 };
    log(`content detector unavailable, flash protection only: ${err?.message ?? err}`);
  }
}

function applySettings(s) {
  const prevFlash = JSON.stringify(profile.flash);
  const prevTriggers = JSON.stringify(triggersForProfile(profile));
  settings = s;
  profile = activeProfile(s);
  if (JSON.stringify(profile.flash) !== prevFlash) flash = createFlashDetector({ ...profile.flash });
  const triggers = triggersForProfile(profile);
  if (content && JSON.stringify(triggers) !== prevTriggers) {
    content.setTriggers(triggers).then(() => (lastTiles = []), (e) => log('setTriggers failed', e));
    lastContentAt = 0; // re-check right away with all tiles
    sampler.changedTiles(); // reset baseline; next check is forced below
    forceAllTiles = true;
  }
  effects.setStyle({ fadeMs: profile.response.fadeMs, ...s.appearance });
  effects.setLabelsVisible(profile.response.showLabel);
  if (!s.enabled) effects.clear();
}
onChange(applySettings);
window.shield?.onReveal(({ ms }) => effects.revealAll(ms));
window.shield?.onToggle(({ enabled }) => applySettings({ ...settings, enabled }));

// --- stats (counts only) ---
const stats = { frames: 0, flashMs: 0, modelMs: 0, modelRuns: 0, since: performance.now() };
setInterval(() => {
  const now = performance.now();
  const secs = (now - stats.since) / 1000;
  const out = {
    fps: stats.frames / secs,
    flashMs: stats.frames ? stats.flashMs / stats.frames : 0,
    modelMs: stats.modelRuns ? stats.modelMs / stats.modelRuns : 0,
    modelHz: stats.modelRuns / secs,
    device: contentInfo.device,
    capture: captureState,
  };
  window.shield?.sendStats(out);
  if (selftest) log('stats', JSON.stringify(out));
  // `npm run app:debug`: what the flash detector saw this second (numbers only, never pixels)
  if (debug && flash.diagnostics) {
    const d = flash.diagnostics();
    log(`flash fps=${out.fps.toFixed(0)} maxFlashes/s=${d.maxFlashes} flashingArea=${(100 * d.maxFlashingFraction).toFixed(1)}% (needs ${100 * d.minAreaFraction}%) motion=${(100 * d.movingShare).toFixed(0)}% regions=${flashEvents.length}`);
  }
  Object.assign(stats, { frames: 0, flashMs: 0, modelMs: 0, modelRuns: 0, since: now });
}, 1000);

// --- per-frame loop ---
let flashEvents = [];
let lastRegions = [];
let lastFrameAt = 0;
// If the capture delivers no new frame (some capturers pause on a static screen, e.g. the dark gap of a
// strobe), keep the last protection this long, like the detector's own still rule, then let it go.
const NO_FRAME_KEEP_MS = 400;

async function checkContent(now) {
  contentBusy = true;
  lastContentAt = now;
  try {
    const changed = sampler.changedTiles();
    if (forceAllTiles) changed.fill(true), (forceAllTiles = false);
    if (changed.some(Boolean) || !lastTiles.length) {
      const t0 = performance.now();
      const bitmap = await createImageBitmap(video);
      lastTiles = await content.scoreTiles(bitmap, lastTiles.length ? changed : undefined);
      bitmap.close();
      stats.modelMs += performance.now() - t0;
      stats.modelRuns++;
    }
  } catch (err) {
    log('content check failed', err?.message ?? err);
  } finally {
    contentBusy = false;
  }
}

function onFrame(now) {
  video.requestVideoFrameCallback(onFrame);
  if (!settings.enabled) return;
  stats.frames++;
  const data = sampler.sample();
  const t0 = performance.now();
  flashEvents = profile.flash.enabled ? flash.push({ data, tMs: now }) : [];
  stats.flashMs += performance.now() - t0;

  if (content && profile.content.enabled && !contentBusy && now - lastContentAt >= CONTENT_INTERVAL_MS) checkContent(now);
  const tiles = content && profile.content.enabled ? lastTiles : [];
  lastRegions = toRegions(flashEvents, tiles, profile);
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
loadContent();

if (selftest) {
  log(`window ${screenX},${screenY} ${innerWidth}x${innerHeight} vs screen ${screen.width}x${screen.height} @${devicePixelRatio}x`);
  const t = await import('@huggingface/transformers');
  log(`SELFTEST overlay ok: profile=${settings.activeProfileId} transformers=${t.env.version}`);
}
if (params.has('spike')) (await import('./spike.js')).runSpike(video, canvas, log);
