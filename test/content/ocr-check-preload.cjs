// OWNER: Agent C. Bridge for test/content/ocr-check.js only.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('check', { lines: () => ipcRenderer.invoke('lines'), areas: (a) => ipcRenderer.send('areas', a) });
