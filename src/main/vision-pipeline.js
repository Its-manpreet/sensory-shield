// OWNER: Agent C. One content check with the vision-language model: detect boxes, then classify each crop.
// No Electron here: the image operations and the model client are passed in, so the exact same code runs
// in the app (nativeImage + llama-server) and in the evaluation script (ffmpeg + llama-server).
import { detectPrompt, classifyPrompt, parseDetections, parseClassify, dedupeBoxes, padBox, needsConcept, conceptPrompt, learnConcept, TEXT_PROMPT, isYes } from './vision-prompt.js';

// Screenshot width sent for detection. 640 gave the same box precision as 896 (within ~0.2% of the true
// edges on our pages) and is ~150 ms faster; the crops for classification still come from the full image.
export const DETECT_WIDTH = 640;
export const MAX_BOXES = 6; // classify at most this many proposals per check (~0.25 s each)

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Box  normalized 0..1
 * @typedef {{ id: string, label: string }} VisionTerm
 * @typedef {{
 *   resized(width: number): Promise<string>,              // whole image, base64 JPEG
 *   crop(box: Box): Promise<string>,                       // region at native resolution, base64 JPEG
 * }} ImageOps
 * @typedef {{ chat(jpegBase64: string, prompt: string, maxTokens: number): Promise<string> }} VisionClient
 */

/**
 * @param {ImageOps} image
 * @param {VisionTerm[]} terms
 * @param {VisionClient} client
 * @param {{ classify?: boolean, detectWidth?: number }} [opts]  classify=false trusts detection labels (faster, more false alarms)
 * @returns {Promise<{ detections: { term: VisionTerm, box: Box }[], timings: { detectMs: number, classifyMs: number, proposals: number } }>}
 */
export async function analyzeImage(image, terms, client, opts = {}) {
  const classify = opts.classify ?? true;
  // new words: ask once what they look like (text only, ~0.2 s, cached for the session)
  for (const t of terms) if (needsConcept(t)) learnConcept(t, await client.chat(null, conceptPrompt(t), 40));
  const t0 = performance.now();
  const answer = await client.chat(await image.resized(opts.detectWidth ?? DETECT_WIDTH), detectPrompt(terms), 300);
  const proposals = dedupeBoxes(parseDetections(answer, terms)).slice(0, MAX_BOXES);
  const detectMs = performance.now() - t0;

  if (!classify) {
    const detections = proposals.filter((p) => p.term).map((p) => ({ term: p.term, box: padBox(p.box) }));
    return { detections, timings: { detectMs, classifyMs: 0, proposals: proposals.length } };
  }
  // All crop questions at once: the server runs them in parallel slots on the GPU. Per box: which term (if
  // any), and is it mostly text (a heading that NAMES the thing must not be blurred).
  const checked = await Promise.all(
    proposals.map(async (p) => {
      // native-resolution crop of exactly the proposed box: padding or rescaling made answers less stable
      const crop = await image.crop(p.box);
      const [which, text] = await Promise.all([client.chat(crop, classifyPrompt(terms), 4), client.chat(crop, TEXT_PROMPT, 3)]);
      const verdict = parseClassify(which, terms);
      return verdict && !isYes(text) ? { term: verdict, box: padBox(p.box) } : null;
    }),
  );
  const detections = checked.filter(Boolean);
  return { detections, timings: { detectMs, classifyMs: performance.now() - t0 - detectMs, proposals: proposals.length } };
}

/** OpenAI-compatible chat client for a local llama-server */
export function createLlamaClient(baseUrl, { timeoutMs = 15000, apiKey = '' } = {}) {
  return {
    async chat(jpegBase64, prompt, maxTokens) {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: jpegBase64
                ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }, { type: 'text', text: prompt }]
                : prompt, // text-only request (concept descriptions)
            },
          ],
          // model card: temperature 0.1, top_k 50, repeat penalty 1.1; thinking off for speed
          temperature: 0, // deterministic: the same screen gives the same answer (no flicker between checks)
          top_k: 50,
          repeat_penalty: 1.1,
          max_tokens: maxTokens,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!res.ok) throw new Error(`vision model HTTP ${res.status}`);
      const j = await res.json();
      return j.choices?.[0]?.message?.content ?? '';
    },
  };
}
