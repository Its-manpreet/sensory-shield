// OWNER: Agent D. Scaffold placeholder so the app runs; D replaces the numbers and adds validation.
// Imported by the main process (Node ESM) AND by renderers, so keep it free of DOM / Node APIs.
// Shape: see docs/INTERFACES.md section 4.

/** @typedef {import('./types.js').Profile} Profile */

/** @type {Record<string, Profile>} */
export const DEFAULT_PROFILES = {
  photosensitive: {
    id: 'photosensitive',
    name: 'Photosensitive',
    flash: { enabled: true, maxFlashesPerSec: 3, minAreaFraction: 0.25, detectRed: true },
    content: { enabled: false, threshold: 0.6, categories: [], customTriggers: [] },
    response: { fadeMs: 300, showLabel: true, blurStrengthPx: 24, dimLevel: 0.85 },
  },
  'graphic-sensitive': {
    id: 'graphic-sensitive',
    name: 'Graphic-content sensitive',
    flash: { enabled: true, maxFlashesPerSec: 3, minAreaFraction: 0.25, detectRed: true },
    content: { enabled: true, threshold: 0.6, categories: ['graphic-violence', 'graphic-injury'], customTriggers: [] },
    response: { fadeMs: 300, showLabel: true, blurStrengthPx: 24, dimLevel: 0.7 },
  },
  custom: {
    id: 'custom',
    name: 'Custom',
    flash: { enabled: true, maxFlashesPerSec: 3, minAreaFraction: 0.25, detectRed: true },
    content: { enabled: true, threshold: 0.6, categories: ['graphic-violence', 'graphic-injury'], customTriggers: [] },
    response: { fadeMs: 300, showLabel: true, blurStrengthPx: 24, dimLevel: 0.7 },
  },
};

/**
 * Settings: the whole persisted object. Settings only, never frames.
 * @returns {import('./types.js').Settings}
 */
export function defaultSettings() {
  return {
    enabled: true,
    activeProfileId: 'graphic-sensitive',
    profiles: structuredClone(DEFAULT_PROFILES),
  };
}

/** @param {import('./types.js').Settings} s */
export function activeProfile(s) {
  return s.profiles[s.activeProfileId] ?? s.profiles.custom ?? DEFAULT_PROFILES.custom;
}
