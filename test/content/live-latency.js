// OWNER: Agent C. Live end-to-end test of content panes in the REAL app (capture -> models -> overlay):
//   npx electron test/content/live-latency.js        (ROUNDS=12 by default; ~5 s per round)
// Harmless trigger photos from the calibration set (assets/images/eval) appear at random places on the real
// screen, stay 1.6 s, scroll 260 px, disappear. Measures, per picture:
//   latency   picture painted -> first pane over it (same wall clock)
//   panes     how many panes cover it once fitted (goal: 1)
//   fit       IoU of the pane with the photo once fitted (1 = exact)
//   follow    share of the photo covered while it scrolls (mean and worst sample)
// Needs Screen Recording permission for the terminal. Nothing flashes; nothing is saved.
import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iou, intersect, area } from '../../src/engine/panes.js';

const ROUNDS = Number(process.env.ROUNDS ?? 12);
process.env.SHIELD_SELFTEST = '1';
process.env.SHIELD_NO_VOLUME = '1';
process.env.SHIELD_SELFTEST_MS = String(ROUNDS * 5200 + 16000);
const here = path.dirname(fileURLToPath(import.meta.url));
const shown = [], pos = [], panes = [];

app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (e) => {
    let m;
    if ((m = /SHOWN (\d+) (\{.*\})/.exec(e.message))) shown.push({ at: +m[1], rect: JSON.parse(m[2]) });
    else if ((m = /POS (\d+) (\{.*\})/.exec(e.message))) pos.push({ at: +m[1], rect: JSON.parse(m[2]) });
    else if ((m = /PANES (\d+) (\[.*\])/.exec(e.message))) panes.push({ at: +m[1], rects: JSON.parse(m[2]) });
  });
});
// no top-level await on app readiness here: Electron holds 'ready' until an ES-module entry has finished loading
import('../../src/main/main.js');
app.whenReady().then(() =>
  setTimeout(() => {
    const { bounds } = screen.getPrimaryDisplay();
    const win = new BrowserWindow({ ...bounds, frame: false, show: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true } });
    // above other apps (so only the test page is measured) but below the overlay ('screen-saver' level)
    win.setAlwaysOnTop(true, 'floating');
    win.loadFile(path.join(here, 'live-latency.html'), { query: { rounds: String(ROUNDS) } });
  }, 9000), // models load and warm up first
);

/** share of `r` covered by the union of rects (sampled on a grid) */
function coverage(r, rects) {
  let hit = 0, n = 0;
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++, n++) {
    const x = r.x + ((i + 0.5) / 20) * r.w, y = r.y + ((j + 0.5) / 20) * r.h;
    if (rects.some((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h)) hit++;
  }
  return hit / n;
}
const at = (list, t) => list.reduce((best, s) => (Math.abs(s.at - t) < Math.abs(best.at - t) ? s : best), list[0]);

app.on('will-quit', () => {
  const rows = [];
  shown.forEach((s, k) => {
    const end = shown[k + 1]?.at ?? Infinity;
    const mine = panes.filter((p) => p.at >= s.at && p.at < end);
    const first = mine.find((p) => p.rects.some((r) => intersect(r, s.rect)));
    // fitted: the last sample before the picture starts to move
    const moveStart = pos.find((p) => p.at > s.at)?.at ?? s.at + 1600;
    const fitted = mine.filter((p) => p.at < moveStart).at(-1);
    const over = fitted ? fitted.rects.filter((r) => intersect(r, s.rect) && area(intersect(r, s.rect)) > 0.05 * area(r)) : [];
    const fit = over.length ? Math.max(...over.map((r) => iou(r, s.rect))) : 0;
    const moves = pos.filter((p) => p.at >= moveStart && p.at < end);
    const follow = moves.map((m) => coverage(m.rect, at(mine, m.at)?.rects ?? []));
    rows.push({
      latency: first ? first.at - s.at : null,
      panes: over.length,
      fit,
      cover: fitted ? coverage(s.rect, fitted.rects) : 0,
      followMean: follow.length ? follow.reduce((a, b) => a + b, 0) / follow.length : 0,
      followMin: follow.length ? Math.min(...follow) : 0,
    });
  });
  if (process.env.TIMELINE) {
    const f = (r) => `[${[r.x, r.y, r.w, r.h].map((v) => v.toFixed(2)).join(' ')}]`;
    shown.forEach((s, k) => {
      const end = shown[k + 1]?.at ?? Infinity;
      console.log(`[live] round ${k + 1} picture ${f(s.rect)}`);
      let last = '';
      for (const p of panes.filter((q) => q.at >= s.at - 300 && q.at < end)) {
        const now = p.rects.map(f).join(' ');
        if (now !== last) console.log(`[live]   +${p.at - s.at} ms: ${now}`);
        last = now;
      }
    });
  }
  for (const [i, r] of rows.entries()) console.log(`[live] #${i + 1} latency ${r.latency ?? 'MISS'} ms, panes ${r.panes}, fit IoU ${r.fit.toFixed(2)}, covered ${(100 * r.cover).toFixed(0)}%, while scrolling covered ${(100 * r.followMean).toFixed(0)}% (worst ${(100 * r.followMin).toFixed(0)}%)`);
  const ok = rows.filter((r) => r.latency != null);
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  if (ok.length) console.log(`[live] SUMMARY found ${ok.length}/${rows.length}; latency median ${med(ok.map((r) => r.latency))} ms worst ${Math.max(...ok.map((r) => r.latency))} ms; one pane on ${ok.filter((r) => r.panes === 1).length}/${ok.length}; fit IoU median ${med(ok.map((r) => r.fit)).toFixed(2)}; scrolling coverage median ${(100 * med(ok.map((r) => r.followMean))).toFixed(0)}%`);
});
