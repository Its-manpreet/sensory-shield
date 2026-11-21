// OWNER: Agent B. Synthetic frame sequences for the flash detector, generated in memory (no files).
// Each generator yields { data: Uint8ClampedArray (RGBA gridW*gridH*4), tMs } frames.

export const GRID_W = 64;
export const GRID_H = 36;

/**
 * @param {object} o
 * @param {number} o.seconds
 * @param {number} [o.fps]
 * @param {(x:number, y:number, tMs:number) => [number, number, number]} o.pixel  x,y normalized 0..1
 */
export function* frames({ seconds, fps = 30, pixel, t0 = 0, ss = 1 }) {
  const count = Math.round(seconds * fps);
  for (let f = 0; f < count; f++) {
    const tMs = t0 + (f * 1000) / fps;
    const data = new Uint8ClampedArray(GRID_W * GRID_H * 4);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        // ss x ss subsamples per cell: averages like the real canvas downscale does
        let r = 0, g = 0, b = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const c = pixel((x + (sx + 0.5) / ss) / GRID_W, (y + (sy + 0.5) / ss) / GRID_H, tMs);
            r += c[0]; g += c[1]; b += c[2];
          }
        }
        const p = (y * GRID_W + x) * 4;
        const k = ss * ss;
        data[p] = r / k;
        data[p + 1] = g / k;
        data[p + 2] = b / k;
        data[p + 3] = 255;
      }
    }
    yield { data, tMs };
  }
}

/** deterministic pseudo-random 0..1 for integer inputs */
const hash = (a, b) => {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** a photo grid like Google Photos: tiles of random brightness/colour with white gutters */
function photoGrid(x, y, dark = false) {
  const tw = 0.16, th = 0.24, gap = 0.012; // tile size in screen widths / heights
  const col = Math.floor(x / tw), row = Math.floor(y / th);
  const fx = x / tw - col, fy = y / th - row;
  if (fx < gap / tw || fy < gap / th) return dark ? [20, 20, 22] : [255, 255, 255];
  const v = hash(col, row);
  if (v < 0.25) return [15 + 30 * v, 15 + 20 * v, 20]; // night photo
  if (v > 0.75) return [235, 235, 230]; // snow / bright sky
  const h = hash(row, col);
  // simple in-tile structure: a horizon line
  return fy < 0.45 ? [120 + 100 * h, 160 + 80 * h, 230] : [60 + 120 * v, 90 + 60 * h, 40 + 50 * v];
}

/** scroll position in screen heights at time t for a speed profile */
const scrollPos = (profile, speed, t) => {
  const s = t / 1000;
  if (profile === 'steady') return speed * s;
  if (profile === 'flick') return (speed / 2.5) * (1 - Math.exp(-2.5 * s)) * 3; // fast flick decaying
  if (profile === 'jiggle') return 0.15 * Math.sin(2 * Math.PI * 1.5 * s); // up/down 1.5x per second
  return 0;
};

/** square wave: true for the "on" half of each cycle */
const on = (hz, tMs) => Math.floor((tMs / 1000) * hz * 2) % 2 === 0;

const GREY = [90, 90, 90];

export const scenes = {
  steady: (s = 3) => frames({ seconds: s, pixel: () => GREY }),

  /** full-screen black/white flash at hz */
  flash: (hz, s = 3) => frames({ seconds: s, pixel: (_x, _y, t) => (on(hz, t) ? [255, 255, 255] : [0, 0, 0]) }),

  /** black/white flash inside a box (normalized), grey elsewhere */
  flashBox: (hz, box, s = 3) =>
    frames({
      seconds: s,
      pixel: (x, y, t) =>
        x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h ? (on(hz, t) ? [255, 255, 255] : [0, 0, 0]) : GREY,
    }),

  /** saturated red vs. dark red: small luminance change, large red change */
  redFlash: (hz, s = 3) => frames({ seconds: s, pixel: (_x, _y, t) => (on(hz, t) ? [255, 0, 0] : [60, 0, 0]) }),

  /** black to white and back over 4 s */
  slowFade: (s = 4) =>
    frames({
      seconds: s,
      pixel: (_x, _y, t) => {
        const v = Math.round(255 * (1 - Math.abs(1 - (2 * t) / (s * 1000))));
        return [v, v, v];
      },
    }),

  /**
   * scrolling a photo grid. speedPx: pixels per second on a 956 px tall screen.
   * profile: 'steady' | 'flick' | 'jiggle'
   */
  scrollPhotos: (speedPx, { profile = 'steady', dark = false, s = 4, fps = 30, ss = 4, horizontal = false } = {}) =>
    frames({
      seconds: s,
      fps,
      ss,
      pixel: (x, y, t) => {
        const d = scrollPos(profile, speedPx / 956, t);
        return horizontal ? photoGrid(x + d * (956 / 1470), y, dark) : photoGrid(x, y + d, dark);
      },
    }),

  /** scrolling text page: thin dark lines on white */
  scrollText: (speedPx, s = 4, dark = false) =>
    frames({
      seconds: s,
      ss: 4,
      pixel: (x, y, t) => {
        const yy = y + (speedPx / 956) * (t / 1000);
        const line = (yy * 40) % 1;
        return x > 0.1 && x < 0.9 && line > 0.55 && line < 0.75 && hash(Math.floor(yy * 40), Math.floor(x * 30)) > 0.15 ? (dark ? [230, 230, 230] : [40, 40, 40]) : dark ? [24, 24, 26] : [255, 255, 255];
      },
    }),

  /** a flashing video box in the middle of a photo page that is being scrolled at the same time */
  flashWhileScrolling: (hz, speedPx, s = 3) =>
    frames({
      seconds: s,
      ss: 4,
      pixel: (x, y, t) => {
        if (x >= 0.2 && x < 0.8 && y >= 0.15 && y < 0.85) return on(hz, t) ? [255, 255, 255] : [0, 0, 0];
        return photoGrid(x, y + (speedPx / 956) * (t / 1000));
      },
    }),

  /** moving gradients with a hard scene cut every 2.5 s: ordinary video */
  normalVideo: (s = 10) =>
    frames({
      seconds: s,
      pixel: (x, y, t) => {
        const scene = Math.floor(t / 2500);
        const base = [[40, 60, 90], [200, 180, 150], [20, 20, 30], [230, 230, 240]][scene % 4];
        const wave = 40 * Math.sin(6 * x + 4 * y + t / 700 + scene);
        return [base[0] + wave, base[1] + wave, base[2] + wave];
      },
    }),
};

/** run a generator through a detector, returning [{ tMs, events }] */
export function run(detector, gen) {
  const out = [];
  for (const frame of gen) out.push({ tMs: frame.tMs, events: detector.push(frame) });
  return out;
}

/** concatenate generators, shifting each one's timestamps to follow the previous */
export function* concat(...makers) {
  let offset = 0;
  for (const make of makers) {
    let last = 0;
    for (const f of make()) {
      last = f.tMs;
      yield { data: f.data, tMs: f.tMs + offset };
    }
    offset += last + 1000 / 30;
  }
}
