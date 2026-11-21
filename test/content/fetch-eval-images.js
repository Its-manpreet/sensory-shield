// OWNER: Agent C. Downloads a small, harmless calibration set from Wikimedia Commons (free licences) into
// assets/images/eval/<class>/ (git-ignored). No nudity or gore is collected: those categories are checked
// for false alarms only (swimwear, statues, red food...).   node test/content/fetch-eval-images.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'images', 'eval');
const PER_CLASS = 6;
const UA = 'SensoryShieldEval/0.1 (offline calibration script)';
// class -> [expected trigger id or null, Commons search]
const CLASSES = {
  gun: ['violence', 'handgun pistol'],
  rifle: ['violence', 'assault rifle'],
  knife: ['violence', 'combat knife'],
  spider: ['phobia:spiders', 'spider macro'],
  syringe: ['phobia:needles', 'syringe needle injection'],
  snake: ['phobia:snakes', 'snake reptile'],
  clown: ['phobia:clowns', 'clown makeup'],
  cat: [null, 'domestic cat portrait'],
  pasta: [null, 'spaghetti tomato sauce'],
  steak: [null, 'raw beef steak'],
  swimwear: [null, 'beach volleyball players'],
  portrait: [null, 'portrait photograph woman'],
  street: [null, 'city street photograph'],
  statue: [null, 'marble statue museum'],
  toygun: [null, 'water gun toy'],
  kitchen: [null, 'kitchen knife cutting vegetables'],
};

async function search(q) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  Object.entries({ action: 'query', format: 'json', generator: 'search', gsrsearch: `filetype:bitmap ${q}`, gsrnamespace: '6', gsrlimit: '30', prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '640' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { headers: { 'User-Agent': UA } });
  const pages = Object.values((await res.json()).query?.pages ?? {});
  return pages
    .sort((a, b) => a.index - b.index)
    .map((p) => ({ title: p.title, info: p.imageinfo?.[0] }))
    .filter((p) => p.info && /jpeg|png/.test(p.info.mime) && p.info.thumburl);
}

const credits = [];
for (const [cls, [expect, q]] of Object.entries(CLASSES)) {
  const dir = path.join(OUT, cls);
  await fs.mkdir(dir, { recursive: true });
  const have = (await fs.readdir(dir)).filter((f) => f.endsWith('.jpg')).length;
  if (have >= PER_CLASS) {
    console.log(`have ${cls}`);
    continue;
  }
  let n = 0;
  for (const r of await search(q)) {
    if (n >= PER_CLASS) break;
    const img = await fetch(r.info.thumburl, { headers: { 'User-Agent': UA } });
    if (!img.ok) continue;
    await fs.writeFile(path.join(dir, `${n}.jpg`), Buffer.from(await img.arrayBuffer()));
    credits.push({ file: `${cls}/${n}.jpg`, title: r.title, licence: r.info.extmetadata?.LicenseShortName?.value, url: r.info.descriptionurl });
    n++;
    await new Promise((res) => setTimeout(res, 300));
  }
  console.log(`got ${n} ${cls}`);
}
const manifest = Object.fromEntries(Object.entries(CLASSES).map(([c, [e]]) => [c, e]));
await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify({ expect: manifest, credits }, null, 1));
console.log(`eval images in ${OUT}`);
