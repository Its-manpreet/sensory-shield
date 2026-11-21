// OWNER: Agent C. Opens a test page in a hidden Electron window, prints its console, quits on "DONE".
//   electron test/content/run-page.js test/content/bench.html
// Network stays blocked: the page may only load local files (same rule as the app).
import { app, BrowserWindow, session, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcr, ocrHelperPath } from '../../src/main/ocr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// same text-box detection as the app (src/main/main.js 'ocr:boxes')
let ocr = null;
ipcMain.handle('ocr:boxes', async (_e, frame) => {
  ocr ??= createOcr(ocrHelperPath(path.join(here, '..', '..', 'src')), { level: 'fast' });
  if (!ocr.available) return { boxes: [], available: false };
  const r = await ocr.recognize(frame);
  return { boxes: r.lines.map(({ x, y, w, h }) => ({ x, y, w, h })), available: true };
});
app.on('will-quit', () => ocr?.stop());

const page = path.resolve(process.argv.slice(2).find((a) => a.endsWith('.html')));
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?):/i.test(d.url) }));
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, backgroundThrottling: false, preload: path.join(here, 'page-preload.cjs') } });
  win.webContents.on('console-message', (e) => {
    console.log(e.message);
    if (/\bDONE\b/.test(e.message)) app.quit();
  });
  win.loadFile(page, { query: Object.fromEntries(process.argv.filter((a) => a.includes('=') && !a.startsWith('-')).map((a) => a.split('='))) });
  setTimeout(() => (console.log('timeout'), app.quit()), Number(process.env.PAGE_TIMEOUT_MS) || 180000);
});
