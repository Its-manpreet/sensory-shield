// OWNER: Agent A. Gate 1 feedback-loop check (run with `npm run spike`):
// shows a magenta box in the overlay, then reads the captured frame at that spot.
// PASS = the capture does NOT contain the overlay's own pixels.
export async function runSpike(video, _canvas, log) {
  if (!video.videoWidth) return log('SPIKE feedback-loop: SKIPPED, no capture (grant Screen Recording permission)');
  const box = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', left: '40vw', top: '40vh', width: '20vw', height: '20vh', background: '#ff00ff', zIndex: 10 });
  document.body.append(box);
  await new Promise((r) => setTimeout(r, 1500));
  const c = new OffscreenCanvas(video.videoWidth, video.videoHeight);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0);
  const d = ctx.getImageData(Math.round(video.videoWidth / 2), Math.round(video.videoHeight / 2), 1, 1).data;
  const magenta = d[0] > 200 && d[1] < 60 && d[2] > 200;
  log(`SPIKE feedback-loop: captured center pixel rgb(${d[0]},${d[1]},${d[2]}) -> ${magenta ? 'FAIL overlay is visible in capture' : 'PASS overlay excluded from capture'}`);
  box.remove();
}
