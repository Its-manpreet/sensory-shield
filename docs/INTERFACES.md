# Interfaces (FROZEN: change only through the humans)

All coordinates are **normalized** (0 to 1, relative to the full captured screen) so modules do not care about resolution or display scaling. Origin is top-left.

```js
/** @typedef {{x:number, y:number, w:number, h:number}} Rect  // normalized 0..1 */
```

## 1. Flash detector (Agent B) -> `src/engine/flash.js`

Pure JavaScript. No DOM, no Electron, runs in Node (for tests) and in a Web Worker.

```js
/**
 * @param {FlashConfig} config
 * @returns {{ push(frame: FrameInput): FlashEvent[], reset(): void }}
 *
 * FlashConfig: {
 *   gridW: number,            // default 64
 *   gridH: number,            // default 36
 *   regionsX: number,         // default 4   (screen is split into regionsX x regionsY regions)
 *   regionsY: number,         // default 4
 *   maxFlashesPerSec: number, // default 3  (trigger when exceeded or reached; be CONSERVATIVE)
 *   minAreaFraction: number,  // default 0.25 (share of screen area that must flash together)
 *   holdMs: number,           // default 1500 (keep reporting after the last flash so it cannot flicker back)
 *   detectRed: boolean        // default true (saturated red flashes)
 * }
 *
 * FrameInput: { data: Uint8ClampedArray /* RGBA, gridW*gridH*4 */, tMs: number /* monotonic ms */ }
 *
 * FlashEvent: { rect: Rect, severity: number /* 0..1 */, kind: 'luminance'|'red', active: boolean }
 *   Returned on every push() for regions that are currently in a flashing state (active) and
 *   for regions in the hold period (active: false but still to be dimmed).
 *   Empty array when nothing needs protection.
 */
export function createFlashDetector(config) {}
```

Notes: convert sRGB to linear light before computing relative luminance. Count opposing brightness jumps in a sliding 1-second window per region. Prefer false alarms over misses.

## 2. Content detector (Agent C) -> `src/engine/content.js`

```js
/**
 * @param {ContentConfig} config
 * @returns {Promise<ContentDetector>}
 *
 * ContentConfig: {
 *   device: 'webgpu'|'wasm',   // try webgpu first, fall back to wasm automatically
 *   modelId: string,
 *   localModelPath: string,    // models must load from disk; app must work with the network off
 *   tilesX: number,            // default 4
 *   tilesY: number             // default 3
 * }
 *
 * ContentDetector: {
 *   init(): Promise<{ device: string, modelId: string, loadMs: number }>,
 *   setTriggers(triggers: Trigger[]): Promise<void>,   // embeds the text prompts once
 *   scoreTiles(frame: ImageBitmap | HTMLCanvasElement | ImageData, changedTiles?: boolean[]): Promise<TileResult[]>,
 *   dispose(): void
 * }
 *
 * Trigger:    { id: string, label: string,          // label is what the user typed, e.g. "spiders" or "graphic violence"
 *               prompts: string[],                  // text prompts for the model
 *               threshold: number }                 // 0..1 after calibration
 *
 * TileResult: { rect: Rect, triggerId: string|null, label: string|null, score: number }
 *   triggerId is null when the tile is considered safe. Compare each trigger against SAFE prompts too,
 *   not just against a bare threshold.
 */
export async function createContentDetector(config) {}
```

## 3. Effects renderer (Agent A) -> `src/overlay/effects.js`

```js
/**
 * Region to protect, produced by the overlay from FlashEvent[] and TileResult[] using the active profile.
 * Region: { id: string, rect: Rect, effect: 'dim'|'blur'|'freeze', reason: string, strength: number /* 0..1 */ }
 *
 * createEffects(canvas: HTMLCanvasElement, video: HTMLVideoElement): {
 *   setRegions(regions: Region[], nowMs: number): void,  // handles fade in (about 300 ms), hold, and fade out
 *   revealAll(ms: number): void,                         // hotkey reveal: show everything for ms, then resume
 *   setLabelsVisible(b: boolean): void
 * }
 * The effects renderer draws a BLURRED/DIMMED COPY of the captured pixels over each region
 * (canvas 2D `ctx.filter`), plus a small frosted label with `reason`.
 */
```

## 4. Profiles and settings (Agent D) -> `src/shared/`

```js
/**
 * Profile: {
 *   id: string, name: string,
 *   flash:   { enabled: boolean, maxFlashesPerSec: number, minAreaFraction: number, detectRed: boolean },
 *   content: { enabled: boolean, threshold: number, categories: string[], customTriggers: string[] },
 *   response:{ fadeMs: number, showLabel: boolean, blurStrengthPx: number, dimLevel: number /* 0..1 */ }
 * }
 * Defaults ship in src/shared/profiles.js: 'photosensitive', 'graphic-sensitive', 'custom'.
 *
 * Settings store (src/shared/store.js): getSettings(), setSettings(patch), onChange(cb)
 *   Persisted as JSON in Electron's userData folder through IPC (Agent A provides the IPC handlers).
 *   Stores ONLY settings. Never frames, never screenshots.
 */
```

## 5. IPC channels (Agent A implements the main-process side)

| Channel | Direction | Payload |
|---|---|---|
| `settings:get` | renderer -> main (invoke) | none, returns Settings |
| `settings:set` | renderer -> main (invoke) | partial Settings, returns Settings |
| `settings:changed` | main -> renderers | Settings |
| `shield:toggle` | main -> overlay | `{ enabled: boolean }` (tray / hotkey) |
| `shield:reveal` | main -> overlay | `{ ms: number }` (global hotkey) |
| `shield:stats` | overlay -> main | `{ fps: number, flashMs: number, modelMs: number, modelHz: number }` (shown in the tray tooltip and used for the pitch numbers; counts only) |

## 6. Test assets (Agent D, `assets/`)
- `assets/clips/flash-3hz.*`, `flash-6hz.*`, `normal-video.*`: synthetic clips we generate (no copyrighted media). Flashing clips are SMALL and SHORT and each file name starts with `FLASH-WARNING-`.
- `assets/images/`: a small, labeled, tasteful set to calibrate the content detector (safe images; mild stand-ins such as spiders or generic injury-free "warning" scenes). **Do not collect real gore.** For the live demo, graphic content is simulated with a stand-in image the team agrees on.
