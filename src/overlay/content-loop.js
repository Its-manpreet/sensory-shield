// OWNER: Agent A. Child-safety content loop in the overlay: decides WHEN to look and WHAT to re-check, and
// turns results into blur regions. The models live in src/engine (content.js: pictures, text-safety.js: text).
//
// Pictures (target 100-200 ms from appearing on screen to blurred):
//   PAGES (a plain background on screen): every check splits the screen into pictures (connected areas of
//      solid picture content on an 11 x 13 px cell grid; letters never fill a 4 x 4 block, so text is never a
//      picture, and thumbnails 10 px apart stay separate) and judges each picture as a tight crop of itself
//      (cached by content: an unchanged or scrolled picture is not scored again). The cover is exactly the
//      flagged pictures, cut at their pixel-exact border; a picture that is gone or no longer matches is
//      uncovered in that check. Words are never judged, so they never cause a blur.
//   NO PAGE (full-screen video / photo) and the nudity detector: changed tiles are scored (words painted over
//      first), hits become free-form panes (src/engine/shape-mask.js) that are re-checked in small windows
//      on every check: parts without the trigger are uncovered, parts next to it where it continues are added.
//   Fast release: every frame, a pane whose content is replaced (window switch, next picture) has its plain
//      page / text parts released at once; a running check stops and the next one looks at it first.
//   Every frame each pane follows its content (scrolling, a moving window): box-motion.js on a 256x144 copy.
// Text: OCR (macOS Vision, ~75 ms) + two text models whenever the screen changed, at most every 250 ms, only
//   the changed rows. Explicit sentences / paragraphs are blurred and follow scrolling the same way.
// Frames and text stay in memory only.
import { createContentDetector } from '../engine/content.js';
import { createTextSafety } from '../engine/text-safety.js';
import { triggersFor, thresholdFor } from '../engine/categories.js';
import { groupTouching, unionAll, coveredBy, iou, intersect, area, pad, picturesAround, pageBackground, contentShare, snapEdges } from '../engine/panes.js';
const shiftRect = (r, dx, dy) => ({ ...r, x: r.x + dx, y: r.y + dy });
import { CW, CH, createShape, shapeFromCells, segmentCells, paintRect, near, mergeInto, shift, bbox, count, cellRect, coverOf, applyProbes, pictureAreas, applyAreas, compact, probeRects } from '../engine/shape-mask.js';
import { trackBox, moveBox } from './box-motion.js';
import { maskText } from './text-mask.js';

const GRID_W = 64, GRID_H = 36; // the flash sampler's grid, reused for change detection
const TILES_X = 4, TILES_Y = 3;
const TEXT_EVERY_MS = 250;
const OCR_MAX_W = 1600;
// Screen transitions (switching windows / spaces, a page loading): a frame where much of the screen changed
// since the previous frame can be half-painted or mid-slide. Detections from such a snapshot, and borderline
// ones, are only shown once a later snapshot confirms them.
const BIG_CHANGE_SHARE = 0.3; // share of 64x36 cells that changed a lot between two frames
const SETTLE_MS = 150; // a snapshot this soon after a big change is "unsettled"
const CONFIRM_GAP_MS = 60; // the confirming snapshot is at least this much later
const PENDING_MAX_MS = 1500; // unconfirmed for this long: dropped
const SURE_MARGIN = 0.15; // a settled detection this far over the threshold is shown at once
const ABRUPT_CHANGE = 15; // mean colour change (0..255) of a pane's tiles that means "different content now"
const VERIFY_FACTOR = 0.3; // a tile hit is kept on a page only if a picture in it scores this share of the threshold
// free-form panes (src/engine/shape-mask.js): re-check windows of PROBE_CELLS x PROBE_CELLS cells
// (16 x 16 = 1/8 x 2/9 of the screen) over each pane and a ring around it
const PROBE_CELLS = 16;
const PROBES_PER_PANE = 9;
const PROBE_BUDGET = 24; // crops per check (~6 ms each), so new pictures are never kept waiting long
const AREAS_PER_PANE = 20; // picture areas scored per pane per check: a photo grid has many small ones
// On a page, judged at full logical resolution in 4x4-pixel blocks (letters never fill a block, so text
// scores ~0): a cell is the CORE of a picture when at least half of it is solid picture; picture areas are
// connected core cells, so two thumbnails 10 px apart stay two areas, each judged on its own. A cell the
// picture only partly fills (its border, or the gap between two thumbnails) is an EDGE cell: covered with
// the picture next to it, never joining two pictures and never an area by itself.
const CORE_SHARE = 0.5;
const GRID_COLS = 128, GRID_ROWS = 72; // the pane cell grid over the whole screen (shape-mask.js CW, CH)
const PAGE_SHARE = 0.25; // the screen has a page when this share of it is one background colour
const MIN_PICTURE_CELLS = 12; // smaller solid areas (icons, bullets, bold glyph clusters) are not judged
const MEDIA_SHARE = 0.5;
const NUDITY_EXTRA = 0.3; // on pages the picture model's nudity score must clear the threshold by this much // one "picture" this big means no page there: full-screen video / photo -> tiles
const EDGE_SHARE = 0.15;

const KEEP_FACTOR = 0.5; // a covered cell stays while a window over it scores this share of the threshold
const CELL_FADE_MS = 60; // an uncovered part fades out quickly; new cover appears at once
// per frame: the content under a pane changed this much (mean, 0..255) without moving = replaced (window
// switch, next photo, page changed): its next check goes first and clears it on one miss
const REPLACED_DIFF = 18;
const OWN_FILL = '#808080'; // our own windows are painted flat grey before any model sees the screen
const ABORT = Symbol('abort');
// quick look at the screen under a pane whose content was just replaced (logical resolution)
const quick = new OffscreenCanvas(1, 1);
const quickCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (quick.getContext('2d', { willReadFrequently: true }));

/** @typedef {import('../shared/types.js').Rect} Rect */

/**
 * @typedef {{ id: number, shape: import('../engine/shape-mask.js').Shape, triggerId: string, label: string,
 *   score: number, triggers: Set<string>, pending: boolean, bornAt: number, dirty: boolean, mx: number, my: number,
 *   gone?: boolean, cleared?: boolean }} Pane
 *   triggerId/label: the strongest trigger (shown on the label); triggers: everything this pane covers (merged
 *   panes keep all of them, so a spider pane that merged with a gun pane still keeps the gun covered)
 *   shape: the covered cells (any shape, follows its content); pending: not drawn until a later snapshot
 *   confirms it; bornAt: time of the snapshot that found it; dirty: its shape changed, look again;
 *   mx, my: how far its content has moved in total (growing or trimming the grid moves its origin, so the
 *   origin cannot tell motion during a check)
 */

/**
 * @param {{ video: HTMLVideoElement, sampler: { gray(): Uint8Array, grayWidth: number, grayHeight: number },
 *           modelsUrl: string, log: (...a: any[]) => void, debug?: boolean, onUpdate: () => void }} opts
 *   onUpdate: new results are ready (caller redraws right away)
 */
