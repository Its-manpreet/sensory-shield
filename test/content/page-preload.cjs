// OWNER: Agent C. Test pages run by run-page.js get the app's text-box detection (fast OCR helper, boxes only).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shield', { findTextBoxes: (frame) => ipcRenderer.invoke('ocr:boxes', frame) });
