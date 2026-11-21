// OWNER: Agent C. Explicit / sexual TEXT on screen, judged by meaning in context (not a word list).
//
// Two stages, both on-device:
//   1. DistilBERT NSFW text classifier (eliasalbouzidi/distilbert-nsfw-text-classifier, ONNX jdp8/...):
//      fast (~1 ms a line) and catches sexual writing reliably, but it reacts to words alone
//      ("Sex: Male/Female", "chicken breast", "sex education" all score > 0.8).
//   2. Only lines stage 1 flags are re-read by an NLI model (MoritzLaurer DeBERTa-v3-base-mnli-fever-anli,
//      ONNX Xenova/...): "does this text entail: it describes sexual activity or nudity in an erotic way?"
//      This is where context comes in: a form field or a biology sentence does not entail that.
// Both must agree. OCR text is held in memory for one check and never logged or stored.
import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';
import { setupRuntime, gpu } from './runtime.js';
import { groupParagraphs, textUnits, explicitAreas } from './text-layout.js';

const STAGE1_ID = 'jdp8/distilbert-nsfw-text-classifier';
const STAGE2_ID = 'Xenova/DeBERTa-v3-base-mnli-fever-anli';
export const HYPOTHESIS = 'This text describes sexual activity or nudity in an erotic way.';
const STAGE1_MIN = 0.8; // stage 1 is only a filter: below this a text is safe without asking stage 2
const BATCH = 16;
// stage 2 (DeBERTa-base) in small batches: a batch cannot be interrupted, and picture checks wait for it
const BATCH2 = 4;

const softmaxAt = (d, row, k, idx) => {
  let max = -Infinity;
  for (let c = 0; c < k; c++) max = Math.max(max, Number(d[row * k + c]));
  let sum = 0;
  for (let c = 0; c < k; c++) sum += Math.exp(Number(d[row * k + c]) - max);
  return Math.exp(Number(d[row * k + idx]) - max) / sum;
};

/**
 * @param {{ modelsUrl: string, threshold?: number }} opts  threshold: stage-2 entailment needed (0..1)
 */
export async function createTextSafety({ modelsUrl, threshold = 0.5 }) {
  const t0 = performance.now();
  const rt = await setupRuntime(modelsUrl);
  const load = async (id) => [await AutoTokenizer.from_pretrained(id), await gpu(() => AutoModelForSequenceClassification.from_pretrained(id, { device: rt.device, dtype: rt.dtype }))];
  const [tok1, model1] = await load(STAGE1_ID);
  const [tok2, model2] = await load(STAGE2_ID);
  const nsfwIdx = Number(Object.entries(model1.config.id2label).find(([, l]) => /nsfw/i.test(l))?.[0] ?? 1);
  const entIdx = Number(Object.entries(model2.config.id2label).find(([, l]) => /entail/i.test(l))?.[0] ?? 0);
  const info = { device: rt.device, modelId: `${STAGE1_ID} + ${STAGE2_ID}`, loadMs: performance.now() - t0 };

  async function stage1(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const inputs = tok1(texts.slice(i, i + BATCH), { padding: true, truncation: true, max_length: 128 });
      const { logits } = await gpu(() => model1(inputs), 'low');
      for (let r = 0; r < logits.dims[0]; r++) out.push(softmaxAt(logits.data, r, logits.dims[1], nsfwIdx));
    }
    return out;
  }

  async function stage2(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH2) {
      const batch = texts.slice(i, i + BATCH2);
      const inputs = tok2(batch, { text_pair: batch.map(() => HYPOTHESIS), padding: true, truncation: true, max_length: 160 });
      const { logits } = await gpu(() => model2(inputs), 'low');
      for (let r = 0; r < logits.dims[0]; r++) out.push(softmaxAt(logits.data, r, logits.dims[1], entIdx));
    }
    return out;
  }

  // Most text on screen is the same from one check to the next: remember scores (memory only, this session).
  const cache = new Map();
  const CACHE_MAX = 4000;

  /** @param {string[]} texts @returns {Promise<number[]>} 0..1, explicit when >= threshold */
  async function scoreTexts(texts) {
    const todo = [...new Set(texts.filter((t) => !cache.has(t)))];
    if (todo.length) {
      const s1 = await stage1(todo);
      const ask = todo.map((_, i) => i).filter((i) => s1[i] >= STAGE1_MIN);
      const s2 = ask.length ? await stage2(ask.map((i) => todo[i])) : [];
      const out = todo.map(() => 0);
      ask.forEach((i, j) => (out[i] = s2[j]));
      todo.forEach((t, i) => cache.set(t, out[i]));
      if (cache.size > CACHE_MAX) for (const k of [...cache.keys()].slice(0, cache.size - CACHE_MAX)) cache.delete(k);
    }
    return texts.map((t) => cache.get(t));
  }

  return {
    info,
    get threshold() {
      return threshold;
    },
    set threshold(t) {
      threshold = t;
    },
    scoreTexts,
    /**
     * @param {import('./text-layout.js').OcrLine[]} lines  OCR result for the screen
     * @returns {Promise<{ rect: import('./text-layout.js').Rect, score: number }[]>} areas to blur
     */
    async findExplicit(lines) {
      const paras = groupParagraphs(lines);
      const units = textUnits(paras);
      if (!units.length) return [];
      const scores = await scoreTexts(units.map((u) => u.text));
      return explicitAreas(paras, units, scores, threshold);
    },
  };
}
