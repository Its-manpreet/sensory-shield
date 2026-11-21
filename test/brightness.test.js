// Sudden brightness jumps: eased in, gentle changes and repeated flashing left to the flash detector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrightnessGuard } from '../src/engine/brightness.js';
import { frames, run } from './gen-flash.js';

const area = (events) => events.reduce((a, e) => a + e.rect.w * e.rect.h, 0);

test('dark screen -> white page: veiled at once over the whole screen, eased out over ~1 s', () => {
  const gen = frames({ seconds: 2.5, pixel: (_x, _y, t) => (t < 1000 ? [18, 18, 20] : [250, 250, 250]) });
  const res = run(createBrightnessGuard(), gen);
  const first = res.find((r) => r.events.length);
  assert.ok(first && first.tMs >= 1000 && first.tMs <= 1034, `first veil at ${first?.tMs}`);
  assert.ok(area(first.events) > 0.99, 'whole screen');
  assert.ok(first.events[0].strength > 0.8, `starts dark: ${first.events[0].strength}`);
  const mid = res.find((r) => r.tMs >= 1500);
  assert.ok(mid.events.length && mid.events[0].strength < first.events[0].strength && mid.events[0].strength > 0.02);
  const last = res.filter((r) => r.events.length).at(-1).tMs;
  assert.ok(last >= 1900 && last <= 2034, `eased out by ${last}`);
  assert.ok(new Set(first.events.map((e) => e.strength)).size === 1, 'one shared veil, no seams');
});

test('only the part of the screen that jumped is veiled (a white window opening on the right)', () => {
  const gen = frames({ seconds: 1.5, pixel: (x, _y, t) => (t >= 800 && x >= 0.5 ? [245, 245, 245] : [20, 20, 24]) });
  const res = run(createBrightnessGuard(), gen);
  const first = res.find((r) => r.events.length);
  assert.ok(first.events.every((e) => e.rect.x >= 0.5));
  assert.ok(Math.abs(area(first.events) - 0.5) < 0.01);
});

test('no veil: gradual brightening over 2 s, a bright screen getting brighter, a light-mode page', () => {
  const fade = frames({ seconds: 2.5, pixel: (_x, _y, t) => { const v = 20 + Math.min(1, t / 2000) * 230; return [v, v, v]; } });
  assert.equal(run(createBrightnessGuard(), fade).some((r) => r.events.length), false);
  const brighter = frames({ seconds: 1.5, pixel: (_x, _y, t) => (t < 700 ? [170, 170, 170] : [255, 255, 255]) });
  assert.equal(run(createBrightnessGuard(), brighter).some((r) => r.events.length), false);
  const steady = frames({ seconds: 1, pixel: () => [250, 250, 250] });
  assert.equal(run(createBrightnessGuard(), steady).some((r) => r.events.length), false);
});

test('dark -> medium grey (small rise) is not a jump', () => {
  const gen = frames({ seconds: 1.5, pixel: (_x, _y, t) => (t < 700 ? [20, 20, 20] : [110, 110, 110]) });
  assert.equal(run(createBrightnessGuard(), gen).some((r) => r.events.length), false);
});
