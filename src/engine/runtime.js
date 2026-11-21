// OWNER: Agent C. One place that sets up the on-device model runtime (Transformers.js + ONNX Runtime Web).
// Models load ONLY from the local models/ folder; remote loading is off, so the app works with Wi-Fi off.
// WebGPU first (fp16 weights), WASM CPU fallback (8-bit weights).
import { env } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';

let device = null;
/** @type {{ high: {fn: () => Promise<any>, ok: (v: any) => void, fail: (e: any) => void}[], low: any[] }} */
const lanes = { high: [], low: [] };
let running = false;

/**
 * Run model work one piece at a time. ONNX Runtime Web cannot create two WebGPU sessions at once and
 * concurrent runs corrupt its memory, so every load and every inference goes through this queue.
 * Pictures are 'high' (the 100-200 ms target), text is 'low': text batches wait while pictures are queued.
 * Work is queued per batch, so neither starves. Never call gpu() from inside gpu() (it would wait for itself).
 * @template T @param {() => Promise<T>} fn @param {'high'|'low'} [priority] @returns {Promise<T>}
 */
export function gpu(fn, priority = 'high') {
  return new Promise((ok, fail) => {
    lanes[priority].push({ fn, ok, fail });
    pump();
  });
}

async function pump() {
  if (running) return;
  const job = lanes.high.shift() ?? lanes.low.shift();
  if (!job) return;
  running = true;
  try {
    job.ok(await job.fn());
  } catch (err) {
    job.fail(err);
  } finally {
    running = false;
    pump();
  }
}

/**
 * @param {string} modelsUrl  URL of the models/ folder (file:// in the app)
 * @returns {Promise<{ device: 'webgpu'|'wasm', dtype: 'fp16'|'q8', ort: typeof ort, modelsUrl: string }>}
 */
export async function setupRuntime(modelsUrl) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelsUrl;
  const ortDist = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url).href;
  ort.env.wasm.wasmPaths = ortDist;
  if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = ortDist;
  if (!device) {
    let gpu = null;
    try {
      gpu = await globalThis.navigator?.gpu?.requestAdapter();
    } catch {}
    device = gpu ? 'webgpu' : 'wasm';
  }
  return { device, dtype: device === 'webgpu' ? 'fp16' : 'q8', ort, modelsUrl };
}
