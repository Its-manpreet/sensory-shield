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

test('the very first sound after start-up (faint onset, then speech) is not mistaken for a sudden loud sound', () => {
  const out = trace((t) => (t < 50 ? -45 : -20), 2000, { leveling: false, softStart: false, harsh: false });
  assert.ok(out.every((o) => o.gainDb === 0), JSON.stringify(out.find((o) => o.gainDb < 0)));
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
  assert.ok(later < -8 && later >= -11, `settles near target (-18 from -8): ${later}`);
});

test('loudness normalisation: loud and quiet-ish content end up at about the same loudness, never boosted', () => {
  for (const lvl of [-4, -10, -14]) {
    const out = trace(() => lvl, 20000, { limiter: false, softStart: false, harsh: false });
    const g = at(out, 19000).gainDb;
    assert.ok(Math.abs(lvl + g - -18) < 1, `${lvl} -> ${lvl + g}`);
  }
  assert.ok(trace(() => -20, 10000, { limiter: false, softStart: false }).every((o) => o.gainDb === 0));
});

const toneTrace = (tone, ms, cfg = {}) => {
  const g = createLoudnessGuard({ leveling: false, limiter: false, softStart: false, ...cfg });
  const out = [];
  for (let t = 0; t <= ms; t += 10) out.push({ t, ...g.push({ levelDb: -26, tMs: t, ...tone(t) }) });
  return out;
};
const broad = { toneDb: -50, toneShareDb: -22 };

test('sharp high pitch (feedback squeal) dips the volume within ~50 ms, held while it lasts, then released', () => {
  const out = toneTrace((t) => (t >= 2000 && t < 4000 ? { toneDb: -20, toneShareDb: -1, toneSharpDb: 0 } : broad), 6000);
  assert.ok(out.filter((o) => o.t < 2000).every((o) => o.gainDb === 0));
  const hit = at(out, 2050);
  assert.ok(hit.gainDb <= -24 + 0.01 && hit.reason === 'harsh', JSON.stringify(hit));
  assert.ok(at(out, 3900).gainDb <= -23.9, 'held while the tone lasts');
  assert.ok(at(out, 4500).gainDb > -24 && at(out, 4500).gainDb < 0, 'releasing');
  assert.equal(at(out, 5100).gainDb, 0);
});

test('quieter sharp tone: a smaller dip, but at least the minimum', () => {
  const out = toneTrace(() => ({ toneDb: -42, toneShareDb: -2, toneSharpDb: 0 }), 500);
  assert.equal(at(out, 400).gainDb, -8);
});

test('broad high sounds (hi-hats, "s") and very short clicks do not trigger the sharp-tone dip', () => {
  assert.ok(toneTrace(() => ({ toneDb: -30, toneShareDb: -15, toneSharpDb: 0 }), 3000).every((o) => o.gainDb === 0));
  // speech "s"/"sh": a narrow hiss band can hold half the sound, but it is not a pure tone (real `say` speech)
  assert.ok(toneTrace(() => ({ toneDb: -27, toneShareDb: -4, toneSharpDb: -2.2 }), 3000).every((o) => o.gainDb === 0));
  assert.ok(toneTrace((t) => (t === 1000 || t === 1010 ? { toneDb: -20, toneShareDb: 0, toneSharpDb: 0 } : broad), 3000).every((o) => o.gainDb === 0));
  assert.ok(toneTrace(() => ({ toneDb: -20, toneShareDb: 0, toneSharpDb: 0 }), 1000, { harsh: false }).every((o) => o.gainDb === 0));
});

test('sound after a long silence (autoplay): volume already lowered DURING the silence, then eased in (no hitch)', () => {
  const out = trace((t) => (t < 6000 ? -90 : -24), 9000, { limiter: false, leveling: false });
  assert.equal(at(out, 4900).gainDb, 0, 'not yet: short silences are left alone');
  const ready = at(out, 5950);
  assert.ok(ready.gainDb <= -17 && ready.reason === 'soft-start', `pre-lowered before the sound: ${JSON.stringify(ready)}`);
  const start = at(out, 6000);
  assert.ok(start.gainDb <= -17, 'the first sound arrives already quiet');
  assert.ok(at(out, 7000).gainDb > start.gainDb);
  assert.equal(at(out, 8100).gainDb, 0);
  // never a dip after the sound has started: the gain only rises from the first sound on
  const after = out.filter((o) => o.t >= 6000);
  for (let i = 1; i < after.length; i++) assert.ok(after[i].gainDb >= after[i - 1].gainDb - 1e-9, `dip at ${after[i].t}`);
  const cont = trace(() => -24, 8000, { limiter: false, leveling: false });
  assert.ok(cont.slice(2).every((o) => o.gainDb === 0));
});

test('each part can be switched off on its own', () => {
  const loud = (t) => (t >= 5000 && t < 5600 ? -8 : -30);
  assert.ok(trace(loud, 7000, { limiter: false, leveling: false, softStart: false, harsh: false }).every((o) => o.gainDb === 0));
});
