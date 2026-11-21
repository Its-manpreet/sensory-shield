// OWNER: Agent A. Pure functions: detector outputs + settings -> Region[] for the effects renderer.
// Kept DOM-free so they can be unit tested in Node (test/overlay-contract.test.js).
// `style` is an additive field (not in the frozen contract) that picks the look within an effect:
//   desaturate (red / colour flicker), veil (brightness ease), framecap (constant motion).

/**
 * Each switch is independent: plain flashing (profile.flash.enabled) covers 'luminance' events; red flashes
 * (profile.flash.detectRed) and red/blue colour flicker (sensory.colorFlicker) both arrive as 'red' events.
 * @param {import('../shared/types.js').FlashEvent[]} flashEvents
 * @param {import('../shared/types.js').Profile} profile
 * @param {{ colorFlicker?: boolean }} [sensory]
 * @returns {import('../shared/types.js').Region[]}
 */
export function toRegions(flashEvents, profile, sensory = {}) {
  const redOn = profile.flash.detectRed || !!sensory.colorFlicker;
  return flashEvents.filter((ev) => (ev.kind === 'red' ? redOn : profile.flash.enabled)).map((ev, i) => ({
    id: `flash-${i}-${ev.rect.x.toFixed(3)}-${ev.rect.y.toFixed(3)}`,
    rect: ev.rect,
    effect: 'dim', // drawn as glass fog or a dark veil, per settings.appearance.flashStyle
    style: ev.kind === 'red' ? 'desaturate' : undefined,
    reason: ev.kind === 'red' ? 'Red flicker softened' : 'Flashing softened',
    strength: profile.response.dimLevel,
  }));
}

const key = (r) => `${r.x.toFixed(2)}-${r.y.toFixed(2)}-${r.w.toFixed(2)}-${r.h.toFixed(2)}`;

/**
 * @param {{ brightness?: {rect: any, strength: number}[], motion?: {rect: any, kind: string}[] }} found
 * @returns {import('../shared/types.js').Region[]}
 */
export function sensoryRegions({ brightness = [], motion = [] }) {
  return [
    ...brightness.map((b) => ({ id: `bright-${key(b.rect)}`, rect: b.rect, effect: 'dim', style: 'veil', reason: '', strength: b.strength })),
    ...motion.map((m) => ({
      id: `motion-${m.kind}-${key(m.rect)}`,
      rect: m.rect,
      effect: 'freeze',
      style: 'framecap',
      reason: 'Motion calmed',
      strength: 1,
    })),
  ];
}
