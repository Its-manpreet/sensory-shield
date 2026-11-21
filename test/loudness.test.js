// Sound protection decisions on synthetic level traces (dBFS readings every 50 ms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoudnessGuard } from '../src/engine/loudness.js';

function trace(levelAt, ms, cfg = {}) {
  const g = createLoudnessGuard(cfg);
  const out = [];
  for (let t = 0; t <= ms; t += 50) out.push({ t, level: levelAt(t), ...g.push({ levelDb: levelAt(t), tMs: t }) });
  return out;
}
const at = (out, t) => out.find((o) => o.t >= t);

test('sudden loud sound (jump scare) after quiet speech: cut at once, released over ~1.5 s', () => {
  const out = trace((t) => (t >= 5000 && t < 5600 ? -8 : -30), 8000, { leveling: false });
  const hit = at(out, 5000);
  assert.ok(hit.gainDb <= -14 && hit.reason === 'limiter', JSON.stringify(hit));
  assert.ok(at(out, 4900).gainDb === 0, 'nothing before');
  assert.ok(at(out, 6100).gainDb < 0 && at(out, 6100).gainDb > hit.gainDb, 'releasing');
  assert.equal(at(out, 7800).gainDb, 0, 'released');
});

test('steady loud music is not "sudden": no limiter (leveling handles loudness)', () => {
  const out = trace(() => -10, 6000, { leveling: false });
  assert.ok(out.every((o) => o.gainDb === 0));
});

test('quiet video then a loud ad: levelled down toward the comfortable level, slowly, only down', () => {
  const out = trace((t) => (t < 6000 ? -30 : -8), 16000, { limiter: false });
  assert.equal(at(out, 5900).gainDb, 0, 'quiet content is never boosted');
  const soon = at(out, 6500).gainDb, later = at(out, 15000).gainDb;
  assert.ok(soon > -4, `gentle at first: ${soon}`);
  assert.ok(later < -9 && later >= -15, `settles near target: ${later}`);
});

test('sound after a long silence (autoplay) eases in over ~2 s; continuous sound does not', () => {
  const out = trace((t) => (t < 5000 ? -90 : -24), 8000, { limiter: false, leveling: false });
  const start = at(out, 5000);
  assert.ok(start.gainDb <= -17 && start.reason === 'soft-start', JSON.stringify(start));
  assert.ok(at(out, 6000).gainDb > start.gainDb);
  assert.equal(at(out, 7100).gainDb, 0);
  const cont = trace(() => -24, 6000, { limiter: false, leveling: false });
  assert.ok(cont.slice(2).every((o) => o.gainDb === 0));
});

test('each part can be switched off on its own', () => {
  const loud = (t) => (t >= 5000 && t < 5600 ? -8 : -30);
  assert.ok(trace(loud, 7000, { limiter: false, leveling: false, softStart: false }).every((o) => o.gainDb === 0));
});
