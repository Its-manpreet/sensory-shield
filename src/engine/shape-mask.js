// OWNER: Agent C. Free-form blur panes (pure JS, no DOM, unit tested in test/shape-mask.test.js).
// A pane is a grid of small cells (1/128 x 1/72 of the screen, ~11 x 13 px on a laptop) that can take any
// shape: cells are painted on where a trigger is found, removed where re-checks no longer find it, and
// added at the edge where it continues. The grid has a free (sub-cell) origin so the pane can follow its
// content smoothly while it scrolls. Panes that overlap or come within one cell of each other become one.

/** @typedef {{x:number, y:number, w:number, h:number}} Rect  normalized 0..1 */
/**
 * @typedef {{ x: number, y: number, cols: number, rows: number, on: Uint8Array, miss: Uint8Array,
 *   alpha: Float32Array }} Shape
 *   x, y: top-left of cell 0 (normalized, may be fractional cells after motion); on: covered;
 *   miss: re-checks in a row that did not see the trigger; alpha: drawn opacity (animated by the caller)
 */

export const CW = 1 / 128;
export const CH = 1 / 72;

/** @param {Rect} rect @returns {Shape} */
export function createShape(rect) {
  const s = { x: Math.floor(rect.x / CW) * CW, y: Math.floor(rect.y / CH) * CH, cols: 0, rows: 0, on: new Uint8Array(0), miss: new Uint8Array(0), alpha: new Float32Array(0) };
  paintRect(s, rect);
  return s;
}

/** cell i as a normalized rect */
export function cellRect(s, i) {
  const c = i % s.cols, r = (i / s.cols) | 0;
  return { x: s.x + c * CW, y: s.y + r * CH, w: CW, h: CH };
}

/** grow the grid (keeping cells in place) so that columns c0..c1-1 and rows r0..r1-1 exist */
function ensure(s, c0, r0, c1, r1) {
  const addL = Math.max(0, -c0), addT = Math.max(0, -r0);
  const cols = Math.max(s.cols + addL, c1 + addL), rows = Math.max(s.rows + addT, r1 + addT);
  if (!addL && !addT && cols === s.cols && rows === s.rows) return { dc: 0, dr: 0 };
  const on = new Uint8Array(cols * rows), miss = new Uint8Array(cols * rows), alpha = new Float32Array(cols * rows);
  for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) {
    const a = r * s.cols + c, b = (r + addT) * cols + c + addL;
    on[b] = s.on[a], miss[b] = s.miss[a], alpha[b] = s.alpha[a];
  }
  Object.assign(s, { x: s.x - addL * CW, y: s.y - addT * CH, cols, rows, on, miss, alpha });
  return { dc: addL, dr: addT };
}

/**
 * Cover `rect`: every cell it overlaps by at least a quarter is turned on (covering a bit more is the safe
 * side). The grid grows as needed. Returns the number of cells newly turned on.
 */
export function paintRect(s, rect) {
  const fc0 = (rect.x - s.x) / CW, fr0 = (rect.y - s.y) / CH;
  const fc1 = (rect.x + rect.w - s.x) / CW, fr1 = (rect.y + rect.h - s.y) / CH;
  // cell c is covered when the rect overlaps it by >= 1/4: c >= fc0 - 3/4 and c <= fc1 - 1/4
  const e = 1e-6;
  let c0 = Math.ceil(fc0 - 0.75 - e), r0 = Math.ceil(fr0 - 0.75 - e), c1 = Math.floor(fc1 - 0.25 + e) + 1, r1 = Math.floor(fr1 - 0.25 + e) + 1;
  // a rect smaller than a cell still gets the cell under its centre
  if (c1 <= c0) (c0 = Math.floor((fc0 + fc1) / 2)), (c1 = c0 + 1);
  if (r1 <= r0) (r0 = Math.floor((fr0 + fr1) / 2)), (r1 = r0 + 1);
  const { dc, dr } = ensure(s, c0, r0, c1, r1);
  let n = 0;
  for (let r = r0 + dr; r < r1 + dr; r++) for (let c = c0 + dc; c < c1 + dc; c++) {
    const i = r * s.cols + c;
    if (!s.on[i]) n++;
    s.on[i] = 1;
    s.miss[i] = 0;
    s.alpha[i] = 1; // new cover appears at once: never let the trigger show while fading in
  }
  return n;
}

