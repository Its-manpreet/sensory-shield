// OWNER: Agent B. Flash detector tests on synthetic in-memory frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlashDetector } from '../src/engine/flash.js';
import { scenes, run, concat, frames, GRID_W, GRID_H } from './gen-flash.js';

const anyEvents = (results) => results.some((r) => r.events.length > 0);
const firstActive = (results) => results.find((r) => r.events.some((e) => e.active));

for (const [name, gen] of [
  ['steady image', () => scenes.steady()],
  ['slow fade', () => scenes.slowFade()],
  ['1 Hz flash', () => scenes.flash(1)],
  ['2 Hz flash', () => scenes.flash(2)],
  ['3 Hz flash on a 15% box (below minAreaFraction)', () => scenes.flashBox(3, { x: 0.3, y: 0.3, w: 0.39, h: 0.39 })],
  ['small corner flash at 6 Hz', () => scenes.flashBox(6, { x: 0, y: 0, w: 0.2, h: 0.2 })],
  ['normal video with scene cuts', () => scenes.normalVideo()],
]) {
  test(`no events: ${name}`, () => {
    assert.equal(anyEvents(run(createFlashDetector(), gen())), false);
  });
}

for (const [name, gen, kind] of [
  ['3 Hz luminance flash', () => scenes.flash(3), 'luminance'],
  ['6 Hz luminance flash', () => scenes.flash(6), 'luminance'],
  ['3 Hz red flash', () => scenes.redFlash(3), 'red'],
]) {
  test(`active events within 1 s: ${name}`, () => {
    const results = run(createFlashDetector(), gen());
    const hit = firstActive(results);
    assert.ok(hit, 'expected an active event');
    assert.ok(hit.tMs <= 1000, `first event at ${hit.tMs} ms`);
    assert.ok(hit.events.every((e) => e.kind === kind), `kinds: ${hit.events.map((e) => e.kind)}`);
    // whole screen flashes: regions together cover the screen
    const area = hit.events.reduce((a, e) => a + e.rect.w * e.rect.h, 0);
    assert.ok(area > 0.95, `covered area ${area}`);
  });
}

test('flash inside half the screen: rects stay near the flashing box', () => {
  const box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const hit = firstActive(run(createFlashDetector(), scenes.flashBox(6, box)));
  assert.ok(hit);
  for (const { rect } of hit.events) {
    assert.ok(rect.x >= box.x - 0.05 && rect.x + rect.w <= box.x + box.w + 0.05);
    assert.ok(rect.y >= box.y - 0.05 && rect.y + rect.h <= box.y + box.h + 0.05);
  }
});

test('red detection can be switched off (dark-red flash then has too little luminance change)', () => {
  const dim = () => frames({ seconds: 3, pixel: (_x, _y, t) => (Math.floor(t / 1000 * 6) % 2 ? [120, 0, 0] : [60, 0, 0]) });
  assert.ok(anyEvents(run(createFlashDetector({ detectRed: true }), dim())));
  assert.equal(anyEvents(run(createFlashDetector({ detectRed: false }), dim())), false);
});

test('hold: events continue after flashing stops, as inactive, then end', () => {
  const holdMs = 1500;
  const results = run(createFlashDetector({ holdMs }), concat(() => scenes.flash(6, 2), () => scenes.steady(5)));
  const flashEnd = 2000;
  const lastActive = results.filter((r) => r.events.some((e) => e.active)).at(-1).tMs;
  const lastAny = results.filter((r) => r.events.length).at(-1).tMs;
  // cells stay "flashing" until their flashes leave the 1 s window, then the hold runs
  assert.ok(lastActive <= flashEnd + 1000, `last active ${lastActive}`);
  assert.ok(lastAny >= lastActive + holdMs - 50, `hold ended at ${lastAny}`);
  assert.ok(lastAny <= lastActive + holdMs + 50, `hold ended at ${lastAny}`);
  const holding = results.find((r) => r.tMs > lastActive && r.events.length);
  assert.ok(holding.events.every((e) => !e.active));
  assert.equal(results.at(-1).events.length, 0);
});

test('reset clears state', () => {
  const det = createFlashDetector();
  run(det, scenes.flash(6, 2));
  det.reset();
  assert.equal(det.push({ data: new Uint8ClampedArray(GRID_W * GRID_H * 4), tMs: 2100 }).length, 0);
});

test('speed: push() on 64x36 is well under 1 ms', () => {
  const det = createFlashDetector();
  const gen = [...scenes.flash(6, 4)];
  const t0 = performance.now();
  for (const f of gen) det.push(f);
  const perFrame = (performance.now() - t0) / gen.length;
  console.log(`flash push(): ${perFrame.toFixed(3)} ms per 64x36 frame (${gen.length} frames)`);
  assert.ok(perFrame < 1, `${perFrame} ms`);
});

test('60 fps input: 3 Hz flash still detected within 1 s', () => {
  const gen = frames({ seconds: 2, fps: 60, pixel: (_x, _y, t) => (Math.floor((t / 1000) * 6) % 2 ? [0, 0, 0] : [255, 255, 255]) });
  const hit = firstActive(run(createFlashDetector(), gen));
  assert.ok(hit && hit.tMs <= 1000);
});
