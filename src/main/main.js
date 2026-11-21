// OWNER: Agent A. Electron main process: overlay + settings windows, tray, hotkeys, IPC, capture permission.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, session, desktopCapturer, nativeImage, systemPreferences, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings } from './settings-file.js';
import { createVolumeControl } from './volume.js';

// System audio capture ("loopback") for sound protection. Windows supports it out of the box; on macOS
// Chromium has it behind these features (ScreenCaptureKit, macOS 13+). No extra install either way.
app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..');
const PRELOAD = path.join(here, 'preload.cjs');
const SELFTEST = process.env.SHIELD_SELFTEST === '1'; // `npm run selftest`: log renderer output, quit after a few seconds
const SPIKE = process.env.SHIELD_SPIKE === '1'; // `npm run spike`: feedback-loop check, see src/overlay/spike.js
const ALLOW_NETWORK = process.env.SHIELD_ALLOW_NETWORK === '1'; // dev only; the app must work with this OFF

export const HOTKEYS = { reveal: 'CommandOrControl+Alt+R', toggle: 'CommandOrControl+Alt+S', settings: 'CommandOrControl+Alt+,' };
const REVEAL_MS = 5000;

let settings;
let overlayWin = null;
let settingsWin = null;
let tray = null;
let lastStats = null;
let revealUntil = 0;
let volume = null; // created when the app is ready (macOS: system volume control)

/** reveal hotkey: show everything for REVEAL_MS; pressing it again while revealed ends the reveal early */
function toggleReveal() {
  const now = Date.now();
  const ms = now < revealUntil ? 0 : REVEAL_MS;
  revealUntil = now + ms;
  broadcast('shield:reveal', { ms });
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function forwardConsole(win, name) {
  win.webContents.on('console-message', (e) => console.log(`[${name}] ${e.message}`));
}

function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    // macOS: a non-activating panel can float above full-screen apps (YouTube in full screen, games, Keynote)
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setBounds(bounds); // macOS pushes new windows below the menu bar; the overlay must cover it too
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true); // clicks pass through to apps below
  overlayWin.setContentProtection(true); // keep the overlay out of our own capture (VERIFY per OS, see CLAUDE.md)
  forwardConsole(overlayWin, 'overlay');
  const query = {};
  if (SELFTEST) query.selftest = '1';
  if (SPIKE) query.spike = '1';
  if (process.env.SHIELD_DEBUG === '1') query.debug = '1';
  // macOS can re-place a panel once it is shown (seen: y=-32, 32 px taller). Re-assert the exact display
  // bounds after load and whenever displays change, or every effect lands off target.
  const fit = () => {
    const { bounds: b } = screen.getPrimaryDisplay();
    const cur = overlayWin.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
      overlayWin.setBounds(b);
      console.log(`[main] overlay refit ${JSON.stringify(cur)} -> ${JSON.stringify(overlayWin.getBounds())}`);
    }
  };
  overlayWin.webContents.on('did-finish-load', fit);
  overlayWin.on('move', fit);
  overlayWin.on('resize', fit);
  screen.on('display-metrics-changed', fit);
  setTimeout(fit, 1000);
  overlayWin.loadFile(path.join(SRC, 'overlay/index.html'), { query });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 460,
    height: 780,
    minWidth: 400,
    minHeight: 560,
    title: 'Sensory Shield',
    show: !SELFTEST,
    backgroundColor: '#f5f5f7',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' } : {}),
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
  });
  forwardConsole(settingsWin, 'settings');
  settingsWin.loadFile(path.join(SRC, 'settings/index.html'));
}