/** number of covered cells */
export function count(s) {
  let n = 0;
  for (let i = 0; i < s.on.length; i++) n += s.on[i];
  return n;
}

/** tight box around the covered cells (or around visible cells too, when `visible`); null when empty */
export function bbox(s, visible = false) {
  let c0 = Infinity, r0 = Infinity, c1 = -1, r1 = -1;
  for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) {
    const i = r * s.cols + c;
    if (!s.on[i] && !(visible && s.alpha[i] > 0)) continue;
    c0 = Math.min(c0, c), r0 = Math.min(r0, r), c1 = Math.max(c1, c), r1 = Math.max(r1, r);
  }
  if (c1 < 0) return null;
  return { x: s.x + c0 * CW, y: s.y + r0 * CH, w: (c1 - c0 + 1) * CW, h: (r1 - r0 + 1) * CH };
}

/** share of `rect` that is covered (cells sampled at their centres inside rect) */
export function coverOf(s, rect) {
  let hit = 0, n = 0;
  const steps = 8;
  for (let a = 0; a < steps; a++) for (let b = 0; b < steps; b++, n++) {
    const x = rect.x + ((a + 0.5) / steps) * rect.w, y = rect.y + ((b + 0.5) / steps) * rect.h;
    if (isOn(s, x, y)) hit++;
  }
  return hit / n;
}

/** is the point covered? */
export function isOn(s, x, y) {
  const c = Math.floor((x - s.x) / CW), r = Math.floor((y - s.y) / CH);
  return c >= 0 && r >= 0 && c < s.cols && r < s.rows && s.on[r * s.cols + c] === 1;
}

/**
 * Do two shapes overlap or come within `gap` cells of each other? (nearby panes become one)
 */
export function near(a, b, gap = 1) {
  const A = bbox(a), B = bbox(b);
  if (!A || !B) return false;
  const gx = gap * CW + 1e-9, gy = gap * CH + 1e-9;
  if (A.x > B.x + B.w + gx || B.x > A.x + A.w + gx || A.y > B.y + B.h + gy || B.y > A.y + A.h + gy) return false;
  // on a's lattice: at most `gap` empty cells between two covered cells = index distance <= gap + 1
  for (let i = 0; i < b.on.length; i++) {
    if (!b.on[i]) continue;
    const r = cellRect(b, i);
    const c = Math.floor((r.x + CW / 2 - a.x) / CW), rr = Math.floor((r.y + CH / 2 - a.y) / CH);
    for (let dr = -gap - 1; dr <= gap + 1; dr++) for (let dc = -gap - 1; dc <= gap + 1; dc++) {
      const cc = c + dc, r2 = rr + dr;
      if (cc >= 0 && r2 >= 0 && cc < a.cols && r2 < a.rows && a.on[r2 * a.cols + cc]) return true;
    }
  }
  return false;
}

/** paint every covered cell of b into a (on a's grid); b's cells keep their miss counts */
export function mergeInto(a, b) {
  for (let i = 0; i < b.on.length; i++) {
    if (!b.on[i]) continue;
    const r = cellRect(b, i);
    // the cell's middle half: lands on the one a-cell it mostly overlaps
    paintRect(a, { x: r.x + CW / 4, y: r.y + CH / 4, w: CW / 2, h: CH / 2 });
    const c = Math.floor((r.x + CW / 2 - a.x) / CW), rr = Math.floor((r.y + CH / 2 - a.y) / CH);
    if (c >= 0 && rr >= 0 && c < a.cols && rr < a.rows) a.miss[rr * a.cols + c] = b.miss[i];
  }
}

/** move with the content */
export function shift(s, dx, dy) {
  s.x += dx;
  s.y += dy;
}

/**
 * Without page structure (a full-screen photo or video): one round of re-checks in windows. probes: crops
 * that were scored, with the trigger's probability p on each. A covered cell is kept while a probe over it
 * still sees the trigger (p >= keepBar); after `clearAfter` misses in a row it is uncovered (one when its
 * content was replaced). A cell next to the cover is added when a probe over it clearly sees the trigger
 * (p >= growBar): the shape grows one cell per round along the object. Cells no probe looked at keep their
 * state. A cell is only uncovered when no neighbour still sees the trigger either: a one-cell safety margin,
 * because a small window over just a corner of the object may not recognise it.
 * pinned(cell): must stay covered (e.g. the nudity detector boxed it).
 * @param {Shape} s
 * @param {{ rect: Rect, p: number }[]} probes
 * @returns {{ removed: number, added: number }}
 */
