// OWNER: Agent C. One-time model download into models/ (git-ignored). Run on every laptop before the demo:
//   npm run models
// After this the app needs no network: Transformers.js loads from models/ with remote loading disabled.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');
const MODELS = {
  'Xenova/mobileclip_s0': [
    'config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/vision_model_fp16.onnx', // WebGPU
    'onnx/text_model_fp16.onnx',
    'onnx/vision_model_quantized.onnx', // WASM (CPU) fallback
    'onnx/text_model_quantized.onnx',
  ],
};

async function fetchWithRetry(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i >= tries) throw err;
      console.log(`retry ${i}/${tries - 1}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

for (const [id, files] of Object.entries(MODELS)) {
  for (const file of files) {
    const dest = path.join(ROOT, id, file);
    try {
      await fs.access(dest);
      console.log(`have  ${id}/${file}`);
      continue;
    } catch {}
    const url = `https://huggingface.co/${id}/resolve/main/${file}`;
    const buf = await fetchWithRetry(url);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    console.log(`got   ${id}/${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
}
console.log(`models ready in ${ROOT}`);
