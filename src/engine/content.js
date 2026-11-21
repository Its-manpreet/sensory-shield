// OWNER: Agent C. STUB from the scaffold: everything scores as safe so the app runs. Replace with the real detector.
// Contract: docs/INTERFACES.md section 2. Runs in the renderer; import Transformers.js as
//   import { ... } from '@huggingface/transformers';   (resolved by the import map in each HTML page)
// Models load from models/ only; the main process blocks all network requests at runtime.

export const DEFAULT_CONTENT_CONFIG = Object.freeze({
  device: 'webgpu',
  modelId: 'TODO-agent-C',
  localModelPath: '../../models/',
  tilesX: 4,
  tilesY: 3,
});

/**
 * @param {Partial<import('../shared/types.js').ContentConfig>} [config]
 */
export async function createContentDetector(config = {}) {
  const cfg = { ...DEFAULT_CONTENT_CONFIG, ...config };
  return {
    async init() {
      return { device: 'stub', modelId: cfg.modelId, loadMs: 0 };
    },
    /** @param {import('../shared/types.js').Trigger[]} _triggers */
    async setTriggers(_triggers) {},
    /** @returns {Promise<import('../shared/types.js').TileResult[]>} */
    async scoreTiles(_frame, _changedTiles) {
      const out = [];
      for (let ty = 0; ty < cfg.tilesY; ty++) {
        for (let tx = 0; tx < cfg.tilesX; tx++) {
          out.push({
            rect: { x: tx / cfg.tilesX, y: ty / cfg.tilesY, w: 1 / cfg.tilesX, h: 1 / cfg.tilesY },
            triggerId: null,
            label: null,
            score: 0,
          });
        }
      }
      return out;
    },
    dispose() {},
  };
}
