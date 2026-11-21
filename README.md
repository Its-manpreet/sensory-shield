# Sensory Shield

A personal sensory shield that runs entirely on your own device and gently softens flashing content. It **reduces exposure to known triggers**; it is not a medical device.

Read first: `CLAUDE.md` (brief and rules), `START-HERE.md` (team plan), `docs/INTERFACES.md` (frozen contract), your prompt in `agents/`.

## Setup
```sh
npm install
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
| `src/engine/content.js` | C | content detector: removed for now (see tag `vision-v1`) |
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

## Content blocklist
Removed for now (the app is flash protection only). The vision-model version is kept at git tag `vision-v1`.

## Packaging
```sh
npm run dist:dir   # unpacked app in dist/ (fast check)
npm run dist       # installer: .dmg on macOS, NSIS .exe on Windows, AppImage on Linux
```
Build on each target OS. The app is unsigned (fine for the demo; macOS: right-click → Open the first time).
