# START HERE (for the four humans)

Goal: working demo in under 12 hours. Four of you, each driving one Claude Code agent. The agents work in parallel because each owns separate files and they talk through the frozen contract in `docs/INTERFACES.md`.

## Who runs which agent
| Human | Agent | Prompt file | Owns |
|---|---|---|---|
| 1 | A: shell, overlay, integration | `agents/A-shell-overlay.md` | `src/main/`, `src/overlay/` |
| 2 | B: flash detector | `agents/B-flash-detector.md` | `src/engine/flash.js` |
| 3 | C: vision model | `agents/C-content-model.md` | `src/engine/content.js`, `models/` |
| 4 | D: settings, profiles, demo, pitch | `agents/D-ui-profiles-demo.md` | `src/settings/`, `src/shared/`, `assets/` |

## First 15 minutes
1. Human 1 creates an empty GitHub repo, copies this whole folder into it (so `CLAUDE.md`, `docs/`, `agents/` are in the root), commits and pushes.
2. Everyone clones it and opens Claude Code in the repo folder.
3. Everyone pastes their own agent prompt (or types: "Read agents/<your file> and do it").
4. Agent A scaffolds the project in the first 30 minutes. B, C and D start right away on their standalone parts and merge when the scaffold arrives.

## Schedule (T = hours since start)
| T | Gate | What must be true |
|---|---|---|
| 0:30 | Scaffold | Everyone has the repo structure and stubs; D has pushed `src/shared/` |
| 2:00 | **Gate 1: day-zero spikes** | A: transparent overlay + capture + no feedback loop. B: flash detector passes unit tests. C: model runs on WebGPU or CPU, loads offline. D: settings window runs with mock store. If A or C is stuck, decide the fallback now (below) |
| 4:30 | **Integration 1** | On one laptop: a flashing clip dims, and a test image blurs, live |
| 7:00 | **Integration 2** | Custom triggers, profiles, response ladder, reveal hotkey |
| 8:30 | **Feature freeze** | Bug fixes, tuning and demo prep only |
| 10:30 | **Code freeze** | Rehearse, record backup video, finish slides |
| 11:30 | Buffer | Fix the unexpected, submit |

## Your job as a human (the agents cannot do these)
- **Run on your own laptop at every gate.** Overlay and capture behavior differs by operating system, so each person tests their own machine.
- **Merge PRs** at each milestone. Keep `main` always runnable and tag the last good build `demo-ok`.
- **Make decisions** when an agent reports a blocker. Keep this list short; do not let agents wander.
- **Before the demo:** download the models on the demo laptop, then turn Wi-Fi off and run the whole demo once.
- **Safety:** warn the room before any flashing content, keep clips small and short.

## Fallbacks (decide at Gate 1, not later)
- **Overlay or capture will not work on your OS:** switch to a **browser-extension version** that processes video and images inside the page (A pivots; B and C's modules are reused as they are). Demo that.
- **WebGPU not available:** C uses the CPU path at a lower check rate. Say so honestly in the pitch.
- **Model too weak on a trigger:** narrow the demo triggers to what works reliably (for example the custom-trigger moment with a clear stand-in image).

## How to talk to your agent
- Tell it the milestone you are on and what the other agents have merged.
- If it asks to change the contract, ask the other humans first.
- When it reports "blocked", read its note in `docs/STATUS.md` and decide; do not just say "keep trying".
- Ask it to append its numbers (milliseconds, checks per second, false alarms) to `docs/STATUS.md`. Those are your pitch numbers.
