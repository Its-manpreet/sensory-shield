// OWNER: Agent A. Overlay renderer: capture loop -> detectors -> regions -> effects.
// SCAFFOLD: wiring only. Agent A fills in capture (getDisplayMedia) and the frame loop at Step 1/2.
import { createFlashDetector } from '../engine/flash.js';
import { createContentDetector } from '../engine/content.js';
import { activeProfile } from '../shared/profiles.js';
import { getSettings, onChange } from '../shared/store.js';
import { createEffects } from './effects.js';
import { toRegions } from './regions.js';

const video = /** @type {HTMLVideoElement} */ (document.getElementById('capture'));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fx'));
const selftest = new URLSearchParams(location.search).has('selftest');

let settings = await getSettings();
const effects = createEffects(canvas, video);
const flash = createFlashDetector({ ...activeProfile(settings).flash });
const content = await createContentDetector({});
const info = await content.init();

onChange((s) => {
  settings = s;
  effects.setLabelsVisible(activeProfile(s).response.showLabel);
});
window.shield?.onReveal(({ ms }) => effects.revealAll(ms));
window.shield?.onToggle(({ enabled }) => {
  if (!enabled) effects.setRegions([], performance.now());
});

// TODO(Agent A, Step 1): navigator.mediaDevices.getDisplayMedia({ video: true }) -> video.srcObject,
// then a requestVideoFrameCallback loop: 64x36 frame -> flash.push(); every 250-500 ms changed tiles -> content.scoreTiles().
const events = flash.push({ data: new Uint8ClampedArray(64 * 36 * 4), tMs: performance.now() });
const tiles = await content.scoreTiles(new ImageData(4, 3));
effects.setRegions(toRegions(events, tiles, activeProfile(settings)), performance.now());

if (selftest) {
  const t = await import('@huggingface/transformers');
  console.log(`SELFTEST overlay ok: profile=${settings.activeProfileId} content=${info.device} regions=0 transformers=${t.env.version}`);
}
