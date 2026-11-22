// Cross-platform launcher for the npm scripts (macOS, Windows, Linux). Sets the env flags the main process
// reads and starts Electron on this repo. `VAR=1 electron .` and `open -a` only work in POSIX shells / macOS.
//   node scripts/run.js [--selftest] [--spike] [--debug] [--detach]
//   --detach  start as its own app, not tied to this terminal. macOS then asks for Screen Recording
//             permission for Electron itself instead of the terminal.
//   --debug   SHIELD_DEBUG=1, output to logs/debug.log
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron'); // path to the Electron binary for this OS
const args = new Set(process.argv.slice(2));

const env = { ...process.env };
if (args.has('--selftest')) env.SHIELD_SELFTEST = '1';
if (args.has('--spike')) env.SHIELD_SPIKE = '1';
if (args.has('--debug')) env.SHIELD_DEBUG = '1';
delete env.ELECTRON_RUN_AS_NODE; // set by some editors' terminals; Electron would start as plain Node

let stdio = 'inherit';
if (args.has('--debug')) {
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const log = fs.openSync(path.join(ROOT, 'logs', 'debug.log'), 'a');
  stdio = ['ignore', log, log];
  console.log(`debug output -> ${path.join('logs', 'debug.log')}`);
}

if (args.has('--detach')) {
  if (process.platform === 'darwin') {
    // `open -n -a Electron.app` makes Electron its own app for macOS privacy permissions
    const appBundle = path.resolve(electron, '..', '..', '..'); // .../Electron.app/Contents/MacOS/Electron
    const openArgs = ['-n', '-a', appBundle];
    if (args.has('--debug')) {
      const log = path.join(ROOT, 'logs', 'debug.log');
      openArgs.push('--env', 'SHIELD_DEBUG=1', '--stdout', log, '--stderr', log);
    }
    spawn('open', [...openArgs, '--args', ROOT], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0));
  } else {
    spawn(electron, [ROOT], { env, stdio: stdio === 'inherit' ? 'ignore' : stdio, detached: true, windowsHide: false }).unref();
  }
} else {
  const child = spawn(electron, [ROOT], { env, stdio, windowsHide: false });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}
