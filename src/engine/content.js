// OWNER: Agent C. Picture content detector (docs/INTERFACES.md section 2), on-device, WebGPU first.
//   - MobileCLIP-S0 (Xenova/mobileclip_s0): each screen tile vs. short descriptions of the triggers and of
//     ordinary content (src/engine/categories.js). ~6 ms per tile on an M5 (no gain from batching).
//   - NudeNet v3.4 320n (YOLOv8n, AGPL-3.0): boxes of exposed body parts over the whole screen, ~15 ms at
//     960x640. Tight boxes for the most important child-safety case.
// Frames are read from the capture element straight into small canvases: memory only, never stored or sent.
import { AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, Tensor } from '@huggingface/transformers';
import { setupRuntime, gpu } from './runtime.js';
import { SAFE_PROMPTS, decide } from './categories.js';

const CLIP_ID = 'Xenova/mobileclip_s0';
const CLIP_SIZE = 256;
const BATCH = 4;
// NudeNet: whole screen letterboxed into NUDE_W x NUDE_H (multiples of 32; the model takes any size)
const NUDE_W = 960;
const NUDE_H = 640;
const NUDE_LABELS = [
  'FEMALE_GENITALIA_COVERED', 'FACE_FEMALE', 'BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED',
  'MALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'FEET_EXPOSED', 'BELLY_COVERED', 'FEET_COVERED', 'ARMPITS_COVERED',
  'ARMPITS_EXPOSED', 'FACE_MALE', 'BELLY_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_COVERED', 'FEMALE_BREAST_COVERED',
  'BUTTOCKS_COVERED',
];
const EXPLICIT = new Set([2, 3, 4, 6, 14]); // exposed buttocks, female breast, genitalia (f/m), anus

/** @typedef {import('../shared/types.js').Rect} Rect */
/** @typedef {import('./categories.js').Trigger} Trigger */

/**
 * @param {{ modelsUrl: string, tilesX?: number, tilesY?: number, nudity?: boolean }} config
 */
