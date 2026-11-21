// OWNER: Agent C. Prompts for the on-device vision-language model (LFM3-VL-2B) and parsing of its answers.
// Pure functions, no Electron: unit tested in test/content-vision.test.js.
//
// How a check works (see src/main/vision.js):
//   1. DETECT: one request with a downscaled screenshot asks for boxes around any of the user's terms.
//      LFM3-VL answers with JSON boxes in 0..1000 coordinates ("bbox" or "bbox_2d").
//   2. CLASSIFY: each box is cropped from the full screenshot and the model says which term (by number), if
//      any, the crop shows. A 2B model often draws the right box with the wrong label (a clown labelled
//      "spiders") or boxes harmless things (a landscape as "cartoon"); on crops it is reliable (6/6 in our
//      tests, ~0.25 s each). So detection proposes boxes and the crop answer decides the label.

/**
 * Broad words the model understands better with a few concrete examples. The user's own word stays the
 * label shown on screen; only the text sent to the model is expanded. Matching is on the lowercased word.
 */
const HINTS = {
  gore: 'gore (blood, open wounds, graphic injury)',
  blood: 'blood or bleeding wounds',
  'graphic-injury': 'graphic injury or gore (blood, open wounds)',
  'graphic-violence': 'graphic violence (people being hurt, fighting with weapons)',
  violence: 'violence (people being hurt or attacked)',
  pornography: 'pornography or nudity (naked bodies, sexual content)',
  porn: 'pornography or nudity (naked bodies, sexual content)',
  nudity: 'nudity (naked bodies)',
  nsfw: 'nudity or sexual content',
  'self-harm': 'self-harm (cuts on skin, injuries to oneself)',
  needles: 'needles or syringes',
  insects: 'insects or bugs',
  snakes: 'snakes',
  clowns: 'clowns (people with clown makeup or costumes)',
  clown: 'clowns (people with clown makeup or costumes)',
  cartoon: 'cartoons or animated drawings',
  cartoons: 'cartoons or animated drawings',
};

const PRETTY = { 'graphic-violence': 'graphic violence', 'graphic-injury': 'graphic injury' };

/** @typedef {{ id: string, label: string }} VisionTerm  id = trigger id, label = what the user typed */

/** the text sent to the model for a term */
export function describeTerm(term) {
  const key = term.label.trim().toLowerCase();
  return HINTS[key] ?? PRETTY[key] ?? key;
}

/** label shown in the frosted pill */
export function displayLabel(term) {
  return PRETTY[term.label] ?? term.label;
}

/** @param {VisionTerm[]} terms */
export function detectPrompt(terms) {
  const list = terms.map((t, i) => `${i + 1}. ${describeTerm(t)}`).join('\n');
  return (
    `Find these things in the screenshot:\n${list}\n` +
    `Only report a thing if it is clearly visible. Output a JSON list of {"label": the number of the thing, ` +
    `"bbox": [x1, y1, x2, y2]}. Output [] if none are visible.`
  );
}

/** @param {VisionTerm[]} terms */
export function classifyPrompt(terms) {
  const list = terms.map((t, i) => `${i + 1}. ${describeTerm(t)}`).join('\n');
  return `Which of these does this image show?\n${list}\nAnswer with the number only, or 0 if none of them.`;
}

/**
 * @param {string} text  the model's answer to classifyPrompt
 * @param {VisionTerm[]} terms
 * @returns {VisionTerm|null}
 */
export function parseClassify(text, terms) {
  const n = Number((text ?? '').match(/\d+/)?.[0]);
  return Number.isInteger(n) && n >= 1 && n <= terms.length ? terms[n - 1] : null;
}

/**
 * Parse the detect answer into boxes. Tolerates the model's variations: "bbox" or "bbox_2d", labels as the
 * list number or as words, extra keys, code fences, prose around the JSON.
 * @param {string} text
 * @param {VisionTerm[]} terms
 * @returns {{ term: VisionTerm, box: {x:number,y:number,w:number,h:number} }[]}  box normalized 0..1
 */
export function parseDetections(text, terms) {
  // Not JSON.parse: the model sometimes repeats keys inside one object ({"bbox": A, "bbox": B}), and
  // JSON.parse would keep only B. Scan each {...} chunk for every box and its label instead.
  const out = [];
  const chunks = (text ?? '').split('}');
  for (const chunk of chunks) {
    const boxes = [...chunk.matchAll(/"(?:bbox_2d|bbox|box)"\s*:\s*\[([^\]]*)\]/g)].map((m) => m[1].split(',').map((v) => Number(v.trim())));
    if (!boxes.length) continue;
    const labelMatch = chunk.match(/"(?:label|category|name)"\s*:\s*("([^"]*)"|-?\d+)/);
    const label = labelMatch ? (labelMatch[2] ?? labelMatch[1]) : null;
    for (const b of boxes) {
      if (b.length !== 4 || !b.every(Number.isFinite)) continue;
      // detection only proposes boxes; an unknown label is fine (classification decides later)
      const term = matchTerm(label, terms);
      const d = toBox(b);
      if (d) out.push({ term, box: d });
    }
  }
  return out;
}

/** [x1, y1, x2, y2] in 0..1000 (or 0..1) -> normalized {x, y, w, h}, or null if degenerate */
function toBox(b) {
  let [x1, y1, x2, y2] = b;
    const scale = Math.max(x1, y1, x2, y2) <= 1.0001 ? 1 : 1000; // some answers come normalized 0..1
    [x1, y1, x2, y2] = [x1, y1, x2, y2].map((v) => Math.min(1, Math.max(0, v / scale)));
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    if (x2 - x1 < 0.01 || y2 - y1 < 0.01) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** drop boxes that are near-duplicates of an earlier one (IoU >= 0.7) */
export function dedupeBoxes(dets) {
  const out = [];
  for (const d of dets) if (!out.some((o) => iou(o.box, d.box) >= 0.7)) out.push(d);
  return out;
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/** label from the model -> one of our terms: list number, exact word, or a word contained either way */
function matchTerm(label, terms) {
  if (label == null) return null;
  const n = Number(label);
  if (Number.isInteger(n) && n >= 1 && n <= terms.length) return terms[n - 1];
  const s = String(label).trim().toLowerCase();
  if (!s) return null;
  for (const t of terms) {
    const words = [t.label.toLowerCase(), describeTerm(t).toLowerCase(), displayLabel(t).toLowerCase()];
    if (words.some((w) => w === s || w.includes(s) || s.includes(w.split(' (')[0]))) return t;
  }
  return null;
}

/** expand a box a little so the blur fully covers the object's edges */
export function padBox(box, pad = 0.03) {
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  return { x, y, w: Math.min(1, box.x + box.w + pad) - x, h: Math.min(1, box.y + box.h + pad) - y };
}
