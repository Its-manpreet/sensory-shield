// OWNER: Agent A. System output volume control for sound protection (macOS).
// The app cannot edit other apps' audio without a virtual audio device, so it turns the SYSTEM volume down
// for a moment and back up. A persistent JavaScript-for-Automation helper (osascript, built into macOS)
// takes "get" / "set N" lines on stdin: ~2 ms per change instead of ~130 ms for a fresh osascript.
// The user's own volume is the baseline: if they change it, that becomes the new baseline. On quit or when
// protection is switched off, the baseline is restored.
import { spawn } from 'node:child_process';

const HELPER = `
ObjC.import('Foundation');
const app = Application.currentApplication();
app.includeStandardAdditions = true;
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
let buf = '';
for (;;) {
  const data = stdin.availableData;
  if (Number(data.length) === 0) break; // JXA gives length as a STRING: '=== 0' never matched, so an orphaned helper spun at 100% CPU
  buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'get') { const s = app.getVolumeSettings(); console.log('vol ' + s.outputVolume + ' ' + (s.outputMuted ? 1 : 0)); }
    else if (/^set \\d+$/.test(line)) { app.setVolume(null, { outputVolume: Number(line.slice(4)) }); console.log('ok'); }
  }
}`;

const POLL_MS = 500; // cheap with the persistent helper; notices the user's own volume changes quickly

export function createVolumeControl() {
  if (process.platform !== 'darwin') {
    return { supported: false, applyGain() {}, restore() {}, stop() {}, get state() { return { supported: false }; } };
  }
  const proc = spawn('osascript', ['-l', 'JavaScript', '-e', HELPER], { stdio: ['pipe', 'ignore', 'pipe'] });
  let base = null; // the user's own volume (0..100)
  let lastSet = null; // what we last set
  let gainDb = 0;
  let pendingSet = false;
  // The user changed the volume while we had it lowered (e.g. pressed volume-up during the quiet before a
  // soft start): respect their choice until the current dip is over, instead of pulling it down again.
  let userOverride = false;
  let out = '';
  proc.stderr.on('data', (d) => {
    out += d.toString(); // JXA console.log writes to stderr
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i).trim();
      out = out.slice(i + 1);
      const m = line.match(/^vol (\d+)/);
      if (m) {
        const v = Number(m[1]);
        // a volume we did not set means the user changed it: that is the new baseline
        if (base === null || (!pendingSet && Math.abs(v - lastSet) > 1)) {
          if (base !== null && gainDb < 0) userOverride = true;
          base = v;
          lastSet = v;
        }
      } else if (line === 'ok') pendingSet = false;
    }
  });
  proc.on('error', () => {});
  const send = (cmd) => proc.stdin.writable && proc.stdin.write(cmd + '\n');
  send('get');
  const poll = setInterval(() => send('get'), POLL_MS);

  function apply() {
    if (base === null || userOverride) return;
    const target = Math.max(0, Math.min(100, Math.round(base * 10 ** (gainDb / 20))));
    if (target === lastSet) return;
    lastSet = target;
    pendingSet = true;
    send(`set ${target}`);
  }

  return {
    supported: true,
    /** @param {number} db  <= 0: how far below the user's volume to go right now */
    applyGain(db) {
      gainDb = Math.min(0, db);
      if (gainDb === 0) userOverride = false; // the dip is over: back to normal protection
      apply();
    },
    /** back to the user's own volume */
    restore() {
      gainDb = 0;
      userOverride = false;
      apply();
    },
    stop() {
      clearInterval(poll);
      if (base !== null && lastSet !== base) send(`set ${base}`);
      setTimeout(() => proc.kill(), 50); // the helper does not exit on its own
    },
    get state() {
      return { supported: true, base, current: lastSet, gainDb };
    },
  };
}
