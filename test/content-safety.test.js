// OWNER: Agent C. Pure parts of child-safety protection (no models): text layout, categories, settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupParagraphs, textUnits, explicitAreas } from '../src/engine/text-layout.js';
import { triggersFor, thresholdFor, decide, SAFE_PROMPTS, PHOBIAS } from '../src/engine/categories.js';
import { defaultSettings, migrateSettings, SETTINGS_VERSION } from '../src/shared/profiles.js';

const line = (text, x, y, w = 0.3, h = 0.02) => ({ text, rect: { x, y, w, h } });

test('lines in separate columns and blocks become separate paragraphs', () => {
  const paras = groupParagraphs([
    line('Left column first line of text here', 0.05, 0.1),
    line('left column second line continues', 0.05, 0.125),
    line('Right column first line', 0.6, 0.1),
    line('A block far below', 0.05, 0.5),
  ]);
  assert.equal(paras.length, 3);
  assert.equal(paras[0].length, 2);
});

test('sentences split at punctuation, at short lines, and before a new item', () => {
  const p = [
    line('Weekly shop', 0.05, 0.1, 0.1),
    line('Chicken breast, skinless, 500 g, £3.20. Cucumbers, 2 for £1.', 0.05, 0.125, 0.3),
    line('Sex: Male Female Prefer not to say', 0.05, 0.15, 0.29),
    line('Breast screening in the last 3 years?', 0.05, 0.175, 0.29),
  ];
  const units = textUnits([p]).filter((u) => u.kind === 'sentence').map((u) => u.text);
  assert.deepEqual(units, ['Weekly shop', 'Chicken breast, skinless, 500 g, £3.20.', 'Cucumbers, 2 for £1.', 'Sex: Male Female Prefer not to say', 'Breast screening in the last 3 years?']);
});

test('wrapped prose stays one sentence across lines', () => {
  const p = [line('He pulled her onto the bed and slowly undressed her, kissing his', 0.05, 0.1, 0.3), line('way down her body.', 0.05, 0.125, 0.1)];
  const s = textUnits([p]).filter((u) => u.kind === 'sentence');
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].lines, [0, 1]);
});

test('context widens a blur but never creates one', () => {
  const p = [line('Weekly shop', 0.05, 0.1, 0.1), line('Chicken breast. Cucumbers.', 0.05, 0.125, 0.3), line('Strip the paint.', 0.05, 0.15, 0.3)];
  const units = textUnits([p]);
  // the paragraph as a whole scores high, but no sentence does: nothing is blurred
  const scores = units.map((u) => (u.kind === 'paragraph' ? 0.95 : 0.3));
  assert.equal(explicitAreas([p], units, scores, 0.5).length, 0);
  // one explicit sentence in an explicit paragraph: the whole paragraph is blurred
  const scores2 = units.map((u, i) => (u.kind === 'paragraph' ? 0.95 : i === 1 ? 0.9 : 0.1));
  const areas = explicitAreas([p], units, scores2, 0.5);
  assert.equal(areas.length, 1);
  assert.ok(areas[0].rect.h > 0.07, 'covers all three lines');
});

test('one explicit sentence in a harmless paragraph blurs only its lines', () => {
  const p = [line('A long harmless sentence that fills the whole line of text.', 0.05, 0.1, 0.3), line('Another harmless sentence that fills this line too, really.', 0.05, 0.125, 0.3), line('An explicit sentence here that fills the line as well.', 0.05, 0.15, 0.3)];
  const units = textUnits([p]);
  const scores = units.map((u) => (u.kind === 'sentence' && u.lines.includes(2) ? 0.9 : 0.05));
  const areas = explicitAreas([p], units, scores, 0.5);
  assert.equal(areas.length, 1);
  assert.ok(areas[0].rect.y > 0.14 && areas[0].rect.y < 0.15);
});

test('triggers follow the safety switches; custom words are cleaned', () => {
  const t = triggersFor({ nudity: true, gore: false, violence: true, phobias: ['spiders', 'nope'], custom: ['  Horror Masks ', ''], sensitivity: 0.5 });
  assert.deepEqual(t.map((x) => x.id), ['nudity', 'violence', 'phobia:spiders', 'custom:horror masks']);
  assert.ok(t.every((x) => x.threshold === thresholdFor(0.5)));
  assert.ok(thresholdFor(1) < thresholdFor(0), 'higher sensitivity, lower bar');
  assert.ok(PHOBIAS.needles && SAFE_PROMPTS.length > 20);
});

test('decide: a trigger must beat ordinary content', () => {
  const triggers = [{ id: 'a', label: 'a', prompts: ['p1', 'p2'], threshold: 0.5 }];
  // prompts: p1, p2, then two safe prompts
  assert.equal(decide([0.3, 0.29, 0.2, 0.2], triggers).triggerId, 'a');
  assert.equal(decide([0.2, 0.2, 0.3, 0.29], triggers).triggerId, null);
});

test('settings v9: safety on by default; saved choices survive migration', () => {
  const d = defaultSettings();
  assert.equal(d.version, SETTINGS_VERSION);
  assert.equal(d.safety.enabled, true);
  assert.equal(migrateSettings({ version: 8, enabled: true, profiles: {} }).safety.nudity, true);
  const mine = { ...d, safety: { ...d.safety, phobias: ['spiders'], custom: ['clowns'], gore: false } };
  const back = migrateSettings(JSON.parse(JSON.stringify(mine)));
  assert.deepEqual(back.safety.phobias, ['spiders']);
  assert.equal(back.safety.gore, false);
});
