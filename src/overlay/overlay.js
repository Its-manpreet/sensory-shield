// OWNER: Agent A. Overlay renderer: capture -> flash detector (every frame) + content detector (2-4 Hz,
// changed tiles only) -> regions -> effects. Frames live in memory only.
import { createFlashDetector } from '../engine/flash.js';
import { createContentDetector, triggersForProfile } from '../engine/content.js';
import { activeProfile } from '../shared/profiles.js';
import { getSettings, onChange } from '../shared/store.js';
import { createEffects } from './effects.js';
import { toRegions, setRevealHint } from './regions.js';
import { startCapture, createSampler } from './capture.js';
import { trackBox, moveBox } from './box-motion.js';

// A vision-model check takes ~1-2 s; checks run back to back while the screen keeps changing, at most this often.
const CONTENT_INTERVAL_MS = 500;
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
let contentInfo = { device: 'off', modelId: '', loadMs: 0 };
let contentLoading = null;
let captureState = 'starting'; // 'starting' | 'ok' | 'denied'
let lastTiles = [];
let contentBusy = false;
let lastContentAt = 0;
let forceAllTiles = false;

/** the vision model is large (~1.3 GB in memory): load it only once content protection has something to do */
const wantsContent = (p) => p.content.enabled && triggersForProfile(p).length > 0;

function loadContent() {
  if (content || contentLoading) return;
  contentInfo = { device: 'loading', modelId: '', loadMs: 0 };
  contentLoading = (async () => {
    try {
      const det = await createContentDetector({ ...TILES });
      contentInfo = await det.init();
      await det.setTriggers(triggersForProfile(profile));
      content = det;
      forceAllTiles = true;
      log(`content detector ready: ${contentInfo.device} ${contentInfo.modelId} in ${Math.round(contentInfo.loadMs)} ms`);
    } catch (err) {
      contentInfo = { device: 'failed', modelId: '', loadMs: 0 };
      log(`content detector unavailable, flash protection only: ${err?.message ?? err}`);
    } finally {
      contentLoading = null;
    }
  })();
}

function applySettings(s) {
  const prevFlash = JSON.stringify(profile.flash);
  const prevTriggers = JSON.stringify(triggersForProfile(profile));
  settings = s;
  profile = activeProfile(s);
  if (JSON.stringify(profile.flash) !== prevFlash) flash = createFlashDetector({ ...profile.flash });
  const triggers = triggersForProfile(profile);
  if (wantsContent(profile)) if (wantsContent(profile)) loadContent();
  if (content && JSON.stringify(triggers) !== prevTriggers) {
    // a removed trigger stops blurring at once; new ones are checked on the next pass
    lastTiles = lastTiles.filter((t) => triggers.some((x) => x.id === t.triggerId));
    content.setTriggers(triggers).catch((e) => log('setTriggers failed', e));
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
window.shield?.onCursor?.((p) => effects.setCursor(p));
window.shield?.getStatus?.().then(({ hotkeys, platform }) => {
  const mac = platform === 'darwin';
  setRevealHint((hotkeys?.reveal ?? '').replace('CommandOrControl+', mac ? '⌘' : 'Ctrl+').replace('Alt+', mac ? '⌥' : 'Alt+'));
});
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
    // static screen: no model run at all (the first call and forced re-checks report every tile changed)
    if (changed.some(Boolean)) {
      const t0 = performance.now();
      const bitmap = await createImageBitmap(video);
      const snapshot = sampler.gray(); // the screen as the model will see it
      content.syncTiles?.(lastTiles);
      const found = await content.scoreTiles(bitmap, changed);
      // the screen may have scrolled during the ~1 s check: move the new boxes by what their content did since
      lastTiles = found.map((t) => {
        if (!t.triggerId) return t;
        const d = trackBox(snapshot, sampler.gray(), sampler.grayWidth, sampler.grayHeight, t.rect, 72, 36);
        const rect = d ? moveBox(t.rect, d) : t.rect;
        return rect ? { ...t, rect } : null;
      }).filter(Boolean);
      if (debug) log(`content check ${Math.round(performance.now() - t0)} ms: ${lastTiles.map((t) => t.label).join(', ') || 'nothing found'}`);
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

/** between vision checks, each blur box follows its content (scrolling, moving windows) */
function followContent(prev, cur) {
  if (!lastTiles.length || prev.length !== cur.length) return;
  lastTiles = lastTiles
    .map((t) => {
      if (!t.triggerId) return t;
      const d = trackBox(prev, cur, sampler.grayWidth, sampler.grayHeight, t.rect, 24, 12);
      if (!d || (d.dx === 0 && d.dy === 0)) return t;
      const rect = moveBox(t.rect, d);
      return rect ? { ...t, rect } : null;
    })
    .filter(Boolean);
}

function onFrame(now) {
  video.requestVideoFrameCallback(onFrame);
  if (!settings.enabled) return;
  stats.frames++;
  const prevGray = sampler.gray();
  const data = sampler.sample();
  followContent(prevGray, sampler.gray());
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
if (wantsContent(profile)) loadContent();

if (selftest) {
  log(`window ${screenX},${screenY} ${innerWidth}x${innerHeight} vs screen ${screen.width}x${screen.height} @${devicePixelRatio}x`);
  log(`SELFTEST overlay ok: profile=${settings.activeProfileId}`);
}
if (params.has('spike')) (await import('./spike.js')).runSpike(video, canvas, log);
