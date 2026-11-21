// Sound from the content playing (system audio): decides how much to turn the volume DOWN. Pure JS, no DOM.
// Input: readings of the captured system audio every ~10 ms (see src/overlay/level-worklet.js):
//   levelDb      perceived loudness (K-weighted, LUFS-like)
//   toneDb       level of the strongest narrow peak above 2.5 kHz (optional)
//   toneShareDb  how much of all the sound that peak is (0 dB = all of it) (optional)
//   toneSharpDb  how narrow the peak is (0 dB = a pure tone; a hiss band like "s" is -2 dB or lower) (optional)
// Output: a gain in dB (always <= 0) that the app applies to the system output volume. It never turns
// anything up beyond the user's own volume.
//
//   - Sudden loud sounds (jump scares, shouting, alarms): a reading `jumpDb` above the recent average cuts the
//     volume at once to about `allowOverDb` above that average, then releases over `releaseMs`.
//   - Sharp high pitches (whistles, feedback squeals, alarm beeps, mosquito tones): when one pure, narrow peak
//     above 2.5 kHz (`harshSharpDb`) is a large part of the sound (`harshShareDb`) for `harshHoldMs`, the volume dips so that tone ends near
//     `harshTargetDb`, held while it lasts, released over `harshReleaseMs`. The app cannot filter out just the
//     high frequencies (that needs a virtual audio device), so the whole sound dips while the tone lasts.
//     Broad high sounds (hi-hats, "s" and "sh" in speech) are not one pure peak, so they do not trigger it
//     (checked on real speech in test/loudness-check.html).
//   - Loudness normalisation (quiet video, then a loud ad): the short-term loudness (power average over
//     `loudWindowMs`) is brought down toward `targetDb`: faster when it gets louder (`levelAttackMs`), slower
//     when it gets quieter (`levelReleaseMs`), so speech and music do not pump. Content quieter than the
//     target plays at the user's own volume (never boosted).
//   - Unexpected sound after silence (autoplay): after `silenceMs` of quiet the volume is ALREADY lowered by
//     `softStartDb` (inaudible, nothing is playing), so new sound starts quiet and eases in over `softStartMs`.
//     Lowering only after the sound is detected would let its first ~10-50 ms through at full volume and then
//     dip: an audible hitch, worse than nothing.
// Reduces exposure to known triggers; it does not replace hearing protection.

export const DEFAULT_LOUDNESS_CONFIG = Object.freeze({
  limiter: true,
  leveling: true,
  softStart: true,
  harsh: true,
  silenceDb: -60, // below this is silence
  averageMs: 3000, // "recent average" window
  jumpDb: 12, // a sudden sound this much louder than the recent average
  minLoudDb: -32, // and at least this loud in absolute terms
  allowOverDb: 4, // how far above the recent average a sudden sound may stay
  maxCutDb: -24,
  limiterWarmupMs: 300, // the recent average needs this much sound first (else the faint first ms of a sound look "quiet")
  releaseMs: 1500,
  targetDb: -18, // comfortable loudness (LUFS-like, of the system mix before the system volume). Streaming
  // services publish at about -14, so ordinary content is trimmed a little and loud ads (-8 and up) a lot
  loudWindowMs: 3000, // short-term loudness window (as EBU R128 "short-term")
  levelAttackMs: 800,
  levelReleaseMs: 4000,
  maxLevelCutDb: -20,
  harshShareDb: -6, // the tone is at least a quarter of all the sound
  harshSharpDb: -1, // and a pure tone: tones measure ~0 dB, speech sibilants -2.2 dB at their sharpest
  harshMinDb: -45, // and audible in absolute terms (dBFS)
  harshHoldMs: 40, // for this long (two FFT frames): one click or "s" does not count
  harshTargetDb: -48, // dip until the tone is about this loud
  harshMinCutDb: -8, // a dip is always at least this deep, so it is real relief
  harshMaxCutDb: -24,
  harshReleaseMs: 1000,
  silenceMs: 5000, // long enough that ordinary pauses in a video do not count
  softStartDb: -18,
  softStartMs: 2000,
});

/**
 * @param {Partial<typeof DEFAULT_LOUDNESS_CONFIG>} [config]
 * @returns {{ push(r: { levelDb: number, tMs: number, toneDb?: number, toneShareDb?: number, toneSharpDb?: number }): { gainDb: number, reason: 'limiter'|'harsh'|'leveling'|'soft-start'|null }, reset(): void }}
 */
