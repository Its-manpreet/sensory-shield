// OWNER: Agent C. Pure functions (no DOM, unit tested in Node): OCR lines -> paragraphs -> sentences to judge,
// and scores -> which screen areas to blur.
//
// Context, not keywords: the classifier judges whole SENTENCES (a word alone means little: "sex" on a form vs.
// in a story), and the whole paragraph is judged too, so an explicit passage is hidden as a whole.
// Lines are NOT simply glued to their neighbours: on real screens that joins unrelated list items
// ("Chicken breast… Cucumbers… Strip the old paint…") into a fake sentence the model misreads.

/** @typedef {{x:number, y:number, w:number, h:number}} Rect  normalized 0..1 */
/** @typedef {{ text: string, rect: Rect }} OcrLine */
/** @typedef {{ text: string, para: number, lines: number[], kind: 'sentence'|'paragraph' }} TextUnit */

/**
 * Group OCR lines into paragraphs: lines that follow each other vertically (gap < ~1.2 line heights),
 * overlap horizontally and have a similar text height. Input order does not matter.
 * @param {OcrLine[]} lines
 * @returns {OcrLine[][]} paragraphs, each top to bottom
 */
export function groupParagraphs(lines) {
  const sorted = [...lines].filter((l) => l.text.trim()).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  /** @type {OcrLine[][]} */
  const paras = [];
  for (const line of sorted) {
    const r = line.rect;
    const home = paras.find((p) => {
      const last = p[p.length - 1].rect;
      const gap = r.y - (last.y + last.h);
      const lineH = Math.max(last.h, r.h);
      const overlap = Math.min(last.x + last.w, r.x + r.w) - Math.max(last.x, r.x);
      return gap > -0.5 * lineH && gap < 1.2 * lineH && overlap > 0.3 * Math.min(last.w, r.w) && Math.abs(last.h - r.h) < 0.6 * lineH;
    });
    if (home) home.push(line);
    else paras.push([line]);
  }
  return paras;
}

const END = /[.!?…]["')\]]*$/;
// a line that ends like this continues on the next line even if that starts with a capital ("the statue of / David")
const CONTINUES = /([,;:\-–]|\b(of|the|a|an|and|or|but|to|in|on|with|his|her|their|my|your|by|for|as|at|from|into|is|was|were|are))$/i;
const STARTS_ITEM = /^([A-Z0-9]|[•☐□○●▪◦\-–*])/;

/**
 * Split each paragraph into sentences. A sentence ends at . ! ? and also at the end of a SHORT line
 * (well under the paragraph's width: a heading, form field or list item), because wrapped prose fills
 * its lines but separate items do not, and before a line that starts like a new item (capital, digit,
 * bullet) unless the line clearly continues ("…the statue of / David").
 * Also one unit per paragraph (its whole text) for context.
 * @param {OcrLine[][]} paras
 * @returns {TextUnit[]}
 */
export function textUnits(paras, { maxChars = 400 } = {}) {
  /** @type {TextUnit[]} */
  const out = [];
  paras.forEach((p, pi) => {
    const widest = Math.max(...p.map((l) => l.rect.w));
    let cur = { text: '', lines: /** @type {number[]} */ ([]) };
    const flush = () => {
      const text = cur.text.trim();
      if (/[a-z]{2}/i.test(text)) out.push({ text: text.slice(0, maxChars), para: pi, lines: cur.lines, kind: 'sentence' });
      cur = { text: '', lines: [] };
    };
    p.forEach((line, li) => {
      // sentence ends inside the line: split there (the line belongs to both sentences)
      const parts = line.text.split(/(?<=[.!?…]["')\]]*)\s+(?=\S)/);
      parts.forEach((part, k) => {
        cur.text += (cur.text ? ' ' : '') + part;
        if (!cur.lines.includes(li)) cur.lines.push(li);
        if (k < parts.length - 1) flush();
      });
      const t = line.text.trim();
      const short = line.rect.w < 0.8 * widest;
      const nextStartsItem = li + 1 < p.length && STARTS_ITEM.test(p[li + 1].text.trim()) && !CONTINUES.test(t);
      if (END.test(t) || short || nextStartsItem || li === p.length - 1) flush();
    });
    if (out.length && out.at(-1).para === pi && p.length > 1) {
      const all = p.map((l) => l.text).join(' ');
      out.push({ text: all.slice(0, maxChars * 2), para: pi, lines: p.map((_, i) => i), kind: 'paragraph' });
    }
  });
  return out;
}

/**
 * Scores -> rects to blur.
 *   A sentence is explicit when its own score >= threshold.
 *   Context widens a blur, it never creates one: when a paragraph has an explicit sentence AND the whole
 *   paragraph reads as explicit, the whole paragraph is blurred (the sentences around it are part of the
 *   same passage). A list or form whose items only add up to something suggestive ("chicken breast…
 *   cucumbers… strip the paint…") has no explicit sentence and stays readable.
 * @param {OcrLine[][]} paras
 * @param {TextUnit[]} units
 * @param {number[]} scores  same order as units
 * @returns {{ rect: Rect, score: number }[]}
 */
export function explicitAreas(paras, units, scores, threshold) {
  const out = [];
  paras.forEach((p, pi) => {
    const sentences = units.map((u, i) => ({ u, s: scores[i] })).filter((x) => x.u.para === pi && x.u.kind === 'sentence');
    const paraScore = units.reduce((m, u, i) => (u.para === pi && u.kind === 'paragraph' ? Math.max(m, scores[i]) : m), 0);
    const bad = sentences.filter((x) => x.s >= threshold);
    if (!bad.length) return;
    const top = Math.max(paraScore, ...bad.map((x) => x.s));
    if (paraScore >= threshold || bad.length * 2 >= sentences.length) return void out.push({ rect: pad(union(p.map((l) => l.rect))), score: top });
    // only the explicit sentences' lines, merged where they touch
    const lineIdx = [...new Set(bad.flatMap((x) => x.u.lines))].sort((a, b) => a - b);
    for (let i = 0; i < lineIdx.length; i++) {
      let j = i;
      while (j + 1 < lineIdx.length && lineIdx[j + 1] === lineIdx[j] + 1) j++;
      out.push({ rect: pad(union(lineIdx.slice(i, j + 1).map((li) => p[li].rect))), score: top });
      i = j;
    }
  });
  return out;
}

/** @param {Rect[]} rects */
export function union(rects) {
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** a little margin so letter tops and descenders are covered */
function pad(r, px = 0.004) {
  const x = Math.max(0, r.x - px), y = Math.max(0, r.y - px);
  return { x, y, w: Math.min(1 - x, r.w + 2 * px), h: Math.min(1 - y, r.h + 2 * px) };
}