function setEnabled(enabled) {
  if (!enabled) volume?.restore();
  settings = { ...settings, enabled };
  saveSettings(settings);
  broadcast('shield:toggle', { enabled });
  broadcast('settings:changed', settings);
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const s = lastStats;
  tray.setToolTip(
    `Sensory Shield: ${settings.enabled ? 'on' : 'off'}` +
      (s ? `\n${s.fps.toFixed(0)} fps, flash ${s.flashMs.toFixed(2)} ms, model ${s.modelHz.toFixed(1)}/s` : ''),
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: settings.enabled ? 'Turn shield off' : 'Turn shield on', click: () => setEnabled(!settings.enabled) },
      { label: `Reveal for ${REVEAL_MS / 1000} s`, accelerator: HOTKEYS.reveal, click: toggleReveal },
      { label: 'Settings…', click: openSettings },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]),
  );
}

function createTray() {
  // 16x16 solid teal square generated in memory, so we ship no icon file. Agent D may replace with assets/icon.png.
  const px = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < px.length; i += 4) px.set([0xa0, 0x90, 0x20, 0xff], i); // BGRA
  tray = new Tray(nativeImage.createFromBitmap(px, { width: 16, height: 16 }));
  if (process.platform === 'darwin') tray.setTitle('Shield');
  tray.on('click', openSettings);
  refreshTray();
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    if (patch.enabled === false) volume?.restore();
    settings = { ...settings, ...patch };
    saveSettings(settings);
    broadcast('settings:changed', settings);
    refreshTray();
    return settings;
  });
  ipcMain.handle('shield:status', () => ({ screenAccess: screenAccess(), platform: process.platform, hotkeys: HOTKEYS }));
  ipcMain.on('shield:open-permission', () => {
    if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });
  ipcMain.on('shield:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });
  // sound protection: the overlay decides how far below the user's volume to go; main applies it
  ipcMain.on('audio:gain', (_e, { gainDb }) => {
    if (settings.enabled) volume?.applyGain(gainDb);
  });
  ipcMain.on('shield:stats', (_e, stats) => {
    lastStats = stats; // counts only, never pixels
    settingsWin?.isDestroyed() === false && settingsWin.webContents.send('shield:stats', stats);
    refreshTray();
  });
}

/** 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' ('granted' off macOS) */
function screenAccess() {
  return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
}

function lockDownNetwork() {
  if (ALLOW_NETWORK) return;
  // Privacy guarantee: renderers may only load local files. Model files must come from models/.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const blocked = /^(https?|wss?):/i.test(details.url);
    if (blocked) console.warn(`[main] blocked network request: ${details.url}`);
    cb({ cancel: blocked });
  });
}

function registerCaptureHandler() {
  // getDisplayMedia() in the overlay resolves to the primary screen without a picker.
  // Agent A: verify on each OS (macOS needs Screen Recording permission for the app / terminal).
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((s) => s.display_id === primaryId) ?? sources[0];
      if (!source) throw new Error('no screen sources (screen recording permission?)');
      // the overlay asks for audio too: the sound of whatever is playing, for sound protection
      const loopback = _req.audioRequested && (process.platform === 'darwin' || process.platform === 'win32');
      cb(loopback ? { video: source, audio: 'loopback' } : { video: source });
    } catch (err) {
      console.error(`[main] screen capture unavailable (screen access: ${screenAccess()}): ${err?.message ?? err}`);
      try {
        cb({}); // denies the request; getDisplayMedia rejects in the overlay
      } catch {}
    }
  });
}

app.whenReady().then(() => {
  settings = loadSettings();
  lockDownNetwork();
  registerCaptureHandler();
  volume = createVolumeControl();
  registerIpc();
  createOverlay();
  createTray();
  globalShortcut.register(HOTKEYS.reveal, toggleReveal);
  globalShortcut.register(HOTKEYS.toggle, () => setEnabled(!settings.enabled));
  globalShortcut.register(HOTKEYS.settings, openSettings);
  openSettings(); // the window is the app's face; closing it leaves the shield running in the tray
  if (SELFTEST) {
    setTimeout(() => app.quit(), SPIKE ? 9000 : Number(process.env.SHIELD_SELFTEST_MS) || 6000);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  volume?.stop(); // puts the user's own volume back
});
app.on('window-all-closed', () => {}); // keep running in the tray
