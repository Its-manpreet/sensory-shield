// OWNER: Agent A. System output volume control for sound protection (macOS and Windows).
// The app cannot edit other apps' audio without a virtual audio device, so it turns the SYSTEM volume down
// for a moment and back up. A persistent helper takes "get" / "set N" lines on stdin and answers
// "vol N M" / "ok" lines: ~2 ms per change instead of ~130 ms for a fresh process each time.
//   macOS:   JavaScript for Automation (osascript, built in), answers on stderr
//   Windows: PowerShell + Core Audio (IAudioEndpointVolume, built in), answers on stdout
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

// Windows: default output device master volume via Core Audio COM. Device looked up per call, so switching
// headphones / speakers just works. Interface layouts are the documented vtable order (unused slots named _n).
const WIN_HELPER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int _1(); int _2(); int _3(); int _4();
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int _5();
  int GetMasterVolumeLevelScalar(out float level);
  int _6(); int _7(); int _8(); int _9();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, out IAudioEndpointVolume ep); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int _1(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
public static class ShieldVolume {
  static IAudioEndpointVolume Ep() {
    var en = new MMDeviceEnumerator() as IMMDeviceEnumerator;
    IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume ep;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out ep));
    return ep;
  }
  public static string Get() {
    var ep = Ep(); float v; bool m;
    ep.GetMasterVolumeLevelScalar(out v); ep.GetMute(out m);
    return "vol " + (int)Math.Round(v * 100) + " " + (m ? 1 : 0);
  }
  public static void Set(int n) { Ep().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, n)) / 100f, Guid.Empty); }
}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $line = $line.Trim()
  try {
    if ($line -eq 'get') { [Console]::Out.WriteLine([ShieldVolume]::Get()) }
    elseif ($line -match '^set (\\d+)$') { [ShieldVolume]::Set([int]$Matches[1]); [Console]::Out.WriteLine('ok') }
  } catch { [Console]::Out.WriteLine('err') }
  [Console]::Out.Flush()
}`;

/** start the platform helper; returns the process and the stream its answers arrive on, or null */
function startHelper() {
  if (process.platform === 'darwin') {
    const proc = spawn('osascript', ['-l', 'JavaScript', '-e', HELPER], { stdio: ['pipe', 'ignore', 'pipe'] });
    return { proc, answers: proc.stderr }; // JXA console.log writes to stderr
  }
  if (process.platform === 'win32') {
    const encoded = Buffer.from(WIN_HELPER, 'utf16le').toString('base64');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    const proc = spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    return { proc, answers: proc.stdout };
  }
  return null;
}

const POLL_MS = 500; // cheap with the persistent helper; notices the user's own volume changes quickly

export function createVolumeControl() {
  const helper = startHelper();
  if (!helper) {
    return { supported: false, applyGain() {}, restore() {}, stop() {}, get state() { return { supported: false }; } };
  }
  const { proc, answers } = helper;
  let base = null; // the user's own volume (0..100)
  let lastSet = null; // what we last set
  let gainDb = 0;
  let pendingSet = false;
  // The user changed the volume while we had it lowered (e.g. pressed volume-up during the quiet before a
  // soft start): respect their choice until the current dip is over, instead of pulling it down again.
  let userOverride = false;
  let out = '';
  answers.on('data', (d) => {
    out += d.toString();
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
  proc.on('error', (err) => console.warn(`[main] volume helper unavailable: ${err?.message ?? err}`));
  proc.stdin.on('error', () => {}); // helper gone (EPIPE): sound protection just stops changing the volume
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
