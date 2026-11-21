# Agent C prompt: Content detector (local vision model)

Paste this into Claude Code (or say: "Read agents/C-content-model.md and do it").

---

You are **Agent C** on Sensory Shield. First read `CLAUDE.md` and `docs/INTERFACES.md` completely. You own `src/engine/content.js`, `test/content*` and the `models/` cache folder. You can start immediately in a standalone HTML test page; you do not need Agent A's scaffold. Merge when it lands.

## Your job

Build `createContentDetector(config)` exactly as specified in `docs/INTERFACES.md`: a small **local CLIP-style model** that scores screen tiles against text prompts (zero-shot), with **custom triggers** the user types.

### Why this design
Zero-shot CLIP means the user can type any trigger ("spiders", "car crash", "graphic injury") and we compare the tile against that text with **no training**. It is small enough to run locally, and Hugging Face publishes real-time CLIP demos on WebGPU that already run this loop in a browser, which is your starting point.

### Deliverables, in order
1. **Spike (by Gate 1, T+2:00): model runs locally.**
   - Start from the Transformers.js real-time CLIP demos (look for the `webgpu-clip` and `mobileclip-webgpu` examples and read their `main.js` to copy the model id and loading pattern).
   - Load the model with **WebGPU** and, as a fallback, **WASM (CPU)**. Detect automatically.
   - Make it load from a **local path** (`models/`) so it works with **Wi-Fi OFF**. Test this explicitly with the network disabled. Document the exact steps and the one-time download command in `docs/DECISIONS.md`. (Humans will run it on each laptop before the demo.)
   - Compare two models if time allows (for example MobileCLIP versus CLIP ViT-B/32): measure load time, ms per tile, and checks per second on this machine. Pick one and say why.
2. **`createContentDetector`** with:
   - `init()` returns `{ device, modelId, loadMs }`.
   - `setTriggers(triggers)` embeds each trigger's text prompts ONCE and caches the vectors.
   - `scoreTiles(frame, changedTiles?)` splits the frame into `tilesX x tilesY` tiles (default 4x3), skips tiles where `changedTiles[i] === false` (reuse the previous result), embeds the others, and returns `TileResult[]`.
3. **Scoring logic that does not just use a bare threshold:**
   - For each tile, compute similarity to every trigger's prompts AND to a set of **safe baseline prompts** ("a screenshot of a document", "a photo of a landscape", "a code editor", "a web page"...). Use softmax over triggers plus safe prompts, so a tile only matches a trigger if it beats the safe baseline.
   - Use prompt ensembling (several phrasings per trigger, for example "a photo of {label}", "an image showing {label}").
   - Provide default triggers: `graphic-violence`, `graphic-injury` (written as careful prompts), and let `customTriggers` be any user text.
   - Map user text to a Trigger with generated prompts: `{ id, label, prompts, threshold }`.
4. **Calibration mini-set (with Agent D):** Agent D collects a small, labeled, safe image set in `assets/images/`. Use it to pick default thresholds so that ordinary screens (documents, code, web pages, photos) do NOT trigger, and the agreed stand-in demo images (for example spiders for the custom trigger demo) do. Report: false alarms and misses on the set, as numbers. **Do not collect real gore or graphic imagery.** The demo uses mild stand-ins.
5. **Speed numbers** for the pitch (put in `docs/STATUS.md`): ms per tile, tiles per second, device used, model size.

### Performance rules
- Run the model off the main thread if it blocks rendering (Web Worker), as long as the contract does not change.
- The caller (Agent A) decides cadence (about 2 to 4 checks per second). You make each check as cheap as possible: skip unchanged tiles, resize tiles to the model's input size once, reuse buffers.

### Stretch (only after Integration 2 works; ask your human first)
- OCR-based text triggers (soften chosen words on screen).
- Optional on-demand "why was this blurred?" explanation using a small vision-language model (never run continuously).

## Acceptance tests
- Works with the network OFF (models loaded from disk).
- WebGPU path and WASM path both work (WASM may be slower).
- A test page shows: ordinary screenshots do not trigger; typing a new trigger ("spiders") makes a matching test image trigger within one check; removing the trigger stops it.
- Contract in `docs/INTERFACES.md` is met exactly.

## Do not
- Do not send images or text anywhere over the network at runtime. Do not save frames to disk.
- Do not change `docs/INTERFACES.md`; ask your human.
- Do not commit model files to git.
- Do not claim the model is accurate beyond the measured numbers. Zero-shot CLIP is weaker on subtle gore: say so in `docs/DECISIONS.md`.

## Report format (append to `docs/STATUS.md` at each gate)
`C @ <time>: works: ... | broken: ... | need from others: ...`
