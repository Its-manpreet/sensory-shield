# Sensory Shield

A personal sensory shield that runs entirely on your own device. It gently softens flashing content and loud sound, and (child safety) blurs nudity, sexual writing, gore, weapons, phobias and your own words. It **reduces exposure to known triggers**; it is not a medical device and no filter catches everything.

Read first: `CLAUDE.md` (brief and rules), `START-HERE.md` (team plan), `docs/INTERFACES.md` (frozen contract), your prompt in `agents/`.

## Setup
```sh
npm install
npm run content:setup   # once: child-safety models (~1 GB) into models/, text-recognition helper (macOS)
npm test          # Node unit tests (node --test test/)
npm start         # run the app (tray icon "Shield"; overlay is invisible until something is flagged)
npm run selftest  # starts the app, prints renderer logs, quits after 6 s
```
macOS: the first capture needs Screen Recording permission (System Settings > Privacy & Security) for Electron, or for your terminal when run with `npm start`.

Hotkeys: reveal 5 s `Cmd/Ctrl+Alt+R`, shield on/off `Cmd/Ctrl+Alt+S`, settings `Cmd/Ctrl+Alt+,`.

## Layout
| Path | Owner | What |
|---|---|---|
| `src/main/` | A | main process: windows, tray, hotkeys, IPC, settings file, network lock, capture handler |
| `src/overlay/` | A | overlay renderer: capture loop, `regions.js` (events -> regions), `effects.js` |
| `src/engine/flash.js` | B | flash detector (stub until B lands it) |
| `src/engine/content.js` | C | picture detector: MobileCLIP-S0 tiles + NudeNet nudity boxes |
| `src/engine/text-safety.js`, `text-layout.js` | C | explicit text in context: sentences -> two text models |
| `src/engine/categories.js`, `runtime.js` | C | what pictures are compared against; model runtime + GPU queue |
| `src/engine/panes.js`, `src/overlay/box-motion.js` | C, A | pane geometry (grouping, picture finder, edge snapping, animation); panes follow their content |
| `src/overlay/content-loop.js` | A | when to check what (changed tiles, changed text rows), results -> blur regions |
| `src/main/ocr.js`, `src/main/ocr/` | A | on-device text recognition (macOS Vision helper) |
| `src/settings/` | D | settings window (placeholder until D lands it) |
| `src/shared/` | D | `profiles.js` defaults, `store.js` settings store, `types.js` JSDoc types |
| `assets/` | D | test clips (git-ignored), calibration images, demo page |
| `models/` | C | local model cache (git-ignored) |

Every stub already matches `docs/INTERFACES.md`, so you can replace one module without touching anyone else's files.
`test/overlay-contract.test.js` guards the shapes the overlay depends on: keep it green.

## Branches
`main` always runs. Work on `a/shell`, `b/flash`, `c/content`, `d/ui`; rebase on `main`, open a PR at each milestone. Tag the last full working build `demo-ok`.

### macOS: run as its own app (recommended)
`npm run app` launches Electron as a standalone app, so macOS asks for Screen Recording permission for **Electron** itself (not your terminal). Grant it in System Settings → Privacy & Security → Screen & System Audio Recording, then press **Relaunch** in the Sensory Shield window.

## Child safety (content protection)
Settings → **Child safety**: nudity and sexual images, sexual writing, gore, weapons and violence, a phobia picker (spiders, needles, snakes, clowns, insects, holes, blood, sharks, rats, dogs) and your own words. All models run on this device (WebGPU, CPU fallback); frames and text stay in memory.

| What | How | Measured (M5, WebGPU) |
|---|---|---|
| Pictures | changed screen tiles (4x3 + half-offset) -> MobileCLIP-S0 vs. trigger and ordinary descriptions; NudeNet boxes for nudity. One pane per object: big at once, then fitted to the picture's border, follows scrolling | live: first pane median 145 ms; one pane on 11/12; fit IoU 0.84; 95% covered while scrolling |
| Text | changed rows -> Apple Vision OCR -> sentences -> DistilBERT NSFW filter -> DeBERTa NLI "describes sexual activity or nudity in an erotic way?" | ~100-250 ms per check |

Checks: `npm run content:check-text` (context sentences, held-out set, rendered screen), `npm run content:eval-images` (Wikimedia calibration set, harmless stand-ins only), `npm run content:latency` (live end-to-end), `npm run content:bench`. Numbers and limits: `docs/DECISIONS.md`. The earlier vision-language-model version (~1.2 s per check) is kept at git tag `vision-v1`.

## Packaging
```sh
npm run dist:dir   # unpacked app in dist/ (fast check)
npm run dist       # installer: .dmg on macOS, NSIS .exe on Windows, AppImage on Linux
```
Build on each target OS. The app is unsigned (fine for the demo; macOS: right-click → Open the first time).
