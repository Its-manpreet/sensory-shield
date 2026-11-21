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
  ...[300, 800, 1500, 2500, 4000, 6000].map((px) => [`scrolling photo grid at ${px} px/s`, () => scenes.scrollPhotos(px)]),
  ...[800, 2500].map((px) => [`scrolling dark-mode photo grid at ${px} px/s`, () => scenes.scrollPhotos(px, { dark: true })]),
  ['scrolling photo grid at 2000 px/s, 60 fps', () => scenes.scrollPhotos(2000, { fps: 60 })],
  ['flick-scrolling a photo grid', () => scenes.scrollPhotos(6000, { profile: 'flick' })],
  ['jiggling a photo grid up and down', () => scenes.scrollPhotos(0, { profile: 'jiggle' })],
  ...[1000, 3000].map((px) => [`scrolling a text page at ${px} px/s`, () => scenes.scrollText(px)]),
  ['scrolling a dark-mode text page at 2000 px/s', () => scenes.scrollText(2000, 4, true)],
  ...[1000, 3000].map((px) => [`sideways scrolling a photo carousel at ${px} px/s`, () => scenes.scrollPhotos(px, { horizontal: true })]),
  ...[800, 2500].map((px) => [`scrolling photos, aliased downscale (1 sample per cell) at ${px} px/s`, () => scenes.scrollPhotos(px, { ss: 1 })]),
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

const PLAYER = { x: 0.2, y: 0.18, w: 0.6, h: 0.6 }; // YouTube-sized player, 36% of the screen
for (const [name, gen] of [
  ['photo strobe 4 Hz full screen', () => scenes.photoStrobe(4)],
  ['photo strobe 8 Hz full screen', () => scenes.photoStrobe(8)],
  ['photo strobe 5 Hz in a video player', () => scenes.photoStrobe(5, { box: PLAYER })],
  ['photo vs its negative at 5 Hz', () => scenes.photoNegative(5)],
  ['brightness strobe while the camera pans at 800 px/s', () => scenes.strobeWhilePanning(5, 800)],
  ['rapid bright/dark cuts, 8 per second', () => scenes.rapidCuts(8)],
]) {
  test(`realistic trigger detected within 1.2 s: ${name}`, () => {
    const hit = firstActive(run(createFlashDetector(), gen()));
    assert.ok(hit, 'expected an active event');
    assert.ok(hit.tMs <= 1200, `first event at ${hit.tMs} ms`);
  });
}

test('flashing video while the page around it scrolls: still detected', () => {
  const hit = firstActive(run(createFlashDetector(), scenes.flashWhileScrolling(6, 1500)));
  assert.ok(hit, 'expected an active event');
  assert.ok(hit.tMs <= 1200, `first event at ${hit.tMs} ms`);
});

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

test('fast onset: 0.5 s after the first 3 Hz change, 0.25 s after the first 6 Hz change', () => {
  // first change at 167 ms (3 Hz) / 83 ms (6 Hz); 2 full flashes later protection must be on
  for (const [hz, limit] of [[3, 167 + 520], [6, 83 + 270]]) {
    const hit = firstActive(run(createFlashDetector(), scenes.flash(hz)));
    assert.ok(hit && hit.tMs <= limit, `${hz} Hz first event at ${hit?.tMs} ms`);
  }
});

test('pause: a still frame after an even 6 Hz flash releases within 0.4 s', () => {
  const results = run(createFlashDetector(), concat(() => scenes.flash(6, 2), () => scenes.steady(3)));
  const flashEnd = 2000;
  const lastAny = results.filter((r) => r.events.length).at(-1).tMs;
  assert.ok(lastAny <= flashEnd + 400, `released at ${lastAny}`);
});

test('hold: if the video keeps playing after flashing, protection holds (inactive) for about holdMs', () => {
  const holdMs = 1500;
  const results = run(createFlashDetector({ holdMs }), concat(() => scenes.flash(6, 2), () => scenes.normalVideo(5)));
  const lastActive = results.filter((r) => r.events.some((e) => e.active)).at(-1).tMs;
  const lastAny = results.filter((r) => r.events.length).at(-1).tMs;
  assert.ok(lastAny >= lastActive + holdMs - 50 && lastAny <= lastActive + holdMs + 50, `active until ${lastActive}, held until ${lastAny}`);
  const holding = results.find((r) => r.tMs > lastActive && r.events.length);
  assert.ok(holding.events.every((e) => !e.active));
  assert.equal(results.at(-1).events.length, 0);
});

test('strobe light: 3 Hz, one bright frame then ~300 ms dark, stays protected between flashes', () => {
  const gen = frames({ seconds: 4, pixel: (_x, _y, t) => (t % 333 < 34 ? [255, 255, 255] : [0, 0, 0]) });
  const results = run(createFlashDetector(), gen);
  const first = firstActive(results).tMs;
  const gaps = results.filter((r) => r.tMs > first + 100 && r.tMs < 3900 && !r.events.length);
  assert.equal(gaps.length, 0, `unprotected frames at ${gaps.map((g) => Math.round(g.tMs))}`);
});

test('bursts: flashing with short pauses stays protected', () => {
  // 6 Hz flashing in 0.6 s bursts with 0.2 s still gaps
  const gen = frames({
    seconds: 4,
    pixel: (_x, _y, t) => (t % 800 < 600 ? (Math.floor((t / 1000) * 12) % 2 ? [255, 255, 255] : [0, 0, 0]) : [0, 0, 0]),
  });
  const results = run(createFlashDetector(), gen);
  const first = firstActive(results).tMs;
  const gaps = results.filter((r) => r.tMs > first + 100 && r.tMs < 3800 && !r.events.length);
  assert.equal(gaps.length, 0, `unprotected frames at ${gaps.map((g) => Math.round(g.tMs))}`);
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

test('profiles: photosensitive catches a flash covering 12% of the screen (part of a video player)', async () => {
  const { DEFAULT_PROFILES } = await import('../src/shared/profiles.js');
  const box = { x: 0.3, y: 0.3, w: 0.35, h: 0.35 };
  const det = createFlashDetector({ ...DEFAULT_PROFILES.photosensitive.flash });
  assert.ok(firstActive(run(det, scenes.photoStrobe(5, { box }))));
});

test('settings migration: new default numbers, user choices kept', async () => {
  const { migrateSettings, SETTINGS_VERSION } = await import('../src/shared/profiles.js');
  const old = {
    enabled: false, activeProfileId: 'custom', appearance: { flashStyle: 'dim', smoothMs: 1500 },
    profiles: { custom: { content: { customTriggers: ['spiders'] }, flash: { minAreaFraction: 0.25 } } },
  };
  const s = migrateSettings(old);
  assert.equal(s.version, SETTINGS_VERSION);
  assert.equal(s.enabled, false);
  assert.equal(s.activeProfileId, 'photosensitive'); // flash-only for now: profile picker hidden
  assert.equal(s.appearance.flashStyle, 'dim');
  assert.deepEqual(s.profiles.custom.content.customTriggers, ['spiders']);
  assert.equal(s.profiles.custom.flash.minAreaFraction, 0.15);
});
