// OWNER: Agent C. Parsing and tracking for the vision-model content detector (no model needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDetections, parseClassify, classifyPrompt, detectPrompt, describeTerm, dedupeBoxes, padBox } from '../src/main/vision-prompt.js';
import { trackDetections, triggersForProfile } from '../src/engine/content.js';
import { DEFAULT_PROFILES } from '../src/shared/profiles.js';

const T = ['spiders', 'clowns', 'cartoon', 'gore'].map((l) => ({ id: l, label: l }));

test('parse: plain answer, 0..1000 coordinates', () => {
  const d = parseDetections('[{"label": "spiders", "bbox": [637, 372, 855, 666]}]', T);
  assert.equal(d.length, 1);
  assert.equal(d[0].term.id, 'spiders');
  assert.deepEqual(Object.values(d[0].box).map((v) => +v.toFixed(3)), [0.637, 0.372, 0.218, 0.294]);
});

test('parse: duplicate keys in one object keep every box (seen from LFM3-VL)', () => {
  const d = parseDetections('[{"label": "spiders", "bbox": [637, 372, 855, 666], "bbox": [75, 314, 429, 723], "label": "spiders"}]', T);
  assert.equal(d.length, 2);
});

test('parse: bbox_2d, numbered labels, described labels, prose and code fences', () => {
  const text = 'Here you go:\n```json\n[{"bbox_2d": [10, 10, 200, 200], "label": 2}, {"label": "cartoons or animated drawings", "bbox": [500, 500, 900, 900]}]\n```';
  const d = parseDetections(text, T);
  assert.deepEqual(d.map((x) => x.term?.id), ['clowns', 'cartoon']);
});

test('parse: unknown label still proposes a box (classification decides); junk is ignored', () => {
  assert.equal(parseDetections('[{"label": "spiders", "bbox": []}, {"bbox": [1, 2]}, "x"]', T).length, 0);
  const d = parseDetections('[{"label": "horse", "bbox": [0, 0, 500, 500]}]', T);
  assert.equal(d.length, 1);
  assert.equal(d[0].term, null);
  assert.deepEqual(parseDetections('[]', T), []);
  assert.deepEqual(parseDetections('I cannot see anything.', T), []);
});

test('classify answers: number -> term, 0 or nonsense -> null', () => {
  assert.equal(parseClassify('2', T).id, 'clowns');
  assert.equal(parseClassify(' 1.', T).id, 'spiders');
  assert.equal(parseClassify('0', T), null);
  assert.equal(parseClassify('The image shows a landscape', T), null);
  assert.equal(parseClassify('9', T), null);
});

test('prompts: broad words are expanded for the model, user words kept', () => {
  assert.match(describeTerm({ label: 'gore' }), /blood/);
  assert.match(describeTerm({ label: 'Pornography' }), /nudity/);
  assert.equal(describeTerm({ label: 'Hot dogs' }), 'hot dogs');
  assert.match(detectPrompt(T), /1\. spiders/);
  assert.match(classifyPrompt(T), /0 if none/);
});

test('boxes: near-duplicates dropped, padding stays on screen', () => {
  const a = { term: null, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } };
  const b = { term: null, box: { x: 0.11, y: 0.1, w: 0.3, h: 0.3 } };
  assert.equal(dedupeBoxes([a, b]).length, 1);
  const p = padBox({ x: 0, y: 0.98, w: 0.5, h: 0.02 });
  assert.ok(p.x === 0 && p.y + p.h <= 1.0000001);
});

test('tracking: stable ids across checks, one missed check tolerated, then dropped', () => {
  let n = 0;
  const key = () => String(++n);
  const box = { x: 0.5, y: 0.3, w: 0.2, h: 0.3 };
  let t = trackDetections([], [{ id: 'spiders', label: 'spiders', box }], key);
  const k = t[0].key;
  t = trackDetections(t, [{ id: 'spiders', label: 'spiders', box: { ...box, x: 0.52 } }], key);
  assert.equal(t[0].key, k, 'same object keeps its id when the box moves a little');
  t = trackDetections(t, [], key);
  assert.equal(t.length, 1, 'kept through one miss');
  t = trackDetections(t, [], key);
  assert.equal(t.length, 0, 'dropped after two misses');
});

test('profiles: graphic-sensitive sends its categories as terms', () => {
  assert.deepEqual(triggersForProfile(DEFAULT_PROFILES['graphic-sensitive']).map((t) => t.label), ['graphic-violence', 'graphic-injury']);
});
