// OWNER: Agent C. Accuracy, placement and speed of the content pipeline on rendered web pages with known
// truth boxes (truth.json: { page: { term, boxes: [[x, y, w, h] normalized] } }, images t-<page>.jpg).
//   node test/vision/eval-pages.js <folder> [port] [detectWidth]
// hit: a box overlaps the truth image; IoU / spill (share of the box outside the truth) measure placement;
// false: a box with < 25% of its area on any truth image (text, harmless pictures).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeImage, createLlamaClient } from '../../src/main/vision-pipeline.js';

const [dir, port = '18080', detectWidth] = process.argv.slice(2);
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
const client = createLlamaClient(`http://127.0.0.1:${port}`);

export function ffmpegOps(file) {
  const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    .toString().trim().split(',').map(Number);
  const jpeg = (vf) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', vf, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', '-']).toString('base64');
  return {
    size: { width: W, height: H },
    resized: async (w) => jpeg(`scale=${w}:-2`),
    crop: async (b) => jpeg(`crop=${Math.max(16, Math.round(b.w * W))}:${Math.max(16, Math.round(b.h * H))}:${Math.round(b.x * W)}:${Math.round(b.y * H)}`),
  };
}
const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

let hits = 0, want = 0, falses = 0, n = 0, ms = 0, iouSum = 0, spillSum = 0, placed = 0;
for (const [name, t] of Object.entries(truth)) {
  const terms = [{ id: t.term, label: t.term }, { id: 'gore', label: 'gore' }];
  const t0 = performance.now();
  const { detections, timings } = await analyzeImage(ffmpegOps(path.join(dir, `t-${name}.jpg`)), terms, client, detectWidth ? { detectWidth: Number(detectWidth) } : {});
  const took = performance.now() - t0;
  ms += took;
  n++;
  const tb = t.boxes.map(([x, y, w, h]) => ({ x, y, w, h }));
  let pageFalse = 0;
  const notes = [];
  for (const d of detections) {
    const best = tb.map((b) => inter(d.box, b)).reduce((a, v) => Math.max(a, v), 0);
    if (best < 0.25 * d.box.w * d.box.h) pageFalse++;
  }
  for (const b of tb) {
    want++;
    const mine = detections.filter((d) => inter(d.box, b) > 0);
    if (!mine.length) continue;
    hits++;
    const d = mine.sort((p, q) => inter(q.box, b) - inter(p.box, b))[0];
    const i = inter(d.box, b);
    const iou = i / (d.box.w * d.box.h + b.w * b.h - i);
    const spill = 1 - i / (d.box.w * d.box.h);
    iouSum += iou; spillSum += spill; placed++;
    notes.push(`IoU ${iou.toFixed(2)} spill ${(100 * spill).toFixed(0)}%`);
  }
  falses += pageFalse;
  console.log(`${name.padEnd(16)} want ${tb.length} hit ${notes.length} false ${pageFalse} ${notes.join(' | ').padEnd(28)} ${Math.round(took)} ms (detect ${Math.round(timings.detectMs)}, ${timings.proposals} boxes) [${detections.map((d) => d.term.label).join(',')}]`);
}
console.log(`\nhits ${hits}/${want}, false alarms ${falses} on ${n} pages, mean IoU ${(iouSum / (placed || 1)).toFixed(2)}, mean spill ${((100 * spillSum) / (placed || 1)).toFixed(0)}%, avg ${Math.round(ms / n)} ms per check`);