export async function createContentDetector(config) {
  const tilesX = config.tilesX ?? 4, tilesY = config.tilesY ?? 3;
  let tokenizer, textModel, visionModel, nudeSession, rt;
  /** @type {Trigger[]} */
  let triggers = [];
  /** @type {Float32Array|null} normalized embeddings of all prompts (trigger prompts, then SAFE), row-major */
  let promptEmb = null;
  let dim = 0;
  /** @type {Map<string, Float32Array>} cache: prompt -> normalized embedding */
  const embCache = new Map();

  const cropCanvas = new OffscreenCanvas(CLIP_SIZE, CLIP_SIZE * BATCH);
  const cropCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (cropCanvas.getContext('2d', { willReadFrequently: true }));
  const nudeCanvas = new OffscreenCanvas(NUDE_W, NUDE_H);
  const nudeCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (nudeCanvas.getContext('2d', { willReadFrequently: true }));

  const srcSize = (src) => [src.videoWidth ?? src.width, src.videoHeight ?? src.height];
  const timing = { prepMs: 0, waitMs: 0, runMs: 0 };

  async function embedTexts(texts) {
    const todo = [...new Set(texts.filter((t) => !embCache.has(t)))];
    for (let i = 0; i < todo.length; i += 32) {
      const batch = todo.slice(i, i + 32);
      const { text_embeds } = await gpu(() => textModel(tokenizer(batch, { padding: 'max_length', truncation: true })));
      const d = text_embeds.dims[1];
      batch.forEach((t, r) => embCache.set(t, normalize(Float32Array.from(text_embeds.data.slice(r * d, (r + 1) * d), Number))));
    }
    return texts.map((t) => embCache.get(t));
  }

  /**
   * CLIP-score crops of `src` (video or canvas). rects are normalized. Returns one decision per rect.
   * @param {CanvasImageSource} src @param {Rect[]} rects
   * @param {{ stop?: () => void }} [opts]  stop: called before each batch of 4; it may throw to end the call early
   */
  async function scoreRects(src, rects, { stop } = {}) {
    if (!promptEmb || !triggers.length) return rects.map(() => ({ triggerId: null, label: null, score: 0 }));
    const [sw, sh] = srcSize(src);
    const out = [];
    for (let i = 0; i < rects.length; i += BATCH) {
      stop?.();
      const tPrep = performance.now();
      const batch = rects.slice(i, i + BATCH);
      batch.forEach((r, k) => cropCtx.drawImage(src, r.x * sw, r.y * sh, Math.max(1, r.w * sw), Math.max(1, r.h * sh), 0, k * CLIP_SIZE, CLIP_SIZE, CLIP_SIZE));
      const px = cropCtx.getImageData(0, 0, CLIP_SIZE, CLIP_SIZE * batch.length).data;
      const n = CLIP_SIZE * CLIP_SIZE;
      const data = new Float32Array(batch.length * 3 * n);
      for (let k = 0; k < batch.length; k++) {
        const base = k * 3 * n;
        for (let p = 0; p < n; p++) {
          const q = (k * n + p) * 4;
          data[base + p] = px[q] / 255; // MobileCLIP: rescale only, no mean/std normalization
          data[base + n + p] = px[q + 1] / 255;
          data[base + 2 * n + p] = px[q + 2] / 255;
        }
      }
      const tQueue = performance.now();
      timing.prepMs += tQueue - tPrep;
      let tRun = 0;
      const { image_embeds } = await gpu(() => ((tRun = performance.now()), visionModel({ pixel_values: new Tensor('float32', data, [batch.length, 3, CLIP_SIZE, CLIP_SIZE]) })));
      timing.waitMs += tRun - tQueue;
      timing.runMs += performance.now() - tRun;
      const d = image_embeds.dims[1];
      const nPrompts = promptEmb.length / dim;
      for (let k = 0; k < batch.length; k++) {
        const img = normalize(Float32Array.from(image_embeds.data.slice(k * d, (k + 1) * d), Number));
        const sims = new Float32Array(nPrompts);
        for (let j = 0; j < nPrompts; j++) {
          let s = 0;
          for (let c = 0; c < dim; c++) s += img[c] * promptEmb[j * dim + c];
          sims[j] = s;
        }
        out.push(decide(sims, triggers));
      }
    }
    return out;
  }

  /** the fixed tile grid, normalized */
  const tiles = [];
  for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) tiles.push({ x: tx / tilesX, y: ty / tilesY, w: 1 / tilesX, h: 1 / tilesY });

  return {
    tiles,
    /** @returns {Promise<{ device: string, modelId: string, loadMs: number }>} */
    async init() {
      const t0 = performance.now();
      rt = await setupRuntime(config.modelsUrl);
      const opts = { device: rt.device, dtype: rt.dtype };
      tokenizer = await AutoTokenizer.from_pretrained(CLIP_ID);
      textModel = await gpu(() => CLIPTextModelWithProjection.from_pretrained(CLIP_ID, opts));
      visionModel = await gpu(() => CLIPVisionModelWithProjection.from_pretrained(CLIP_ID, opts));
      if (config.nudity !== false) {
        nudeSession = await gpu(() =>
          rt.ort.InferenceSession.create(new URL('nudenet/320n.onnx', rt.modelsUrl).href, {
            executionProviders: rt.device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
          }),
        );
      }
      return { device: rt.device, modelId: `${CLIP_ID} + nudenet-320n`, loadMs: performance.now() - t0 };
    },

    /** @param {Trigger[]} next  embeds the prompts once (cached per prompt) */
    async setTriggers(next) {
      const prompts = [...next.flatMap((t) => t.prompts), ...SAFE_PROMPTS];
      const embs = await embedTexts(prompts);
      dim = embs[0].length;
      const flat = new Float32Array(prompts.length * dim);
      embs.forEach((e, i) => flat.set(e, i * dim));
      promptEmb = flat;
      triggers = next;
    },

    /**
     * Contract: score the tile grid (only changed tiles when changedTiles is given; others come back safe
     * with score -1 so the caller keeps its previous result).
     * @param {CanvasImageSource} frame @param {boolean[]} [changedTiles]
     * @returns {Promise<import('../shared/types.js').TileResult[]>}
     */
    async scoreTiles(frame, changedTiles) {
      const idx = tiles.map((_, i) => i).filter((i) => !changedTiles || changedTiles[i]);
      const res = await scoreRects(frame, idx.map((i) => tiles[i]));
      const out = tiles.map((rect) => ({ rect, triggerId: null, label: null, score: -1 }));
      idx.forEach((i, k) => (out[i] = { rect: tiles[i], ...res[k] }));
      return out;
    },

    scoreRects,

    /**
     * Exposed body parts over the whole frame.
     * @param {CanvasImageSource} frame
     * @param {{ minScore?: number }} [opts]
     * @returns {Promise<{ rect: Rect, score: number, part: string }[]>}
     */
    async detectNudity(frame, { minScore = 0.35 } = {}) {
      if (!nudeSession) return [];
      const [sw, sh] = srcSize(frame);
      // letterbox: keep the aspect ratio, pad right/bottom with black (as NudeNet does)
      const s = Math.min(NUDE_W / sw, NUDE_H / sh);
      const dw = Math.round(sw * s), dh = Math.round(sh * s);
      nudeCtx.fillStyle = '#000';
      nudeCtx.fillRect(0, 0, NUDE_W, NUDE_H);
      nudeCtx.drawImage(frame, 0, 0, dw, dh);
      const px = nudeCtx.getImageData(0, 0, NUDE_W, NUDE_H).data;
      const n = NUDE_W * NUDE_H;
      const data = new Float32Array(3 * n);
      for (let p = 0; p < n; p++) {
        data[p] = px[p * 4] / 255;
        data[n + p] = px[p * 4 + 1] / 255;
        data[2 * n + p] = px[p * 4 + 2] / 255;
      }
      const out = await gpu(() => nudeSession.run({ [nudeSession.inputNames[0]]: new rt.ort.Tensor('float32', data, [1, 3, NUDE_H, NUDE_W]) }));
      const o = out[nudeSession.outputNames[0]];
      const [, rows, anchors] = o.dims; // [1, 4 + classes, anchors]
      const d = o.data;
      const found = [];
      for (let a = 0; a < anchors; a++) {
        let best = 0, cls = -1;
        for (let c = 4; c < rows; c++) {
          const v = d[c * anchors + a];
          if (v > best) (best = v), (cls = c - 4);
        }
        if (best < minScore || !EXPLICIT.has(cls)) continue;
        const cx = d[a], cy = d[anchors + a], w = d[2 * anchors + a], h = d[3 * anchors + a];
        found.push({ rect: clampRect({ x: (cx - w / 2) / dw, y: (cy - h / 2) / dh, w: w / dw, h: h / dh }), score: best, part: NUDE_LABELS[cls] });
      }
      return nms(found, 0.45);
    },

    /** where picture-check time went since the last call (ms): preprocessing, waiting for the GPU queue, model */
    timing() {
      const t = { ...timing };
      Object.assign(timing, { prepMs: 0, waitMs: 0, runMs: 0 });
      return t;
    },
    get device() {
      return rt?.device ?? 'off';
    },
    dispose() {
      visionModel?.dispose?.();
      textModel?.dispose?.();
      nudeSession?.release?.();
    },
  };
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const k = 1 / Math.sqrt(s || 1);
  for (let i = 0; i < v.length; i++) v[i] *= k;
  return v;
}

function clampRect(r) {
  const x = Math.max(0, Math.min(1, r.x)), y = Math.max(0, Math.min(1, r.y));
  return { x, y, w: Math.max(0, Math.min(1 - x, r.w + Math.min(0, r.x))), h: Math.max(0, Math.min(1 - y, r.h + Math.min(0, r.y))) };
}

export function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i || 1);
}

function nms(boxes, th) {
  boxes.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of boxes) if (keep.every((k) => iou(k.rect, b.rect) < th)) keep.push(b);
  return keep;
}
