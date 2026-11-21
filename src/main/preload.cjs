// OWNER: Agent A. Exposes window.shield to the overlay and settings renderers.
// Must stay CommonJS (sandboxed preload). Channels: docs/INTERFACES.md section 5.
const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('shield', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: (cb) => listen('settings:changed', cb),
  onToggle: (cb) => listen('shield:toggle', cb),
  onReveal: (cb) => listen('shield:reveal', cb),
  onOwnWindows: (cb) => listen('shield:own-windows', cb), // overlay: our own windows' rects, never analysed
  sendStats: (stats) => ipcRenderer.send('shield:stats', stats),
  sendAudioGain: (gainDb, reason) => ipcRenderer.send('audio:gain', { gainDb, reason }),
  onStats: (cb) => listen('shield:stats', cb), // settings window status line (main re-broadcasts)
  getStatus: () => ipcRenderer.invoke('shield:status'),
  openPermission: () => ipcRenderer.send('shield:open-permission'),
  relaunch: () => ipcRenderer.send('shield:relaunch'),
  // explicit-text protection: { width, height, gray: Uint8Array } -> { lines, ms, available } (memory only)
  recognizeText: (frame) => ipcRenderer.invoke('ocr:recognize', frame),
  // picture protection: { width, height, gray } -> { boxes: Rect[], available } where text is (no words)
  findTextBoxes: (frame) => ipcRenderer.invoke('ocr:boxes', frame),
  // Guardian (webcam). Camera window: levels only, never pixels. Check window: ladder state + "I'm OK".
  sendGuardianState: (s) => ipcRenderer.send('guardian:state', s),
  onGuardianConfig: (cb) => listen('guardian:config', cb),
  onGuardianReset: (cb) => listen('guardian:reset', cb),
  onGuardianLadder: (cb) => listen('guardian:ladder', cb),
  onGuardianStatus: (cb) => listen('guardian:status', cb),
  guardianOk: () => ipcRenderer.send('guardian:ok'),
  guardianStatus: () => ipcRenderer.invoke('guardian:status'),
  guardianNewTopic: () => ipcRenderer.invoke('guardian:new-topic'),
  guardianTest: () => ipcRenderer.invoke('guardian:test'),
  guardianPreview: () => ipcRenderer.send('guardian:check-preview'),
});
