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
export function* frames({ seconds, fps = 30, pixel, t0 = 0 }) {
  const count = Math.round(seconds * fps);
  for (let f = 0; f < count; f++) {
    const tMs = t0 + (f * 1000) / fps;
    const data = new Uint8ClampedArray(GRID_W * GRID_H * 4);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const [r, g, b] = pixel((x + 0.5) / GRID_W, (y + 0.5) / GRID_H, tMs);
        const p = (y * GRID_W + x) * 4;
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 255;
      }
    }
    yield { data, tMs };
  }
}

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
