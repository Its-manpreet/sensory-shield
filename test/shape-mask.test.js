// OWNER: Agent C. Free-form panes: paint, grow, carve, merge, follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CW, CH, createShape, paintRect, count, bbox, near, mergeInto, shift, applyProbes, pictureAreas, applyAreas, compact, probeRects, isOn, coverOf } from '../src/engine/shape-mask.js';

const R = (x, y, w, h) => ({ x, y, w, h });
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
// cell-aligned positions keep the expected counts exact
const X = (c) => c * CW, Y = (r) => r * CH;

test('a rect becomes the cells it covers', () => {
  const s = createShape(R(4 * CW, 2 * CH, 3 * CW, 2 * CH));
  assert.equal(count(s), 6);
  const b = bbox(s);
  assert.ok(close(b.x, 4 * CW) && close(b.y, 2 * CH) && close(b.w, 3 * CW) && close(b.h, 2 * CH));
});

test('painting grows the grid in any direction and keeps earlier cells', () => {
  const s = createShape(R(10 * CW, 10 * CH, CW, CH));
  paintRect(s, R(2 * CW, 3 * CH, CW, CH)); // up-left of the first cell
  assert.equal(count(s), 2);
  assert.ok(isOn(s, 10.5 * CW, 10.5 * CH) && isOn(s, 2.5 * CW, 3.5 * CH));
  assert.ok(!isOn(s, 6.5 * CW, 6.5 * CH), 'any shape: the space between stays clear');
});

test('a sliver of a cell does not cover it; a quarter does', () => {
  const s = createShape(R(4 * CW, 4 * CH, 2.1 * CW, CH));
  assert.equal(count(s), 2);
  paintRect(s, R(4 * CW, 5 * CH, 2.3 * CW, CH));
  assert.equal(count(s), 5);
  paintRect(s, R(3.8 * CW, 6 * CH, CW, CH)); // 0.2 of cell 3, 0.8 of cell 4
  assert.equal(count(s), 6);
});

test('nearby shapes are near, distant ones are not; merging keeps both covers in one shape', () => {
  const a = createShape(R(X(6), Y(4), 4 * CW, 4 * CH));
  const b = createShape(R(X(11), Y(4), 3 * CW, 3 * CH)); // one empty column between
  const c = createShape(R(X(40), Y(20), 3 * CW, 3 * CH));
  assert.ok(near(a, b, 1));
  assert.ok(!near(a, c, 1));
  mergeInto(a, b);
  assert.equal(count(a), 16 + 9);
});

test('re-checks carve away parts without the trigger (after two misses) and keep the rest', () => {
  const x = X(12), y = Y(8);
  const s = createShape(R(x, y, 8 * CW, 4 * CH));
  const left = { rect: R(x - CW, y - CH, 5 * CW, 6 * CH), p: 0.9 };
  const right = { rect: R(x + 4 * CW, y - CH, 5 * CW, 6 * CH), p: 0.05 };
  const opts = { keepBar: 0.3, growBar: 2 }; // no growth in this test
  applyProbes(s, [left, right], opts);
  assert.equal(count(s), 32, 'one miss: nothing removed yet');
  applyProbes(s, [left, right], opts);
  assert.equal(count(s), 16 + 4, 'the left half plus a one-cell safety margin');
  assert.ok(isOn(s, x + 1.5 * CW, y + 1.5 * CH), 'left half stays');
  assert.ok(isOn(s, x + 4.5 * CW, y + 1.5 * CH), 'margin column stays');
  assert.ok(!isOn(s, x + 6.5 * CW, y + 1.5 * CH), 'the rest of the right half is gone');
});

test('replaced content clears on the first miss; pinned cells stay', () => {
  const s = createShape(R(X(20), Y(10), 4 * CW, 4 * CH));
  const all = { rect: R(0, 0, 1, 1), p: 0 };
  applyProbes(s, [all], { keepBar: 0.3, growBar: 0.6, pinned: (c) => c.x < X(20.5), replaced: () => true });
  assert.equal(count(s), 4, 'only the pinned column is left');
});

