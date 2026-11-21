// OWNER: Agent A. Electron main process: overlay + settings windows, tray, hotkeys, IPC, capture permission.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, session, desktopCapturer, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings } from './settings-file.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..');
const PRELOAD = path.join(here, 'preload.cjs');
const SELFTEST = process.env.SHIELD_SELFTEST === '1'; // `npm run selftest`: log renderer output, quit after a few seconds
const ALLOW_NETWORK = process.env.SHIELD_ALLOW_NETWORK === '1'; // dev only; the app must work with this OFF

export const HOTKEYS = { reveal: 'CommandOrControl+Alt+R', toggle: 'CommandOrControl+Alt+S', settings: 'CommandOrControl+Alt+,' };
const REVEAL_MS = 5000;

let settings;
let overlayWin = null;
let settingsWin = null;
let tray = null;
let lastStats = null;

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
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true); // clicks pass through to apps below
  overlayWin.setContentProtection(true); // keep the overlay out of our own capture (VERIFY per OS, see CLAUDE.md)
  forwardConsole(overlayWin, 'overlay');
  overlayWin.loadFile(path.join(SRC, 'overlay/index.html'), SELFTEST ? { query: { selftest: '1' } } : undefined);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 520,
    height: 720,
    title: 'Sensory Shield',
    show: !SELFTEST,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
  });
  forwardConsole(settingsWin, 'settings');
  settingsWin.loadFile(path.join(SRC, 'settings/index.html'));
}

function setEnabled(enabled) {
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
      { label: `Reveal for ${REVEAL_MS / 1000} s`, accelerator: HOTKEYS.reveal, click: () => broadcast('shield:reveal', { ms: REVEAL_MS }) },
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
  refreshTray();
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    broadcast('settings:changed', settings);
    refreshTray();
    return settings;
  });
  ipcMain.on('shield:stats', (_e, stats) => {
    lastStats = stats; // counts only, never pixels
    settingsWin?.isDestroyed() === false && settingsWin.webContents.send('shield:stats', stats);
    refreshTray();
  });
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
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const primaryId = String(screen.getPrimaryDisplay().id);
    cb({ video: sources.find((s) => s.display_id === primaryId) ?? sources[0] });
  });
}

app.whenReady().then(() => {
  settings = loadSettings();
  lockDownNetwork();
  registerCaptureHandler();
  registerIpc();
  createOverlay();
  createTray();
  globalShortcut.register(HOTKEYS.reveal, () => broadcast('shield:reveal', { ms: REVEAL_MS }));
  globalShortcut.register(HOTKEYS.toggle, () => setEnabled(!settings.enabled));
  globalShortcut.register(HOTKEYS.settings, openSettings);
  if (SELFTEST) {
    openSettings();
    setTimeout(() => app.quit(), 6000);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {}); // keep running in the tray
