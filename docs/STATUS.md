# Status log (append only, newest at the bottom)

A @ T+0:30 (scaffold): works: `npm install`, `npm test` (3 contract tests), `npm start` (transparent click-through overlay + tray + hotkeys + settings IPC with stubs), `npm run selftest` (both renderers load, Transformers.js 4.3.2 imports) on macOS | broken: nothing known; screen capture loop, effects, content-protection check are NOT done yet (Step 1) | need from others: D take over `src/shared/` (placeholders are in), B and C replace the stubs in `src/engine/`, keep `test/overlay-contract.test.js` passing.
