// OWNER: Agent A. Effects renderer. Contract: docs/INTERFACES.md section 3.
// A transparent window cannot blur other apps' pixels, so we draw our OWN processed copy of the captured
// frame over each region. Nothing is stored beyond a tiny running average of the current screen.
//
// Glass fog (default for flashing, and for content blur): the screen is kept as a small (192x108)
// TIME-SMOOTHED average: every frame moves each pixel a little toward the new frame (time constant
// smoothMs). Flashing therefore becomes a slow, low-contrast colour drift. That average is blurred and
// drawn under a frosted, lightly tinted rounded panel, like a sheet of fogged glass.

// The flash detector already holds protection while it matters and releases a paused/still area fast;
// this only bridges a frame or two of jitter before fading out.
const HOLD_MS = 100;
// Protection appears fast (every extra frame of a flash matters) and leaves at the profile's fade time.
const FADE_IN_MAX_MS = 120;
const SMOOTH_W = 192;
const SMOOTH_H = 108;

/** @typedef {import('../shared/types.js').Region} Region */

/**
 * @param {HTMLCanvasElement} canvas  full-screen canvas in the overlay
 * @param {HTMLVideoElement} video    captured screen
 * @param {{ fadeMs?: number, cssSize?: () => [number, number], flashStyle?: 'glass'|'dim', smoothMs?: number }} [opts]
 */
