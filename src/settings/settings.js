// OWNER: Agent D. Settings window: flash protection settings and appearance, live status.
// (Profile picker and content blocklist are removed for now; see git tag vision-v1.)
// Every change is saved immediately and the overlay applies it without a restart.
import { getSettings, setSettings, onChange } from '../shared/store.js';

const $ = (id) => document.getElementById(id);
const shield = window.shield; // undefined when opened as a plain web page (mock store)

const HOTKEY_LABELS = { reveal: 'Reveal for 5 s', toggle: 'Shield on / off', settings: 'Open this window' };

/** @type {import('../shared/types.js').Settings} */
let settings;
let status = { screenAccess: 'granted', platform: 'web', hotkeys: {} };
let lastStats = null;

const profile = () => settings.profiles[settings.activeProfileId];

/** save a change to the active profile */
function patchProfile(section, values) {
  const p = profile();
  const next = { ...p, [section]: { ...p[section], ...values } };
  settings = { ...settings, profiles: { ...settings.profiles, [p.id]: next } };
  save({ profiles: settings.profiles });
}

let pending = null;
let timer = 0;
/** throttled save so sliders feel live without flooding IPC */
function save(patch) {
  pending = { ...pending, ...patch };
  if (timer) return;
  timer = setTimeout(async () => {
    const p = pending;
    pending = null;
    timer = 0;
    settings = await setSettings(p);
  }, 120);
}

function setSwitch(el, on) {
  el.setAttribute('aria-checked', String(on));
}

function setRadio(group, value) {
  for (const b of group.querySelectorAll('[role="radio"]')) {
    const on = b.dataset.value === value;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

/** arrow-key navigation inside a radiogroup, as screen-reader users expect */
function radioKeys(group, onPick) {
  group.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const items = [...group.querySelectorAll('[role="radio"]')];
    const i = items.indexOf(document.activeElement);
    const next = items[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length];
    next.focus();
    onPick(next.dataset.value);
    e.preventDefault();
  });
  group.addEventListener('click', (e) => {
    const b = e.target.closest('[role="radio"]');
    if (b) onPick(b.dataset.value);
  });
}

function renderHero() {
  const el = $('hero-state');
  const capture = lastStats?.capture;
  let text, tone;
  if (!settings.enabled) (text = 'Paused. Nothing is being softened.'), (tone = '');
  else if (status.screenAccess === 'denied' || capture === 'denied') (text = 'Waiting for screen access'), (tone = 'warn');
  else if (capture === 'ok') (text = 'On. Watching for flashing in every app.'), (tone = 'good');
  else (text = 'Starting…'), (tone = '');
  el.textContent = text;
  el.dataset.tone = tone;
  $('permission').hidden = !(status.platform === 'darwin' && (status.screenAccess !== 'granted' || capture === 'denied'));
}

function render() {
  const p = profile();
  const look = settings.appearance ?? { flashStyle: 'glass', smoothMs: 900 };
  setSwitch($('enabled'), settings.enabled);

  setSwitch($('flash-enabled'), p.flash.enabled);
  setRadio($('flash-style'), look.flashStyle);
  $('smooth').value = look.smoothMs;
  $('smooth-out').textContent = `${(look.smoothMs / 1000).toFixed(1)} s`;
  $('smooth-field').hidden = look.flashStyle !== 'glass';
  $('dim-field').hidden = look.flashStyle !== 'dim';
  $('dim').value = Math.round(p.response.dimLevel * 100);
  $('dim-out').textContent = `${Math.round(p.response.dimLevel * 100)}%`;
  $('red').checked = p.flash.detectRed;

  $('fade').value = p.response.fadeMs;
  $('fade-out').textContent = `${p.response.fadeMs} ms`;
  $('labels').checked = p.response.showLabel;
  renderHero();
}

function renderStats(st) {
  lastStats = st;
  $('stats').textContent = st.capture === 'ok' ? `${st.fps.toFixed(0)} fps · flash check ${st.flashMs.toFixed(2)} ms per frame` : '';
  renderHero();
}

// --- events ---
$('enabled').addEventListener('click', () => {
  settings = { ...settings, enabled: !settings.enabled };
  setSwitch($('enabled'), settings.enabled);
  renderHero();
  save({ enabled: settings.enabled });
});
$('flash-enabled').addEventListener('click', () => {
  patchProfile('flash', { enabled: !profile().flash.enabled });
  render();
});
radioKeys($('flash-style'), (flashStyle) => {
  settings = { ...settings, appearance: { ...settings.appearance, flashStyle } };
  render();
  save({ appearance: settings.appearance });
});
$('smooth').addEventListener('input', (e) => {
  settings = { ...settings, appearance: { ...settings.appearance, smoothMs: Number(e.target.value) } };
  $('smooth-out').textContent = `${(settings.appearance.smoothMs / 1000).toFixed(1)} s`;
  save({ appearance: settings.appearance });
});
$('dim').addEventListener('input', (e) => {
  patchProfile('response', { dimLevel: Number(e.target.value) / 100 });
  $('dim-out').textContent = `${e.target.value}%`;
});
$('red').addEventListener('change', (e) => patchProfile('flash', { detectRed: e.target.checked }));
$('fade').addEventListener('input', (e) => {
  patchProfile('response', { fadeMs: Number(e.target.value) });
  $('fade-out').textContent = `${e.target.value} ms`;
});
$('labels').addEventListener('change', (e) => patchProfile('response', { showLabel: e.target.checked }));
$('open-permission').addEventListener('click', () => shield?.openPermission());
$('relaunch').addEventListener('click', () => shield?.relaunch());

// --- start ---
settings = await getSettings();
if (shield) {
  status = await shield.getStatus();
  shield.onStats(renderStats);
  if (status.platform === 'darwin') document.documentElement.classList.add('vibrant');
  $('perm-app').textContent = 'Terminal (or the app you started Sensory Shield from)';
}
onChange((s) => {
  if (pending) return; // our own echo while a save is in flight
  settings = s;
  render();
});
$('keys').replaceChildren(
  ...Object.entries(status.hotkeys ?? {}).flatMap(([k, accel]) => {
    const dt = document.createElement('dt');
    dt.textContent = accel.replace('CommandOrControl', status.platform === 'darwin' ? '⌘' : 'Ctrl').replace('Alt', status.platform === 'darwin' ? '⌥' : 'Alt').replaceAll('+', ' ');
    const dd = document.createElement('dd');
    dd.textContent = HOTKEY_LABELS[k] ?? k;
    return [dt, dd];
  }),
);
render();
console.log(`SELFTEST settings ok: ${Object.keys(settings.profiles).length} profiles`);
