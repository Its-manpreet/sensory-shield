// OWNER: Agent A. STUB: contract in docs/INTERFACES.md section 3. Real version draws a blurred/dimmed COPY
// of the captured pixels over each region (canvas 2D ctx.filter), fades ~300 ms, adds a frosted label.

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLVideoElement} video
 */
export function createEffects(canvas, video) {
  void canvas, video;
  let labelsVisible = true;
  return {
    /** @param {import('../shared/types.js').Region[]} regions @param {number} nowMs */
    setRegions(regions, nowMs) {
      void regions, nowMs, labelsVisible;
    },
    /** @param {number} ms */
    revealAll(ms) {
      void ms;
    },
    /** @param {boolean} b */
    setLabelsVisible(b) {
      labelsVisible = b;
    },
  };
}