export function applyProbes(s, probes, { keepBar, growBar, clearAfter = 2, pinned = () => false, replaced = () => false }) {
  ensure(s, -1, -1, s.cols + 1, s.rows + 1); // room to grow by one cell
  const was = s.on.slice();
  let removed = 0, added = 0;
  const dist = distanceTo(s, was, 1);
  const n = s.on.length;
  const bestAt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cell = cellRect(s, i);
    const cx = cell.x + CW / 2, cy = cell.y + CH / 2;
    let best = -1;
    for (const pr of probes) if (cx >= pr.rect.x && cx <= pr.rect.x + pr.rect.w && cy >= pr.rect.y && cy <= pr.rect.y + pr.rect.h) best = Math.max(best, pr.p);
    bestAt[i] = best;
  }
  // evidence: covered cells a probe still sees the trigger over (or that no probe looked at this round)
  const evidence = new Uint8Array(n);
  for (let i = 0; i < n; i++) evidence[i] = was[i] && (bestAt[i] < 0 || bestAt[i] >= keepBar || pinned(cellRect(s, i))) ? 1 : 0;
  const nearEvidence = distanceTo(s, evidence, 1);
  for (let i = 0; i < n; i++) {
    const best = bestAt[i];
    if (best < 0) continue; // not looked at this round
    const cell = cellRect(s, i);
    if (was[i]) {
      if (evidence[i]) s.miss[i] = 0;
      else if (nearEvidence[i] <= 1 && !replaced(cell)) s.miss[i] = 0; // the margin around what is still seen
      else if (++s.miss[i] >= clearAfter || replaced(cell)) (s.on[i] = 0), (s.miss[i] = 0), removed++;
    } else if (best >= growBar && dist[i] === 1) (s.on[i] = 1), (s.miss[i] = 0), (s.alpha[i] = 1), added++;
  }
  return { removed, added };
}

/**
 * With page structure: the picture areas in and around the cover. content(cell) tells whether a cell holds
 * picture content: true / 'core' (solid picture), 'edge' (partly picture: counts only as the border of a
 * core area next to it, never as an area of its own, so dense text cannot form one), or false (plain page
 * background or painted-out text). Connected core cells (8-neighbours) within `reach` cells of the cover,
 * plus the edge cells around them, form one area. The caller scores each area's box as one
 * crop (a tight crop of a picture is the model's most reliable view) and hands the scores to applyAreas.
 * @returns {{ cells: number[], rect: Rect, touches: boolean, size: number }[]} areas; also marks background
 */
export function pictureAreas(s, { reach = 3, content }) {
  ensure(s, -reach, -reach, s.cols + reach, s.rows + reach);
  const n = s.on.length;
  const dist = distanceTo(s, s.on, reach);
  const kind = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    if (dist[i] > reach) continue;
    const c = content(cellRect(s, i));
    kind[i] = c === 'edge' ? 2 : c ? 1 : 0;
  }
  const seen = new Uint8Array(n);
  const out = [];
  for (let start = 0; start < n; start++) {
    if (kind[start] !== 1 || seen[start]) continue;
    const cells = [];
    const stack = [start];
    seen[start] = 1;
    let c0 = Infinity, r0 = Infinity, c1 = -1, r1 = -1;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const c = i % s.cols, r = (i / s.cols) | 0;
      c0 = Math.min(c0, c), r0 = Math.min(r0, r), c1 = Math.max(c1, c), r1 = Math.max(r1, r);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if ((!dc && !dr) || cc < 0 || rr < 0 || cc >= s.cols || rr >= s.rows) continue;
        const j = rr * s.cols + cc;
        if (!seen[j] && kind[j] === 1) (seen[j] = 1), stack.push(j);
      }
    }
    // edge cells around the core: the picture's border where it only partly fills a cell
    const core = cells.length;
    for (let k = 0; k < core; k++) {
      const i = cells[k], c = i % s.cols, r = (i / s.cols) | 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= s.cols || rr >= s.rows) continue;
        const j = rr * s.cols + cc;
        if (kind[j] === 2 && !seen[j]) {
          seen[j] = 1;
          cells.push(j);
          c0 = Math.min(c0, cc), r0 = Math.min(r0, rr), c1 = Math.max(c1, cc), r1 = Math.max(r1, rr);
        }
      }
    }
    out.push({ cells, rect: { x: s.x + c0 * CW, y: s.y + r0 * CH, w: (c1 - c0 + 1) * CW, h: (r1 - r0 + 1) * CH }, touches: cells.some((i) => s.on[i]), size: core });
  }
  return out.sort((a, b) => Number(b.touches) - Number(a.touches) || b.size - a.size);
}

