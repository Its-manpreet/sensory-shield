// OWNER: Agent D. Renderer-side settings store (docs/INTERFACES.md section 4).
// In Electron it talks to main through window.shield (src/main/preload.cjs).
// Opened as a plain web page (no Electron), it falls back to an in-memory mock so UI work can start early.
import { defaultSettings } from './profiles.js';

const bridge = globalThis.window?.shield;
let mock = defaultSettings();
const mockListeners = new Set();

/** @returns {Promise<import('./types.js').Settings>} */
export async function getSettings() {
  return bridge ? bridge.getSettings() : structuredClone(mock);
}

/** @param {Partial<import('./types.js').Settings>} patch @returns {Promise<import('./types.js').Settings>} */
export async function setSettings(patch) {
  if (bridge) return bridge.setSettings(patch);
  mock = { ...mock, ...structuredClone(patch) };
  for (const cb of mockListeners) cb(structuredClone(mock));
  return structuredClone(mock);
}

/** @param {(s: import('./types.js').Settings) => void} cb @returns {() => void} unsubscribe */
export function onChange(cb) {
  if (bridge) return bridge.onSettingsChanged(cb);
  mockListeners.add(cb);
  return () => mockListeners.delete(cb);
}
