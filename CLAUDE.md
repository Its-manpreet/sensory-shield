# Sensory Shield: project brief (every agent reads this first)

## What we are building
A local desktop app that watches the user's screen and gently protects them:
- **Flash protection:** if a region of the screen flashes (about 3 or more flashes per second over a large area), dim it. This is a seizure-risk trigger for people with photosensitive epilepsy.
- **Content protection:** a small local vision model (CLIP-style, zero-shot) scores screen tiles against text prompts. Tiles that match graphic content, or a trigger the user typed (for example "spiders"), get a soft blur.
- **Gentle response:** smooth fade, small frosted label saying why, a hotkey to reveal. Never a hard block.
- **Profiles:** Photosensitive, Graphic-content sensitive, Custom.

One-line pitch: a personal sensory shield that runs entirely on your own device and gently dims or blurs flashing and graphic content, tuned to each person's own triggers.

## Hard constraints
- Software only. No hardware.
- Total time: under 12 hours, 4 humans, each with one Claude Code agent (A, B, C, D).
- **Privacy:** frames are analyzed in memory only. Never save frames to disk, never send them anywhere. No network calls at runtime. Model files must be cached locally so the app works with Wi-Fi OFF.
- **Safety:** never claim the app "prevents seizures". Say "reduces exposure to known triggers". For testing flashing, use synthetic clips we generate ourselves, keep them small and short, and never flash full screen without warning the people in the room.
- Stack: Electron + plain JavaScript (ES modules for shared and renderer code). Transformers.js (`@huggingface/transformers`) for the model, WebGPU first, WASM CPU fallback. Python only for optional offline calibration scripts.

## How it works (why it is built this way)
Two detectors, because the two threats behave differently:
1. **Flash detector** runs on EVERY frame on a tiny downsampled grid (about 64x36). It is cheap math, no model. Flash danger comes from repetition within a second, so catching it within a few frames still protects the user.
2. **Content detector** runs 2 to 4 times per second, only on tiles whose pixels changed since the last check. Graphic content stays on screen for seconds, so a heavier model at a low rate is enough, and static screens cost nothing.
3. **Response layer** draws effects in a transparent always-on-top overlay. IMPORTANT: CSS backdrop blur in a transparent window does NOT blur other apps' pixels. The overlay draws its OWN blurred copy of the captured pixels over the flagged region.
4. **Feedback-loop trap:** the capture could see the overlay and judge its own blur as "safe". Mitigations: ask the OS to exclude the overlay window from capture (`win.setContentProtection(true)`, VERIFY on each OS), and keep a hold timer so a region cannot flicker back by itself.

## Folder ownership (do not edit files outside your folders; ask the owner)
```
src/main/        Agent A   Electron main process, windows, capture permission, tray, hotkeys
src/overlay/     Agent A   overlay window, capture loop, effects renderer
src/engine/flash.js          Agent B   flash detector (pure JS, no DOM)
src/engine/content.js        Agent C   model loading, tile scoring, custom triggers
src/settings/    Agent D   settings window, profile editor
src/shared/      Agent D   profile schema, defaults, settings store (everyone imports, only D edits)
test/            each agent owns test/<their-module>*
docs/            shared: INTERFACES.md is FROZEN (see rules), STATUS.md everyone appends
assets/          Agent D   synthetic test clips and images, demo material
```

## The contract
`docs/INTERFACES.md` defines the function signatures and data shapes between modules. It is **frozen at the start**. If you need a change, tell your human; they agree it with the other humans and the file is updated in ONE commit that everyone pulls. Build against stubs until the real module lands.

## Git rules
- `main` always runs. Tag the last known-good build `demo-ok` whenever the full app works.
- One branch per agent: `a/shell`, `b/flash`, `c/content`, `d/ui`. Small commits. Open a PR to `main` at each milestone; your human merges.
- Rebase on `main` before opening a PR. Never force-push `main`.

## Milestones (T = time since start; humans announce gates)
- T+0:30 repo scaffold pulled by everyone.
- T+2:00 **Gate 1:** day-zero spikes report (overlay + capture without feedback loop, WebGPU and CPU model, flash detector on a synthetic clip). Each agent appends 3 lines to `docs/STATUS.md`.
- T+4:30 **Integration 1:** capture -> flash dim + tile blur working end to end on one machine.
- T+7:00 **Integration 2:** custom triggers, profiles, response ladder, reveal hotkey.
- T+8:30 **Feature freeze.** Only bug fixes, tuning, demo prep.
- T+10:30 **Code freeze.** Rehearsal and backup video only.

## Working agreement for agents
- Read this file and `docs/INTERFACES.md` before writing code.
- Prefer the simplest thing that works. This is a 12-hour build; do not add features outside your prompt.
- Verify claims instead of assuming (OS behavior, API names, model ids). Record findings in `docs/DECISIONS.md` (append-only, one short entry each).
- If you are blocked for more than 20 minutes, stop and tell your human exactly what you need.
- When you finish a milestone, append to `docs/STATUS.md`: what works, what does not, what you need from others.
- Never commit model weight files or large media to git (use `.gitignore`; models live in `models/`, cached locally).
