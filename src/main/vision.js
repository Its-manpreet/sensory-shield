// OWNER: Agent C (A wires it in main.js). Runs the on-device vision model as a bundled llama.cpp server.
//
// - llama-server is a child process listening on 127.0.0.1 only, on a free port. Nothing leaves the device:
//   screenshots go from the overlay to this process over IPC, then to the child over loopback, in memory.
// - Dev: binary in vendor/llama.cpp/<platform-arch>/, model in models/lfm3-vl/ (npm run vision:setup).
//   Packaged: the same folders are copied into the app's resources (see "build" in package.json).
// - Started lazily on the first check (about 5 s to load), stopped when the app quits.
import { app, nativeImage } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISION_MODEL, platformKey } from './vision-config.js';
import { analyzeImage, createLlamaClient } from './vision-pipeline.js';
import { displayLabel } from './vision-prompt.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function paths() {
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const binDir = app.isPackaged ? path.join(process.resourcesPath, 'llama') : path.join(ROOT, 'vendor', 'llama.cpp', platformKey());
  const modelDir = app.isPackaged ? path.join(process.resourcesPath, 'models', VISION_MODEL.dir) : path.join(ROOT, 'models', VISION_MODEL.dir);
  return { exe: path.join(binDir, exeName), binDir, model: path.join(modelDir, VISION_MODEL.model), mmproj: path.join(modelDir, VISION_MODEL.mmproj) };
}

/** 'llama.cpp Metal (Apple M5)' etc., from `llama-server --list-devices` */
function detectDevice(p) {
  return new Promise((resolve) => {
    execFile(p.exe, ['--list-devices'], { cwd: p.binDir, timeout: 10000, windowsHide: true }, (_err, stdout = '', stderr = '') => {
      const line = `${stdout}\n${stderr}`.split('\n').map((l) => l.trim()).find((l) => /^(MTL|Vulkan|CUDA|ROCm)\d*:/i.test(l));
      if (!line) return resolve('llama.cpp CPU');
      const [kind, rest] = line.split(':');
      const name = rest.split('(')[0].trim();
      resolve(`llama.cpp ${/^MTL/i.test(kind) ? 'Metal' : kind.replace(/\d+$/, '')} (${name})`);
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let child = null;
/** @type {Promise<{ ok: boolean, device: string, modelId: string, loadMs: number, error?: string }> | null} */
let starting = null;
let client = null;
let busy = Promise.resolve();

/** start llama-server once; resolves when the model is loaded */
export function startVision() {
  if (starting) return starting;
  starting = (async () => {
    const p = paths();
    for (const f of [p.exe, p.model, p.mmproj]) {
      if (!fs.existsSync(f)) return fail(`missing ${path.basename(f)}: run "npm run vision:setup"`);
    }
    const port = await freePort();
    const device = await detectDevice(p);
    // llama-server allows any origin by default, so a web page in the user's browser could call it. A
    // fresh random key per launch, known only to this process, closes that.
    const apiKey = randomBytes(24).toString('hex');
    const t0 = performance.now();
    const args = ['-m', p.model, '--mmproj', p.mmproj, '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey,
      '-c', '8192', '-np', '2', '-ngl', '99', '--no-webui', '--temp', '0.1', '--top-k', '50', '--repeat-penalty', '1.1']; // 2 slots: crop checks run side by side
    child = spawn(p.exe, args, { cwd: p.binDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let log = '';
    const onData = (d) => {
      log = (log + d.toString()).slice(-4000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.once('exit', () => {
      child = null;
      starting = null; // allow a restart on the next check
    });

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('wait'), 250))]);
      if (code !== 'wait') return fail(`vision server exited (${code}): ${log.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
      try {
        const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
        if (h.ok) break;
      } catch {}
    }
    client = createLlamaClient(base, { apiKey });
    const loadMs = performance.now() - t0;
    console.log(`[vision] ${VISION_MODEL.name} ready on ${base} (${device}) in ${Math.round(loadMs)} ms`);
    return { ok: true, device, modelId: VISION_MODEL.name, loadMs };
  })();
  return starting;

  function fail(error) {
    console.error(`[vision] ${error}`);
    starting = null;
    return { ok: false, device: 'failed', modelId: VISION_MODEL.name, loadMs: 0, error };
  }
}

export function stopVision() {
  child?.kill();
  child = null;
}

/**
 * One content check. Called from the overlay through IPC with a JPEG of the screen (memory only).
 * @param {Uint8Array} jpeg
 * @param {{ id: string, label: string }[]} terms
 * @param {{ classify?: boolean }} opts
 */
export async function analyzeScreen(jpeg, terms, opts = {}) {
  const status = await startVision();
  if (!status.ok) throw new Error(status.error);
  // one check at a time: the model has a single slot
  const run = busy.then(async () => {
    const img = nativeImage.createFromBuffer(Buffer.from(jpeg));
    const { width: W, height: H } = img.getSize();
    const ops = {
      resized: async (w) => img.resize({ width: Math.min(w, W), quality: 'good' }).toJPEG(80).toString('base64'),
      crop: async (b) =>
        img
          .crop({ x: Math.round(b.x * W), y: Math.round(b.y * H), width: Math.max(16, Math.round(b.w * W)), height: Math.max(16, Math.round(b.h * H)) })
          .toJPEG(85)
          .toString('base64'),
    };
    const { detections, timings } = await analyzeImage(ops, terms, client, opts);
    return {
      detections: detections.map((d) => ({ id: d.term.id, label: displayLabel(d.term), box: d.box })),
      timings,
    };
  });
  busy = run.catch(() => {});
  return run;
}

app.on('will-quit', stopVision);
