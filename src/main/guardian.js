// Guardian controller (main process): camera window, the "Are you OK?" check, alerts to trusted contacts.
//
// Ladder: camera detector says 'suspect' -> check window (big "I'm OK" button, soft chime, countdown)
//      -> no answer by the deadline -> text alert to every contact (retried while it fails) + louder local alarm
//      -> "I'm OK now" sends an all-clear. A help hotkey starts a 5 s check straight away.
// Only a deliberate click on the button counts as an answer: during a convulsive seizure hands can hit keys
// or move the mouse, so keyboard / mouse activity is NOT taken as "they are fine".
// The event log keeps times and reasons only (userData/guardian-events.json). Never frames.
import { BrowserWindow, ipcMain, systemPreferences, app, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { sendAlert, newTopic } from './alert.js';

const RETRY_MS = 30_000;
const MAX_RETRIES = 10;
const COOLDOWN_MS = 60_000; // after "I'm OK", don't ask again straight away
const SOS_COUNTDOWN_S = 5;

/**
 * @param {{ getSettings: () => any, preload: string, src: string, onChange?: () => void }} o
 */
export function createGuardian({ getSettings, preload, src, onChange = () => {} }) {
  let camWin = null;
  let checkWin = null;
  /** camera status from the guardian window */
  let cam = { camera: 'off', level: 'normal', progress: 0, dark: false };
  /** @type {{ phase: 'idle'|'check'|'sent'|'cleared', reason?: string, deadline?: number, results?: any[], sentAt?: number }} */
  let ladder = { phase: 'idle' };
  let timer = 0;
  let retryTimer = 0;
  let retries = 0;
  let cooldownUntil = 0;

  const g = () => getSettings().guardian ?? {};
  const contacts = () => (g().contacts ?? []).filter((c) => c.topic);
  const who = () => (g().userName || '').trim() || 'The person using this computer';
  const clock = (t = Date.now()) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function log(event, extra = {}) {
    const file = path.join(app.getPath('userData'), 'guardian-events.json');
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    list.push({ t: new Date().toISOString(), event, ...extra });
    try {
      fs.writeFileSync(file, JSON.stringify(list.slice(-200), null, 2));
    } catch {}
    console.log(`[guardian] ${event} ${JSON.stringify(extra)}`);
  }

  // ---- camera window ----
  async function startCamera() {
    if (camWin) return;
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
      const ok = await systemPreferences.askForMediaAccess('camera');
      if (!ok) {
        cam = { ...cam, camera: 'denied' };
        onChange();
        return;
      }
    }
    if (!g().enabled || camWin) return;
    camWin = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: { preload, sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    camWin.webContents.on('console-message', (e) => console.log(`[guardian-cam] ${e.message}`));
    camWin.on('closed', () => {
      camWin = null;
      cam = { camera: 'off', level: 'normal', progress: 0, dark: false };
      onChange();
    });
    camWin.loadFile(path.join(src, 'guardian/camera.html'));
  }

  function stopCamera() {
    camWin?.destroy();
    camWin = null;
  }

  function sync() {
    if (g().enabled) startCamera();
    else stopCamera();
    if (camWin) camWin.webContents.send('guardian:config', { minDurationSec: g().minDurationSec ?? 10 });
  }

  // ---- check window ----
  function showCheck() {
    if (!checkWin) {
      const { workArea } = screen.getPrimaryDisplay();
      const w = 520;
      const h = 460;
      checkWin = new BrowserWindow({
        x: Math.round(workArea.x + (workArea.width - w) / 2),
        y: Math.round(workArea.y + (workArea.height - h) / 3),
        width: w,
        height: h,
        resizable: false,
        minimizable: false,
        closable: false, // answered with the button, not dismissed by accident
        alwaysOnTop: true,
        frame: false,
        skipTaskbar: true,
        backgroundColor: '#1c2b29',
        webPreferences: { preload, sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
      });
      checkWin.setAlwaysOnTop(true, 'screen-saver', 1);
      checkWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      checkWin.webContents.on('console-message', (e) => console.log(`[guardian-check] ${e.message}`));
      checkWin.webContents.on('did-finish-load', pushLadder);
      checkWin.loadFile(path.join(src, 'guardian/check.html'));
    }
    checkWin.show();
    checkWin.focus();
    pushLadder();
  }

  function closeCheck() {
    if (!checkWin) return;
    checkWin.setClosable(true);
    checkWin.destroy();
    checkWin = null;
  }

  function pushLadder() {
    checkWin?.webContents.send('guardian:ladder', { ...ladder, contacts: contacts().map((c) => c.name || 'contact'), now: Date.now() });
    onChange();
  }

  // ---- ladder ----
  function startCheck(reason, seconds) {
    if (ladder.phase === 'check' || ladder.phase === 'sent') return;
    clearTimeout(timer);
    ladder = { phase: 'check', reason, deadline: Date.now() + seconds * 1000 };
    log('check', { reason });
    timer = setTimeout(alertNow, seconds * 1000);
    showCheck();
  }

  async function alertNow() {
    clearTimeout(timer);
    const reason = ladder.reason;
    ladder = { ...ladder, phase: 'sent', sentAt: Date.now(), results: null };
    pushLadder();
    if (reason === 'preview') {
      // "Try the check" in Settings: show what would happen, send nothing
      ladder = { ...ladder, results: [], preview: true };
      pushLadder();
      return;
    }
    const message =
      reason === 'manual'
        ? `${who()} pressed the help hotkey at ${clock()}. Please check on them now.`
        : `Sensory Shield noticed strong rhythmic movement (a possible seizure) at ${clock()} and ${who()} did not answer an "Are you OK?" check. Please check on them now.`;
    retries = 0;
    const attempt = async () => {
      const pending = contacts().filter((c) => !(ladder.results ?? []).some((r) => r.ok && r.name === (c.name || c.topic)));
      const res = await sendAlert({ ...g(), contacts: pending }, { title: 'Sensory Shield: please check on them', message, urgent: true });
      if (ladder.phase !== 'sent') return;
      const prev = (ladder.results ?? []).filter((r) => r.ok);
      ladder = { ...ladder, results: [...prev, ...res] };
      log('alert', { reason, results: res.map((r) => `${r.name}:${r.ok ? 'sent' : r.error}`) });
      pushLadder();
      if (res.some((r) => !r.ok) && retries++ < MAX_RETRIES) retryTimer = setTimeout(attempt, RETRY_MS);
    };
    if (!contacts().length) {
      ladder = { ...ladder, results: [] };
      log('alert', { reason, results: ['no contacts'] });
      pushLadder();
      return;
    }
    await attempt();
  }

  async function answerOk() {
    if (ladder.phase !== 'check' && ladder.phase !== 'sent') return;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    const wasSent = ladder.phase === 'sent' && (ladder.results ?? []).some((r) => r.ok);
    log(wasSent ? 'all-clear' : 'cancelled', { reason: ladder.reason });
    cooldownUntil = Date.now() + COOLDOWN_MS;
    camWin?.webContents.send('guardian:reset');
    if (wasSent) {
      ladder = { phase: 'cleared' };
      pushLadder();
      await sendAlert(g(), { title: 'Sensory Shield: all clear', message: `${who()} answered at ${clock()}: "I'm OK now."` });
      setTimeout(() => {
        if (ladder.phase === 'cleared') {
          ladder = { phase: 'idle' };
          closeCheck();
          onChange();
        }
      }, 2500);
    } else {
      ladder = { phase: 'idle' };
      closeCheck();
      onChange();
    }
  }

  // ---- IPC ----
  ipcMain.on('guardian:state', (_e, s) => {
    cam = s; // counts and levels only, never pixels
    if (s.level === 'suspect' && ladder.phase === 'idle' && Date.now() > cooldownUntil && g().enabled) {
      startCheck('movement', g().countdownSec ?? 30);
    }
    onChange();
  });
  ipcMain.on('guardian:ok', answerOk);
  ipcMain.handle('guardian:status', () => status());
  ipcMain.handle('guardian:new-topic', () => newTopic());
  ipcMain.handle('guardian:test', async () => {
    if (!contacts().length) return [{ name: 'nobody', ok: false, error: 'add a contact first' }];
    const res = await sendAlert(g(), { title: 'Sensory Shield: test alert', message: `Test from ${who()}'s Sensory Shield. If you got this, alerts reach you. Nothing is wrong.` });
    log('test', { results: res.map((r) => `${r.name}:${r.ok ? 'sent' : r.error}`) });
    return res;
  });
  ipcMain.on('guardian:check-preview', () => startCheck('preview', g().countdownSec ?? 30));

  function status() {
    return { enabled: !!g().enabled, ...cam, phase: ladder.phase, contacts: contacts().length };
  }

  return {
    sync,
    status,
    /** help hotkey / tray item */
    sos() {
      if (!g().enabled) return false;
      startCheck('manual', SOS_COUNTDOWN_S);
      return true;
    },
    stop() {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      stopCamera();
      closeCheck();
    },
  };
}
