// Guardian (webcam) detector tests on synthetic in-memory camera frames. No real video, nobody filmed.
// A "body" is a textured block that moves; the background is a fixed texture plus camera noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeizureDetector, SEIZURE_PRESETS } from '../src/engine/seizure.js';

const W = 32;
const H = 24;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * @param {{ shift?: (t:number)=>number, rect?: {x:number,y:number,w:number,h:number}, seconds?: number, fps?: number,
 *           light?: (t:number)=>number, jitterMs?: number, noise?: number }} o
 */
function* scene(o = {}) {
  const { shift = () => 0, rect = { x: 9, y: 4, w: 14, h: 18 }, seconds = 20, fps = 15, light = () => 1, jitterMs = 6, noise = 2.5 } = o;
  const rand = rng(7);
  const bg = Array.from({ length: W * H }, () => 70 + rand() * 60);
  for (let f = 0; f < seconds * fps; f++) {
    const tMs = (f * 1000) / fps + (rand() - 0.5) * jitterMs; // timers are never exact
    const t = tMs / 1000;
    const s = shift(t);
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = bg[y * W + x];
        if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) {
          const xw = x - s; // body texture moves with the body
          v = 120 + 55 * Math.sin((2 * Math.PI * xw) / 5) * Math.cos((2 * Math.PI * (y + 0.3 * s)) / 7);
        }
        v = v * light(t) + (rand() - 0.5) * 2 * noise;
        const p = (y * W + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = v;
        data[p + 3] = 255;
      }
    }
    yield { data, tMs };
  }
}

function run(frames, config) {
  const d = createSeizureDetector(config);
  const out = [];
  for (const fr of frames) out.push({ t: fr.tMs / 1000, ...d.push(fr) });
  return out;
}
const firstSuspect = (res) => res.find((s) => s.level === 'suspect');
const shake = (hz, amp = 1.5) => (t) => amp * Math.sin(2 * Math.PI * hz * t);

for (const hz of [2, 3, 5]) {
  test(`suspect after ~10 s of whole-body ${hz} Hz jerking`, () => {
    const res = run(scene({ shift: shake(hz) }));
    const hit = firstSuspect(res);
    assert.ok(hit, `never suspect; max fraction ${Math.max(...res.map((r) => r.rhythmicFraction)).toFixed(3)}`);
    assert.ok(hit.t >= 10 && hit.t <= 16, `suspect at ${hit.t.toFixed(1)} s`);
    assert.ok(Math.abs(hit.freqHz - hz) < hz * 0.35, `freq ${hit.freqHz.toFixed(2)} vs ${hz}`);
  });
}

test('suspect with irregular jerking (rate wanders 2-4 Hz, amplitude varies)', () => {
  const shift = (t) => (1 + 0.5 * Math.sin(0.7 * t)) * Math.sin(2 * Math.PI * (3 * t + (0.8 / (2 * Math.PI * 0.3)) * Math.sin(2 * Math.PI * 0.3 * t)));
  assert.ok(firstSuspect(run(scene({ shift }))));
});

test('suspect at 10 fps as well (slow camera)', () => {
  assert.ok(firstSuspect(run(scene({ shift: shake(2.5), fps: 10 }))));
});

test('minDurationSec is respected', () => {
  const hit = firstSuspect(run(scene({ shift: shake(3), seconds: 30 }), { minDurationSec: 18 }));
  assert.ok(hit && hit.t >= 18, `suspect at ${hit?.t}`);
});

test('minDurationSec 1 s: steady shaking is flagged within a few seconds', () => {
  const hit = firstSuspect(run(scene({ shift: shake(3), seconds: 15 }), { minDurationSec: 1 }));
  assert.ok(hit && hit.t < 8, `suspect at ${hit?.t}`);
});

test('minMotion is respected: a high limit ignores the same shaking', () => {
  const frames = scene({ shift: shake(3), seconds: 20 });
  assert.ok(firstSuspect(run(frames)));
  const res = run(frames, { minMotion: 30 });
  assert.ok(!firstSuspect(res) && !res.some((s) => s.level === 'rhythmic'));
});

