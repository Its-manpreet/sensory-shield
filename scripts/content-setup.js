// One-time setup for child-safety protection:  npm run content:setup
//   1. downloads the models into models/ (git-ignored, ~650 MB). After this the app needs no network:
//      models load from models/ with remote loading disabled.
//   2. macOS: compiles the text-recognition helper (Apple Vision) into vendor/ocr/shield-ocr (needs Xcode
//      command line tools: xcode-select --install).
//
//   Xenova/mobileclip_s0                     picture tiles vs. descriptions (gore, weapons, phobias, own words)
//   nudenet/320n.onnx                        nudity detector with boxes (NudeNet v3.4 YOLOv8n, AGPL-3.0)
//   jdp8/distilbert-nsfw-text-classifier     explicit text, stage 1 (fast filter; Apache-2.0 base model)
//   Xenova/DeBERTa-v3-base-mnli-fever-anli   explicit text, stage 2 (reads the meaning in context; MIT)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');
const HF = (id, file) => `https://huggingface.co/${id}/resolve/main/${file}`;
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
  ].map((f) => [f, HF('Xenova/mobileclip_s0', f)]),
  'jdp8/distilbert-nsfw-text-classifier': [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_fp16.onnx',
    'onnx/model_quantized.onnx',
  ].map((f) => [f, HF('jdp8/distilbert-nsfw-text-classifier', f)]),
  'Xenova/DeBERTa-v3-base-mnli-fever-anli': [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_fp16.onnx',
    'onnx/model_quantized.onnx',
  ].map((f) => [f, HF('Xenova/DeBERTa-v3-base-mnli-fever-anli', f)]),
  // GitHub release assets (v3.4-weights) through the API: the plain download link now redirects to a login page
  nudenet: [
    ['320n.onnx', 'https://api.github.com/repos/notAI-tech/NudeNet/releases/assets/176831997'],
  ],
};

async function fetchWithRetry(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/octet-stream' } });
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
  for (const [file, url] of files) {
    const dest = path.join(ROOT, id, file);
    try {
      if ((await fs.stat(dest)).size < 100_000 && file.endsWith('.onnx')) throw new Error('truncated');
      console.log(`have  ${id}/${file}`);
      continue;
    } catch {}
    const buf = await fetchWithRetry(url);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    console.log(`got   ${id}/${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
}
console.log(`content models ready in ${ROOT}`);

if (process.platform === 'darwin') {
  const src = path.join(ROOT, '..', 'src', 'main', 'ocr', 'shield-ocr.swift');
  const out = path.join(ROOT, '..', 'vendor', 'ocr', 'shield-ocr');
  await fs.mkdir(path.dirname(out), { recursive: true });
  try {
    execFileSync('swiftc', ['-O', '-o', out, src], { stdio: 'inherit' });
    console.log(`text recognition helper built: ${out}`);
  } catch {
    console.log('could not build the text recognition helper (install Xcode command line tools: xcode-select --install). Explicit-text protection stays off; everything else works.');
  }
} else {
  console.log('explicit-text protection needs macOS text recognition; it stays off on this system (pictures still work).');
}
