// The audio worklet's measurements on synthetic signals (run in Node with the worklet globals stubbed).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SR = 48000;
let Proc;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => this.out.push(m) }; this.out = []; } };
globalThis.registerProcessor = (_n, c) => (Proc = c);
await import('../src/overlay/level-worklet.js');

/** feed `seconds` of signal f(t) (stereo, same both sides), return the last reading */
function measure(f, seconds = 0.5) {
  const p = new Proc();
  for (let i = 0; i < SR * seconds; i += 128) {
    const ch = Float32Array.from({ length: 128 }, (_, k) => f((i + k) / SR));
    p.process([[ch, ch]]);
  }
  return p.out.at(-1);
}
let seed = 1;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

test('K-weighted loudness: full-scale 1 kHz sine reads about -3 LUFS; 100 Hz a little lower', () => {
  const r = measure((t) => Math.sin(2 * Math.PI * 1000 * t));
  assert.ok(Math.abs(r.levelDb - -3.01) < 0.3, String(r.levelDb));
  const low = measure((t) => Math.sin(2 * Math.PI * 100 * t));
  assert.ok(low.levelDb < r.levelDb - 0.3, `${low.levelDb}`);
});

test('a sharp high tone is one dominant peak; noise and low music are not', () => {
  const tone = measure((t) => 0.2 * Math.sin(2 * Math.PI * 7000 * t) + 0.02 * noise());
  assert.ok(tone.toneShareDb > -2 && tone.toneSharpDb > -0.5 && Math.abs(tone.toneHz - 7000) < 100, JSON.stringify(tone));
  assert.ok(Math.abs(tone.toneDb - 10 * Math.log10(0.02)) < 1.5, JSON.stringify(tone)); // sine power 0.02
  const hiss = measure(() => 0.3 * noise());
  assert.ok(hiss.toneShareDb < -10 && hiss.toneSharpDb < -2, JSON.stringify(hiss)); // triggers: -6 and -1
  const music = measure((t) => 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 330 * t) + 0.02 * Math.sin(2 * Math.PI * 3520 * t));
  assert.ok(music.toneShareDb < -20, JSON.stringify(music));
});
