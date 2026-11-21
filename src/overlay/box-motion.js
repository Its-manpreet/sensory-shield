// OWNER: Agent A. Keeps content blurs on their content while it moves (scrolling, dragging a window).
// Each blur pane follows its pixels on every frame, between model checks. Pure JS on a
// small grayscale copy of the screen (memory only), unit tested in test/overlay-motion.test.js.
//
// How: for a box, average the brightness of each row inside the box (a 1-D "row profile") in the previous and
// the current frame, and find the vertical shift that lines them up best; then the same with column profiles
// for the horizontal shift. Two short 1-D searches instead of a 2-D image search: cheap enough for every frame.

/**
 * @param {Uint8Array} prev  grayscale W*H
 * @param {Uint8Array} cur   grayscale W*H
 * @param {number} W
 * @param {number} H
 * @param {{x:number,y:number,w:number,h:number}} box  normalized
 * @param {number} maxDy  search range in pixels of this grid
 * @param {number} maxDx
 * @returns {{dx: number, dy: number} | null}  normalized shift of the content, or null if not trackable
 */
export function trackBox(prev, cur, W, H, box, maxDy, maxDx) {
  const x0 = clamp(Math.floor(box.x * W), 0, W - 1), x1 = clamp(Math.ceil((box.x + box.w) * W), x0 + 1, W);
  const y0 = clamp(Math.floor(box.y * H), 0, H - 1), y1 = clamp(Math.ceil((box.y + box.h) * H), y0 + 1, H);
  if (x1 - x0 < 3 || y1 - y0 < 3) return null;

  const dy = bestShift(
    (r, img) => rowMean(img, W, r, x0, x1),
    y0, y1, H, maxDy, prev, cur,
  );
  if (dy === null) return null;
  // horizontal on the vertically aligned rows of the previous frame
  const dx = bestShift(
    (c, img) => colMean(img, W, c, img === cur ? y0 + Math.round(dy) : y0, img === cur ? y1 + Math.round(dy) : y1, H),
    x0, x1, W, maxDx, prev, cur,
  );
  if (dx === null) return null;
  return { dx: dx / W, dy: dy / H };
}

/**
 * 1-D search: take the profile of `prev` inside [a, b) (what was in the box) and find where it went in `cur`
 * (prev[i] ~ cur[i + s]). Following the box's own content works even when it moved further than the box is
 * tall; matching "what is in the box now" against the past does not.
 * Returns the sub-pixel shift, 0 when there is no clear motion, or null when the content has no structure.
 */
function bestShift(profile, a, b, n, maxS, prev, cur) {
  const tpl = new Float32Array(b - a);
  for (let i = a; i < b; i++) tpl[i - a] = profile(i, prev);
  // flat content (a uniform area, a solid colour) cannot be tracked
  let mean = 0;
  for (const v of tpl) mean += v;
  mean /= tpl.length;
  let varSum = 0;
  for (const v of tpl) varSum += (v - mean) ** 2;
  if (Math.sqrt(varSum / tpl.length) < 2) return null;

  const lo = Math.max(0, a - maxS), hi = Math.min(n, b + maxS);
  const curP = new Float32Array(hi - lo);
  for (let i = lo; i < hi; i++) curP[i - lo] = profile(i, cur);

  const cost = new Float32Array(2 * maxS + 1).fill(Infinity);
  for (let s = -maxS; s <= maxS; s++) {
    let sum = 0, count = 0;
    for (let i = a; i < b; i++) {
      const j = i + s;
      if (j < lo || j >= hi) continue;
      sum += Math.abs(tpl[i - a] - curP[j - lo]);
      count++;
    }
    if (count * 10 >= (b - a) * 6) cost[s + maxS] = sum / count; // at least 60% of the box still on screen
  }
  let best = maxS;
  for (let k = 0; k < cost.length; k++) if (cost[k] < cost[best]) best = k;
  if (!Number.isFinite(cost[best])) return null;
  // no clear motion: staying put is (nearly) as good as the best shift
  if (cost[maxS] <= cost[best] + 0.75) return 0;
  // the best match must be good in absolute terms, or the content changed rather than moved
  if (cost[best] > 12) return null;
  // sub-pixel: parabola through the best cost and its neighbours
  let s = best - maxS;
  const l = cost[best - 1], r = cost[best + 1], c = cost[best];
  if (Number.isFinite(l) && Number.isFinite(r) && l + r - 2 * c > 1e-6) s += (0.5 * (l - r)) / (l + r - 2 * c);
  return s;
}

function rowMean(img, W, r, x0, x1) {
  let sum = 0;
  const base = r * W;
  for (let x = x0; x < x1; x++) sum += img[base + x];
  return sum / (x1 - x0);
}

function colMean(img, W, c, y0, y1, H) {
  const a = Math.max(0, y0), b = Math.min(H, y1);
  if (b <= a) return 0;
  let sum = 0;
  for (let y = a; y < b; y++) sum += img[y * W + c];
  return sum / (b - a);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** move a normalized box; null when it has left the screen */
export function moveBox(box, d) {
  const b = { ...box, x: box.x + d.dx, y: box.y + d.dy };
  const visW = Math.min(1, b.x + b.w) - Math.max(0, b.x);
  const visH = Math.min(1, b.y + b.h) - Math.max(0, b.y);
  return visW <= 0.005 || visH <= 0.005 ? null : b;
}
