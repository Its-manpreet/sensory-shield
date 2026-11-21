// OWNER: Agent A. Hides written words from the picture model. MobileCLIP reads text: a heading "Spiders", a
// link "guns for sale" or a chat message saying "spider" scores like a photo of one. Before a hit is believed,
// the text lines in that area are found (on-device OCR, boxes only) and painted over with the colour around
// them, then the area is scored again. Pixels stay in memory; the OCR returns boxes, never the words.

/** @typedef {{x:number, y:number, w:number, h:number}} Rect  normalized 0..1 */

/**
 * Paint over the text lines inside `rect` of a canvas.
 * @param {OffscreenCanvasRenderingContext2D|CanvasRenderingContext2D} ctx
 * @param {number} W canvas width  @param {number} H canvas height
 * @param {Rect} rect  normalized area to clean
 * @param {(frame: { width: number, height: number, gray: Uint8Array }) => Promise<{ boxes: Rect[], available?: boolean }>} findBoxes
 * @returns {Promise<number>} lines painted over; -1 when text detection is not available on this system
 */
export async function maskText(ctx, W, H, rect, findBoxes) {
  const x0 = Math.max(0, Math.floor(rect.x * W)), y0 = Math.max(0, Math.floor(rect.y * H));
  const x1 = Math.min(W, Math.ceil((rect.x + rect.w) * W)), y1 = Math.min(H, Math.ceil((rect.y + rect.h) * H));
  const w = x1 - x0, h = y1 - y0;
  if (w < 16 || h < 16) return 0;
  const d = ctx.getImageData(x0, y0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  let r;
  try {
    r = await findBoxes({ width: w, height: h, gray });
  } catch {
    return -1;
  }
  if (!r || r.available === false) return -1;
  let n = 0;
  for (const b of r.boxes ?? []) {
    // a "line" covering much of the area is more likely a picture with lettering than text: leave it
    if (b.w * b.h > 0.25) continue;
    const bh = b.h * h;
    // OCR boxes hug the letters; cover ascenders, descenders and a little margin
    const fx0 = Math.max(0, Math.floor(b.x * w - 0.3 * bh)), fx1 = Math.min(w, Math.ceil((b.x + b.w) * w + 0.3 * bh));
    const fy0 = Math.max(0, Math.floor(b.y * h - 0.25 * bh)), fy1 = Math.min(h, Math.ceil((b.y + b.h) * h + 0.25 * bh));
    if (fx1 - fx0 < 2 || fy1 - fy0 < 2) continue;
    const ring = ringColor(d, w, h, fx0, fy0, fx1, fy1);
    // words sit on a plain background (page, bubble, button); "text" found in a busy photo (scales, fur,
    // leaves) is the OCR seeing patterns: painting there would cut into the very picture we look for
    if (!ring) continue;
    const [cr, cg, cb] = ring;
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(x0 + fx0, y0 + fy0, fx1 - fx0, fy1 - fy0);
    n++;
  }
  return n;
}

/**
 * Per-channel median of the pixels just outside a box: the background the text sits on. null when that
 * ring is not one plain colour (more than 40% of it far from the median).
 */
function ringColor(d, w, h, x0, y0, x1, y1) {
  const rs = [], gs = [], bs = [];
  const add = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = (y * w + x) * 4;
    rs.push(d[p]), gs.push(d[p + 1]), bs.push(d[p + 2]);
  };
  const stepX = Math.max(1, Math.floor((x1 - x0) / 60)), stepY = Math.max(1, Math.floor((y1 - y0) / 20));
  for (let x = x0; x < x1; x += stepX) add(x, y0 - 1), add(x, y1);
  for (let y = y0; y < y1; y += stepY) add(x0 - 1, y), add(x1, y);
  if (!rs.length) return null;
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const m = [med(rs), med(gs), med(bs)];
  let off = 0;
  for (let i = 0; i < rs.length; i++) if (Math.abs(rs[i] - m[0]) + Math.abs(gs[i] - m[1]) + Math.abs(bs[i] - m[2]) > 60) off++;
  // up to 40% may differ: in tightly spaced text the ring touches the neighbouring lines
  return off > 0.4 * rs.length ? null : m;
}
