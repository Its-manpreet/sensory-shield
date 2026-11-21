// OWNER: Agent C (with A for packaging). Pinned versions and file names for the on-device vision model.
// Shared by scripts/vision-setup.js (download) and src/main/vision.js (run). No Electron imports here.

/** llama.cpp release with LFM3-VL support (needs b12088 or newer) */
export const LLAMA_BUILD = 'b12359';

export const VISION_MODEL = {
  name: 'LFM3-VL-2B',
  repo: 'LiquidAI/LFM3-VL-2B-GGUF',
  dir: 'lfm3-vl',
  model: 'LFM3-VL-2B-Q4_K_M.gguf', // 1.1 GB language model
  mmproj: 'mmproj-LFM3-VL-2B-Q8_0.gguf', // 203 MB vision encoder + projector
};

/** e.g. 'darwin-arm64', 'win32-x64' */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}
