// Sound from the content playing (system audio): decides how much to turn the volume DOWN. Pure JS, no DOM.
// Input: short-term level readings (dBFS of the captured system audio, ~20 per second). Output: a gain in dB
// (always <= 0) that the app applies to the system output volume. It never turns anything up beyond the
// user's own volume.
//
//   - Sudden loud sounds (jump scares, shouting, alarms): a reading `jumpDb` above the recent average cuts the
//     volume at once to about `allowOverDb` above that average, then releases over `releaseMs`.
//   - Loudness jumps between content (quiet video, then a loud ad): when the level stays above `targetDb`,
//     the volume is levelled down toward it, slowly (`levelTauMs`), so speech and music do not pump.
//   - Unexpected sound after silence (autoplay): sound starting after `silenceMs` of quiet starts
//     `softStartDb` down and eases in over `softStartMs`.
// Reduces exposure to known triggers; it does not replace hearing protection.

export const DEFAULT_LOUDNESS_CONFIG = Object.freeze({
  limiter: true,
  leveling: true,
  softStart: true,
  silenceDb: -60, // below this is silence
  averageMs: 3000, // "recent average" window
  jumpDb: 12, // a sudden sound this much louder than the recent average
  minLoudDb: -32, // and at least this loud in absolute terms
  allowOverDb: 4, // how far above the recent average a sudden sound may stay
  maxCutDb: -24,
  releaseMs: 1500,
  targetDb: -22, // comfortable level for leveling (dBFS of the system mix)
  levelTauMs: 2000,
  maxLevelCutDb: -15,
  silenceMs: 4000,
  softStartDb: -18,
  softStartMs: 2000,
});

/**
 * @param {Partial<typeof DEFAULT_LOUDNESS_CONFIG>} [config]
 * @returns {{ push(r: { levelDb: number, tMs: number }): { gainDb: number, reason: 'limiter'|'leveling'|'soft-start'|null }, reset(): void }}
 */
export function createLoudnessGuard(config = {}) {
  const cfg = { ...DEFAULT_LOUDNESS_CONFIG, ...config };
  let avg = null; // recent average level (dB), over sound only
  let lastT = null;
  let limit = 0; // current limiter cut (dB, <= 0), releasing toward 0
  let level = 0; // current leveling cut (dB, <= 0)
  let quietSince = null; // start of the current silence
  let soft = null; // { t0 } while a soft start is running

  return {
    push({ levelDb, tMs: t }) {
      const dt = lastT === null ? 50 : Math.max(0, t - lastT);
      lastT = t;
      const sound = levelDb > cfg.silenceDb;

      // --- unexpected sound after silence: ease it in ---
      if (!sound) {
        quietSince ??= t;
      } else {
        if (cfg.softStart && quietSince !== null && t - quietSince >= cfg.silenceMs) soft = { t0: t };
        quietSince = null;
      }
      let softCut = 0;
      if (soft) {
        const k = (t - soft.t0) / cfg.softStartMs;
        if (k >= 1) soft = null;
        else softCut = cfg.softStartDb * (1 - k);
      }

      // --- sudden loud sound: instant cut toward the recent average, slow release ---
      if (cfg.limiter && sound && avg !== null && levelDb - avg >= cfg.jumpDb && levelDb >= cfg.minLoudDb) {
        const want = Math.max(cfg.maxCutDb, avg + cfg.allowOverDb - levelDb);
        limit = Math.min(limit, want);
      }
      limit = Math.min(0, limit + (dt / cfg.releaseMs) * -cfg.maxCutDb * (limit < 0 ? 1 : 0));

      // --- leveling: slowly toward the comfortable target (only down) ---
      if (cfg.leveling && sound && avg !== null) {
        const want = Math.max(cfg.maxLevelCutDb, Math.min(0, cfg.targetDb - avg));
        level += (want - level) * (1 - Math.exp(-dt / cfg.levelTauMs));
      } else if (!cfg.leveling) level = 0;

      // recent average over sound only; a sudden peak barely moves it (that is what makes it "sudden")
      if (sound) avg = avg === null ? levelDb : avg + (levelDb - avg) * (1 - Math.exp(-dt / cfg.averageMs));

      const parts = [[limit, 'limiter'], [level, 'leveling'], [softCut, 'soft-start']];
      let gainDb = 0, reason = null;
      for (const [g, r] of parts) if (g < gainDb - 0.01) (gainDb = g), (reason = r);
      return { gainDb, reason };
    },
    reset() {
      avg = lastT = quietSince = soft = null;
      limit = level = 0;
    },
  };
}
