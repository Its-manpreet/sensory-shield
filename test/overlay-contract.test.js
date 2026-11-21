// OWNER: Agent A. Integration guard: shapes from docs/INTERFACES.md that the overlay relies on.
// B, C, D: keep this passing when you replace a stub. Your own detailed tests go in test/<your-module>*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlashDetector } from '../src/engine/flash.js';
import { DEFAULT_PROFILES, defaultSettings, activeProfile } from '../src/shared/profiles.js';
import { toRegions } from '../src/overlay/regions.js';

const isRect = (r) => ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && r[k] >= 0 && r[k] <= 1);

test('flash detector: push returns FlashEvent[] with normalized rects', () => {
  const det = createFlashDetector({});
  assert.equal(typeof det.reset, 'function');
  for (let i = 0; i < 30; i++) {
    const v = i % 2 ? 255 : 0;
    const events = det.push({ data: new Uint8ClampedArray(64 * 36 * 4).fill(v), tMs: i * 33 });
    assert.ok(Array.isArray(events));
    for (const e of events) {
      assert.ok(isRect(e.rect));
      assert.ok(e.severity >= 0 && e.severity <= 1);
      assert.ok(['luminance', 'red'].includes(e.kind));
      assert.equal(typeof e.active, 'boolean');
    }
  }
});

test('profiles: the three defaults exist with every contract field', () => {
  for (const id of ['photosensitive', 'graphic-sensitive', 'custom']) {
    const p = DEFAULT_PROFILES[id];
    assert.equal(p.id, id);
    assert.ok(p.flash && p.content && p.response);
    assert.ok(Array.isArray(p.content.customTriggers));
  }
  assert.ok(activeProfile(defaultSettings()));
});

test('regions: flash -> dim, matched tile -> blur, safe tile -> nothing', () => {
  const profile = DEFAULT_PROFILES['graphic-sensitive'];
  const rect = { x: 0, y: 0, w: 0.25, h: 0.25 };
  const regions = toRegions(
    [{ rect, severity: 1, kind: 'luminance', active: true }],
    [
      { rect, triggerId: 'spiders', label: 'spiders', score: 0.9 },
      { rect: { ...rect, x: 0.5 }, triggerId: null, label: null, score: 0.1 },
    ],
    profile,
  );
  assert.deepEqual(regions.map((r) => r.effect), ['dim', 'blur']);
  assert.ok(regions.every((r) => isRect(r.rect) && r.strength >= 0 && r.strength <= 1));
});
