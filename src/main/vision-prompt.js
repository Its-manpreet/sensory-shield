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
  gore: 'blood, open wounds, graphic injury',
  blood: 'blood, bleeding wounds',
  'graphic-injury': 'gore, blood, open wounds, badly injured bodies',
  'graphic-violence': 'people being hurt or attacked, fighting with weapons, shootings',
  violence: 'people being hurt or attacked, fights',
  pornography: 'nudity, naked bodies, sexual content',
  porn: 'nudity, naked bodies, sexual content',
  nudity: 'naked bodies',
  nsfw: 'nudity, sexual content',
  'self-harm': 'cuts on skin, injuries people give themselves',
  needles: 'needles, syringes, injections',
  guns: 'pistols, rifles, shotguns, any firearm',
  gun: 'pistols, rifles, shotguns, any firearm',
  weapons: 'guns, knives, swords',
  knives: 'knives, blades',
  insects: 'insects, bugs',
  snakes: 'snakes',
  clowns: 'people with clown makeup or clown costumes',
  clown: 'people with clown makeup or clown costumes',
  cartoon: 'cartoons, animated drawings',
  cartoons: 'cartoons, animated drawings',
};

const PRETTY = { 'graphic-violence': 'graphic violence', 'graphic-injury': 'graphic injury' };

/** @typedef {{ id: string, label: string }} VisionTerm  id = trigger id, label = what the user typed */

/** visual descriptions the model wrote for other words (see conceptPrompt), filled at runtime */
const learned = new Map();

/** the text sent to the model for a term */
export function describeTerm(term) {
  const key = term.label.trim().toLowerCase();
  const name = PRETTY[key] ?? key;
  if (HINTS[key]) return HINTS[key] === name ? name : `${name} (${HINTS[key]})`;
  return learned.get(key) ?? name;
}

/** true when a word has no built-in or learned description yet */
export function needsConcept(term) {
  const key = term.label.trim().toLowerCase();
  return !HINTS[key] && !PRETTY[key] && !learned.has(key);
}

/**
 * Text-only request, once per new word: the model spells out what the thing LOOKS like, so a short or
 * abstract word ("guns", "medical stuff") becomes concrete visual forms it can find in a picture.
 */
export function conceptPrompt(term) {
  return (
    `A person does not want to see pictures of "${term.label}". In at most 12 words, list the concrete things ` +
    `a picture of "${term.label}" would typically show (kinds, forms, close variants). Reply with the list only.`
  );
}

export function learnConcept(term, answer) {
  const key = term.label.trim().toLowerCase();
  // the answer is a list in some format (commas, dashes, bullets, lines): keep up to 8 distinct items
  const seen = new Set([key]);
  const items = (answer ?? '')
    .split(/[,;\n\r]|\s+-\s+|\s*\u2022\s*/)
    .map((x) => x.replace(/^[\s"'*\d.)-]+|[\s"'.*]+$/g, '').replace(/\s+etc$/i, '').trim())
    .filter((x) => x && x.length <= 40 && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
    .slice(0, 8);
  learned.set(key, items.length ? `${key} (${items.join(', ').toLowerCase()})` : key);
}

/** label shown in the frosted pill */
export function displayLabel(term) {
  return PRETTY[term.label] ?? term.label;
}

/** short name, then what it looks like on its own line: the model echoes only the short name back */
function termList(terms) {
  return terms
    .map((t, i) => {
      const d = describeTerm(t);
      const name = displayLabel(t).toLowerCase();
      const looks = d.startsWith(name) ? d.slice(name.length).replace(/^\s*\(|\)\s*$/g, '').trim() : d;
      return `${i + 1}. ${name}${looks ? `\n   looks like: ${looks}` : ''}`;
    })
    .join('\n');
}

/** @param {VisionTerm[]} terms */
export function detectPrompt(terms) {
  const list = termList(terms);
  return (
    `Find these things in the pictures, photos, drawings or videos in this screenshot:\n${list}\n` +
    `Only report a thing if it is actually pictured and clearly visible. Ignore written text: a word that only ` +
    `names a thing is not the thing. Give a tight box around the thing itself. Output a JSON list of ` +
    `{"label": the number of the thing, "bbox": [x1, y1, x2, y2]}. Output [] if none are visible.`
  );
}

/** @param {VisionTerm[]} terms */
export function classifyPrompt(terms) {
  const list = termList(terms);
  return (
    `Which of these does this picture show?\n${list}\nOnly count things that are actually pictured (a photo, ` +
    `drawing or video). Written words that only name a thing do not count.\nAnswer with the number only, or 0 if none of them.`
  );
}

/**
 * Asked only for boxes that matched a term: a crop of a heading or paragraph that NAMES the thing ("10 facts
 * about spiders") can fool the classify question, but this direct question separates text from pictures
 * reliably (5/5 on headings, paragraphs, photos, a cartoon).
 */
export const TEXT_PROMPT = 'Is this image mostly text (words, letters, a web page paragraph or heading)? Answer only yes or no.';

export function isYes(text) {
  return /^\W*yes\b/i.test(text ?? '');
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
    const boxes = [...chunk.matchAll(/"(?:bbox_2d|box_2d|bbox|box)"\s*:\s*\[([^\]]*)\]/g)].map((m) => m[1].split(',').map((v) => Number(v.trim())));
    if (!boxes.length) continue;
    const labelMatch = chunk.match(/"(?:label|category|name|number)"\s*:\s*("([^"]*)"|-?\d+)/);
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
export function padBox(box, pad = 0.008) {
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  return { x, y, w: Math.min(1, box.x + box.w + pad) - x, h: Math.min(1, box.y + box.h + pad) - y };
}
