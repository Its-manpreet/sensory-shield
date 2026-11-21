# Agent A prompt: Shell, capture, overlay, effects

Paste this into Claude Code (or say: "Read agents/A-shell-overlay.md and do it").

---

You are **Agent A** on Sensory Shield. First read `CLAUDE.md` and `docs/INTERFACES.md` completely. You own `src/main/` and `src/overlay/`. You are also the **integrator**: you wire the other agents' modules into the overlay.

## Your job, in order

### Step 0 (first 30 minutes, others are waiting): scaffold
Create the repo skeleton so everyone can pull it:
- `package.json` with `electron` and `@huggingface/transformers`; scripts: `start` (run the app), `test` (Node tests).
- The folder layout from `CLAUDE.md` with placeholder files exporting the stubs from `docs/INTERFACES.md` (stubs return empty arrays / safe defaults so the app runs before real modules land).
- `.gitignore` (node_modules, models, large media), `docs/STATUS.md`, `docs/DECISIONS.md`.
- Create branches `main`, `a/shell`, `b/flash`, `c/content`, `d/ui`. Commit and tell your human the scaffold is ready to push.
- Decide how the renderer imports ES modules and Transformers.js (plain ESM, or a minimal bundler such as Vite only if truly needed). Record the decision in `docs/DECISIONS.md` in 3 lines. Keep it simple.

### Step 1 (by Gate 1, T+2:00): the overlay spike. This is the riskiest part of the project
Prove, on this machine, all of these. Record the result of each in `docs/STATUS.md`:
1. A transparent, frameless, always-on-top, full-screen window on the primary display, with `setIgnoreMouseEvents(true)` so clicks pass through to apps below.
2. Screen capture of the primary display in the overlay renderer: `getDisplayMedia` with `session.setDisplayMediaRequestHandler` and `desktopCapturer.getSources`. (Check the current Electron docs for the exact API.)
3. **Feedback-loop test:** draw an obviously colored rectangle in the overlay. The captured video must NOT show it. Try `win.setContentProtection(true)`. If the OS does not honor it, implement the fallback: a hold timer plus never un-blurring a region until the underlying captured content has changed by a clear amount, or a periodic "overlay off for one frame" capture. Pick the simplest that works and write it down.
4. Draw a blurred copy of a captured region into the overlay canvas using canvas `ctx.filter = 'blur(...)'`, positioned exactly over the real region. Test on a high-DPI display: compute from `devicePixelRatio` / display scale factor, normalize rects to 0..1.
5. Global hotkey (reveal for N ms) and a tray icon with on/off. Because partial click-through is unreliable on macOS, the **hotkey is the primary reveal method**.

If any of 1 to 3 cannot be made to work on this OS within about 90 minutes, STOP and report to your human with what you tried. The team will choose the fallback.

### Step 2 (T+2:00 to T+4:30): integration 1
- Build the capture loop: use `requestVideoFrameCallback` on the video element; every frame draw to a small canvas (64x36) and send to the flash detector (Web Worker is fine; the detector is pure JS). Every 250 to 500 ms, grab full-resolution tiles that changed and give them to the content detector.
- Convert `FlashEvent[]` and `TileResult[]` into `Region[]` using the active profile, and call `effects.setRegions(...)`.
- Implement `src/overlay/effects.js` per the contract: fade in about 300 ms, hold, fade out; effects `dim`, `blur`, `freeze`; small frosted label with the reason; `revealAll(ms)`.
- Implement the IPC handlers listed in `docs/INTERFACES.md` and a settings store file in the userData folder.
- Merge in the real modules from B and C as their PRs land. Until then use the stubs.

### Step 3 (T+4:30 to T+8:30)
- Wire profiles live (changes in settings apply without restart).
- Measure and display performance numbers (`shield:stats`): flash check time per frame, model checks per second, overall CPU feel. These are pitch numbers.
- Make the app robust: no crash if the model fails to load (show a tray warning and keep the flash detector running).

## Acceptance tests
- App starts with `npm start`, overlay does not block clicking apps underneath.
- A synthetic flashing clip playing in any app gets dimmed within a fraction of a second; a normal video does not.
- Overlay never causes a capture feedback loop (a blurred region does not un-blur by itself while the real content is unchanged).
- Hotkey reveal works. Tray on/off works.
- Works with the network off.

## Do not
- Do not save frames or screenshots anywhere. Do not add network calls.
- Do not edit other agents' files; open an issue note in `docs/STATUS.md` and tell your human.
- Do not add stretch features before Integration 2 is working.

## Report format (append to `docs/STATUS.md` at each gate)
`A @ <time>: works: ... | broken: ... | need from others: ...`