test('the cover grows one cell per round along the object, only at its edge', () => {
  const s = createShape(R(0.5, 0.5, 2 * CW, 2 * CH));
  const object = { rect: R(0.5 - 3 * CW, 0.5, 5 * CW, 2 * CH), p: 0.9 };
  applyProbes(s, [object], { keepBar: 0.3, growBar: 0.6 });
  assert.ok(isOn(s, 0.5 - 0.5 * CW, 0.5 + 0.5 * CH), 'grew one cell left');
  assert.ok(!isOn(s, 0.5 - 1.5 * CW, 0.5 + 0.5 * CH), 'not two at once');
  applyProbes(s, [object], { keepBar: 0.3, growBar: 0.6 });
  assert.ok(isOn(s, 0.5 - 1.5 * CW, 0.5 + 0.5 * CH));
  assert.ok(!isOn(s, 0.5 + 0.5 * CW, 0.5 - 0.5 * CH), 'no growth where no probe sees it above the bar');
});

test('shapes follow motion with sub-cell precision', () => {
  const s = createShape(R(X(20), Y(10), 2 * CW, 2 * CH));
  shift(s, 0.25 * CW, -1.5 * CH);
  const b = bbox(s);
  assert.ok(close(b.x, X(20.25), 1e-6) && close(b.y, Y(8.5), 1e-6), JSON.stringify(b));
  assert.equal(coverOf(s, R(b.x, b.y, b.w, b.h)), 1);
});

test('compact trims cleared borders but keeps fading cells', () => {
  const s = createShape(R(X(12), Y(8), 6 * CW, 2 * CH));
  for (let i = 0; i < s.on.length; i++) if (i % s.cols >= 3) (s.on[i] = 0), (s.alpha[i] = 0);
  s.alpha[0] = 0.5; // a fading cell
  compact(s);
  assert.equal(s.cols, 3);
  assert.equal(count(s), 6);
  s.on[0] = 0; // fading, still visible
  compact(s);
  assert.equal(s.cols, 3, 'a cell that is still fading out is kept');
});

