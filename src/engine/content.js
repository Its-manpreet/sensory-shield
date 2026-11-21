// OWNER: Agent C. Content detector. Contract: docs/INTERFACES.md section 2.
// Backend: LFM3-VL-2B, a small vision-language model run on this device by a bundled llama.cpp server
// (src/main/vision.js). The user's blocklist can be any words ("spiders", "gore", "clowns", "cartoon").
// One check: the screen is sent as an in-memory JPEG over IPC; the model proposes boxes, each box is
// re-checked on a crop, and the confirmed boxes come back as TileResults whose rect IS the box.
// Never stored, never sent off the device.

export const DEFAULT_CONTENT_CONFIG = Object.freeze({
  device: 'webgpu', // contract field; the vision model picks Metal / Vulkan / CPU itself
  modelId: 'LFM3-VL-2B',
  localModelPath: 'models/lfm3-vl/',
  tilesX: 4,
  tilesY: 3,
});

const SEND_WIDTH = 1600; // screenshot width sent to the model process (crops come from this)
const KEEP_MISSES = 1; // keep a detection through this many checks that miss it (no flicker on one miss)

/**
 * Triggers to embed for a profile (additive export, not in the frozen contract).
 * @param {import('../shared/types.js').Profile} profile
 * @returns {import('../shared/types.js').Trigger[]}
 */
export function triggersForProfile(profile) {
  const labels = [...profile.content.categories, ...profile.content.customTriggers];
  return labels.map((label) => ({ id: label, label, prompts: [label], threshold: profile.content.threshold }));
}

/**
 * Give detections stable ids across checks (so the blur does not fade out and back in when a box moves a
 * little) and keep a detection through one missed check.
 * @param {{ key: string, id: string, label: string, box: any, misses: number }[]} previous
 * @param {{ id: string, label: string, box: any }[]} found
 */
export function trackDetections(previous, found, nextKey) {
  const out = [];
  const used = new Set();
  for (const f of found) {
    let best = null, bestIou = 0.2;
    for (const p of previous) {
      if (used.has(p) || p.id !== f.id) continue;
      const v = iou(p.box, f.box);
      if (v > bestIou) (best = p), (bestIou = v);
    }
    if (best) used.add(best);
    out.push({ key: best?.key ?? nextKey(), id: f.id, label: f.label, box: f.box, misses: 0 });
  }
  for (const p of previous) if (!used.has(p) && p.misses < KEEP_MISSES) out.push({ ...p, misses: p.misses + 1 });
  return out;
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/**
 * @param {Partial<import('../shared/types.js').ContentConfig>} [config]
 */
export async function createContentDetector(config = {}) {
  const cfg = { ...DEFAULT_CONTENT_CONFIG, ...config };
  const shield = globalThis.window?.shield;
  let terms = [];
  let classify = true;
  let tracked = [];
  let counter = 0;
  const canvas = new OffscreenCanvas(SEND_WIDTH, Math.round((SEND_WIDTH * 9) / 16));
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));

  const results = () =>
    tracked.map((t) => ({ id: `content-${t.key}`, rect: t.box, triggerId: t.id, label: t.label, score: t.misses ? 0.5 : 1 }));

  return {
    async init() {
      if (!shield?.visionStart) throw new Error('vision model needs the Electron app (window.shield)');
      const r = await shield.visionStart();
      if (!r.ok) throw new Error(r.error);
      return { device: r.device, modelId: r.modelId, loadMs: r.loadMs };
    },
    /** @param {import('../shared/types.js').Trigger[]} triggers */
    async setTriggers(triggers) {
      terms = triggers.map((t) => ({ id: t.id, label: t.label }));
      // sensitivity: a lower threshold (higher sensitivity) trusts the first pass; otherwise every box is
      // re-checked on a crop, which removes most false alarms
      classify = (triggers[0]?.threshold ?? 0.6) >= 0.35;
      tracked = tracked.filter((t) => terms.some((x) => x.id === t.id));
    },
    /**
     * @param {ImageBitmap | HTMLCanvasElement | ImageData} frame
     * @param {boolean[]} [changedTiles]  all false: nothing changed, reuse the last answer
     * @returns {Promise<import('../shared/types.js').TileResult[]>}
     */
    async scoreTiles(frame, changedTiles) {
      if (!terms.length) return (tracked = []), [];
      if (changedTiles && !changedTiles.some(Boolean)) return results();
      const fw = frame.width, fh = frame.height;
      canvas.width = Math.min(SEND_WIDTH, fw);
      canvas.height = Math.round((canvas.width * fh) / fw);
      if (frame instanceof ImageData) ctx.putImageData(frame, 0, 0);
      else ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const { detections } = await shield.visionAnalyze(jpeg, terms, classify);
      tracked = trackDetections(tracked, detections, () => String(++counter));
      return results();
    },
    dispose() {
      tracked = [];
    },
  };
}
