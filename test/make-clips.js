// OWNER: Agent B. Renders small, short synthetic test clips into assets/clips/ (git-ignored).
// Flashing clips start with FLASH-WARNING-. Warn the room before playing them. Needs ffmpeg on PATH.
// Usage: npm run clips   (Node, so it works on macOS, Windows and Linux)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'clips');
fs.mkdirSync(OUT, { recursive: true });
const S = '480x270';
const D = 4;
const ENC = ['-pix_fmt', 'yuv420p', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-an', '-loglevel', 'error', '-y'];

function ffmpeg(input, filter, name) {
  const args = ['-f', 'lavfi', '-i', input, ...(filter ? ['-vf', filter] : []), ...ENC, path.join(OUT, name)];
  try {
    execFileSync('ffmpeg', args, { stdio: 'inherit' });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('ffmpeg not found. Install it (macOS: brew install ffmpeg, Windows: winget install ffmpeg) and retry.');
      process.exit(1);
    }
    throw err;
  }
}

/** @param {number} hz @param {string} colour @param {string} name */
function flash(hz, colour, name) {
  ffmpeg(`color=c=black:s=${S}:r=30:d=${D}`, `drawbox=c=${colour}:t=fill:enable='lt(mod(t\\,1/${hz})\\,1/(2*${hz}))'`, `FLASH-WARNING-${name}.webm`);
}

flash(3, 'white', 'flash-3hz');
flash(6, 'white', 'flash-6hz');
flash(4, 'red', 'red-flash-4hz');
// red <-> blue colour flicker with little brightness change (colour flicker detector)
ffmpeg(`color=c=0x6450b4:s=${S}:r=30:d=${D}`, `drawbox=c=0xb45064:t=fill:enable='lt(mod(t\\,1/5)\\,1/10)'`, 'FLASH-WARNING-redblue-5hz.webm');
ffmpeg(`gradients=s=${S}:r=30:d=${D}:speed=0.02`, null, 'normal-video.webm');
for (const f of fs.readdirSync(OUT)) console.log(`${String(fs.statSync(path.join(OUT, f)).size).padStart(9)}  ${f}`);
