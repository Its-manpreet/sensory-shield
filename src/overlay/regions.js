// OWNER: Agent A. Pure function: detector outputs + active profile -> Region[] for the effects renderer.
// Kept DOM-free so it can be unit tested in Node (test/overlay-regions.test.js).

/**
 * @param {import('../shared/types.js').FlashEvent[]} flashEvents
 * @param {import('../shared/types.js').TileResult[]} tiles
 * @param {import('../shared/types.js').Profile} profile
 * @returns {import('../shared/types.js').Region[]}
 */
export function toRegions(flashEvents, tiles, profile) {
  const regions = [];
  if (profile.flash.enabled) {
    flashEvents.forEach((ev, i) => {
      regions.push({
        id: `flash-${i}-${ev.rect.x.toFixed(3)}-${ev.rect.y.toFixed(3)}`,
        rect: ev.rect,
        effect: 'dim',
        reason: ev.kind === 'red' ? 'Red flashing softened' : 'Flashing softened',
        strength: profile.response.dimLevel,
      });
    });
  }
  if (profile.content.enabled) {
    for (const t of tiles) {
      if (!t.triggerId) continue;
      regions.push({
        id: t.id ?? `tile-${t.rect.x.toFixed(3)}-${t.rect.y.toFixed(3)}`, // detectors may give stable ids
        rect: t.rect,
        effect: 'blur',
        reason: `Blurred: ${t.label ?? t.triggerId}`,
        strength: Math.min(1, profile.response.blurStrengthPx / 40),
      });
    }
  }
  return regions;
}
