// OWNER: Agent C. One pane per object: grouping, shrinking, edge snapping, grow-fast / shrink-slow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTouching, unionAll, findPictures, snapEdges, approach, iou } from '../src/engine/panes.js';

const R = (x, y, w, h) => ({ x, y, w, h });

test('touching flagged tiles become one pane; a separate one stays separate', () => {
  const g = groupTouching([{ rect: R(0, 0, 0.25, 0.33) }, { rect: R(0.25, 0, 0.25, 0.33) }, { rect: R(0.125, 0.165, 0.25, 0.33) }, { rect: R(0.75, 0.66, 0.25, 0.33) }]);
  assert.equal(g.length, 2);
  assert.deepEqual(unionAll(g[0].map((x) => x.rect)), R(0, 0, 0.5, 0.495));
});

test('finds the photo on a page, not the text around it', () => {
  const W = 300, H = 200, g = new Uint8Array(W * H).fill(245);
  for (let y = 20; y < 180; y += 9) for (let x = 10; x < 290; x++) if (x % 7 < 4) g[y * W + x] = 40, g[(y + 1) * W + x] = 40; // text lines
  for (let y = 60; y < 150; y++) for (let x = 120; x < 240; x++) g[y * W + x] = 60 + ((x * 7 + y * 13) % 80); // photo
  for (let y = 80; y < 100; y++) for (let x = 150; x < 190; x++) g[y * W + x] = 245; // a white patch inside the photo
  const photo = R(120 / W, 60 / H, 120 / W, 90 / H);
  const found = findPictures(g, W, H, R(0.25, 0.2, 0.7, 0.7));
  assert.ok(found?.length >= 1);
  assert.ok(iou(found[0], photo) > 0.9, JSON.stringify(found[0]));
});

test('inside a full-screen photo there is no page background: no fit', () => {
  const W = 200, H = 120, g = new Uint8Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = (i * 37) % 200;
  assert.equal(findPictures(g, W, H, R(0.2, 0.2, 0.5, 0.5)), null);
});

test('edges snap to the border of a photo on a page', () => {
  const W = 200, H = 120, g = new Uint8Array(W * H).fill(245);
  for (let y = 30; y < 90; y++) for (let x = 50; x < 140; x++) g[y * W + x] = 60 + ((x * 7 + y * 13) % 80);
  const photo = R(50 / W, 30 / H, 90 / W, 60 / H);
  const snapped = snapEdges(g, W, H, R(58 / W, 36 / H, 74 / W, 46 / H)); // a fitted box a bit inside the photo
  assert.ok(iou(snapped, photo) > 0.95, JSON.stringify(snapped));
  // no border nearby (inside a big photo): the box stays where it was
  const flat = new Uint8Array(W * H).fill(120);
  assert.ok(iou(snapEdges(flat, W, H, R(0.3, 0.3, 0.2, 0.2)), R(0.3, 0.3, 0.2, 0.2)) > 0.99);
});

test('a pane grows at once but shrinks smoothly', () => {
  const big = R(0.1, 0.1, 0.5, 0.5), small = R(0.2, 0.2, 0.2, 0.2);
  assert.deepEqual(approach(small, big, 16), big, 'growth is immediate');
  const mid = approach(big, small, 16);
  assert.ok(mid.w < big.w && mid.w > small.w, 'shrink is gradual');
  let s = big;
  for (let i = 0; i < 60; i++) s = approach(s, small, 16);
  assert.ok(iou(s, small) > 0.98, 'settles on the target');
});

test('text-only area on a page: no pictures (the picture gate rejects CLIP hits on words)', () => {
  const W = 300, H = 200, g = new Uint8Array(W * H).fill(245);
  for (let y = 20; y < 180; y += 9) for (let x = 10; x < 290; x++) if (x % 7 < 4) g[y * W + x] = 40, g[(y + 1) * W + x] = 40; // body text
  // a big bold heading: 24 px tall letters with 5 px strokes and gaps between letters
  for (let c = 0; c < 7; c++) for (let y = 30; y < 54; y++) for (let x = 20 + c * 30; x < 20 + c * 30 + 22; x++) {
    const lx = x - 20 - c * 30, ly = y - 30;
    if (lx < 5 || lx >= 17 || ly < 5 || ly >= 19 || (ly >= 10 && ly < 14)) g[y * W + x] = 20;
  }
  assert.deepEqual(findPictures(g, W, H, R(0.25, 0.2, 0.5, 0.5), { bgRegion: R(0.1, 0.05, 0.8, 0.8) }), []);
});

test('contentShare: a photo is picture content, text strokes are not', async () => {
  const { contentShare } = await import('../src/engine/panes.js');
  const W = 200, H = 100, g = new Uint8Array(W * H).fill(30); // a dark editor
  for (let y = 10; y < 90; y += 13) for (let x = 10; x < 90; x++) if (x % 5 < 1 || y % 13 === 10) g[y * W + x] = 200; // thin strokes
  for (let y = 10; y < 90; y++) for (let x = 110; x < 190; x++) g[y * W + x] = 90 + ((x * 7 + y * 13) % 120); // photo
  assert.ok(contentShare(g, W, H, R(0.05, 0.1, 0.4, 0.8), 30) < 0.05);
  assert.ok(contentShare(g, W, H, R(0.55, 0.1, 0.4, 0.8), 30) > 0.8);
});
