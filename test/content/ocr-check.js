// OWNER: Agent C. Real-pipeline check for explicit text, without touching the real screen:
//   npx electron test/content/ocr-check.js
// 1. renders test/content/text-screen.html offscreen at 1470x956 (a 14" MacBook screen) and grabs its pixels
// 2. grayscale -> the OCR helper (same code path as the app: src/main/ocr.js)
// 3. lines -> the text-safety engine in a hidden window (WebGPU) -> areas to blur
// 4. compares the areas with the sections marked data-explicit="1"
import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcr, ocrHelperPath } from '../../src/main/ocr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const W = 1470, H = 956;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?):/i.test(d.url) }));
  const screenWin = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { offscreen: true } });
  await screenWin.loadFile(path.join(here, 'text-screen.html'));
  await new Promise((r) => setTimeout(r, 500));
  const expected = await screenWin.webContents.executeJavaScript(
    `[...document.querySelectorAll('section')].map(s => { const r = s.getBoundingClientRect(); return { explicit: s.dataset.explicit === '1', x: r.x / innerWidth, y: r.y / innerHeight, w: r.width / innerWidth, h: r.height / innerHeight }; })`,
  );
  const img = await screenWin.webContents.capturePage();
  const { width, height } = img.getSize();
  const bgra = img.toBitmap();
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (bgra[i] * 29 + bgra[i + 1] * 150 + bgra[i + 2] * 77) >> 8;
  console.log(`[ocr] screen ${width}x${height}`);

  for (const level of (process.env.OCR_LEVELS ?? 'fast,accurate').split(',')) {
    const ocr = createOcr(ocrHelperPath(path.join(here, '..', '..', 'src')), { level });
    await ocr.recognize({ width, height, gray }); // warm-up
    const t0 = performance.now();
    const r = await ocr.recognize({ width, height, gray });
    console.log(`[ocr] ${level}: ${r.lines.length} lines, helper ${r.ms} ms, round trip ${(performance.now() - t0).toFixed(0)} ms`);
    if (process.env.SHOW_LINES) for (const l of r.lines) console.log(`[ocr]    ${l.t}`);
    if (level === (process.env.OCR_USE ?? 'accurate')) {
      // text-safety runs in a renderer (WebGPU); hand it the lines and wait for the areas
      const engineWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(here, 'ocr-check-preload.cjs'), sandbox: true } });
      engineWin.webContents.on('console-message', (e) => console.log(e.message));
      const areas = await new Promise((resolve) => {
        ipcMain.once('areas', (_e, a) => resolve(a));
        ipcMain.handleOnce('lines', () => r.lines.map((l) => ({ text: l.t, rect: { x: l.x, y: l.y, w: l.w, h: l.h } })));
        engineWin.loadFile(path.join(here, 'ocr-check-engine.html'), { query: process.env.WHY ? { why: '1' } : {} });
      });
      const inside = (a, s) => a.rect.x + a.rect.w / 2 > s.x && a.rect.x + a.rect.w / 2 < s.x + s.w && a.rect.y + a.rect.h / 2 > s.y && a.rect.y + a.rect.h / 2 < s.y + s.h;
      let ok = true;
      expected.forEach((s, i) => {
        const hits = areas.filter((a) => inside(a, s));
        const covered = hits.reduce((sum, a) => sum + a.rect.w * a.rect.h, 0) / (s.w * s.h);
        const good = s.explicit ? hits.length > 0 : hits.length === 0;
        ok &&= good;
        console.log(`[ocr] ${good ? 'ok  ' : 'FAIL'} section ${i + 1} ${s.explicit ? 'explicit' : 'safe    '}: ${hits.length} blurred area(s), ${(covered * 100).toFixed(0)}% of the section`);
      });
      console.log(`[ocr] ${ok ? 'PASS' : 'FAIL'}`);
    }
    ocr.stop();
  }
  app.quit();
});
