// OWNER: Agent A. Effects renderer. Contract: docs/INTERFACES.md section 3.
// A transparent window cannot blur other apps' pixels, so we draw our OWN processed copy of the captured
// frame over each region: blur = downscale + upscale + small blur filter (cheap), dim = dark veil,
// freeze = the region as it looked when protection started. Nothing is stored beyond the current frame.

const HOLD_MS = 800; // a region that disappears from setRegions stays this long before fading out
const SMALL = 1 / 12; // blur works on a 1/12-size copy: cheaper and softer than a large-radius filter

/** @typedef {import('../shared/types.js').Region} Region */

/**
 * @param {HTMLCanvasElement} canvas  full-screen canvas in the overlay
 * @param {HTMLVideoElement} video    captured screen
 * @param {{ fadeMs?: number, cssSize?: () => [number, number] }} [opts]  cssSize: canvas size in CSS px (default: window)
 */
export function createEffects(canvas, video, opts = {}) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const small = document.createElement('canvas');
  const sctx = /** @type {CanvasRenderingContext2D} */ (small.getContext('2d'));
  let fadeMs = opts.fadeMs ?? 300;
  let labelsVisible = true;
  let revealUntil = 0;
  let lastDraw = performance.now();
  /** @type {Map<string, {region: Region, alpha: number, seenAt: number, frozen: HTMLCanvasElement|null}>} */
  const live = new Map();

  function resize() {
    const [cw, ch] = opts.cssSize ? opts.cssSize() : [innerWidth, innerHeight];
    const w = Math.round(cw * devicePixelRatio);
    const h = Math.round(ch * devicePixelRatio);
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  }

  /** normalized rect -> [sx, sy, sw, sh] in video pixels and [dx, dy, dw, dh] in canvas pixels */
  function px(rect) {
    const vw = video.videoWidth, vh = video.videoHeight, cw = canvas.width, ch = canvas.height;
    return {
      s: [rect.x * vw, rect.y * vh, Math.max(1, rect.w * vw), Math.max(1, rect.h * vh)],
      d: [Math.round(rect.x * cw), Math.round(rect.y * ch), Math.round(rect.w * cw), Math.round(rect.h * ch)],
    };
  }

  function drawBlur(rect, strength, alpha) {
    const { s, d } = px(rect);
    const k = SMALL * (1.2 - strength); // stronger blur -> smaller copy
    small.width = Math.max(2, Math.round(d[2] * k));
    small.height = Math.max(2, Math.round(d[3] * k));
    sctx.drawImage(video, ...s, 0, 0, small.width, small.height);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.rect(...d);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = `blur(${Math.round(4 + 12 * strength)}px)`;
    // draw a little larger than the clip so the blurred edges are not transparent
    const m = 24;
    ctx.drawImage(small, d[0] - m, d[1] - m, d[2] + 2 * m, d[3] + 2 * m);
    ctx.filter = 'none';
    ctx.fillStyle = `rgba(30, 34, 40, ${0.25 * strength})`;
    ctx.fillRect(...d);
    ctx.restore();
  }

  /** all dim rects are filled as ONE path, so overlapping rects do not stack into darker seams */
  function drawDims(entries) {
    if (!entries.length) return;
    ctx.beginPath();
    let a = 0;
    for (const e of entries) {
      ctx.rect(...px(e.region.rect).d);
      a = Math.max(a, Math.min(0.97, e.region.strength) * e.alpha);
    }
    ctx.fillStyle = `rgba(12, 14, 18, ${a})`;
    ctx.fill('nonzero');
  }

  function drawFreeze(entry, alpha) {
    const { s, d } = px(entry.region.rect);
    if (!entry.frozen) {
      entry.frozen = document.createElement('canvas');
      entry.frozen.width = Math.max(1, Math.round(s[2] / 4));
      entry.frozen.height = Math.max(1, Math.round(s[3] / 4));
      entry.frozen.getContext('2d').drawImage(video, ...s, 0, 0, entry.frozen.width, entry.frozen.height);
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.filter = 'blur(6px)';
    ctx.drawImage(entry.frozen, ...d);
    ctx.restore();
  }

  function drawLabel(rect, text, alpha) {
    const { d } = px(rect);
    const dpr = devicePixelRatio;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${13 * dpr}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const padX = 10 * dpr, h = 26 * dpr;
    const w = Math.min(d[2] - 16 * dpr, ctx.measureText(text).width + 2 * padX);
    if (w < 40 * dpr || d[3] < h + 16 * dpr) return ctx.restore();
    const x = d[0] + 8 * dpr, y = d[1] + 8 * dpr;
    ctx.fillStyle = 'rgba(245, 247, 250, 0.72)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(20, 24, 30, 0.9)';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX, y + h / 2, w - 2 * padX);
    ctx.restore();
  }

  /** draw one frame; call on every captured frame or animation frame */
  function draw(nowMs = performance.now()) {
    resize();
    const dt = Math.max(0, nowMs - lastDraw);
    lastDraw = nowMs;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const step = fadeMs > 0 ? dt / fadeMs : 1;
    const revealing = nowMs < revealUntil;
    const dims = [];
    const labels = [];
    for (const [id, e] of live) {
      const wanted = !revealing && nowMs - e.seenAt <= HOLD_MS;
      e.alpha = Math.max(0, Math.min(1, e.alpha + (wanted ? step : -step)));
      if (e.alpha === 0) {
        if (!wanted && nowMs - e.seenAt > HOLD_MS) live.delete(id);
        continue;
      }
      if (!video.videoWidth) continue;
      const { rect, effect, strength } = e.region;
      if (effect === 'blur') drawBlur(rect, strength, e.alpha);
      else if (effect === 'freeze') drawFreeze(e, e.alpha);
      else dims.push(e);
      if (labelsVisible && e.region.reason) labels.push(e);
    }
    drawDims(dims);
    // one label per distinct reason, on its top-left region, so a dimmed area is not covered in labels
    const seen = new Set();
    labels.sort((p, q) => p.region.rect.y - q.region.rect.y || p.region.rect.x - q.region.rect.x);
    for (const e of labels) {
      if (seen.has(e.region.reason)) continue;
      seen.add(e.region.reason);
      drawLabel(e.region.rect, e.region.reason, e.alpha);
    }
  }

  return {
    /** @param {Region[]} regions @param {number} nowMs */
    setRegions(regions, nowMs) {
      for (const r of regions) {
        const e = live.get(r.id);
        if (e) (e.region = r), (e.seenAt = nowMs);
        else live.set(r.id, { region: r, alpha: 0, seenAt: nowMs, frozen: null });
      }
    },
    /** @param {number} ms */
    revealAll(ms) {
      revealUntil = performance.now() + ms;
    },
    /** @param {boolean} b */
    setLabelsVisible(b) {
      labelsVisible = b;
    },
    // additions beyond the contract, used by overlay.js
    draw,
    setFadeMs(ms) {
      fadeMs = ms;
    },
    clear() {
      live.clear();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    get activeCount() {
      return live.size;
    },
  };
}
