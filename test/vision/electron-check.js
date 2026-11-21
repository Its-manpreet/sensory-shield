// OWNER: Agent C. Checks the real Electron path of the vision model (bundled llama-server spawn,
// nativeImage crops, IPC handler code) on screenshot files, with no window and nothing on screen.
//   npx electron test/vision/electron-check.js <image.jpg> [term ...]
import { app } from 'electron';
import fs from 'node:fs';
import { startVision, analyzeScreen, stopVision } from '../../src/main/vision.js';

const [img, ...labels] = process.argv.slice(process.argv.findIndex((a) => a.endsWith('electron-check.js')) + 1);
app.whenReady().then(async () => {
  const s = await startVision();
  console.log('START', JSON.stringify(s));
  if (s.ok) {
    const terms = (labels.length ? labels : ['spiders', 'clowns', 'cartoon', 'gore', 'pornography']).map((l) => ({ id: l, label: l }));
    for (const file of img.split(',')) {
      const t0 = performance.now();
      const r = await analyzeScreen(new Uint8Array(fs.readFileSync(file)), terms, { classify: true });
      console.log('RESULT', file.split('/').pop(), Math.round(performance.now() - t0), 'ms', JSON.stringify(r.detections.map((d) => [d.label, +d.box.x.toFixed(2), +d.box.y.toFixed(2)])));
    }
  }
  stopVision();
  app.quit();
});