/**
 * Apply the scores of pictureAreas (ps[k]: the trigger's probability on area k's crop; NaN = not scored this
 * round, keep as is). An area with the trigger (p >= keepBar) is covered completely when it touches the cover
 * (a separate area needs p >= growBar); an area without it is uncovered after `clearAfter` misses (one when
 * replaced). Areas smaller than `minCells` cannot hold cover by themselves (text fragments, icons). Covered
 * cells that are not picture content at all (page background) are uncovered at once, unless pinned.
 * @returns {{ removed: number, added: number }}
 */
export function applyAreas(s, areas, ps, { keepBar, growBar, clearAfter = 2, minCells = 4, pinned = () => false, replaced = () => false }) {
  const was = s.on.slice();
  const inArea = new Uint8Array(s.on.length);
  let removed = 0, added = 0;
  areas.forEach((a, k) => {
    for (const i of a.cells) inArea[i] = 1;
    const p = ps[k];
    if (Number.isNaN(p)) return;
    const pin = a.cells.some((i) => was[i] && pinned(cellRect(s, i)));
    if ((p >= keepBar && a.size >= minCells) || pin) {
      if (a.touches || p >= growBar) for (const i of a.cells) {
        if (!s.on[i]) added++;
        s.on[i] = 1, s.miss[i] = 0, s.alpha[i] = 1;
      }
    } else if (a.touches) {
      for (const i of a.cells) {
        if (!was[i]) continue;
        if (++s.miss[i] >= clearAfter || replaced(cellRect(s, i)) || a.size < minCells) (s.on[i] = 0), (s.miss[i] = 0), removed++;
      }
    }
  });
  for (let i = 0; i < s.on.length; i++) {
    if (was[i] && !inArea[i] && !pinned(cellRect(s, i))) (s.on[i] = 0), (s.miss[i] = 0), removed++; // page background
  }
  return { removed, added };
}

/** chessboard distance (in cells) of every cell to the nearest covered cell, capped at max + 1 */
function distanceTo(s, on, max) {
  const n = on.length, d = new Uint8Array(n).fill(max + 1);
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    const c = i % s.cols, r = (i / s.cols) | 0;
    for (let dr = -max; dr <= max; dr++) for (let dc = -max; dc <= max; dc++) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= s.cols || rr >= s.rows) continue;
      const j = rr * s.cols + cc, v = Math.max(Math.abs(dc), Math.abs(dr));
      if (v < d[j]) d[j] = v;
    }
  }
  return d;
}

/** drop empty rows / columns at the borders (after cells faded out) */
export function compact(s) {
  const b = bbox(s, true);
  if (!b) return Object.assign(s, { cols: 0, rows: 0, on: new Uint8Array(0), miss: new Uint8Array(0), alpha: new Float32Array(0) });
  const c0 = Math.round((b.x - s.x) / CW), r0 = Math.round((b.y - s.y) / CH);
  const cols = Math.round(b.w / CW), rows = Math.round(b.h / CH);
  if (c0 === 0 && r0 === 0 && cols === s.cols && rows === s.rows) return s;
  const on = new Uint8Array(cols * rows), miss = new Uint8Array(cols * rows), alpha = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = (r + r0) * s.cols + c + c0, d = r * cols + c;
    on[d] = s.on[a], miss[d] = s.miss[a], alpha[d] = s.alpha[a];
  }
  return Object.assign(s, { x: s.x + c0 * CW, y: s.y + r0 * CH, cols, rows, on, miss, alpha });
}

/**
 * Crops that re-check a pane: overlapping windows of `size` cells over the cover plus a `ring` of cells
 * around it (so the shape can grow), at most `max` of them (the stride widens on a big pane).
 * @returns {Rect[]}
 */
