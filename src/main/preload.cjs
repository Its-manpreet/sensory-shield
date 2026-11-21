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
  onCursor: (cb) => listen('shield:cursor', cb), // normalized {x, y} or null; only while "clear around cursor" is on
  sendStats: (stats) => ipcRenderer.send('shield:stats', stats),
  onStats: (cb) => listen('shield:stats', cb), // settings window status line (main re-broadcasts)
  getStatus: () => ipcRenderer.invoke('shield:status'),
  openPermission: () => ipcRenderer.send('shield:open-permission'),
  relaunch: () => ipcRenderer.send('shield:relaunch'),
  visionStart: () => ipcRenderer.invoke('vision:start'),
  visionAnalyze: (jpeg, terms, classify) => ipcRenderer.invoke('vision:analyze', { jpeg, terms, classify }),
});
