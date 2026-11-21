// OWNER: Agent C. Accuracy + speed of the real content pipeline (src/main/vision-pipeline.js) on a folder of
// labelled screenshots. Needs a running llama-server (npm run vision:server) and ffmpeg.
//   node test/vision/eval.js <folder> [port]
// File names say what is expected: eval-<term>-<L|R>.jpg (term in the left/right half), eval-none-*.jpg.
// Images are NOT in git (assets/images/ holds only safe, free-to-use images; see LABELS.md).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeImage, createLlamaClient } from '../../src/main/vision-pipeline.js';

const [dir, port = '18080'] = process.argv.slice(2);
const TERMS = ['spiders', 'clowns', 'cartoon', 'gore', 'pornography'].map((l) => ({ id: l, label: l }));
const client = createLlamaClient(`http://127.0.0.1:${port}`);

function ffmpegOps(file) {
  const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    .toString().trim().split(',').map(Number);
  const jpeg = (vf) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', vf, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', '-']).toString('base64');
  return {
    resized: async (w) => jpeg(`scale=${w}:-2`),
    crop: async (b) => jpeg(`crop=${Math.max(16, Math.round(b.w * W))}:${Math.max(16, Math.round(b.h * H))}:${Math.round(b.x * W)}:${Math.round(b.y * H)}`),
  };
}

let hits = 0, misses = 0, falseAlarms = 0, total = 0, ms = 0;
for (const f of fs.readdirSync(dir).filter((f) => /^eval-.*\.jpg$/.test(f)).sort()) {
  const [, want, side] = f.match(/^eval-([a-z]+?)\d*-([LR]|\d+)/) ?? [];
  const t0 = performance.now();
  const { detections, timings } = await analyzeImage(ffmpegOps(path.join(dir, f)), TERMS, client);
  ms += performance.now() - t0;
  total++;
  // the trigger photo spans x 110..630 (L) or 840..1360 (R) of a 1470 px screen
  const [px0, px1] = side === 'L' ? [110 / 1470, 630 / 1470] : [840 / 1470, 1360 / 1470];
  const right = detections.filter((d) => want !== 'none' && d.term.label.startsWith(want) && d.box.x < px1 && d.box.x + d.box.w > px0);
  const wrong = detections.filter((d) => !right.includes(d));
  if (want !== 'none') right.length ? hits++ : misses++;
  falseAlarms += wrong.length;
  console.log(`${f.padEnd(22)} ${want !== 'none' ? (right.length ? 'HIT ' : 'MISS') : '    '} false=${wrong.length} ` +
    `[${detections.map((d) => `${d.term.label}@${d.box.x.toFixed(2)}`).join(' ')}] detect ${Math.round(timings.detectMs)} ms + classify ${Math.round(timings.classifyMs)} ms (${timings.proposals} boxes)`);
}
console.log(`\nhits ${hits}/${hits + misses}, false alarms ${falseAlarms} on ${total} screens, avg ${Math.round(ms / total)} ms per check`);