export function createContentLoop({ video, sampler, modelsUrl, log, debug = false, onUpdate }) {
  /** @type {Awaited<ReturnType<typeof createContentDetector>>|null} */
  let pics = null;
  /** @type {Awaited<ReturnType<typeof createTextSafety>>|null} */
  let text = null;
  let picsLoading = false, textLoading = false;
  let safety = null;
  let triggersKey = '';
  /** the picture model's triggers (ids are the keys of its probabilities) */
  let activeTriggers = [];
  /** picture content signature -> the model's probabilities for it (pages: unchanged pictures are not scored again) */
  const scoreCache = new Map();
  /** trigger id -> its label, for naming what a pane hides */
  const labels = new Map([['nudity', 'nudity']]);
  let picBusy = false, textBusy = false;
  let lastTextAt = 0;
  let ocrAvailable = true;
  let textBoxesAvailable = true; // text detection for the picture model (macOS helper); off when missing
  const stats = { picRuns: 0, picMs: 0, firstMs: 0, textRuns: 0, textMs: 0, device: 'off' };

  // --- tiles: the base grid plus half-offset tiles centred on the inner grid corners ---
  const tiles = [];
  for (let ty = 0; ty < TILES_Y; ty++) for (let tx = 0; tx < TILES_X; tx++) tiles.push({ x: tx / TILES_X, y: ty / TILES_Y, w: 1 / TILES_X, h: 1 / TILES_Y, base: true });
  for (let ty = 0; ty < TILES_Y - 1; ty++) for (let tx = 0; tx < TILES_X - 1; tx++) tiles.push({ x: (tx + 0.5) / TILES_X, y: (ty + 0.5) / TILES_Y, w: 1 / TILES_X, h: 1 / TILES_Y, base: false });
  /** per tile: grid colours when last checked */
  const ref = tiles.map(() => /** @type {Float32Array|null} */ (null));
  /** @type {Pane[]} */
  let panes = [];
  let nextId = 1;
  /** @type {{ rect: Rect, score: number, id: number }[]} */
  let textAreas = [];
  /** motion tracking: the previous 256x144 gray frame, and when panes were last animated */
  let prevGray = null;
  let lastAnim = 0;
  /** the newest 64x36 grid, so a running check can notice that something new appeared */
  let latestGrid = null;
  /** 64x36 grid at the last text check: text is re-read only where the screen changed since */
  let textRef = null;
  /** last OCR result for the whole screen (normalized), updated band by band */
  let lastLines = [];
  /** the previous frame's grid and when much of the screen last changed at once (window switch, page load) */
  let prevTickGrid = null;
  let lastBigChangeAt = -Infinity;
  /** our own windows (settings) on the captured screen, normalized: never analysed */
  let ownRects = [];
  const unsettled = (t) => t - lastBigChangeAt < SETTLE_MS;

  const cellsOf = (t) => {
    const x0 = Math.floor(t.x * GRID_W), y0 = Math.floor(t.y * GRID_H);
    const x1 = Math.min(GRID_W, Math.ceil((t.x + t.w) * GRID_W)), y1 = Math.min(GRID_H, Math.ceil((t.y + t.h) * GRID_H));
    return { x0, y0, x1, y1 };
  };
  function lumaOf(grid, t) {
    const { x0, y0, x1, y1 } = cellsOf(t);
    const out = new Float32Array((x1 - x0) * (y1 - y0) * 3);
    let k = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * GRID_W + x) * 4;
      out[k++] = grid[i], out[k++] = grid[i + 1], out[k++] = grid[i + 2];
    }
    return out;
  }
  /**
   * How much a tile changed since it was last checked (mean colour difference, 0..255); 0 when below the
   * change threshold (mean > 2 levels or any cell > 20: a new picture, a scroll, a video frame).
   */
  function changeOf(i, grid) {
    const cur = lumaOf(grid, tiles[i]);
    const prev = ref[i];
    if (!prev) return 255;
    let sum = 0, max = 0;
    for (let k = 0; k < cur.length; k++) {
      const d = Math.abs(cur[k] - prev[k]);
      sum += d;
      if (d > max) max = d;
    }
    const mean = sum / cur.length;
    return mean > 2 || max > 20 ? Math.max(mean, 2.01) : 0;
  }

  const wantPics = (s) => s?.enabled && (s.nudity || s.gore || s.violence || s.phobias?.length || s.custom?.length);
  const wantText = (s) => s?.enabled && s.sexualText;

  async function loadPics() {
    picsLoading = true;
    try {
      const det = await createContentDetector({ modelsUrl, tilesX: TILES_X, tilesY: TILES_Y });
      const info = await det.init();
      pics = det;
      stats.device = info.device;
      log(`content: picture models ready on ${info.device} in ${Math.round(info.loadMs)} ms`);
      // start the text-box helper now: its first call takes ~0.7 s, which must not delay the first blur
      window.shield?.findTextBoxes?.({ width: 32, height: 32, gray: new Uint8Array(32 * 32) }).catch(() => {});
      triggersKey = '';
      apply(safety);
    } catch (err) {
      stats.device = 'failed';
      log(`content: picture models unavailable, other protection keeps running: ${err?.message ?? err}`);
    }
    picsLoading = false;
  }

  async function loadText() {
    textLoading = true;
    try {
      text = await createTextSafety({ modelsUrl });
      log(`content: text models ready on ${text.info.device} in ${Math.round(text.info.loadMs)} ms`);
    } catch (err) {
      log(`content: text models unavailable: ${err?.message ?? err}`);
    }
    textLoading = false;
  }

  function apply(s) {
    safety = s;
    if (wantPics(s) && !pics && !picsLoading) loadPics();
    if (wantText(s) && !text && !textLoading) loadText();
    if (!wantText(s)) textAreas = [];
    if (text) text.threshold = 0.7 - 0.4 * (s?.sensitivity ?? 0.5); // 0.5 at the default sensitivity
    const trig = wantPics(s) ? triggersFor(s) : [];
    activeTriggers = trig;
    for (const t of trig) labels.set(t.id, t.label);
    const key = JSON.stringify(trig);
    if (pics && key !== triggersKey) {
      triggersKey = key;
      pics.setTriggers(trig).then(() => {
        ref.fill(null); // re-check everything against the new triggers
        const on = new Set([...trig.map((t) => t.id), ...(s?.nudity ? ['nudity'] : [])]);
        for (const p of panes) for (const t of [...p.triggers]) if (!on.has(t)) p.triggers.delete(t);
        panes = panes.filter((p) => p.triggers.size);
        onUpdate();
      });
    }
  }

  // One snapshot of the screen per picture check, at logical resolution, in a CPU-backed canvas: every crop
  // and the nudity detector then read from memory instead of the GPU video each time (~6 ms per batch saved),
  // and all tiles of one check see the same frame. Overwritten by the next check; never stored.
  const snap = new OffscreenCanvas(1, 1);
  const snapCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (snap.getContext('2d', { willReadFrequently: true }));
  function snapshot() {
    const w = Math.min(1600, Math.round(video.videoWidth / Math.max(1, devicePixelRatio)));
    const h = Math.round((w * video.videoHeight) / video.videoWidth);
    if (snap.width !== w || snap.height !== h) Object.assign(snap, { width: w, height: h });
    snapCtx.drawImage(video, 0, 0, w, h);
    maskOwn(snapCtx, w, h, 0, 1);
    lastSnapAt = performance.now();
    return snap;
  }

  /** paint our own windows flat grey in a canvas showing rows y0..y1 (normalized) of the screen */
  function maskOwn(ctx, w, h, y0, y1) {
    if (!ownRects.length) return;
    ctx.fillStyle = OWN_FILL;
    const k = h / (y1 - y0);
    for (const r of ownRects) ctx.fillRect(r.x * w, (r.y - y0) * k, r.w * w, r.h * k);
  }

  /** half-resolution grayscale of the current snapshot, for snapping pane edges to borders */
  const edgeCanvas = new OffscreenCanvas(1, 1);
  const edgeCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (edgeCanvas.getContext('2d', { willReadFrequently: true }));
  /** @param {number} [scale] 0.5: half resolution (picture finding), 1: full logical resolution (pane shapes) */
  function snapshotGray(scale = 0.5) {
    const w = Math.round(snap.width * scale), h = Math.round(snap.height * scale);
    if (edgeCanvas.width !== w || edgeCanvas.height !== h) Object.assign(edgeCanvas, { width: w, height: h });
    edgeCtx.drawImage(snap, 0, 0, w, h);
    const m = edgeCtx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let k = 0, p = 0; k < g.length; k++, p += 4) g[k] = (54 * m[p] + 183 * m[p + 1] + 19 * m[p + 2]) >> 8;
    return { g, w, h };
  }

  const threshold = () => thresholdFor(safety?.sensitivity);
  /** where content seen in the snapshot is now (it may have scrolled while the models ran) */
  function sinceSnapshot(rect, snapGray) {
    if (!snapGray || !prevGray) return rect;
    const d = trackBox(snapGray, prevGray, sampler.grayWidth, sampler.grayHeight, rect, 36, 18);
    return d ? moveBox(rect, d) ?? rect : rect;
  }

  /** something new appeared since the check started, in a tile that was still then (not a playing video) */
  const newChange = (todo) => tiles.some((_, i) => !todo.includes(i) && changeOf(i, latestGrid) > 6);

  /** a pane's cover as a box (covered cells only) */
  const boxOf = (p) => bbox(p.shape) ?? { x: p.shape.x, y: p.shape.y, w: 0, h: 0 };

  /**
   * Add a detection: covers `rect` in the pane it overlaps or comes within one cell of (any trigger), or
   * starts a new pane. Panes that end up near each other become one (mergePanes).
   */
  function addDetection({ rect, triggerId, label, score, pending = false, bornAt = performance.now() }) {
    const probe = createShape(rect);
    const home = panes.find((p) => !p.page && near(p.shape, probe, 1));
    if (home) {
      paintRect(home.shape, rect);
      home.triggers.add(triggerId);
      home.cleared = false;
      if (!pending) home.pending = false; // a sure detection makes a pending pane real
      if (score > home.score) Object.assign(home, { triggerId, label, score });
      home.dirty = true;
      return home;
    }
    const p = { id: nextId++, shape: probe, triggerId, label, score, triggers: new Set([triggerId]), pending, bornAt, dirty: true, mx: 0, my: 0 };
    panes.push(p);
    return p;
  }

  /**
   * Tiles under these panes are checked again on the next check: a hit there was skipped while the pane
   * "explained" it (e.g. a stale pane from the previous window over a real picture in the new one).
   */
  function forgetTilesUnder(list) {
    tiles.forEach((t, i) => {
      if (list.some((p) => intersect(bbox(p.shape, true) ?? boxOf(p), t))) ref[i] = null;
    });
  }

  /** panes that overlap or are within one cell of each other become one shape */
  function mergePanes() {
    for (let a = 0; a < panes.length; a++) {
      for (let b = a + 1; b < panes.length; b++) {
        const A = panes[a], B = panes[b];
        if (A.page || B.page || !near(A.shape, B.shape, 1)) continue;
        mergeInto(A.shape, B.shape);
        for (const t of B.triggers) A.triggers.add(t);
        if (B.score > A.score) Object.assign(A, { triggerId: B.triggerId, label: B.label, score: B.score });
        A.pending &&= B.pending;
        A.dirty = true;
        panes.splice(b, 1);
        b = a; // A grew: look at every other pane again
      }
    }
  }

  // --- one picture check ---
  async function checkPictures(grid) {
    picBusy = true;
    const t0 = performance.now();
    let first = 0;
    const publish = () => {
      if (!first && panes.some((p) => !p.pending)) first = performance.now() - t0;
      mergePanes();
      onUpdate();
    };
    try {
      const change = tiles.map((_, i) => changeOf(i, grid));
      const todo = tiles.map((_, i) => i).filter((i) => change[i] > 0).sort((a, b) => change[b] - change[a]);
      const confirmable = (p) => p.pending && t0 - p.bornAt >= CONFIRM_GAP_MS;
      const unfinished = (p) => p.dirty || p.shape.miss.some((m) => m > 0) || confirmable(p);
      if (!todo.length && !panes.some((p) => unfinished(p) || p.urgent)) return;
      const frame = snapshot();
      const snapGray = prevGray;
      const th = threshold();
      // taken during a transition (window switch, page painting): nothing found in it is shown unconfirmed
      const shaky = unsettled(t0);
      /** where each pane's grid was in this snapshot (panes keep moving with their content meanwhile) */
      const atSnap = new Map(panes.map((p) => [p.id, { mx: p.mx, my: p.my, box: boxOf(p) }]));
      const scored = [];
      let grayMemo = null;
      const grayNow = () => (grayMemo ??= snapshotGray());
      let grayFullMemo = null;
      const grayFull = () => (grayFullMemo ??= snapshotGray(1));
      // a shown pane's content was replaced after this snapshot: stop now, so the next check (on a new
      // snapshot) can remove it first instead of waiting for this one to finish
      const replacedSince = () => panes.some((p) => p.urgentAt > t0);
      const bail = () => {
        if (replacedSince()) throw ABORT;
      };

      /**
       * Paint over the written words in `rect` of this snapshot, so the picture model judges only pictures
       * ("guns" or "spider" in a heading, a link, a chat must never be blurred). Returns lines painted over.
       */
      const cleaned = [];
      async function cleanText(rect) {
        if (!textBoxesAvailable || !window.shield?.findTextBoxes) return 0;
        if (cleaned.some((c) => coveredBy(rect, c) > 0.98)) return 0;
        const n = await maskText(snapCtx, snap.width, snap.height, rect, window.shield.findTextBoxes);
        if (n < 0) {
          textBoxesAvailable = false;
          log('content: text detection unavailable; written words may be judged as pictures');
          return 0;
        }
        cleaned.push(rect);
        if (n) grayMemo = grayFullMemo = null; // the structure maps must see the cleaned snapshot
        return n;
      }

      /**
       * Where is the trigger? On a page, CLIP's hit must be confirmed on a PICTURE in the flagged area.
       * Returns the pictures that hold the trigger (with the trigger's probability on that picture), [] when
       * only text / harmless pictures are there, or null when there is no page around (full-screen photo or
       * video: the tiles are covered and the shape is carved to the object by the re-checks).
       */
      async function verifyOnPictures(rect, triggerId) {
        // the same fine picture areas as the re-checks: in a photo grid every thumbnail is its own area (the
        // coarse picture finder closed the 10 px gaps and judged whole rows as one collage, missing spiders)
        const { g, w, h } = grayFull();
        const bg = pageBackground(g, w, h, pad(rect, 0.1));
        if (bg === null) return null;
        const around = pictureAreas(createShape(rect), { reach: 12, content: (c) => cellKind(g, w, h, c, bg) })
          .filter((a) => a.size >= 12 && intersect(a.rect, rect) && area(intersect(a.rect, rect)) >= 0.25 * area(a.rect))
          .slice(0, AREAS_PER_PANE)
          .map((a) => a.rect);
        if (!around.length) return [];
        const res = await pics.scoreRects(frame, around, { stop: bail });
        // a low bar on purpose: the tiles already matched; this only asks "is it in a picture, not in the words?"
        return around.map((r, k) => ({ r, p: res[k].probs[triggerId] ?? 0, id: res[k].triggerId })).filter((x) => x.p >= th * VERIFY_FACTOR || x.id === triggerId);
      }

      /** pictures on the page; null when the screen has no page background (full-screen media) */
      function segmentScreen({ g, w, h }) {
        const hist = new Uint32Array(256);
        for (let i = 0; i < g.length; i += 3) hist[g[i]]++;
        let bg = 0, best = 0, n = Math.ceil(g.length / 3);
        for (let v = 0; v < 256; v++) {
          let k = 0;
          for (let d = -6; d <= 6; d++) k += hist[v + d] ?? 0;
          if (k > best) (best = k), (bg = v);
        }
        if (best < PAGE_SHARE * n) return null;
        const kind = new Uint8Array(GRID_COLS * GRID_ROWS);
        for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
          const k = cellKind(g, w, h, { x: c * CW, y: r * CH, w: CW, h: CH }, bg);
          kind[r * GRID_COLS + c] = k === 'core' ? 1 : k === 'edge' ? 2 : 0;
        }
        const all = segmentCells(kind, GRID_COLS, GRID_ROWS).filter((s) => s.core >= MIN_PICTURE_CELLS);
        const rectOf = (s) => ({ x: s.c0 * CW, y: s.r0 * CH, w: (s.c1 - s.c0 + 1) * CW, h: (s.r1 - s.r0 + 1) * CH });
        const isMedia = (s) => area(rectOf(s)) >= MEDIA_SHARE;
        return {
          bg,
          g, w, h,
          pictures: all.filter((s) => !isMedia(s)).map((s) => ({ ...s, rect: rectOf(s), sig: signature(g, w, h, rectOf(s)) })),
          media: all.filter(isMedia).map(rectOf),
        };
      }

      /** score every picture not in the cache (biggest first, a batch at a time) and update the page panes */
      async function judgePictures(seg) {
        const items = seg.pictures;
        for (const it of items) {
          it.probs = scoreCache.get(it.sig) ?? null;
          // the picture's exact border (cells are ~11 x 13 px; captions sit a few pixels below a thumbnail)
          // (the cell area can reach ~2 cells past the picture where a caption sits right under it: look that far in)
          const inward = Math.min(0.4, Math.max(0.15, (2.5 * CW) / it.rect.w, (2.5 * CH) / it.rect.h));
          it.exact = snapEdges(seg.g, seg.w, seg.h, it.rect, { out: 0.03, inward });
        }
        updatePagePanes(items);
        const todoPics = items.filter((it) => !it.probs).sort((a, b) => b.core - a.core);
        for (let k = 0; k < todoPics.length; k += 8) {
          bail();
          const batch = todoPics.slice(k, k + 8);
          const res = await pics.scoreRects(frame, batch.map((it) => it.rect), { stop: bail });
          batch.forEach((it, j) => {
            it.probs = res[j].probs;
            scoreCache.set(it.sig, it.probs);
          });
          if (scoreCache.size > 600) for (const key of [...scoreCache.keys()].slice(0, 200)) scoreCache.delete(key);
          updatePagePanes(items);
        }
        if (debug) for (const it of items) {
          const top = activeTriggers.map((t) => [t.label, it.probs?.[t.id] ?? 0]).sort((a, b) => b[1] - a[1])[0];
          if (top && top[1] >= 0.1) log(`content:   picture at ${(it.rect.x * 100).toFixed(0)},${(it.rect.y * 100).toFixed(0)}% ${(it.rect.w * 100).toFixed(0)}x${(it.rect.h * 100).toFixed(0)}%: ${top[0]} ${top[1].toFixed(2)}`);
        }
        if (debug) log(`content: page with ${items.length} picture(s), ${todoPics.length} scored, ${panes.filter((p) => p.page).length} hidden${seg.media.length ? `, ${seg.media.length} media area(s) left to the tiles` : ''}`);
      }

      /**
       * Page panes = the flagged pictures. A picture keeps its pane (same id) while it stays flagged; a picture
       * not scored yet keeps the pane it already has; everything else is uncovered now.
       */
      function updatePagePanes(items) {
        const prev = panes.filter((p) => p.page);
        const next = [];
        const used = new Set();
        // where content in the snapshot is now (it may have moved while the model ran)
        const now = (r) => sinceSnapshot(r, snapGray);
        for (const it of items) {
          const r = now(it.rect);
          const mine = prev.find((p) => !used.has(p) && coverOf(p.shape, r) >= 0.3);
          if (!it.probs) {
            if (mine) used.add(mine), next.push(mine); // not judged yet: keep what is there
            continue;
          }
          let best = null;
          for (const t of activeTriggers) {
            const v = it.probs[t.id] ?? 0;
            let bar = mine ? th * KEEP_FACTOR : th; // a covered picture stays covered on a slightly lower score
            // the picture model's nudity prompts also fire on food and pets; NudeNet (run on every check) is the
            // real nudity detector, so on pages the backup needs a clear score
            if (t.id === 'nudity') bar = Math.max(bar, th + NUDITY_EXTRA);
            if (v >= bar && (!best || v > best.v)) best = { t, v };
          }
          if (!best) continue;
          const shape = shapeFromCells(it.cells, GRID_COLS);
          const dx = r.x - it.rect.x, dy = r.y - it.rect.y;
          shift(shape, dx, dy);
          const pane = mine ?? { id: nextId++, page: true, bornAt: t0, pending: shaky, mx: 0, my: 0, dirty: false };
          if (mine) used.add(mine), (pane.pending = pane.pending && (shaky || t0 - pane.bornAt < CONFIRM_GAP_MS));
          // the cover is cut to the picture's exact border; the clip moves with the pane (mx, my)
          const clip = { x: it.exact.x + dx - 1 / 1600, y: it.exact.y + dy - 1 / 1000, w: it.exact.w + 2 / 1600, h: it.exact.h + 2 / 1000 };
          Object.assign(pane, { shape, clip, clipAt: [pane.mx, pane.my], triggerId: best.t.id, label: best.t.label, score: best.v, triggers: new Set([best.t.id]) });
          next.push(pane);
        }
        panes = [...panes.filter((p) => !p.page), ...next];
        publish();
      }

      // 2. look under each pane (and a ring around it): parts where the trigger is gone are uncovered, parts
      //    next to the cover where it continues are added. The shape morphs onto the object; an empty pane
      //    ends. Pending panes are confirmed here too: a later snapshot must see the trigger.
      //    Panes whose content changed go FIRST, before any new tile is scored, so a blur leaves fast.
      const replacedAt = (cell) => tiles.some((t, i) => change[i] >= ABRUPT_CHANGE && intersect(t, cell) && area(intersect(t, cell)) >= 0.5 * area(cell));
      const changedUnder = (box) => todo.some((i) => intersect(tiles[i], box));
      // urgent since this snapshot was taken: this snapshot still shows the old content; the next check handles it
      const stale = (p) => p.urgentAt > t0;
      let budget = PROBE_BUDGET;
      let looked = 0;
      const done = new Set();
      async function recheck(list) {
        list = list.filter((p) => !p.page && !done.has(p) && !stale(p));
        if (!list.length) return;
        list.forEach((p) => done.add(p));
        if (list.some((p) => p.triggers.has('nudity')) && lastNudeAt !== lastSnapAt) {
          lastNude = (await pics.detectNudity(frame, { minScore: nudeMin() })).map((b) => b.rect);
          lastNudeAt = lastSnapAt;
        }
        for (const p of list) {
          if (budget <= 0) break;
          bail();
          if (!panes.includes(p)) continue; // merged away meanwhile
          const s0 = atSnap.get(p.id);
          // probe windows where the pane was in the snapshot
          const dx0 = p.mx - s0.mx, dy0 = p.my - s0.my;
          // the area to look at: the cover plus a ring, where the pane was in the snapshot
          const all = probeRects(p.shape, { size: PROBE_CELLS, ring: 2, max: 400 }).map((r) => ({ ...r, x: r.x - dx0, y: r.y - dy0 }));
          if (!all.length) continue;
          // windows stay small (a big window always contains a bit of the object); a big pane is worked through
          // in rotating batches over several checks
          const take = Math.min(all.length, PROBES_PER_PANE, Math.max(1, budget));
          p.cursor = (p.cursor ?? 0) % all.length;
          const windows = Array.from({ length: take }, (_, k) => all[(p.cursor + k) % all.length]);
          p.cursor += take;
          looked++;
          p.busy = true; // its grid must not be trimmed while cell indices are in use
          await cleanText(unionAll(all));
          const { g, w, h } = grayFull();
          const bg = pageBackground(g, w, h, pad(unionAll(all), 0.15));
          const probOf = (r) => Math.max(...[...p.triggers].map((t) => r.probs[t] ?? 0));
          /** per trigger, the best score seen this round: the label names what is still there */
          const seenBy = new Map();
          const note = (res) => res.forEach((r) => p.triggers.forEach((t) => seenBy.set(t, Math.max(seenBy.get(t) ?? 0, r.probs[t] ?? 0))));
          const dxNow = () => [p.mx - s0.mx, p.my - s0.my];
          const toSnap = (c) => {
            const [dx, dy] = dxNow();
            return { ...c, x: c.x - dx, y: c.y - dy };
          };
          const nude = p.triggers.has('nudity');
          // content replaced under it (another window, page or picture): one miss is enough everywhere
          const urgent = p.urgent;
          p.urgent = false;
          const common = { keepBar: th * KEEP_FACTOR, growBar: th, pinned: (c) => nude && lastNude.some((b) => intersect(b, toSnap(c))), replaced: (c) => urgent || replacedAt(toSnap(c)) };
          let ps, removed, added;
          if (bg !== null) {
            // on a page: every picture area in and around the cover, each scored as a tight crop of itself
            const areas = pictureAreas(p.shape, { reach: 6, content: (c) => {
              return cellKind(g, w, h, toSnap(c), bg);
            } });
            const n = Math.min(areas.length, AREAS_PER_PANE, Math.max(1, budget));
            const res = n ? await pics.scoreRects(frame, areas.slice(0, n).map((a) => toSnap(a.rect)), { stop: bail }) : [];
            bail();
            ps = areas.map((_, k) => (k < n ? probOf(res[k]) : NaN));
            note(res);
            budget -= n;
            ({ removed, added } = applyAreas(p.shape, areas, ps, { ...common, clearAfter: 1, minCells: 12 })); // tight crops are reliable: one miss
            if (debug) log(`content: pane ${p.id} on a page: ${areas.length} picture area(s) around it`);
          } else {
            // full-screen photo / video: overlapping windows, each cell decides
            const res = await pics.scoreRects(frame, windows, { stop: bail });
            bail();
            ps = res.map(probOf);
            note(res);
            budget -= windows.length;
            const [dx, dy] = dxNow();
            ({ removed, added } = applyProbes(p.shape, windows.map((r, k) => ({ rect: { ...r, x: r.x + dx, y: r.y + dy }, p: ps[k] })), common));
          }
          p.busy = false;
          p.dirty = removed > 0 || added > 0;
          // name what is still there: every trigger this round saw, strongest first
          const still = [...seenBy].filter(([, v]) => v >= th * KEEP_FACTOR).sort((a, b) => b[1] - a[1]);
          if (still.length) Object.assign(p, { triggerId: still[0][0], score: still[0][1], label: still.map(([t]) => labels.get(t) ?? t).join(', ') });
          ps = ps.filter((v) => !Number.isNaN(v));
          const seen = (ps.length && Math.max(...ps) >= th * 0.85) || (nude && lastNude.some((b) => intersect(b, s0.box)));
          if (p.pending) {
            if (seen) p.pending = false;
            else p.shape.on.fill(0); // checked twice, not confirmed
          }
          if (debug && (removed || added)) log(`content: pane ${p.id} reshaped: -${removed} +${added} cells, ${count(p.shape)} covered`);
        }
        // emptied panes: tiles under them are checked again; a shown one fades out (regions() removes it), an
        // unconfirmed one just goes (its tiles were checked twice and stay checked)
        const empty = panes.filter((p) => !count(p.shape) && !p.cleared);
        for (const p of empty) {
          p.cleared = true;
          if (p.pending) p.gone = true;
          else forgetTilesUnder([p]);
        }
        panes = panes.filter((p) => !p.gone && (!p.pending || t0 - p.bornAt <= PENDING_MAX_MS));
        publish(); // removals show at once
      }
      const shown = (p) => !p.pending && atSnap.has(p.id);

      // 0. PAGES: every picture on the screen, each judged on its own (cached by content). The cover is exactly
      //    the flagged pictures; a picture that is gone or no longer matches is uncovered in this check. Only
      //    pictures are judged, so words never cause a blur. Where there is no page (full-screen video or
      //    photo: one huge "picture"), the tiles below do the work.
      const seg = segmentScreen(grayFull());
      if (seg) await judgePictures(seg);

      await recheck(panes.filter((p) => shown(p) && (p.urgent || changedUnder(atSnap.get(p.id).box))));

      // 1. changed tiles, most-changed first; nudity detector after the first batch. On a page only tiles over
      //    "media" (an area with no page in it) are scored; everything else was judged picture by picture.
      const tileTodo = !seg ? todo : todo.filter((i) => seg.media.some((m) => {
        const x = intersect(m, tiles[i]);
        return x && area(x) >= 0.3 * area(tiles[i]);
      }));
      for (const i of todo) if (!tileTodo.includes(i)) ref[i] = lumaOf(grid, tiles[i]);
      let nudityRan = !safety.nudity || !todo.length;
      if (!nudityRan && !tileTodo.length) {
        nudityRan = true;
        if (lastNudeAt !== lastSnapAt) await checkNudity(frame, snapGray, publish, shaky, t0);
      }
      // first batch of 2: the most-changed tiles (usually the new picture) are scored as early as possible
      for (let k = 0, n = 2; k < tileTodo.length; k += n, n = 4) {
        // something new appeared elsewhere since this check started: stop here, the next check starts with it
        // (tiles not scored yet keep their old reference, so they are still "changed" next time)
        // (also when a pane's content was replaced meanwhile: the next check, on a new snapshot, removes it first)
        if (k > 0 && (newChange(todo) || panes.some((p) => p.urgentAt > t0))) break;
        const batch = tileTodo.slice(k, k + n);
        for (const i of batch) (ref[i] = lumaOf(grid, tiles[i])), scored.push(tiles[i]);
        const res = await pics.scoreRects(frame, batch.map((i) => tiles[i]), { stop: bail });
        bail();
        const fresh = [];
        batch.forEach((i, j) => {
          if (!res[j].triggerId) return;
          const t = tiles[i];
          // mostly COVERED already (by actual cells, not a pane's bounding box: in a photo grid that box spans
          // most of the screen): the pane's own re-checks handle it
          if (panes.some((p) => !p.pending && coverOf(p.shape, shiftRect(t, p.mx - atSnap.get(p.id)?.mx || 0, p.my - atSnap.get(p.id)?.my || 0)) >= 0.5)) return;
          fresh.push({ rect: { x: t.x, y: t.y, w: t.w, h: t.h }, ...res[j] });
        });
        if (fresh.length) {
          let added = false;
          for (let g of groupTouching(fresh)) {
            bail();
            // words first: with the text painted over, is it still a hit? (a page that says "spiders": no)
            if (await cleanText(unionAll(g.map((x) => x.rect)))) {
              const again = await pics.scoreRects(frame, g.map((x) => x.rect), { stop: bail });
              // still there without the words (the same 0.85 margin as re-checks: only "did it vanish?")
              const before = g.length;
              g = g.map((x, k) => ({ ...x, score: again[k].probs[x.triggerId] ?? 0 })).filter((x) => x.score >= th * 0.85);
              if (debug) log(`content: words painted over, ${g.length}/${before} hit tile(s) still hit`);
              if (!g.length) continue;
            }
            const best = g.reduce((a, b) => (b.score > a.score ? b : a));
            // sure enough to show at once: a settled snapshot and a clear score on the tiles or on the picture
            // itself (the tight crop is a second, independent look); otherwise the next check must agree
            const sure = (p) => !shaky && p >= th + SURE_MARGIN;
            const det = { triggerId: best.triggerId, label: best.label, score: best.score, bornAt: t0 };
            const tilesRect = unionAll(g.map((x) => x.rect));
            const found = await verifyOnPictures(tilesRect, best.triggerId);
            if (debug) log(`content: hit ${best.label} ${best.score.toFixed(2)} -> ${found === null ? 'no page around: tiles, carved by re-checks' : `${found.length} picture(s) hold it`}`);
            if (found === null) addDetection({ ...det, pending: !sure(best.score), rect: sinceSnapshot(tilesRect, snapGray) });
            else for (const { r, p } of found) addDetection({ ...det, pending: !sure(Math.max(best.score, p)), rect: sinceSnapshot(pad(r, 0.01), snapGray) });
            added ||= found === null || found.length > 0;
          }
          if (added) publish();
        }
        if (!nudityRan) {
          nudityRan = true;
          if (lastNudeAt !== lastSnapAt) await checkNudity(frame, snapGray, publish, shaky, t0);
        }
      }

      // 3. the rest: panes still settling, unconfirmed ones, ones with a miss
      await recheck(panes
        .filter((p) => !p.page && atSnap.has(p.id) && (p.pending ? confirmable(p) : unfinished(p)))
        .sort((a, b) => Number(b.pending) - Number(a.pending) || Number(b.dirty) - Number(a.dirty)));
      panes = panes.filter((p) => !p.pending || t0 - p.bornAt <= PENDING_MAX_MS);

      stats.picRuns++;
      stats.picMs += performance.now() - t0;
      stats.firstMs += first;
      if (debug) {
        const tm = pics.timing();
        log(`content: ${todo.length} tiles${shaky ? ' (transition)' : ''}, ${looked} pane(s) re-checked with ${PROBE_BUDGET - budget} windows in ${Math.round(performance.now() - t0)} ms (prep ${Math.round(tm.prepMs)}, queue ${Math.round(tm.waitMs)}, model ${Math.round(tm.runMs)}; first pane ${Math.round(first)} ms), ${panes.filter((p) => !p.pending).length} pane(s) + ${panes.filter((p) => p.pending).length} pending`);
      }
    } catch (err) {
      if (err === ABORT) {
        if (debug) log(`content: check stopped after ${Math.round(performance.now() - t0)} ms: content under a pane was replaced`);
      } else log(`content: picture check failed: ${err?.message ?? err}`);
    } finally {
      for (const p of panes) p.busy = false;
      picBusy = false;
    }
  }

  const nudeMin = () => 0.45 - 0.2 * (safety.sensitivity ?? 0.5);
  /** the nudity detector's latest boxes (snapshot coordinates) */
  let lastNude = [];
  let lastNudeAt = 0, lastSnapAt = 0;
  /** NudeNet over the whole snapshot: each box (with a margin) is covered; its cells stay while it is boxed */
  async function checkNudity(frame, snapGray, publish, shaky, t0) {
    const min = nudeMin();
    const boxes = await pics.detectNudity(frame, { minScore: min });
    lastNude = boxes.map((b) => b.rect);
    lastNudeAt = lastSnapAt;
    if (!boxes.length) return;
    for (const b of boxes) addDetection({ rect: sinceSnapshot(pad(b.rect, 0.25), snapGray), triggerId: 'nudity', label: 'nudity', score: b.score, pending: shaky || b.score < min + SURE_MARGIN, bornAt: t0 });
    publish();
  }

  // --- one text check ---
  const ocrCanvas = new OffscreenCanvas(1, 1);
  const ocrCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (ocrCanvas.getContext('2d', { willReadFrequently: true }));
  /** @param {{ y0: number, y1: number }} band  normalized rows to re-read (full width: lines are not cut) */
  async function checkText(band) {
    textBusy = true;
    lastTextAt = performance.now();
    const t0 = performance.now();
    try {
      // logical resolution (Retina frames halved): text is as large as the reader sees it, 4x fewer pixels
      const fullW = Math.min(OCR_MAX_W, Math.round(video.videoWidth / Math.max(1, devicePixelRatio)));
      const fullH = Math.round((fullW * video.videoHeight) / video.videoWidth);
      const w = fullW, h = Math.max(8, Math.round((band.y1 - band.y0) * fullH));
      if (ocrCanvas.width !== w || ocrCanvas.height !== h) Object.assign(ocrCanvas, { width: w, height: h });
      const sy = band.y0 * video.videoHeight, sh = (band.y1 - band.y0) * video.videoHeight;
      ocrCtx.drawImage(video, 0, sy, video.videoWidth, sh, 0, 0, w, h);
      maskOwn(ocrCtx, w, h, band.y0, band.y1);
      const rgba = ocrCtx.getImageData(0, 0, w, h).data;
      const gray = new Uint8Array(w * h);
      for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
      const r = await window.shield.recognizeText({ width: w, height: h, gray });
      if (r.available === false) {
        ocrAvailable = false;
        log('content: text recognition is not available on this system; explicit-text protection is off');
        return;
      }
      // band coordinates -> screen; keep earlier lines outside the band
      const bh = band.y1 - band.y0;
      const fresh = r.lines.map((l) => ({ text: l.t, rect: { x: l.x, y: band.y0 + l.y * bh, w: l.w, h: l.h * bh } }));
      const kept = lastLines.filter((l) => l.rect.y + l.rect.h / 2 < band.y0 || l.rect.y + l.rect.h / 2 > band.y1);
      const lines = (lastLines = [...kept, ...fresh]);
      const snapGray = prevGray;
      const areas = lines.length ? await text.findExplicit(lines) : [];
      const before = JSON.stringify(textAreas.map((a) => a.rect));
      const prevAreas = textAreas;
      textAreas = areas.map((a) => {
        const rect = sinceSnapshot(a.rect, snapGray);
        const same = prevAreas.find((q) => iou(q.rect, rect) > 0.3);
        return { ...a, rect, id: same?.id ?? nextId++ };
      });
      if (JSON.stringify(areas.map((a) => a.rect)) !== before) onUpdate();
      stats.textRuns++;
      stats.textMs += performance.now() - t0;
      if (debug) log(`content: text check rows ${Math.round(band.y0 * 100)}-${Math.round(band.y1 * 100)}%: ${fresh.length} new lines (ocr ${r.ms} ms), ${lines.length} on screen, in ${Math.round(performance.now() - t0)} ms, ${areas.length} explicit area(s)`); // counts only, never the text
    } catch (err) {
      log(`content: text check failed: ${err?.message ?? err}`);
    } finally {
      textBusy = false;
    }
  }

  return {
    apply,
    /** call on every captured frame with the flash sampler's 64x36 RGBA grid */
    tick(grid) {
      if (!safety?.enabled || !video.videoWidth) return;
      latestGrid = grid;
      noteTransition(grid);
      follow();
      if (pics && wantPics(safety) && !picBusy && triggersKey) checkPictures(grid);
      if (text && wantText(safety) && ocrAvailable && window.shield?.recognizeText) {
        if (!textBusy && performance.now() - lastTextAt >= TEXT_EVERY_MS) {
          const band = changedBand(grid);
          if (band) {
            textRef = grid.slice();
            checkText(band);
          }
        }
      }
    },
    /** @param {import('../shared/types.js').Profile} profile @returns {import('../shared/types.js').Region[]} */
    regions(profile) {
      if (!safety?.enabled) return [];
      const now = performance.now();
      const dt = lastAnim ? Math.min(100, now - lastAnim) : 0;
      lastAnim = now;
      const out = [];
      for (const p of panes) {
        if (p.pending) continue; // waiting for a second look
        const s = p.shape;
        for (let i = 0; i < s.on.length; i++) s.alpha[i] = s.on[i] ? 1 : Math.max(0, s.alpha[i] - dt / CELL_FADE_MS);
        const box = bbox(s, true);
        if (!box) continue;
        // `shape` (additive to the Region contract): the renderer draws the cells as one soft blob
        const clip = p.clip ? { ...p.clip, x: p.clip.x + p.mx - p.clipAt[0], y: p.clip.y + p.my - p.clipAt[1] } : null;
        out.push({ id: `pane-${p.id}`, rect: clip ? intersect(box, clip) ?? box : box, effect: 'blur', reason: `Hidden: ${p.label}`, strength: 1, shape: { x: s.x, y: s.y, cw: CW, ch: CH, cols: s.cols, rows: s.rows, alpha: s.alpha, clip } });
      }
      // faded-out borders are trimmed; panes with nothing left to draw are gone
      for (const p of panes) if (!p.pending && !count(p.shape) && !bbox(p.shape, true)) p.gone = true;
      if (panes.some((p) => p.gone)) panes = panes.filter((p) => !p.gone);
      for (const p of panes) if (!p.pending && !p.busy && !p.shape.alpha.some((a, i) => a > 0 && a < 1 && !p.shape.on[i])) compact(p.shape);
      textAreas.forEach((a) => out.push({ id: `text-${a.id}`, rect: a.rect, effect: 'blur', reason: 'Hidden: explicit text', strength: 1 }));
      return out;
    },
    /** counts and timings only */
    stats() {
      const s = { device: stats.device, modelHz: stats.picRuns, modelMs: stats.picRuns ? stats.picMs / stats.picRuns : 0, firstMs: stats.picRuns ? stats.firstMs / stats.picRuns : 0, textHz: stats.textRuns, textMs: stats.textRuns ? stats.textMs / stats.textRuns : 0 };
      Object.assign(stats, { picRuns: 0, picMs: 0, firstMs: 0, textRuns: 0, textMs: 0 });
      return s;
    },
    /**
     * Our own windows on the captured screen (normalized rects; main sends the settings window while it is
     * in front). They are painted grey before any model looks, so the app never blurs its own labels.
     * @param {Rect[]} rects
     */
    setOwnWindows(rects) {
      const before = ownRects;
      ownRects = Array.isArray(rects) ? rects : [];
      // what was hidden or shown changed: re-check those tiles and re-read all text
      tiles.forEach((t, i) => {
        if ([...before, ...ownRects].some((r) => intersect(r, t))) ref[i] = null;
      });
      textRef = null;
      lastLines = [];
      const own = (r) => ownRects.some((o) => coveredBy(r, o) > 0.5);
      panes = panes.filter((p) => !own(boxOf(p)));
      textAreas = textAreas.filter((a) => !own(a.rect));
      onUpdate();
    },
    clear() {
      lastLines = [];
      textRef = null;
      ref.fill(null);
      panes = [];
      textAreas = [];
      prevGray = null;
    },
  };

  /** every frame: remember when a large part of the screen changed at once (window switch, page load) */
  function noteTransition(grid) {
    if (prevTickGrid) {
      let n = 0;
      for (let p = 0; p < grid.length; p += 4) {
        if (Math.abs(grid[p] - prevTickGrid[p]) + Math.abs(grid[p + 1] - prevTickGrid[p + 1]) + Math.abs(grid[p + 2] - prevTickGrid[p + 2]) > 45) n++;
      }
      if (n > BIG_CHANGE_SHARE * GRID_W * GRID_H) lastBigChangeAt = performance.now();
    }
    prevTickGrid = grid;
  }

  /**
   * The content under a shown pane was just replaced (window switch, picture closed, next page). Without
   * waiting for the model: every part that is now plain page or text (no solid picture content, judged like
   * the re-checks) cannot be hiding a picture and is released in this frame. Parts that still show a picture
   * (a video cut to another shot) stay covered until the model has looked. Returns true when cells were freed.
   */
  function quickRelease(p, box) {
    const area_ = pad(box, 0.15);
    const k = 1 / Math.max(1, devicePixelRatio); // video pixels -> logical resolution
    const vw = video.videoWidth, vh = video.videoHeight;
    const w = Math.max(8, Math.round(area_.w * vw * k)), h = Math.max(8, Math.round(area_.h * vh * k));
    if (quick.width !== w || quick.height !== h) Object.assign(quick, { width: w, height: h });
    quickCtx.drawImage(video, area_.x * vw, area_.y * vh, area_.w * vw, area_.h * vh, 0, 0, w, h);
    maskOwn(quickCtx, w, h, 0, 1); // (own windows: approximate, the mask is screen-relative)
    const m = quickCtx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0, q = 0; i < g.length; i++, q += 4) g[i] = (54 * m[q] + 183 * m[q + 1] + 19 * m[q + 2]) >> 8;
    const bg = pageBackground(g, w, h, { x: 0, y: 0, w: 1, h: 1 });
    if (bg === null) return false; // no page around (full-screen video): only the model can tell
    const s = p.shape;
    // the same rule as pages: a cell stays covered only when it belongs to a real picture (a solid area of at
    // least MIN_PICTURE_CELLS cells); scattered solid specks (colourful code, bold glyphs) do not count
    const kind = new Uint8Array(s.on.length);
    for (let i = 0; i < s.on.length; i++) {
      const c = cellRect(s, i);
      const local = { x: (c.x - area_.x) / area_.w, y: (c.y - area_.y) / area_.h, w: c.w / area_.w, h: c.h / area_.h };
      const k = cellKind(g, w, h, local, bg);
      kind[i] = k === 'core' ? 1 : k === 'edge' ? 2 : 0;
    }
    const keep = new Uint8Array(s.on.length);
    for (const comp of segmentCells(kind, s.cols, s.rows)) if (comp.core >= MIN_PICTURE_CELLS) for (const i of comp.cells) keep[i] = 1;
    let freed = 0;
    for (let i = 0; i < s.on.length; i++) if (s.on[i] && !keep[i]) (s.on[i] = 0), (s.miss[i] = 0), freed++;
    if (freed && debug) log(`content: pane ${p.id}: content replaced, ${freed} cell(s) of plain page / text released at once`);
    return freed > 0;
  }

  /** a picture's content in 64 numbers (8 x 8 means, quantized) plus its shape: equal pictures, equal key */
  function signature(g, w, h, r) {
    const x0 = Math.floor(r.x * w), y0 = Math.floor(r.y * h), x1 = Math.ceil((r.x + r.w) * w), y1 = Math.ceil((r.y + r.h) * h);
    let key = `${Math.round(((x1 - x0) / Math.max(1, y1 - y0)) * 10)}:`;
    for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) {
      const ya = y0 + Math.floor(((y1 - y0) * by) / 8), yb = y0 + Math.floor(((y1 - y0) * (by + 1)) / 8);
      const xa = x0 + Math.floor(((x1 - x0) * bx) / 8), xb = x0 + Math.floor(((x1 - x0) * (bx + 1)) / 8);
      let sum = 0, n = 0;
      for (let y = ya; y < yb; y += 2) for (let x = xa; x < xb; x += 2) (sum += g[y * w + x]), n++;
      key += ((n ? sum / n : 0) >> 4).toString(16);
    }
    return key;
  }

  /** what a cell (normalized rect, snapshot coordinates) holds on a page: 'core' picture, 'edge' or nothing */
  function cellKind(g, w, h, r, bg) {
    const share = contentShare(g, w, h, r, bg);
    return share >= CORE_SHARE ? 'core' : share >= EDGE_SHARE ? 'edge' : false;
  }

  /** mean brightness change inside a box between two gray frames */
  function meanDiff(a, b, W, H, box, d = null) {
    const x0 = Math.max(0, Math.floor(box.x * W)), x1 = Math.min(W, Math.ceil((box.x + box.w) * W));
    const y0 = Math.max(0, Math.floor(box.y * H)), y1 = Math.min(H, Math.ceil((box.y + box.h) * H));
    const sx = d ? Math.round(d.dx * W) : 0, sy = d ? Math.round(d.dy * H) : 0; // where the content went
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      const yy = y + sy;
      if (yy < 0 || yy >= H) continue;
      for (let x = x0; x < x1; x++) {
        const xx = x + sx;
        if (xx < 0 || xx >= W) continue;
        sum += Math.abs(a[y * W + x] - b[yy * W + xx]);
        n++;
      }
    }
    return n > 0.3 * (x1 - x0) * (y1 - y0) ? sum / n : 0; // mostly scrolled off: not "replaced"
  }

  /** every frame: each pane and text area follows its content (scrolling, a moving window) */
  function follow() {
    if (!panes.length && !textAreas.length) return void (prevGray = null);
    const cur = sampler.gray();
    if (prevGray) {
      const W = sampler.grayWidth, H = sampler.grayHeight;
      let left = false, released = false;
      for (const p of panes) {
        const box = bbox(p.shape, true);
        if (!box) continue;
        const d = trackBox(prevGray, cur, W, H, box, 24, 12);
        // replaced: the content differs even after following the motion the tracker reports (on a totally
        // different screen it can still "find" a shift)
        if (!p.pending && meanDiff(prevGray, cur, W, H, box, d) > REPLACED_DIFF) {
          p.urgent = true;
          p.urgentAt = performance.now();
          if (quickRelease(p, box)) released = true;
          continue;
        }
        if (!d || (!d.dx && !d.dy)) continue;
        if (!moveBox(box, d)) {
          p.gone = true; // scrolled off screen
          left = true;
          continue;
        }
        shift(p.shape, d.dx, d.dy);
        p.mx += d.dx;
        p.my += d.dy;
      }
      for (const a of textAreas) {
        const d = trackBox(prevGray, cur, W, H, a.rect, 24, 12);
        if (d && (d.dx || d.dy)) a.rect = moveBox(a.rect, d) ?? a.rect;
      }
      if (left) panes = panes.filter((p) => !p.gone);
      if (released) onUpdate();
    }
    prevGray = cur;
  }

  /**
   * text: the band of rows (full width) that changed since the last OCR, padded by one grid row; null when
   * nothing changed. Whole screen on the first check.
   */
  function changedBand(grid) {
    if (!textRef) return { y0: 0, y1: 1 };
    let r0 = GRID_H, r1 = -1;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const p = (y * GRID_W + x) * 4;
        if (Math.abs(grid[p] - textRef[p]) + Math.abs(grid[p + 1] - textRef[p + 1]) + Math.abs(grid[p + 2] - textRef[p + 2]) > 12) {
          r0 = Math.min(r0, y);
          r1 = Math.max(r1, y);
          break;
        }
      }
    }
    if (r1 < 0) return null;
    return { y0: Math.max(0, (r0 - 1) / GRID_H), y1: Math.min(1, (r1 + 2) / GRID_H) };
  }
}