export function probeRects(s, { size = 8, ring = 2, max = 12 } = {}) {
  const b = bbox(s);
  if (!b) return [];
  const x0 = Math.max(0, b.x - ring * CW), y0 = Math.max(0, b.y - ring * CH);
  const x1 = Math.min(1, b.x + b.w + ring * CW), y1 = Math.min(1, b.y + b.h + ring * CH);
  // windows overlap by half: about 2 per window length; when that would exceed `max`, fewer and BIGGER
  // windows, so the whole area is always looked at (a cell no window covers could never be uncovered)
  let nx = Math.max(1, Math.ceil((x1 - x0) / (size * CW / 2)) - 1), ny = Math.max(1, Math.ceil((y1 - y0) / (size * CH / 2)) - 1);
  while (nx * ny > max && (nx > 1 || ny > 1)) nx >= ny ? nx-- : ny--;
  // each window: at least `size` cells, and big enough that n windows overlap across the span
  const span = (a, z, n, min) => Math.min(1, Math.max(min, n === 1 ? z - a : ((z - a) / n) * 1.5));
  const pw = span(x0, x1, nx, size * CW), ph = span(y0, y1, ny, size * CH);
  const starts = (a, z, p, n) => {
    if (n === 1 || z - a <= p) return [Math.max(0, Math.min(1 - p, (a + z) / 2 - p / 2))];
    return Array.from({ length: n }, (_, j) => a + ((z - a - p) * j) / (n - 1));
  };
  const xs = starts(x0, x1, pw, nx), ys = starts(y0, y1, ph, ny);
  const out = [];
  for (const y of ys) for (const x of xs) out.push({ x, y, w: pw, h: ph });
  return out;
}

/**
 * A shape from cells of the screen-aligned grid (cell c, r covers c*CW.., r*CH..).
 * @param {number[]} cells  indices c + r * gridCols  @param {number} gridCols
 * @returns {Shape}
 */
export function shapeFromCells(cells, gridCols) {
  let c0 = Infinity, r0 = Infinity, c1 = -1, r1 = -1;
  for (const i of cells) {
    const c = i % gridCols, r = (i / gridCols) | 0;
    c0 = Math.min(c0, c), r0 = Math.min(r0, r), c1 = Math.max(c1, c), r1 = Math.max(r1, r);
  }
  const cols = c1 - c0 + 1, rows = r1 - r0 + 1;
  const s = { x: c0 * CW, y: r0 * CH, cols, rows, on: new Uint8Array(cols * rows), miss: new Uint8Array(cols * rows), alpha: new Float32Array(cols * rows) };
  for (const i of cells) {
    const j = (((i / gridCols) | 0) - r0) * cols + (i % gridCols) - c0;
    s.on[j] = 1;
    s.alpha[j] = 1;
  }
  return s;
}

/**
 * The pictures on a page, from a screen-aligned grid of cell kinds (1 core: mostly solid picture, 2 edge:
 * partly picture, 0 page / text). A picture is a connected group of core cells (8-neighbours) plus the edge
 * cells touching it; an edge cell never links two pictures, so thumbnails a few pixels apart stay apart.
 * @param {Uint8Array} kind  cols*rows
 * @returns {{ cells: number[], c0: number, r0: number, c1: number, r1: number, core: number }[]}
 */
export function segmentCells(kind, cols, rows) {
  const seen = new Uint8Array(kind.length);
  const out = [];
  for (let start = 0; start < kind.length; start++) {
    if (kind[start] !== 1 || seen[start]) continue;
    const cells = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const c = i % cols, r = (i / cols) | 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if ((!dc && !dr) || cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        const j = rr * cols + cc;
        if (!seen[j] && kind[j] === 1) (seen[j] = 1), stack.push(j);
      }
    }
    const core = cells.length;
    for (let k = 0; k < core; k++) {
      const i = cells[k], c = i % cols, r = (i / cols) | 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        const j = rr * cols + cc;
        if (kind[j] === 2 && !seen[j]) (seen[j] = 1), cells.push(j);
      }
    }
    let c0 = Infinity, r0 = Infinity, c1 = -1, r1 = -1;
    for (const i of cells) {
      const c = i % cols, r = (i / cols) | 0;
      c0 = Math.min(c0, c), r0 = Math.min(r0, r), c1 = Math.max(c1, c), r1 = Math.max(r1, r);
    }
    out.push({ cells, c0, r0, c1, r1, core });
  }
  return out;
}