test('threshold mode: motion over the number triggers, under it never does, rhythm not needed', () => {
  // random jumps: no rhythm at all, so the rhythm mode ignores it
  const jumpy = (t) => (Math.floor(t * 7) * 2654435761) % 7 - 3;
  const frames = [...scene({ shift: jumpy, seconds: 20 })];
  const res = run(frames, { mode: 'threshold', motionThreshold: 1, minDurationSec: 2 });
  const hit = firstSuspect(res);
  assert.ok(hit && hit.path === 'threshold', 'over the number -> suspect');
  const peak = Math.max(...res.map((s) => s.motion));
  assert.ok(!firstSuspect(run(frames, { mode: 'threshold', motionThreshold: peak + 0.5, minDurationSec: 2 })), 'under the number -> never');
  assert.ok(!firstSuspect(run(frames, { mode: 'threshold', motionThreshold: 25 })), 'synthetic movement is well under 25');
});

test('severe movement still counts in smart mode, however far over the limit and however irregular', () => {
  // violent, irregular, whole-body: random jumps, no rhythm
  const violent = (t) => ((Math.floor(t * 9) * 2654435761) % 13) - 6;
  const frames = [...scene({ shift: violent, seconds: 20 })];
  assert.ok(!firstSuspect(run(frames, { mode: 'rhythm', motionThreshold: 1e9 })), 'not rhythmic: smart checks alone miss it');
  const res = run(frames, { mode: 'rhythm', motionThreshold: 1 });
  const hit = firstSuspect(res);
  assert.ok(hit && hit.path === 'threshold', 'over the limit -> suspect even in smart mode');
  // once over, it stays categorised while it stays over (no upper cut-off)
  const after = res.filter((s) => s.t >= hit.t);
  assert.ok(after.every((s) => s.motion < 1 || s.level === 'suspect'));
});

// "Small movements (head)" preset: a head-sized area moving a little, not caught by the whole-body defaults
const HEAD = { x: 13, y: 2, w: 6, h: 6 };
for (const [name, shift] of [
  ['nodding 1 Hz', shake(1, 1)],
  ['shaking 2 Hz, small', shake(2, 0.6)],
  ['jerking 3 Hz, small', shake(3, 0.5)],
  ['slow nod 0.8 Hz', shake(0.8, 1.5)],
  ['tiny 1.5 Hz', shake(1.5, 0.3)],
]) {
  test(`small preset: head ${name} -> suspect (defaults ignore it)`, () => {
    const frames = [...scene({ shift, rect: HEAD, seconds: 20 })];
    assert.ok(firstSuspect(run(frames, SEIZURE_PRESETS.small)));
    assert.ok(!firstSuspect(run(frames)));
  });
}
for (const [name, opts] of [
  ['still person', {}],
  ['empty room, heavy camera noise', { rect: { x: 0, y: 0, w: 0, h: 0 }, noise: 6 }],
  ['slow sway 0.3 Hz', { shift: shake(0.3, 3) }],
  ['leaning 0.6 Hz', { shift: shake(0.6, 2) }],
  ['head drifting 0.5 Hz', { shift: shake(0.5, 1), rect: HEAD }],
  ['one slow head turn', { shift: (t) => (t > 5 && t < 8 ? 2 * Math.sin((Math.PI * (t - 5)) / 3) : 0), rect: HEAD }],
  ['lights switching', { light: (t) => (Math.floor(t / 4) % 2 ? 1 : 0.6) }],
]) {
  test(`small preset: never suspect: ${name}`, () => {
    assert.ok(!firstSuspect(run(scene({ ...opts, seconds: 20 }), SEIZURE_PRESETS.small)));
  });
}

