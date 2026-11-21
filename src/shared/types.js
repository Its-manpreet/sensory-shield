// OWNER: Agent D. JSDoc types mirroring docs/INTERFACES.md (the .md file is the source of truth).
// Import types with: /** @typedef {import('../shared/types.js').Region} Region */
export {};

/** @typedef {{x:number, y:number, w:number, h:number}} Rect  normalized 0..1, origin top-left */

/** @typedef {{gridW:number, gridH:number, regionsX:number, regionsY:number, maxFlashesPerSec:number, minAreaFraction:number, holdMs:number, detectRed:boolean}} FlashConfig */
/** @typedef {{data: Uint8ClampedArray, tMs: number}} FrameInput */
/** @typedef {{rect: Rect, severity: number, kind: 'luminance'|'red', active: boolean}} FlashEvent */

/** @typedef {{device: 'webgpu'|'wasm', modelId: string, localModelPath: string, tilesX: number, tilesY: number}} ContentConfig */
/** @typedef {{id: string, label: string, prompts: string[], threshold: number}} Trigger */
/** @typedef {{rect: Rect, triggerId: string|null, label: string|null, score: number}} TileResult */

/** @typedef {{id: string, rect: Rect, effect: 'dim'|'blur'|'freeze', reason: string, strength: number}} Region */

/**
 * @typedef {{
 *   id: string, name: string,
 *   flash:   { enabled: boolean, maxFlashesPerSec: number, minAreaFraction: number, detectRed: boolean },
 *   content: { enabled: boolean, threshold: number, categories: string[], customTriggers: string[] },
 *   response:{ fadeMs: number, showLabel: boolean, blurStrengthPx: number, dimLevel: number }
 * }} Profile
 */

/** @typedef {{flashStyle: 'glass'|'dim', smoothMs: number}} Appearance */
/** @typedef {{colorFlicker: boolean, loudLimiter: boolean, loudLeveling: boolean, softStart: boolean, harshTones: boolean}} Sensory */
/** @typedef {{enabled: boolean, nudity: boolean, sexualText: boolean, gore: boolean, violence: boolean, phobias: string[], custom: string[], sensitivity: number}} Safety */
/** @typedef {{enabled: boolean, activeProfileId: string, profiles: Record<string, Profile>, appearance: Appearance, sensory: Sensory, safety: Safety, guardian: Guardian}} Settings */
/** @typedef {{enabled: boolean, userName: string, contacts: {name: string, topic: string}[], server: string, minDurationSec: number, countdownSec: number}} Guardian */

/** @typedef {{fps: number, flashMs: number, modelMs: number, modelHz: number}} ShieldStats */
