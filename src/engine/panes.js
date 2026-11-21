// OWNER: Agent C. Pure geometry for content panes (no DOM, unit tested in test/content-panes.test.js).
// One pane per object: flagged tiles that touch become ONE big pane at once (nothing is missed), then the
// pane fits the picture it found: inside the pane, dense image blocks that stand out from the page background
// are found (text is sparse and does not count), their edges snap to the exact border, and the model confirms
// which block holds the trigger. Panes grow at once and glide when they shrink.
// (Shrinking by cutting sides while the model still sees the trigger was tried and dropped: the model
// recognises a gun from a fragment, so panes shrank onto the barrel. Live fit IoU 0.23.)

/** @typedef {{x:number, y:number, w:number, h:number}} Rect  normalized 0..1 */

export const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);

export function intersect(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function union(a, b) {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

export function iou(a, b) {
  const i = intersect(a, b);
  return i ? area(i) / (area(a) + area(b) - area(i)) : 0;
}

/** share of `a` covered by `b` */
export const coveredBy = (a, b) => {
  const i = intersect(a, b);
  return i ? area(i) / (area(a) || 1) : 0;
};

export function clamp01(r) {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, w: Math.max(0, Math.min(1, r.x + r.w) - x), h: Math.max(0, Math.min(1, r.y + r.h) - y) };
}

/** grow by k of its size on every side (k < 0 shrinks) */
export const pad = (r, k) => clamp01({ x: r.x - r.w * k, y: r.y - r.h * k, w: r.w * (1 + 2 * k), h: r.h * (1 + 2 * k) });

/**
 * Rects that overlap or touch (within `gap`) end up in one group; each group becomes one pane.
 * @template {{ rect: Rect }} T @param {T[]} items @returns {T[][]}
 */
export function groupTouching(items, gap = 0.005) {
  const groups = items.map((it) => [it]);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length && !merged; j++) {
        if (groups[i].some((a) => groups[j].some((b) => intersect(a.rect, { x: b.rect.x - gap, y: b.rect.y - gap, w: b.rect.w + 2 * gap, h: b.rect.h + 2 * gap })))) {
          groups[i].push(...groups.splice(j, 1)[0]);
          merged = true;
        }
      }
    }
  }
  return groups;
}

export const unionAll = (rects) => rects.reduce((u, r) => (u ? union(u, r) : r), null);

/**
 * Pictures inside `region` of a page: connected areas of dense "not page background" blocks. Text is sparse
 * (letters cover well under the density bar) so it does not form blocks; photos, videos and drawings do.
 * Returns null when the region has no clear page background around it (it sits inside a full-screen photo or
 * video): structure cannot tell where the object ends there.
 * @param {Uint8Array} gray W*H grayscale  @param {Rect} region normalized
 * @returns {Rect[]|null} normalized, largest first, edges snapped to the picture border
 */