for (const [name, opts] of [
  ['still person, camera noise', {}],
  ['empty room, heavy camera noise', { rect: { x: 0, y: 0, w: 0, h: 0 }, noise: 6 }],
  ['slow sway (0.3 Hz)', { shift: shake(0.3, 3) }],
  ['leaning back and forth (0.6 Hz)', { shift: shake(0.6, 2) }],
  ['rocking (0.8 Hz)', { shift: shake(0.8, 2.5) }],
  ['small nods while talking (1.5 Hz, tiny)', { shift: shake(1.5, 0.15) }],
  ['4 s burst of shaking, then still', { shift: (t) => (t > 5 && t < 9 ? shake(3)(t) : 0), seconds: 25 }],
  ['typing: small rhythmic area at the bottom', { shift: shake(4), rect: { x: 12, y: 20, w: 6, h: 3 } }],
  ['waving one hand in a corner', { shift: shake(2), rect: { x: 1, y: 1, w: 6, h: 6 } }],
  [
    'random fidgeting (jumps at random moments)',
    {
      shift: (() => {
        const rand = rng(3);
        const jumps = [];
        for (let t = 0; t < 20; t += 0.25 + rand() * 0.9) jumps.push([t, (rand() - 0.5) * 4]);
        return (t) => jumps.findLast(([s]) => s <= t)?.[1] ?? 0;
      })(),
    },
  ],
  ['lights switched off and on once', { light: (t) => (t > 6 && t < 12 ? 0.3 : 1) }],
]) {
  test(`never suspect: ${name}`, () => {
    const res = run(scene({ seconds: 20, ...opts }));
    const hit = firstSuspect(res);
    assert.equal(hit, undefined, `suspect at ${hit?.t.toFixed(1)} s (fraction ${hit?.rhythmicFraction.toFixed(3)}, ${hit?.freqHz.toFixed(2)} Hz)`);
  });
}

// The motion-energy path (ported from shake_proxy_detector.py) on its own, cell path switched off.
const ENERGY_ONLY = { minCorr: 9 };
test('energy path alone: suspect on 3 Hz whole-body jerking', () => {
  const hit = firstSuspect(run(scene({ shift: shake(3, 2) }), ENERGY_ONLY));
  assert.ok(hit, 'never suspect');
  assert.equal(hit.path, 'energy');
});
for (const [name, opts] of [
  ['still person', {}],
  ['slow sway (0.3 Hz)', { shift: shake(0.3, 3) }],
  ['rocking (0.8 Hz)', { shift: shake(0.8, 2.5) }],
  ['typing: small rhythmic area', { shift: shake(4), rect: { x: 12, y: 20, w: 6, h: 3 } }],
  ['waving one hand in a corner', { shift: shake(2), rect: { x: 1, y: 1, w: 6, h: 6 } }],
  ['lights switched off and on once', { light: (t) => (t > 6 && t < 12 ? 0.3 : 1) }],
]) {
  test(`energy path alone, never suspect: ${name}`, () => {
    assert.equal(firstSuspect(run(scene(opts), ENERGY_ONLY)), undefined);
  });
}

test('warming until the window is full; dark scene is flagged', () => {
  const res = run(scene({ light: () => 0.05, seconds: 6 }));
  assert.equal(res[0].level, 'warming');
  assert.ok(res.at(-1).dark);
  assert.notEqual(res.at(-1).level, 'warming');
});

test('stops being suspect once the movement stops (after the gap)', () => {
  const res = run(scene({ shift: (t) => (t < 16 ? shake(3)(t) : 0), seconds: 26 }));
  assert.ok(firstSuspect(res));
  assert.notEqual(res.at(-1).level, 'suspect');
});

test('reset clears history', () => {
  const d = createSeizureDetector();
  let last;
  for (const fr of scene({ shift: shake(3) })) last = d.push(fr);
  assert.equal(last.level, 'suspect');
  d.reset();
  const [fr] = scene({ shift: shake(3), seconds: 1 });
  assert.equal(d.push(fr).level, 'warming');
});

test('push() is cheap (32x24 grid, 15 fps)', () => {
  const d = createSeizureDetector();
  const frames = [...scene({ shift: shake(3), seconds: 12 })];
  const t0 = performance.now();
  for (const fr of frames) d.push(fr);
  const ms = (performance.now() - t0) / frames.length;
  console.log(`# seizure push(): ${ms.toFixed(2)} ms per frame`);
  assert.ok(ms < 8, `${ms.toFixed(2)} ms`);
});
