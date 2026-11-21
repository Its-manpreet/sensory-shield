// OWNER: Agent A. Blur boxes follow their content between vision checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackBox, moveBox } from '../src/overlay/box-motion.js';

const W = 256, H = 144;
/** a page with textured "photos" and text-like stripes, scrolled by (ox, oy) pixels */
function page(ox, oy) {
  const img = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + ox, py = y + oy;
      let v = 240;
      if (px > 140 && px < 200 && py > 40 && py < 90) v = 60 + ((px * 7 + py * 13) % 90) + 40 * Math.sin(py / 4); // photo
      else if (px > 20 && px < 120 && py % 9 < 2) v = 40; // text lines
      img[y * W + x] = Math.max(0, Math.min(255, v));
    }
  }
  return img;
}
const photo = { x: 140 / W, y: 40 / H, w: 60 / W, h: 50 / H };

test('follows vertical scrolling (sub-pixel accurate)', () => {
  for (const dy of [3, 7.5, 15, -10, 22]) {
    const got = trackBox(page(0, 0), page(0, Math.round(dy)), W, H, photo, 24, 12);
    assert.ok(got, `dy ${dy}`);
    // content moves UP on screen when the page scrolls down by dy
    assert.ok(Math.abs(got.dy * H + Math.round(dy)) < 0.6, `dy ${dy}: got ${got.dy * H}`);
    assert.ok(Math.abs(got.dx * W) < 0.6);
  }
});

test('follows a move larger than the box itself (a vision result that arrives after a long scroll)', () => {
  const got = trackBox(page(0, 0), page(0, 60), W, H, photo, 72, 36);
  assert.ok(got && Math.abs(got.dy * H + 60) < 0.6, JSON.stringify(got && got.dy * H));
});

test('follows horizontal moves', () => {
  const got = trackBox(page(0, 0), page(-6, 0), W, H, photo, 24, 12);
  assert.ok(Math.abs(got.dx * W - 6) < 0.6, `dx ${got.dx * W}`);
});

test('no motion: stays put', () => {
  const got = trackBox(page(0, 0), page(0, 0), W, H, photo, 24, 12);
  assert.deepEqual(got, { dx: 0, dy: 0 });
});

test('flat content cannot be tracked (returns null, box is left alone)', () => {
  const flat = new Uint8Array(W * H).fill(128);
  assert.equal(trackBox(flat, flat, W, H, photo, 24, 12), null);
});

test('content replaced (not moved): the box does not move', () => {
  const other = new Uint8Array(W * H).map((_, i) => (i * 7919) % 251);
  const got = trackBox(page(0, 0), other, W, H, photo, 24, 12);
  assert.ok(got === null || (got.dx === 0 && got.dy === 0), JSON.stringify(got));
});

test('moveBox drops boxes that scrolled off screen', () => {
  assert.equal(moveBox({ x: 0.2, y: 0.01, w: 0.2, h: 0.1 }, { dx: 0, dy: -0.2 }), null);
  assert.ok(moveBox({ x: 0.2, y: 0.5, w: 0.2, h: 0.1 }, { dx: 0, dy: -0.2 }));
});