export function findPictures(gray, W, H, region, { block = 4, dense = 0.75, diff = 12, minBlocks = 36, bgRegion = region } = {}) {
  const px = (r) => ({
    x0: Math.max(0, Math.floor(r.x * W)), y0: Math.max(0, Math.floor(r.y * H)),
    x1: Math.min(W, Math.ceil((r.x + r.w) * W)), y1: Math.min(H, Math.ceil((r.y + r.h) * H)),
  });
  const { x0, y0, x1, y1 } = px(region);
  if (x1 - x0 < 4 * block || y1 - y0 < 4 * block) return null;
  // page background: the most common brightness along the frame of bgRegion (a ring wider than the search
  // area, so a big photo the area sits inside is not mistaken for the page)
  const hist = new Uint32Array(256);
  let frame = 0;
  const f = px(bgRegion);
  const add = (x, y) => (hist[gray[y * W + x]]++, frame++);
  for (let x = f.x0; x < f.x1; x++) add(x, f.y0), add(x, f.y1 - 1);
  for (let y = f.y0; y < f.y1; y++) add(f.x0, y), add(f.x1 - 1, y);
  let bg = 0, best = 0;
  for (let v = 0; v < 256; v++) {
    let n = 0;
    for (let d = -6; d <= 6; d++) n += hist[v + d] ?? 0;
    if (n > best) (best = n), (bg = v);
  }
  if (best < 0.5 * frame) return null;
  // dense blocks
  const bw = Math.floor((x1 - x0) / block), bh = Math.floor((y1 - y0) / block);
  const on = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let n = 0;
    for (let y = 0; y < block; y++) for (let x = 0; x < block; x++) if (Math.abs(gray[(y0 + by * block + y) * W + x0 + bx * block + x] - bg) > diff) n++;
    on[by * bw + bx] = n >= dense * block * block ? 1 : 0;
  }
  // close 1-block holes (a flat patch inside a photo that matches the page colour)
  const closed = on.slice();
  for (let by = 1; by < bh - 1; by++) for (let bx = 1; bx < bw - 1; bx++) {
    const i = by * bw + bx;
    if (!on[i] && ((on[i - 1] && on[i + 1]) || (on[i - bw] && on[i + bw]))) closed[i] = 1;
  }
  // connected components -> bounding boxes
  const seen = new Uint8Array(bw * bh);
  const out = [];
  for (let start = 0; start < closed.length; start++) {
    if (!closed[start] || seen[start]) continue;
    let n = 0, bx0 = bw, by0 = bh, bx1 = -1, by1 = -1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop(), bx = i % bw, by = (i / bw) | 0;
      n++;
      bx0 = Math.min(bx0, bx), by0 = Math.min(by0, by), bx1 = Math.max(bx1, bx), by1 = Math.max(by1, by);
      for (const j of [bx > 0 ? i - 1 : -1, bx < bw - 1 ? i + 1 : -1, i - bw, i + bw]) if (j >= 0 && j < closed.length && closed[j] && !seen[j]) (seen[j] = 1), stack.push(j);
    }
    if (n < minBlocks) continue;
    const r = { x: (x0 + bx0 * block) / W, y: (y0 + by0 * block) / H, w: ((bx1 - bx0 + 1) * block) / W, h: ((by1 - by0 + 1) * block) / H };
    out.push(snapEdges(gray, W, H, r, { out: 0.06, inward: 0.03 }));
  }
  return out.sort((a, b) => area(b) - area(a));
}

/**
 * The page background around `rect`: the most common brightness on the frame of `rect` (within +-6 levels),
 * or null when that frame is not mostly one colour (inside a full-screen photo or video: no page).
 * @returns {number|null}
 */
export function pageBackground(gray, W, H, rect) {
  const x0 = Math.max(0, Math.floor(rect.x * W)), y0 = Math.max(0, Math.floor(rect.y * H));
  const x1 = Math.min(W, Math.ceil((rect.x + rect.w) * W)), y1 = Math.min(H, Math.ceil((rect.y + rect.h) * H));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let x = x0; x < x1; x++) hist[gray[y0 * W + x]]++, hist[gray[(y1 - 1) * W + x]]++, (n += 2);
  for (let y = y0; y < y1; y++) hist[gray[y * W + x0]]++, hist[gray[y * W + x1 - 1]]++, (n += 2);
  let bg = 0, best = 0;
  for (let v = 0; v < 256; v++) {
    let k = 0;
    for (let d = -6; d <= 6; d++) k += hist[v + d] ?? 0;
    if (k > best) (best = k), (bg = v);
  }
  return best >= 0.5 * n ? bg : null;
}

/**
 * Share of `rect` that is picture, as findPictures judges it: small blocks (block x block pixels) of which at
 * least `dense` differ from the page background. Letters are thin strokes and never fill a block, so text
 * (even when the OCR missed it) scores ~0; photos and solid objects score high.
 */
export function contentShare(gray, W, H, rect, bg, { block = 4, dense = 0.75, diff = 12 } = {}) {
  const x0 = Math.max(0, Math.floor(rect.x * W)), y0 = Math.max(0, Math.floor(rect.y * H));
  const x1 = Math.min(W, Math.ceil((rect.x + rect.w) * W)), y1 = Math.min(H, Math.ceil((rect.y + rect.h) * H));
  let n = 0, hit = 0;
  for (let by = y0; by + block <= y1; by += block) for (let bx = x0; bx + block <= x1; bx += block, n++) {
    let k = 0;
    for (let y = by; y < by + block; y++) for (let x = bx; x < bx + block; x++) if (Math.abs(gray[y * W + x] - bg) > diff) k++;
    if (k >= dense * block * block) hit++;
  }
  return n ? hit / n : 0;
}

/** share of the pixels in `rect` that differ from the page background by more than `diff` levels */
export function inkShare(gray, W, H, rect, bg, diff = 12) {
  const x0 = Math.max(0, Math.floor(rect.x * W)), y0 = Math.max(0, Math.floor(rect.y * H));
  const x1 = Math.min(W, Math.ceil((rect.x + rect.w) * W)), y1 = Math.min(H, Math.ceil((rect.y + rect.h) * H));
  let n = 0, hit = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) if (Math.abs(gray[y * W + x] - bg) > diff) hit++;
  return n ? hit / n : 0;
}

