# Agent B prompt: Flash detector

Paste this into Claude Code (or say: "Read agents/B-flash-detector.md and do it").

---

You are **Agent B** on Sensory Shield. First read `CLAUDE.md` and `docs/INTERFACES.md` completely. You own `src/engine/flash.js` and `test/flash*`. You can start immediately: your module is pure JavaScript with no Electron or DOM, so you do not need Agent A's scaffold. Work in your own folder in the meantime and merge when the scaffold lands.

## Your job

Build `createFlashDetector(config)` exactly as specified in `docs/INTERFACES.md`.

### How it should work (and why)
- Input is a tiny RGBA frame (default 64x36) pushed every video frame. Tiny input keeps the cost to a few hundred numbers per frame, so it never slows the app.
- Convert sRGB to **linear** light, then compute **relative luminance** per cell (the way the eye judges brightness).
- Split the screen into `regionsX x regionsY` regions (default 4x4). For each region, track mean luminance over a sliding **1-second window**.
- Count **opposing jumps**: a rise followed by a fall (or the reverse) where the change is large relative to the brighter value (start from about 10 percent of maximum luminance; the usual guideline also only applies when the darker value is below a bright threshold. Look up the WCAG 2.x "general flash" definition and the "red flash" definition and implement them as faithfully as is practical, then document where you simplified in `docs/DECISIONS.md`).
- A **flash** is a pair of opposing jumps. Trigger when a region reaches `maxFlashesPerSec` (default 3) AND the flashing regions together cover at least `minAreaFraction` of the screen (default 0.25). Be **conservative**: a false alarm costs the user nothing much, a miss defeats the purpose.
- Detect **saturated red** flashes separately when `detectRed` is true.
- After the last flash, keep reporting the region as protected for `holdMs` (default 1500) so the dim does not flicker off between flashes. Hold events have `active: false`.
- Return `FlashEvent[]` from every `push()`, empty when nothing needs protection.

### Deliverables, in order
1. **Synthetic test generator** (`test/gen-flash.js`): produces frame sequences in memory (no files needed) for: steady image, 1 Hz flash, 3 Hz flash, 6 Hz flash, flash in only a small corner, red flash, slow fade, and a "normal video" simulation (moving gradients, scene cuts every few seconds). These drive your tests.
2. **The detector** with unit tests (`npm test`). Required outcomes:
   - steady, slow fade, small-corner flash, 1 Hz flash, normal video: no events.
   - 3 Hz and 6 Hz full-area luminance flash and red flash: events with `active: true`, within the first 1 second of flashing.
   - After the flashing stops, events continue for about `holdMs`, then stop.
3. **Speed:** measure `push()` time on a 64x36 frame; report the number. It should be well under 1 ms. Put the figure in `docs/STATUS.md` (it is a pitch number).
4. **Synthetic media for Agent D / demo:** a script that renders short flashing test clips (for example HTML canvas page or ffmpeg if installed) into `assets/clips/` with names starting `FLASH-WARNING-`. Keep them small (for example 480x270) and under 5 seconds. Coordinate with Agent D who owns `assets/`: put the generator in `test/` and give D the command.
5. **Calibration notes:** run your detector against the normal-video simulation and tune the defaults so it does not fire on normal content. Write the final default numbers in `docs/DECISIONS.md`.

### Stretch (only after Integration 2 works; ask your human first)
- High-contrast stripe/spiral pattern detector (spatial frequency check) as a second event kind `'pattern'`.
- Sudden loud audio detector (Web Audio, volume ducking) as a separate module `src/engine/audio.js`.

## Acceptance tests
- All unit tests pass with `npm test`.
- Contract in `docs/INTERFACES.md` is met exactly (names, shapes, normalized rects).
- No dependency on the DOM, Electron, or the network.

## Do not
- Do not change `docs/INTERFACES.md`; ask your human.
- Do not make the detector depend on a vision model.
- Do not create media that is graphic or copyrighted. Flashing clips are synthetic, small, short, and clearly labeled.
- Never claim in code comments or docs that this prevents seizures.

## Report format (append to `docs/STATUS.md` at each gate)
`B @ <time>: works: ... | broken: ... | need from others: ...`
