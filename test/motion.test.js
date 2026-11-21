// Constant motion (an always-moving region), on synthetic frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMotionDetector } from '../src/engine/motion.js';
import { frames as frames64, run, scenes as scenes64 } from './gen-flash.js';

// the motion detector works on a finer 96x54 grid
const MW = 96, MH = 54;
function* frames({ seconds, fps = 30, pixel, ss = 2 }) {
  for (let f = 0; f < Math.round(seconds * fps); f++) {
    const tMs = (f * 1000) / fps;
    const data = new Uint8ClampedArray(MW * MH * 4);
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      let g = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) g += pixel((x + (sx + 0.5) / ss) / MW, (y + (sy + 0.5) / ss) / MH, tMs)[0];
      const p = (y * MW + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = g / (ss * ss);
      data[p + 3] = 255;
    }
    yield { data, tMs };
  }
}
const scenes = { steady: (s) => frames({ seconds: s, pixel: () => [90, 90, 90] }) };
void frames64, scenes64;

/** textured layer: a photo-grid-like pattern sampled at an offset */
const tex = (x, y) => {
  const cx = Math.floor(x * 22), cy = Math.floor(y * 14);
  const v = (((cx * 73 + cy * 151) % 97) + 97) % 97 / 97;
  const fx = x * 22 - cx, fy = y * 14 - cy;
  const g = fx < 0.12 || fy < 0.12 ? 250 : 30 + 190 * v;
  return [g, g, g]; // frames() wants [r, g, b]
};
const any = (res, kind) => res.some((r) => r.events.some((e) => e.kind === kind));

test('constant motion: an always-moving region is flagged after ~3 s, only that region', () => {
  const gen = () => frames({ ss: 2, seconds: 5, pixel: (x, y, t) => (x < 0.5 && y < 0.5 ? tex(x + (t / 1000) * 0.3, y) : [230, 230, 230]) });
  const res = run(createMotionDetector(), gen());
  const hit = res.find((r) => r.events.some((e) => e.kind === 'constant'));
  assert.ok(hit && hit.tMs >= 2500 && hit.tMs <= 3600, `first at ${hit?.tMs}`);
  assert.ok(hit.events.every((e) => e.rect.x < 0.55 && e.rect.y < 0.55), JSON.stringify(hit.events));
});

test('speed: push() on 64x36', () => {
  const det = createMotionDetector();
  const gen = [...frames({ ss: 2, seconds: 3, pixel: (x, y, t) => (y < 0.5 ? tex(x, y + (t / 1000)) : tex(x, y + (t / 1000) * 0.3)) })];
  const t0 = performance.now();
  for (const f of gen) det.push(f);
  const ms = (performance.now() - t0) / gen.length;
  console.log(`motion push(): ${ms.toFixed(3)} ms per frame`);
  assert.ok(ms < 2);
});

test('not constant motion: a still page, a 1.5 s animation, a page scrolled once', () => {
  assert.equal(any(run(createMotionDetector(), scenes.steady(5)), 'constant'), false);
  const short = frames({ seconds: 5, pixel: (x, y, t) => (t < 1500 ? tex(x + (t / 1000) * 0.3, y) : tex(x + 0.45, y)) });
  assert.equal(any(run(createMotionDetector(), short), 'constant'), false);
  const scrollOnce = frames({ seconds: 5, pixel: (x, y, t) => tex(x, y + Math.min(t, 1200) / 1000 * 0.5) });
  assert.equal(any(run(createMotionDetector(), scrollOnce), 'constant'), false);
});
