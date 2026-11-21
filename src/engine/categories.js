// OWNER: Agent C. What the picture model looks for. Pure data + functions (no DOM), unit tested in Node.
// MobileCLIP compares each screen tile with these short descriptions. Every trigger competes against the
// SAFE descriptions (ordinary screen content), so a tile is only flagged when it looks MORE like the
// trigger than like anything ordinary. Nudity also has a dedicated detector (NudeNet); CLIP is its backup
// for drawings and scenes the detector does not box.

/** @typedef {{ id: string, label: string, prompts: string[], threshold: number }} Trigger */

const photo = (things) => things.flatMap((t) => [`a photo of ${t}`, `a picture of ${t}`]);

/** built-in categories (switches in settings.safety) */
export const CATEGORIES = {
  nudity: {
    label: 'nudity',
    prompts: ['pornography', 'a pornographic photo', 'a naked woman', 'a naked man', 'a topless woman', 'people having sex', 'an explicit sex scene', 'nude bodies', 'a nude drawing'],
  },
  gore: {
    label: 'graphic injury',
    prompts: ['graphic gore', 'a bloody wound', 'a mutilated body', 'a dead body', 'a corpse', 'a severed limb', 'a gruesome injury', 'blood splattered everywhere', 'a person covered in blood'],
  },
  violence: {
    label: 'weapons or violence',
    prompts: [...photo(['a gun', 'a handgun', 'a rifle', 'a person pointing a gun', 'a knife', 'a person holding a knife', 'weapons']), 'people fighting', 'a person being beaten', 'a violent attack', 'a shooting', 'an explosion with victims'],
  },
};

/** phobia picker (settings.safety.phobias holds these ids) */
export const PHOBIAS = {
  spiders: { label: 'spiders', prompts: [...photo(['a spider', 'a tarantula', 'a spider web with a spider']), 'a close-up of a spider'] },
  needles: { label: 'needles', prompts: [...photo(['a syringe', 'a hypodermic needle', 'an injection into an arm', 'a needle']), 'a vaccine being injected'] },
  snakes: { label: 'snakes', prompts: [...photo(['a snake', 'a python', 'a cobra', 'a viper']), 'a close-up of a snake'] },
  clowns: { label: 'clowns', prompts: [...photo(['a clown', 'a scary clown', 'a person in clown makeup'])] },
  insects: { label: 'insects', prompts: [...photo(['cockroaches', 'a swarm of insects', 'maggots', 'a large beetle', 'a centipede'])] },
  holes: { label: 'clusters of holes', prompts: ['clusters of small holes', 'a lotus seed pod', 'a honeycomb pattern of holes', 'skin with many small holes'] },
  blood: { label: 'blood', prompts: [...photo(['blood', 'a bleeding cut', 'a pool of blood', 'a blood test tube'])] },
  sharks: { label: 'sharks', prompts: [...photo(['a shark', 'a shark with open jaws'])] },
  rats: { label: 'rats', prompts: [...photo(['a rat', 'mice', 'a rodent'])] },
  dogs: { label: 'dogs', prompts: [...photo(['a dog', 'an aggressive dog barking'])] },
};

/** ordinary screen content: what a tile is compared against */
export const SAFE_PROMPTS = [
  'a screenshot of a website', 'a page of text', 'a text document', 'a user interface with buttons', 'a spreadsheet', 'a chart', 'a map',
  'a blank white background', 'a dark background', 'a code editor', 'a video player', 'a video game', 'a cartoon', 'an icon', 'a logo',
  'a photo of a person', 'a photo of people', 'a portrait of a face', 'a selfie', 'a person in a swimsuit', 'a person in clothes', 'a baby',
  'a landscape', 'a city street', 'a room interior', 'a building', 'a car', 'food on a plate', 'a red sauce', 'raw meat at a butcher',
  'a cat', 'a bird', 'a flower', 'a tree', 'a toy', 'a product photo', 'a doctor in a hospital', 'a sports match', 'a concert',
  'a news photo', 'a painting', 'a sculpture', 'a book cover', 'clothes', 'a kitchen', 'a phone', 'a computer',
  // look-alikes found in calibration (test/content/image-eval.html): food, cooking, toys
  'a raw steak on a plate', 'steak tartare', 'minced meat', 'a kitchen knife cutting vegetables', 'cooking in a kitchen',
  'a colorful plastic toy water gun', 'a plastic toy',
  // text and app UI (CLIP reads words; these give text-heavy tiles an ordinary match)
  'a list of search results', 'a settings window with switches', 'a menu of text labels', 'an article with a headline',
  'a chat conversation', 'an email inbox',
];

/**
 * Settings -> triggers for the picture model.
 * @param {{ nudity?: boolean, gore?: boolean, violence?: boolean, phobias?: string[], custom?: string[], sensitivity?: number }} safety
 * @returns {Trigger[]}
 */
export function triggersFor(safety = {}) {
  const th = thresholdFor(safety.sensitivity);
  const out = [];
  for (const [id, c] of Object.entries(CATEGORIES)) if (safety[id]) out.push({ id, label: c.label, prompts: c.prompts, threshold: th });
  for (const id of safety.phobias ?? []) if (PHOBIAS[id]) out.push({ id: `phobia:${id}`, label: PHOBIAS[id].label, prompts: PHOBIAS[id].prompts, threshold: th });
  for (const raw of safety.custom ?? []) {
    const w = String(raw).trim().toLowerCase().slice(0, 60);
    if (w) out.push({ id: `custom:${w}`, label: w, prompts: [`a photo of ${w}`, `a picture of ${w}`, w], threshold: th });
  }
  return out;
}

/** sensitivity 0..1 (1 = blur more) -> share of the probability a trigger needs, 0.65 .. 0.25 */
export function thresholdFor(sensitivity = 0.5) {
  const s = Math.min(1, Math.max(0, Number(sensitivity)));
  return 0.65 - 0.4 * s;
}

/**
 * Zero-shot decision for one tile. sims[i] is the cosine similarity of the tile to prompt i, where prompts
 * are all trigger prompts (in trigger order) followed by SAFE_PROMPTS. Softmax over every prompt with CLIP's
 * logit scale; a trigger's probability is the sum over its prompts.
 * @param {ArrayLike<number>} sims
 * @param {Trigger[]} triggers
 * @returns {{ triggerId: string|null, label: string|null, score: number, probs: Record<string, number> }}
 *   best trigger (null when safe), and every trigger's probability (used to shrink a pane onto its object)
 */
export function decide(sims, triggers, scale = 100) {
  let max = -Infinity;
  for (let i = 0; i < sims.length; i++) max = Math.max(max, sims[i]);
  let z = 0;
  const e = new Float64Array(sims.length);
  for (let i = 0; i < sims.length; i++) z += e[i] = Math.exp(scale * (sims[i] - max));
  let best = { triggerId: null, label: null, score: 0 };
  const probs = {};
  let at = 0;
  for (const t of triggers) {
    let p = 0;
    for (let k = 0; k < t.prompts.length; k++) p += e[at + k] / z;
    at += t.prompts.length;
    probs[t.id] = p;
    if (p >= t.threshold && p > best.score) best = { triggerId: t.id, label: t.label, score: p };
    else if (!best.triggerId && p > best.score) best.score = p;
  }
  return { ...best, probs };
}
