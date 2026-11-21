// OWNER: Agent A. Pure function: flash detector output + active profile -> Region[] for the effects renderer.
// Kept DOM-free so it can be unit tested in Node (test/overlay-contract.test.js).
// (Content tiles -> blur regions is removed for now; see git tag vision-v1.)

/**
 * @param {import('../shared/types.js').FlashEvent[]} flashEvents
 * @param {import('../shared/types.js').Profile} profile
 * @returns {import('../shared/types.js').Region[]}
 */
export function toRegions(flashEvents, profile) {
  if (!profile.flash.enabled) return [];
  return flashEvents.map((ev, i) => ({
    id: `flash-${i}-${ev.rect.x.toFixed(3)}-${ev.rect.y.toFixed(3)}`,
    rect: ev.rect,
    effect: 'dim', // drawn as glass fog or a dark veil, per settings.appearance.flashStyle
    reason: ev.kind === 'red' ? 'Red flashing softened' : 'Flashing softened',
    strength: profile.response.dimLevel,
  }));
}