/**
 * Pictures in and around `base`. A picture that touches the edge of the searched area may be bigger than the
 * area (a tall photo the flagged tiles only half cover): search a wider area, up to twice.
 * @returns {Rect[]|null} up to 4 pictures that overlap `base`; null when there is no page background around
 *   (inside a full-screen photo or video)
 */
export function picturesAround(gray, W, H, base) {
  let prev = [];
  for (const k of [0.08, 0.4, 1]) {
    const region = pad(base, k);
    const all = findPictures(gray, W, H, region, { bgRegion: pad(base, Math.max(0.6, k)) });
    if (all === null) return k === 0.08 ? null : prev.slice(0, 4);
    const found = all.filter((r) => intersect(r, base) && area(intersect(r, base)) > 0.3 * Math.min(area(r), area(base)));
    const eps = 2 / W;
    const touches = (r) =>
      (r.x <= region.x + eps && region.x > 0) || (r.y <= region.y + eps && region.y > 0) ||
      (r.x + r.w >= region.x + region.w - eps && region.x + region.w < 1) || (r.y + r.h >= region.y + region.h - eps && region.y + region.h < 1);
    if (!found.some(touches) || k === 1) return found.filter((r) => !touches(r) || k === 1).slice(0, 4);
    prev = found;
  }
  return [];
}

/**
 * Snap each side of `box` to a straight border nearby (the edge of a photo or video on a page): a row/column
 * where most of the pixels along that side jump in brightness. Searches outward up to `out` and inward up to
 * `inward` of the box size. Sides with no clear border keep their place.
 * @param {Uint8Array} gray  W*H grayscale
 */
export function snapEdges(gray, W, H, box, { out = 0.2, inward = 0.06, minJump = 14, minShare = 0.6 } = {}) {
  const px = { x0: box.x * W, x1: (box.x + box.w) * W, y0: box.y * H, y1: (box.y + box.h) * H };
  /** share of positions along the side where brightness jumps at line `k` (between k-1 and k) */
  const colScore = (x, y0, y1) => {
    if (x < 1 || x >= W) return 0;
    let n = 0, hit = 0;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++, n++) if (Math.abs(gray[y * W + x] - gray[y * W + x - 1]) >= minJump) hit++;
    return n ? hit / n : 0;
  };
  const rowScore = (y, x0, x1) => {
    if (y < 1 || y >= H) return 0;
    let n = 0, hit = 0;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++, n++) if (Math.abs(gray[y * W + x] - gray[(y - 1) * W + x]) >= minJump) hit++;
    return n ? hit / n : 0;
  };
  const search = (from, dirOut, size, score) => {
    const a = Math.round(from - dirOut * inward * size), b = Math.round(from + dirOut * out * size);
    let best = null;
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) {
      const s = score(k);
      // the strongest border; on a tie the outer one (covering more is the safe side)
      if (s >= minShare && (!best || s > best.s + 0.05 || (Math.abs(s - best.s) <= 0.05 && dirOut * (k - best.k) > 0))) best = { k, s };
    }
    return best ? best.k : from;
  };
  const x0 = search(px.x0, -1, box.w * W, (k) => colScore(k, px.y0, px.y1));
  const x1 = search(px.x1, +1, box.w * W, (k) => colScore(k, px.y0, px.y1));
  const y0 = search(px.y0, -1, box.h * H, (k) => rowScore(k, px.x0, px.x1));
  const y1 = search(px.y1, +1, box.h * H, (k) => rowScore(k, px.x0, px.x1));
  return clamp01({ x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H });
}

/**
 * Animate the drawn pane toward its target: a side that must move OUT jumps at once (never uncover), a side
 * that moves IN glides (time constant tauMs).
 */
export function approach(shown, target, dtMs, tauMs = 110) {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  const s = { x0: shown.x, y0: shown.y, x1: shown.x + shown.w, y1: shown.y + shown.h };
  const t = { x0: target.x, y0: target.y, x1: target.x + target.w, y1: target.y + target.h };
  const x0 = t.x0 < s.x0 ? t.x0 : s.x0 + (t.x0 - s.x0) * k;
  const y0 = t.y0 < s.y0 ? t.y0 : s.y0 + (t.y0 - s.y0) * k;
  const x1 = t.x1 > s.x1 ? t.x1 : s.x1 + (t.x1 - s.x1) * k;
  const y1 = t.y1 > s.y1 ? t.y1 : s.y1 + (t.y1 - s.y1) * k;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