export function createEffects(canvas, video, opts = {}) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  let fadeMs = opts.fadeMs ?? 300;
  let flashStyle = opts.flashStyle ?? 'glass';
  let smoothMs = opts.smoothMs ?? 900;
  let labelsVisible = true;
  let revealUntil = 0;
  let lastDraw = performance.now();
  /** @type {Map<string, {region: Region, alpha: number, seenAt: number, frozen: HTMLCanvasElement|null}>} */
  const live = new Map();

  // --- time smoothing: Float32 running average (8-bit canvases cannot hold small per-frame steps) ---
  const grab = new OffscreenCanvas(SMOOTH_W, SMOOTH_H);
  const gctx = /** @type {OffscreenCanvasRenderingContext2D} */ (grab.getContext('2d', { willReadFrequently: true }));
  const avg = new Float32Array(SMOOTH_W * SMOOTH_H * 4);
  const avgImage = new ImageData(SMOOTH_W, SMOOTH_H);
  const fog = document.createElement('canvas'); // blurred average, drawn scaled up under the glass
  Object.assign(fog, { width: SMOOTH_W, height: SMOOTH_H });
  const fctx = /** @type {CanvasRenderingContext2D} */ (fog.getContext('2d'));
  const avgCanvas = new OffscreenCanvas(SMOOTH_W, SMOOTH_H);
  const actx = /** @type {OffscreenCanvasRenderingContext2D} */ (avgCanvas.getContext('2d'));
  let avgReady = false;

  function updateAverage(dt) {
    if (!video.videoWidth) return;
    gctx.drawImage(video, 0, 0, SMOOTH_W, SMOOTH_H);
    const cur = gctx.getImageData(0, 0, SMOOTH_W, SMOOTH_H).data;
    const k = avgReady ? 1 - Math.exp(-dt / Math.max(16, smoothMs)) : 1;
    const out = avgImage.data;
    for (let i = 0; i < avg.length; i++) {
      avg[i] += (cur[i] - avg[i]) * k;
      out[i] = avg[i];
    }
    avgReady = true;
    actx.putImageData(avgImage, 0, 0);
    fctx.clearRect(0, 0, SMOOTH_W, SMOOTH_H);
    fctx.filter = 'blur(2.5px) saturate(1.35)';
    // draw slightly enlarged so the blur does not darken the edges
    fctx.drawImage(avgCanvas, -6, -6, SMOOTH_W + 12, SMOOTH_H + 12);
    fctx.filter = 'none';
  }

  // subtle grain: real frosted glass is never perfectly smooth, and grain hides upscaling softness
  const noise = document.createElement('canvas');
  Object.assign(noise, { width: 128, height: 128 });
  {
    const n = noise.getContext('2d');
    const img = n.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data.set([v, v, v, 255], i);
    }
    n.putImageData(img, 0, 0);
  }
  const noisePattern = ctx.createPattern(noise, 'repeat');

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

  /** one frosted glass panel over canvas-pixel rect d */
  function paintGlass(d, alpha, { radius, contrast = 1, blurPx = 0, tint = 0, saturate = 1 }) {
    const [x, y, w, h] = d;
    if (w < 2 || h < 2) return;
    const dpr = devicePixelRatio;
    const r = Math.min(radius * dpr, w / 2, h / 2);
    ctx.save();
    ctx.globalAlpha = alpha;

    // soft shadow lifts the panel off the page
    ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
    ctx.shadowBlur = 30 * dpr;
    ctx.shadowOffsetY = 8 * dpr;
    ctx.fillStyle = 'rgba(128, 128, 128, 1)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.clip();
    // the fogged, time-smoothed screen behind the glass, aligned with the real screen
    ctx.imageSmoothingQuality = 'high';
    const filters = [];
    if (contrast !== 1) filters.push(`contrast(${contrast})`);
    if (saturate !== 1) filters.push(`saturate(${saturate})`);
    if (blurPx) filters.push(`blur(${Math.round(blurPx * dpr)}px)`);
    if (filters.length) ctx.filter = filters.join(' ');
    ctx.drawImage(fog, 0, 0, SMOOTH_W, SMOOTH_H, 0, 0, canvas.width, canvas.height);
    ctx.filter = 'none';

    // milky tint with a gentle top-left sheen
    const sheen = ctx.createLinearGradient(x, y, x + w, y + h);
    sheen.addColorStop(0, `rgba(255, 255, 255, ${0.3 + tint})`);
    sheen.addColorStop(0.5, `rgba(255, 255, 255, ${0.16 + tint})`);
    sheen.addColorStop(1, `rgba(255, 255, 255, ${0.1 + tint})`);
    ctx.fillStyle = sheen;
    ctx.fillRect(x, y, w, h);

    ctx.globalAlpha = alpha * 0.045;
    ctx.fillStyle = noisePattern;
    ctx.fillRect(x, y, w, h);

    // hairline edge highlight, like light catching the glass
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.roundRect(x + 0.5 * dpr, y + 0.5 * dpr, w - dpr, h - dpr, r);
    ctx.stroke();
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

  /** flashing regions merge into one glass panel over their bounding box */
  function drawFlashGlass(entries) {
    if (!entries.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, a = 0;
    for (const e of entries) {
      const [x, y, w, h] = px(e.region.rect).d;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
      a = Math.max(a, e.alpha);
    }
    // stronger smoothing + lower contrast for flashes: the whole point is to calm them; red and red/blue
    // colour flicker also has its colour drained out
    const desat = entries.some((e) => e.region.style === 'desaturate');
    paintGlass([x0, y0, x1 - x0, y1 - y0], a, { radius: 22, contrast: 0.7, saturate: desat ? 0.15 : 1 });
    return { rect: { x: x0 / canvas.width, y: y0 / canvas.height, w: (x1 - x0) / canvas.width, h: (y1 - y0) / canvas.height }, alpha: a };
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
    ctx.font = `500 ${13 * dpr}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif`;
    const padX = 12 * dpr, h = 28 * dpr, dot = 7 * dpr;
    const w = Math.min(d[2] - 24 * dpr, ctx.measureText(text).width + 2 * padX + dot + 8 * dpr);
    if (w < 60 * dpr || d[3] < h + 24 * dpr) return ctx.restore();
    const x = d[0] + 14 * dpr, y = d[1] + 14 * dpr;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
    ctx.shadowBlur = 12 * dpr;
    ctx.fillStyle = 'rgba(250, 250, 252, 0.78)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = dpr;
    ctx.stroke();
    ctx.fillStyle = 'rgba(47, 111, 100, 0.95)';
    ctx.beginPath();
    ctx.arc(x + padX + dot / 2, y + h / 2, dot / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(28, 32, 38, 0.92)';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX + dot + 8 * dpr, y + h / 2 + 0.5 * dpr, w - 2 * padX - dot - 8 * dpr);
    ctx.restore();
  }

  /** draw one frame; call on every animation frame */
  function draw(nowMs = performance.now()) {
    resize();
    const dt = Math.max(0, nowMs - lastDraw);
    lastDraw = nowMs;
    updateAverage(dt); // keeps running so the average is already settled when protection starts
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!video.videoWidth) return;
    const stepOut = fadeMs > 0 ? dt / fadeMs : 1;
    const stepIn = Math.max(stepOut, dt / FADE_IN_MAX_MS);
    const revealing = nowMs < revealUntil;
    const dims = [], glass = [], labels = [];
    for (const [id, e] of live) {
      const wanted = !revealing && nowMs - e.seenAt <= HOLD_MS;
      e.alpha = Math.max(0, Math.min(1, e.alpha + (wanted ? stepIn : -stepOut)));
      if (e.alpha === 0) {
        if (!wanted && nowMs - e.seenAt > HOLD_MS) live.delete(id);
        continue;
      }
      const { effect } = e.region;
      if (effect === 'blur') {
        const [x, y, w, h] = px(e.region.rect).d;
        const inset = 4 * devicePixelRatio; // neighbouring tiles read as separate frosted panes
        // content the user asked to hide: much heavier than the flash glass, so shapes are not recognisable
        const k = e.region.strength;
        paintGlass([x + inset, y + inset, w - 2 * inset, h - 2 * inset], e.alpha, { radius: 16, blurPx: 14 + 30 * k, tint: 0.12 + 0.1 * k });
        if (labelsVisible && e.region.reason) labels.push({ rect: e.region.rect, reason: e.region.reason, alpha: e.alpha });
      } else if (effect === 'freeze') drawFreeze(e, e.alpha);
      else (flashStyle === 'glass' ? glass : dims).push(e);
    }
    drawDims(dims);
    const panel = drawFlashGlass(glass);
    if (labelsVisible) {
      if (panel) labels.push({ rect: panel.rect, reason: glass[0].region.reason, alpha: panel.alpha });
      else if (dims.length) labels.push({ rect: dims[0].region.rect, reason: dims[0].region.reason, alpha: dims[0].alpha });
    }
    // one label per distinct reason, top-left first, so a protected area is not covered in labels
    const seen = new Set();
    labels.sort((p, q) => p.rect.y - q.rect.y || p.rect.x - q.rect.x);
    for (const l of labels) {
      if (!l.reason || seen.has(l.reason)) continue;
      seen.add(l.reason);
      drawLabel(l.rect, l.reason, l.alpha);
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
    /** @param {{ fadeMs?: number, flashStyle?: 'glass'|'dim', smoothMs?: number }} s */
    setStyle(s) {
      if (s.fadeMs != null) fadeMs = s.fadeMs;
      if (s.flashStyle) flashStyle = s.flashStyle;
      if (s.smoothMs != null) smoothMs = s.smoothMs;
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
