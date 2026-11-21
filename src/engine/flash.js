// OWNER: Agent B. STUB from the scaffold: returns no events so the app runs. Replace with the real detector.
// Contract: docs/INTERFACES.md section 1. Pure JS: no DOM, no Electron, no network.

export const DEFAULT_FLASH_CONFIG = Object.freeze({
  gridW: 64,
  gridH: 36,
  regionsX: 4,
  regionsY: 4,
  maxFlashesPerSec: 3,
  minAreaFraction: 0.25,
  holdMs: 1500,
  detectRed: true,
});

/**
 * @param {Partial<import('../shared/types.js').FlashConfig>} [config]
 * @returns {{ push(frame: import('../shared/types.js').FrameInput): import('../shared/types.js').FlashEvent[], reset(): void }}
 */
export function createFlashDetector(config = {}) {
  const cfg = { ...DEFAULT_FLASH_CONFIG, ...config };
  void cfg;
  return {
    push(_frame) {
      return [];
    },
    reset() {},
  };
}
