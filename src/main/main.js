// OWNER: Agent A. Electron main process: overlay + settings windows, tray, hotkeys, IPC, capture permission.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, session, desktopCapturer, nativeImage, systemPreferences, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSettings, saveSettings } from './settings-file.js';
import { createVolumeControl } from './volume.js';
import { createOcr, ocrHelperPath } from './ocr.js';
import { createGuardian } from './guardian.js';

// System audio capture ("loopback") for sound protection. Windows supports it out of the box; on macOS
// Chromium has it behind these features (ScreenCaptureKit, macOS 13+). No extra install either way.
app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..');
const PRELOAD = path.join(here, 'preload.cjs');
const SELFTEST = process.env.SHIELD_SELFTEST === '1'; // `npm run selftest`: log renderer output, quit after a few seconds
const SPIKE = process.env.SHIELD_SPIKE === '1'; // `npm run spike`: feedback-loop check, see src/overlay/spike.js
const ALLOW_NETWORK = process.env.SHIELD_ALLOW_NETWORK === '1'; // dev only; the app must work with this OFF

export const HOTKEYS = { reveal: 'CommandOrControl+Alt+R', toggle: 'CommandOrControl+Alt+S', settings: 'CommandOrControl+Alt+,', help: 'CommandOrControl+Alt+H' };
const REVEAL_MS = 5000;

let settings;
let overlayWin = null;
let settingsWin = null;
let tray = null;
let lastStats = null;
let revealUntil = 0;
let volume = null; // created when the app is ready (macOS: system volume control)
let ocr = null; // on-device text recognition for explicit-text protection, started on first use
let guardian = null; // webcam Guardian (src/main/guardian.js): camera window, "Are you OK?" check, alerts
let ocrBoxes = null; // fast text detection (boxes only) so the picture model never judges written words

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
  // content models: resources/models in the packaged app, models/ in development (npm run content:setup)
  const models = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(SRC, '..', 'models');
  const query = { models: `${pathToFileURL(models).href}/` };
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
  overlayWin.webContents.on('did-finish-load', () => ((sendOwnWindows.last = null), sendOwnWindows()));
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
  // the overlay never analyses our own window (its labels say "sexual writing", "spiders"...)
  for (const ev of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore', 'move', 'resize', 'enter-full-screen', 'leave-full-screen']) settingsWin.on(ev, sendOwnWindows);
  settingsWin.on('closed', () => setImmediate(sendOwnWindows));
  settingsWin.loadFile(path.join(SRC, 'settings/index.html'));
}

/**
 * Tell the overlay where our settings window is (normalized to the captured primary display), while it is
 * in front. Only while focused: an unfocused window may be behind another app whose content must still be
 * checked. Rects only, no pixels.
 */
function sendOwnWindows() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const rects = [];
  const w = settingsWin;
  if (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused()) {
    const d = screen.getPrimaryDisplay().bounds, b = w.getBounds();
    const x0 = Math.max(d.x, b.x), y0 = Math.max(d.y, b.y), x1 = Math.min(d.x + d.width, b.x + b.width), y1 = Math.min(d.y + d.height, b.y + b.height);
    if (x1 > x0 && y1 > y0) rects.push({ x: (x0 - d.x) / d.width, y: (y0 - d.y) / d.height, w: (x1 - x0) / d.width, h: (y1 - y0) / d.height });
  }
  const key = JSON.stringify(rects);
  if (key === sendOwnWindows.last) return;
  sendOwnWindows.last = key;
  overlayWin.webContents.send('shield:own-windows', rects);
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
      ...(settings.guardian?.enabled ? [{ label: 'Send help alert now', accelerator: HOTKEYS.help, click: () => guardian?.sos() }] : []),
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
    if ('guardian' in patch) guardian?.sync();
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
  // explicit-text protection: grayscale screen pixels in, recognized lines out. Memory only; never logged.
  ipcMain.handle('ocr:recognize', async (_e, frame) => {
    if (!settings.enabled || !settings.safety?.enabled || !settings.safety?.sexualText) return { lines: [], ms: 0, available: true };
    ocr ??= createOcr(ocrHelperPath(SRC));
    if (!ocr.available) return { lines: [], ms: 0, available: false };
    return { ...(await ocr.recognize(frame)), available: true };
  });
  // picture protection: where is text in this area? Boxes only (the words are dropped here). Memory only.
  // A separate fast helper, so it never waits behind the accurate explicit-text reads.
  ipcMain.handle('ocr:boxes', async (_e, frame) => {
    if (!settings.enabled || !settings.safety?.enabled) return { boxes: [], available: true };
    ocrBoxes ??= createOcr(ocrHelperPath(SRC), { level: 'fast' });
    if (!ocrBoxes.available) return { boxes: [], available: false };
    const r = await ocrBoxes.recognize(frame);
    return { boxes: r.lines.map(({ x, y, w, h }) => ({ x, y, w, h })), available: true };
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
  // SHIELD_NO_VOLUME=1 (tests): decide everything, but never touch the real system volume
  volume = process.env.SHIELD_NO_VOLUME === '1' ? null : createVolumeControl();
  registerIpc();
  guardian = createGuardian({
    getSettings: () => settings,
    preload: PRELOAD,
    src: SRC,
    onChange: () => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('guardian:status', guardian.status());
      refreshTray();
    },
  });
  guardian.sync();
  createOverlay();
  createTray();
  globalShortcut.register(HOTKEYS.reveal, toggleReveal);
  globalShortcut.register(HOTKEYS.toggle, () => setEnabled(!settings.enabled));
  globalShortcut.register(HOTKEYS.settings, openSettings);
  globalShortcut.register(HOTKEYS.help, () => guardian?.sos());
  openSettings(); // the window is the app's face; closing it leaves the shield running in the tray
  if (SELFTEST) {
    setTimeout(() => app.quit(), SPIKE ? 9000 : Number(process.env.SHIELD_SELFTEST_MS) || 6000);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  volume?.stop(); // puts the user's own volume back
  ocr?.stop();
  ocrBoxes?.stop();
  guardian?.stop();
});
app.on('window-all-closed', () => {}); // keep running in the tray
