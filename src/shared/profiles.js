// OWNER: Agent D. Scaffold placeholder so the app runs; D replaces the numbers and adds validation.
// Imported by the main process (Node ESM) AND by renderers, so keep it free of DOM / Node APIs.
// Shape: see docs/INTERFACES.md section 4.

/** @typedef {import('./types.js').Profile} Profile */

/** @type {Record<string, Profile>} */
export const DEFAULT_PROFILES = {
  photosensitive: {
    id: 'photosensitive',
    name: 'Photosensitive',
    // WCAG's flash area (341x256 px at 1024x768) is about 11% of a screen. 0.1 catches a flashing video
    // player that is only partly flashing; scrolling no longer false-alarms (motion is ignored).
    flash: { enabled: true, maxFlashesPerSec: 3, minAreaFraction: 0.1, detectRed: true },
    content: { enabled: false, threshold: 0.6, categories: [], customTriggers: [] },
    response: { fadeMs: 250, showLabel: true, blurStrengthPx: 24, dimLevel: 0.85 },
  },
  'graphic-sensitive': {
    id: 'graphic-sensitive',
    name: 'Graphic-content sensitive',
    flash: { enabled: true, maxFlashesPerSec: 3, minAreaFraction: 0.15, detectRed: true },
    content: { enabled: true, threshold: 0.6, categories: ['graphic-violence', 'graphic-injury'], customTriggers: [] },
    response: { fadeMs: 250, showLabel: true, blurStrengthPx: 24, dimLevel: 0.7 },
  },
  custom: {
    id: 'custom',
    name: 'Custom',
    flash: { enabled: true, maxFlashesPerSec: 3, minAreaFraction: 0.15, detectRed: true },
    content: { enabled: true, threshold: 0.6, categories: ['graphic-violence', 'graphic-injury'], customTriggers: [] },
    response: { fadeMs: 250, showLabel: true, blurStrengthPx: 24, dimLevel: 0.7 },
  },
};

/**
 * Settings: the whole persisted object. Settings only, never frames.
 * @returns {import('./types.js').Settings}
 */
/** bump when default numbers change; older saved settings are migrated in src/main/settings-file.js */
export const SETTINGS_VERSION = 3;

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    enabled: true,
    activeProfileId: 'photosensitive',
    profiles: structuredClone(DEFAULT_PROFILES),
    // How flashing is softened. 'glass': frosted fog over a time-smoothed copy (colours drift slowly);
    // 'dim': dark veil. smoothMs: time constant of the colour smoothing. Not part of Profile (frozen contract).
    appearance: { flashStyle: 'glass', smoothMs: 900, peekRadius: 0 }, // peekRadius > 0: clear content blur around the cursor (CSS px)
  };
}

/** @param {import('./types.js').Settings} s */
/**
 * Bring saved settings from an older version up to date: take the new default numbers but keep the
 * user's own choices (on/off, active profile, appearance, typed triggers).
 */
export function migrateSettings(saved) {
  const fresh = defaultSettings();
  if (!saved || typeof saved !== 'object') return fresh;
  if (saved.version === SETTINGS_VERSION) return { ...fresh, ...saved };
  const profiles = structuredClone(fresh.profiles);
  for (const [id, p] of Object.entries(saved.profiles ?? {})) {
    if (!profiles[id]) profiles[id] = p;
    else profiles[id].content.customTriggers = p.content?.customTriggers ?? [];
  }
  return {
    ...fresh,
    enabled: saved.enabled ?? fresh.enabled,
    activeProfileId: profiles[saved.activeProfileId] ? saved.activeProfileId : fresh.activeProfileId,
    appearance: { ...fresh.appearance, ...saved.appearance },
    profiles,
  };
}

export function activeProfile(s) {
  return s.profiles[s.activeProfileId] ?? s.profiles.custom ?? DEFAULT_PROFILES.custom;
}
