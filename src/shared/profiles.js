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
export const SETTINGS_VERSION = 10;

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    enabled: true,
    activeProfileId: 'photosensitive',
    profiles: structuredClone(DEFAULT_PROFILES),
    // How flashing is softened. 'glass': frosted fog over a time-smoothed copy (colours drift slowly);
    // 'dim': dark veil. smoothMs: time constant of the colour smoothing. Not part of Profile (frozen contract).
    appearance: { flashStyle: 'glass', smoothMs: 900 },
    // One switch per trigger beyond plain flashing. Not part of Profile (frozen contract).
    sensory: {
      colorFlicker: true, // red <-> blue colour flicker (red flashes follow profile.flash.detectRed)
      // sound of what is playing (system volume is turned down, never up)
      loudLimiter: true, // sudden loud sounds: jump scares, shouting, alarms
      loudLeveling: true, // normalise loudness between content (quiet video, then a loud ad); on since v10
      harshTones: true, // sharp high pitches: whistles, feedback squeals, alarm beeps (whole volume dips)
      softStart: true, // sound that starts by itself after silence (autoplay) is eased in
    },
    // Child safety / content protection: on-device picture and text models blur what matches.
    // Not part of Profile (frozen contract). Categories: src/engine/categories.js.
    safety: {
      enabled: true,
      nudity: true, // nudity and sexual images (NudeNet + MobileCLIP)
      sexualText: true, // sexual / explicit writing, judged in context (OCR + two text models)
      gore: true, // graphic injury, blood, dead bodies
      violence: true, // guns, knives, fighting
      phobias: [], // ids from PHOBIAS in src/engine/categories.js, e.g. 'spiders', 'needles'
      custom: [], // any words, e.g. 'clowns', 'horror masks'
      sensitivity: 0.5, // 0..1, higher blurs more readily
    },
    // Guardian: the webcam watches for strong rhythmic movement (a possible convulsive seizure), asks
    // "Are you OK?", and with no answer sends a TEXT alert to trusted contacts (ntfy push). Off by default:
    // it is the app's only network use and it needs the camera. Frames stay in memory. src/main/guardian.js.
    guardian: {
      enabled: false,
      userName: '', // used in the alert text, e.g. "Sam did not answer"
      contacts: [], // [{ name, topic }] ntfy topics the contacts subscribe to
      server: 'https://ntfy.sh',
      minDurationSec: 10, // rhythmic this long before the check
      countdownSec: 30, // time to answer the check before alerting
    },
  };
}

/** @param {import('./types.js').Settings} s */
/**
 * Bring saved settings from an older version up to date: take the new default numbers but keep the
 * user's own choices (on/off, active profile, appearance, typed triggers).
 */
/** current keys only (removed switches are dropped), saved values where they exist */
const pick = (fresh, saved = {}) => Object.fromEntries(Object.keys(fresh).map((k) => [k, k in saved ? saved[k] : fresh[k]]));

export function migrateSettings(saved) {
  const fresh = defaultSettings();
  if (!saved || typeof saved !== 'object') return fresh;
  if (saved.version === SETTINGS_VERSION) return { ...fresh, ...saved, sensory: pick(fresh.sensory, saved.sensory), safety: pick(fresh.safety, saved.safety), guardian: pick(fresh.guardian, saved.guardian) };
  const profiles = structuredClone(fresh.profiles);
  for (const [id, p] of Object.entries(saved.profiles ?? {})) {
    if (!profiles[id]) profiles[id] = p;
    else profiles[id].content.customTriggers = p.content?.customTriggers ?? [];
  }
  return {
    ...fresh,
    enabled: saved.enabled ?? fresh.enabled,
    // the profile picker is hidden while the app is flash-only: everyone uses Photosensitive
    activeProfileId: fresh.activeProfileId,
    appearance: { ...fresh.appearance, ...saved.appearance },
    // v10: loudness normalisation is on by default (before, off was the default, not a choice)
    sensory: { ...pick(fresh.sensory, saved.sensory), ...((saved.version ?? 0) < 10 ? { loudLeveling: true } : {}) },
    safety: pick(fresh.safety, saved.safety), // v9: new, on by default
    guardian: pick(fresh.guardian, saved.guardian),
    profiles,
  };
}

export function activeProfile(s) {
  return s.profiles[s.activeProfileId] ?? s.profiles.custom ?? DEFAULT_PROFILES.custom;
}