export function createLoudnessGuard(config = {}) {
  const cfg = { ...DEFAULT_LOUDNESS_CONFIG, ...config };
  let avg = null; // recent average level (dB), over sound only
  let power = null; // short-term loudness as mean power (linear), over sound only
  let lastT = null;
  let soundMs = 0; // how much sound the recent average has seen
  let limit = 0; // current limiter cut (dB, <= 0), releasing toward 0
  let harsh = 0; // current sharp-tone cut (dB, <= 0)
  let harshSince = null; // start of the current sharp tone
  let level = 0; // current leveling cut (dB, <= 0)
  let quietSince = null; // start of the current silence
  let soft = null; // { t0 } while a soft start is running

  return {
    push({ levelDb, tMs: t, toneDb = -120, toneShareDb = -120, toneSharpDb = -120 }) {
      const dt = lastT === null ? 10 : Math.max(0, t - lastT);
      lastT = t;
      const sound = levelDb > cfg.silenceDb;

      // --- unexpected sound after silence: lowered in advance during the silence, eased in when it starts ---
      let softCut = 0;
      if (!sound) {
        quietSince ??= t;
        soft = null;
        if (cfg.softStart && t - quietSince >= cfg.silenceMs) softCut = cfg.softStartDb; // pre-lowered, inaudible
      } else {
        if (cfg.softStart && quietSince !== null && t - quietSince >= cfg.silenceMs) soft = { t0: t };
        quietSince = null;
      }
      if (soft) {
        const k = (t - soft.t0) / cfg.softStartMs;
        if (k >= 1) soft = null;
        else softCut = cfg.softStartDb * (1 - k);
      }

      // --- sudden loud sound: instant cut toward the recent average, slow release ---
      if (sound) soundMs += dt;
      if (cfg.limiter && sound && avg !== null && soundMs >= cfg.limiterWarmupMs && levelDb - avg >= cfg.jumpDb && levelDb >= cfg.minLoudDb) {
        const want = Math.max(cfg.maxCutDb, avg + cfg.allowOverDb - levelDb);
        limit = Math.min(limit, want);
      }
      if (limit < 0) limit = Math.min(0, limit + (dt / cfg.releaseMs) * -cfg.maxCutDb);

      // --- sharp high pitch: dip while one narrow high peak dominates, then release ---
      const tonal = cfg.harsh && toneShareDb >= cfg.harshShareDb && toneSharpDb >= cfg.harshSharpDb && toneDb >= cfg.harshMinDb;
      if (tonal) {
        harshSince ??= t;
        if (t - harshSince >= cfg.harshHoldMs) {
          const want = Math.max(cfg.harshMaxCutDb, Math.min(cfg.harshMinCutDb, cfg.harshTargetDb - toneDb));
          harsh = Math.min(harsh, want);
        }
      } else {
        harshSince = null;
        if (harsh < 0) harsh = Math.min(0, harsh + (dt / cfg.harshReleaseMs) * -cfg.harshMaxCutDb);
      }
      if (!cfg.harsh) harsh = 0;

      // --- loudness normalisation: short-term loudness toward the comfortable target (only down) ---
      if (sound) {
        const p = 10 ** (levelDb / 10);
        power = power === null ? p : power + (p - power) * (1 - Math.exp(-dt / cfg.loudWindowMs));
      }
      if (cfg.leveling && power !== null) {
        const loud = 10 * Math.log10(power);
        const want = Math.max(cfg.maxLevelCutDb, Math.min(0, cfg.targetDb - loud));
        const tau = want < level ? cfg.levelAttackMs : cfg.levelReleaseMs;
        level += (want - level) * (1 - Math.exp(-dt / tau));
      } else if (!cfg.leveling) level = 0;

      // recent average over sound only; a sudden peak barely moves it (that is what makes it "sudden").
      // Until it has seen `averageMs` of sound it is a plain running mean, so a faint first reading (the
      // onset of the first sound after start-up) does not hold it down for seconds.
      if (sound) avg = avg === null ? levelDb : avg + (levelDb - avg) * (soundMs < cfg.averageMs ? Math.min(1, dt / soundMs) : 1 - Math.exp(-dt / cfg.averageMs));

      // the deepest single cut wins; leveling and the dips do not stack (they react to the same loudness)
      const parts = [[limit, 'limiter'], [harsh, 'harsh'], [level, 'leveling'], [softCut, 'soft-start']];
      let gainDb = 0, reason = null;
      for (const [g, r] of parts) if (g < gainDb - 0.01) (gainDb = g), (reason = r);
      return { gainDb, reason };
    },
    reset() {
      avg = power = lastT = quietSince = soft = harshSince = null;
      limit = level = harsh = soundMs = 0;
    },
  };
}
