// One-time setup for the on-device vision model (run on every machine, and before packaging):
//   npm run vision:setup
// Downloads (if missing) the llama.cpp server build for THIS platform into vendor/llama.cpp/<platform-arch>/
// and the LFM3-VL-2B model + vision projector into models/lfm3-vl/. Both folders are git-ignored.
// After this, the app needs no network: llama-server runs as a local child process on 127.0.0.1.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LLAMA_BUILD, VISION_MODEL, platformKey } from '../src/main/vision-config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = platformKey();
const ASSET = {
  'darwin-arm64': `llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`,
  'darwin-x64': `llama-${LLAMA_BUILD}-bin-macos-x64.tar.gz`,
  'win32-x64': `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`, // Vulkan: GPU on most Windows laptops, CPU fallback
  'win32-arm64': `llama-${LLAMA_BUILD}-bin-win-cpu-arm64.zip`,
  'linux-x64': `llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz`,
}[key];
if (!ASSET) throw new Error(`no llama.cpp build mapped for ${key}`);

async function download(url, dest) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
      await fsp.rename(tmp, dest);
      return;
    } catch (err) {
      if (i >= 4) throw err;
      console.log(`retry ${i}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

// 1. llama.cpp server for this platform
const binDir = path.join(ROOT, 'vendor', 'llama.cpp', key);
const exe = path.join(binDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
if (fs.existsSync(exe)) console.log(`have  llama.cpp ${LLAMA_BUILD} (${key})`);
else {
  const archive = path.join(ROOT, 'vendor', 'llama.cpp', ASSET);
  console.log(`get   ${ASSET}`);
  await download(`https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${ASSET}`, archive);
  const tmp = path.join(ROOT, 'vendor', 'llama.cpp', `_extract-${key}`);
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', tmp]); // bsdtar: .tar.gz and .zip (macOS, Windows 10+)
  const entries = fs.readdirSync(tmp);
  // archives either wrap everything in one folder or put files at the top level
  const src = entries.length === 1 && fs.statSync(path.join(tmp, entries[0])).isDirectory() ? path.join(tmp, entries[0]) : tmp;
  await fsp.rm(binDir, { recursive: true, force: true });
  await fsp.cp(src, binDir, { recursive: true });
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.rm(archive, { force: true });
  console.log(`got   llama.cpp ${LLAMA_BUILD} -> vendor/llama.cpp/${key}`);
}

// 2. model + vision projector
for (const file of [VISION_MODEL.model, VISION_MODEL.mmproj]) {
  const dest = path.join(ROOT, 'models', VISION_MODEL.dir, file);
  if (fs.existsSync(dest)) {
    console.log(`have  models/${VISION_MODEL.dir}/${file}`);
    continue;
  }
  console.log(`get   ${file} (large, one time)`);
  await download(`https://huggingface.co/${VISION_MODEL.repo}/resolve/main/${file}`, dest);
}
console.log('vision model ready');
