# Sensory Shield

A personal sensory shield that runs entirely on your own device and gently dims or blurs flashing and graphic content, tuned to each person's own triggers. It **reduces exposure to known triggers**; it is not a medical device.

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
| `src/engine/content.js` | C | content detector (stub until C lands it) |
| `src/settings/` | D | settings window (placeholder until D lands it) |
| `src/shared/` | D | `profiles.js` defaults, `store.js` settings store, `types.js` JSDoc types |
| `assets/` | D | test clips (git-ignored), calibration images, demo page |
| `models/` | C | local model cache (git-ignored) |

Every stub already matches `docs/INTERFACES.md`, so you can replace one module without touching anyone else's files.
`test/overlay-contract.test.js` guards the shapes the overlay depends on: keep it green.

## Branches
`main` always runs. Work on `a/shell`, `b/flash`, `c/content`, `d/ui`; rebase on `main`, open a PR at each milestone. Tag the last full working build `demo-ok`.