test('probes cover the shape plus a ring, overlapping, within the budget', () => {
  const s = createShape(R(0.3, 0.3, 12 * CW, 10 * CH));
  const ps = probeRects(s, { size: 8, ring: 2, max: 12 });
  assert.ok(ps.length >= 4 && ps.length <= 12, String(ps.length));
  // every covered cell centre is inside some probe
  for (let i = 0; i < s.on.length; i++) {
    if (!s.on[i]) continue;
    const cx = s.x + ((i % s.cols) + 0.5) * CW, cy = s.y + (((i / s.cols) | 0) + 0.5) * CH;
    assert.ok(ps.some((p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h));
  }
  const small = probeRects(createShape(R(0.5, 0.5, CW, CH)));
  assert.equal(small.length, 1, 'a small pane is looked at with context around it');
});

// a page: picture content in a block of cells (cols 20-29, rows 10-17), a cut-out object shaped like an L
const inside = (r, c0, r0, c1, r1) => r.x + CW / 2 >= X(c0) && r.x + CW / 2 < X(c1) && r.y + CH / 2 >= Y(r0) && r.y + CH / 2 < Y(r1);
const photoPage = (r) => inside(r, 20, 10, 30, 18);
const lShape = (r) => inside(r, 40, 5, 42, 15) || inside(r, 40, 13, 50, 15);
/** one structured round: areas scored by `score(areaRect)` */
const round = (s, content, score, opts = {}) => {
  const areas = pictureAreas(s, { reach: 3, content });
  return applyAreas(s, areas, areas.map((a) => score(a.rect)), { keepBar: 0.3, growBar: 0.6, ...opts });
};

test('on a page the cover becomes the whole picture, never the page around it', () => {
  // the first cover is a rough tile that spills onto the page and misses part of the photo
  const s = createShape(R(X(16), Y(8), 10 * CW, 6 * CH));
  round(s, photoPage, () => 0.9);
  assert.equal(count(s), 63, 'first round: the photo up to 3 cells beyond the cover, none of the page');
  round(s, photoPage, () => 0.9);
  assert.equal(count(s), 80, 'exactly the 10 x 8 photo');
  assert.ok(isOn(s, X(29.5), Y(17.5)) && !isOn(s, X(17.5), Y(9.5)));
});

test('an object on a plain background is covered as its outline', () => {
  const s = createShape(R(X(39), Y(4), 4 * CW, 4 * CH));
  for (let k = 0; k < 4; k++) round(s, lShape, () => 0.9);
  assert.equal(count(s), 20 + 16, 'the L: 2 x 10 stem plus 8 x 2 foot');
  assert.ok(!isOn(s, X(45.5), Y(8.5)), 'the empty corner of the L stays clear');
});

test('each picture is judged on its own: a harmless one next door is never covered; a gone trigger clears', () => {
  const s = createShape(R(X(20), Y(10), 10 * CW, 8 * CH));
  const both = (r) => photoPage(r) || inside(r, 31, 10, 36, 18); // a second photo one column away
  const isFirst = (rect) => rect.x < X(30);
  round(s, both, (rect) => (isFirst(rect) ? 0.9 : 0.05));
  assert.equal(count(s), 80, 'the harmless photo next to it is not covered');
  round(s, both, () => 0.05);
  assert.equal(count(s), 80, 'one miss');
  round(s, both, () => 0.05);
  assert.equal(count(s), 0);
});

test('text fragments (tiny areas) cannot hold cover', () => {
  const s = createShape(R(X(10), Y(10), 2 * CW, CH));
  round(s, (r) => inside(r, 10, 10, 12, 11), () => 0.99);
  assert.equal(count(s), 0);
});

test('probes leave no gaps, even on a pane bigger than the budget', () => {
  const s = createShape(R(X(4), Y(2), 50 * CW, 30 * CH));
  const ps = probeRects(s, { size: 8, ring: 2, max: 9 });
  assert.ok(ps.length <= 9);
  for (let i = 0; i < s.on.length; i++) {
    const cx = s.x + ((i % s.cols) + 0.5) * CW, cy = s.y + (((i / s.cols) | 0) + 0.5) * CH;
    assert.ok(ps.some((p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h), `cell ${i} not looked at`);
  }
});

test('edge cells border a picture but never form an area alone (dense text)', () => {
  const s = createShape(R(X(20), Y(10), 4 * CW, 4 * CH));
  const content = (r) => (inside(r, 20, 10, 24, 14) ? 'core' : inside(r, 24, 10, 25, 14) ? 'edge' : inside(r, 30, 10, 31, 20) ? 'edge' : false);
  for (let k = 0; k < 3; k++) round(s, content, () => 0.9);
  assert.equal(count(s), 16 + 4, 'the picture plus its partly filled border column');
  assert.ok(!isOn(s, X(30.5), Y(12.5)), 'a column of dense text nearby is not covered');
});

test('segmenting a photo grid: thumbnails a few pixels apart are separate pictures; text is not a picture', async () => {
  const { segmentCells, shapeFromCells } = await import('../src/engine/shape-mask.js');
  const cols = 30, rows = 10, kind = new Uint8Array(cols * rows);
  const set = (c0, r0, c1, r1, v) => { for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) kind[r * cols + c] = v; };
  set(1, 1, 8, 6, 1); // thumbnail A
  set(8, 1, 9, 6, 2); // the gap column: partly picture on both sides
  set(9, 1, 16, 6, 1); // thumbnail B
  set(1, 7, 16, 8, 0); // caption row: text, no solid blocks
  const pics = segmentCells(kind, cols, rows);
  assert.equal(pics.length, 2);
  assert.deepEqual(pics.map((p) => p.core).sort(), [35, 35]);
  assert.equal(pics.reduce((a, p) => a + p.cells.length, 0), 35 * 2 + 5, 'the gap column goes to one of them, once');
  const s = shapeFromCells(pics[0].cells, cols);
  assert.equal(count(s), pics[0].cells.length);
});
