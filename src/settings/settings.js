// OWNER: Agent D. Settings window: one independent switch per sensory trigger, the look, live status.
// Child safety card: categories, phobias, own words, sensitivity (settings.safety).
// Every change is saved immediately and the overlay applies it without a restart.
import { getSettings, setSettings, onChange } from '../shared/store.js';
import { PHOBIAS } from '../engine/categories.js';

const $ = (id) => document.getElementById(id);
const shield = window.shield; // undefined when opened as a plain web page (mock store)

/**
 * Every trigger the shield can soften, each with its own switch. `get`/`set` read and write where the value
 * lives: the active profile (frozen contract fields) or settings.sensory (everything newer).
 */
const TRIGGERS = [
  { id: 'flash', name: 'Flashing', hint: 'Bright flashes three or more times a second.', get: () => profile().flash.enabled, set: (on) => patchProfile('flash', { enabled: on }) },
  { id: 'red', name: 'Red flashes', hint: 'Saturated red flashing, which is more provocative.', get: () => profile().flash.detectRed, set: (on) => patchProfile('flash', { detectRed: on }) },
  { id: 'colorFlicker', name: 'Red / blue colour flicker', hint: 'Colours swapping fast, even without a brightness change.', sensory: true },
  { id: 'loudLimiter', group: 'Sound', name: 'Sudden loud sounds', hint: 'Jump scares, shouting, alarms: the volume dips at once, then comes back.', sensory: true },
  { id: 'loudLeveling', group: 'Sound', name: 'Even out loudness', hint: 'Loud videos and ads are brought down to the same comfortable level as the rest.', sensory: true },
  { id: 'harshTones', group: 'Sound', name: 'Sharp high pitches', hint: 'Whistles, feedback squeals, alarm beeps: the volume dips while the tone lasts.', sensory: true },
  { id: 'softStart', group: 'Sound', name: 'Sound that starts by itself', hint: 'Autoplay after silence fades in instead of blaring.', sensory: true },
];
const isOn = (t) => (t.sensory ? !!settings.sensory?.[t.id] : t.get());
function setTrigger(t, on) {
  if (t.sensory) {
    settings = { ...settings, sensory: { ...settings.sensory, [t.id]: on } };
    save({ sensory: settings.sensory });
  } else t.set(on);
}

function buildTriggers() {
  let group = 'Sight';
  $('triggers').replaceChildren(
    ...TRIGGERS.flatMap((t) => {
      const head = [];
      if ((t.group ?? 'Sight') !== group) {
        group = t.group;
        const h = document.createElement('h3');
        h.className = 'group-head';
        h.textContent = group;
        head.push(h);
      }
      const row = document.createElement('div');
      row.className = 'row-switch';
      row.innerHTML = `<div><span class="label" id="t-${t.id}-label"></span><p class="hint"></p></div>
        <button class="switch" role="switch" aria-checked="false" aria-labelledby="t-${t.id}-label" id="t-${t.id}"><span></span></button>`;
      row.querySelector('.label').textContent = t.name;
      row.querySelector('.hint').textContent = t.hint;
      row.querySelector('button').addEventListener('click', () => {
        setTrigger(t, !isOn(t));
        render();
      });
      return [...head, row];
    }),
  );
}
// --- child safety ---
const SAFETY_CATS = [
  { id: 'nudity', name: 'Adult images', hint: 'Photos and drawings meant for adults only.' },
  { id: 'sexualText', name: 'Adult writing', hint: 'Adult-only stories and messages. Judged by meaning, so forms and school lessons stay readable.' },
  { id: 'gore', name: 'Gore and graphic injury', hint: 'Blood, wounds, dead bodies.' },
  { id: 'violence', name: 'Weapons and violence', hint: 'Guns, knives, fighting.' },
];
const safety = () => settings.safety ?? { enabled: false, phobias: [], custom: [], sensitivity: 0.5 };
function patchSafety(values) {
  settings = { ...settings, safety: { ...safety(), ...values } };
  save({ safety: settings.safety });
  renderSafety();
}

function buildSafety() {
  $('safety-cats').replaceChildren(
    ...SAFETY_CATS.map((c) => {
      const row = document.createElement('div');
      row.className = 'row-switch';
      row.innerHTML = `<div><span class="label" id="s-${c.id}-label"></span><p class="hint"></p></div>
        <button class="switch" role="switch" aria-checked="false" aria-labelledby="s-${c.id}-label" id="s-${c.id}"><span></span></button>`;
      row.querySelector('.label').textContent = c.name;
      row.querySelector('.hint').textContent = c.hint;
      row.querySelector('button').addEventListener('click', () => patchSafety({ [c.id]: !safety()[c.id] }));
      return row;
    }),
  );
  $('phobias').replaceChildren(
    ...Object.entries(PHOBIAS).map(([id, p]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = id;
      b.textContent = p.label;
      b.addEventListener('click', () => {
        const cur = safety().phobias ?? [];
        patchSafety({ phobias: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
      });
      return b;
    }),
  );
}

function renderSafety() {
  const s = safety();
  setSwitch($('safety-enabled'), !!s.enabled);
  $('safety-body').hidden = !s.enabled;
  for (const c of SAFETY_CATS) setSwitch($(`s-${c.id}`), !!s[c.id]);
  for (const b of $('phobias').querySelectorAll('button')) b.setAttribute('aria-pressed', String((s.phobias ?? []).includes(b.dataset.id)));
  $('custom-chips').replaceChildren(
    ...(s.custom ?? []).map((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${w}`);
      x.addEventListener('click', () => patchSafety({ custom: s.custom.filter((c) => c !== w) }));
      li.append(x);
      return li;
    }),
  );
  $('sensitivity').value = Math.round((s.sensitivity ?? 0.5) * 100);
  $('sens-out').textContent = `${Math.round((s.sensitivity ?? 0.5) * 100)}%`;
}

const HOTKEY_LABELS = { reveal: 'Reveal for 5 s', toggle: 'Shield on / off', settings: 'Open this window', help: 'Send a help alert (Guardian)' };

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
  else if (capture === 'ok') (text = 'On. Watching your screen in every app.'), (tone = 'good');
  else (text = 'Starting…'), (tone = '');
  el.textContent = text;
  el.dataset.tone = tone;
  $('permission').hidden = !(status.platform === 'darwin' && (status.screenAccess !== 'granted' || capture === 'denied'));
}

function render() {
  const p = profile();
  const look = settings.appearance ?? { flashStyle: 'glass', smoothMs: 900 };
  setSwitch($('enabled'), settings.enabled);

  for (const t of TRIGGERS) setSwitch($(`t-${t.id}`), isOn(t));
  setRadio($('flash-style'), look.flashStyle);
  $('smooth').value = look.smoothMs;
  $('smooth-out').textContent = `${(look.smoothMs / 1000).toFixed(1)} s`;
  $('smooth-field').hidden = look.flashStyle !== 'glass';
  $('dim-field').hidden = look.flashStyle !== 'dim';
  $('dim').value = Math.round(p.response.dimLevel * 100);
  $('dim-out').textContent = `${Math.round(p.response.dimLevel * 100)}%`;

  $('fade').value = p.response.fadeMs;
  $('fade-out').textContent = `${p.response.fadeMs} ms`;
  $('labels').checked = p.response.showLabel;
  renderSafety();
  renderGuardian();
  renderHero();
}

function renderStats(st) {
  lastStats = st;
  const sound = st.sound === 'on' ? (st.soundCutDb < -0.5 ? ` · sound turned down ${Math.round(-st.soundCutDb)} dB` : ' · listening') : st.sound === 'unavailable' ? ' · sound not available here' : '';
  $('stats').textContent = st.capture === 'ok' ? `${st.fps.toFixed(0)} fps · all checks ${(st.engineMs ?? st.flashMs).toFixed(2)} ms per frame${sound}` : '';
  const dev = { webgpu: 'graphics chip', wasm: 'processor' }[st.device];
  $('safety-status').textContent = !safety().enabled
    ? ''
    : st.device === 'failed'
      ? 'The on-device models could not start. Run npm run content:setup.'
      : dev
        ? `Running on the ${dev}.${st.modelHz > 0 ? ` Pictures: ${Math.round(st.modelMs)} ms per check, first blur after ${Math.round(st.firstMs)} ms.` : ''}${st.textHz > 0 ? ` Text: ${Math.round(st.textMs)} ms per check.` : ''}`
        : 'Loading on-device models…';
  renderHero();
}

// --- events ---
$('enabled').addEventListener('click', () => {
  settings = { ...settings, enabled: !settings.enabled };
  setSwitch($('enabled'), settings.enabled);
  renderHero();
  save({ enabled: settings.enabled });
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
$('fade').addEventListener('input', (e) => {
  patchProfile('response', { fadeMs: Number(e.target.value) });
  $('fade-out').textContent = `${e.target.value} ms`;
});
$('labels').addEventListener('change', (e) => patchProfile('response', { showLabel: e.target.checked }));
$('safety-enabled').addEventListener('click', () => patchSafety({ enabled: !safety().enabled }));
$('custom-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const w = $('custom-input').value.trim().toLowerCase();
  const cur = safety().custom ?? [];
  if (w && !cur.includes(w)) patchSafety({ custom: [...cur, w] });
  $('custom-input').value = '';
});
$('sensitivity').addEventListener('input', (e) => {
  settings = { ...settings, safety: { ...safety(), sensitivity: Number(e.target.value) / 100 } };
  $('sens-out').textContent = `${e.target.value}%`;
  save({ safety: settings.safety });
});
$('open-permission').addEventListener('click', () => shield?.openPermission());
$('relaunch').addEventListener('click', () => shield?.relaunch());

// --- Guardian (camera) ---
const guardian = () => settings.guardian ?? { enabled: false, userName: '', contacts: [], minDurationSec: 10, countdownSec: 30 };
let guardianStatus = null;
function patchGuardian(values) {
  settings = { ...settings, guardian: { ...guardian(), ...values } };
  save({ guardian: settings.guardian });
  renderGuardian();
}
function renderGuardian() {
  const g = guardian();
  setSwitch($('guardian-enabled'), !!g.enabled);
  $('guardian-body').hidden = !g.enabled;
  if (document.activeElement !== $('g-name')) $('g-name').value = g.userName ?? '';
  $('g-duration').value = g.minDurationSec;
  $('g-duration-out').textContent = `${g.minDurationSec} s`;
  $('g-countdown').value = g.countdownSec;
  $('g-countdown-out').textContent = `${g.countdownSec} s`;
  $('g-contacts').replaceChildren(
    ...(g.contacts ?? []).map((c) => {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      const name = document.createElement('span');
      name.textContent = c.name;
      const code = document.createElement('code');
      code.textContent = c.topic;
      code.title = 'Subscribe to this in the ntfy app';
      who.append(name, code);
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${c.name}`);
      x.addEventListener('click', () => patchGuardian({ contacts: g.contacts.filter((k) => k.topic !== c.topic) }));
      li.append(who, x);
      return li;
    }),
  );
  renderGuardianStatus();
}
function renderGuardianStatus() {
  const g = guardian();
  const st = guardianStatus;
  const el = $('guardian-status');
  if (!g.enabled || !st) return void (el.textContent = '');
  let text, tone;
  if (st.camera === 'denied') (text = 'Camera access is off. Allow it in System Settings > Privacy > Camera.'), (tone = 'warn');
  else if (st.camera === 'unavailable') (text = 'No camera found.'), (tone = 'warn');
  else if (st.camera !== 'ok') (text = 'Starting the camera…'), (tone = '');
  else if (st.dark) (text = 'Too dark for the camera to see you.'), (tone = 'warn');
  else if (st.phase === 'check') (text = 'Asking "Are you OK?"'), (tone = 'warn');
  else if (st.phase === 'sent') (text = 'Help alert sent.'), (tone = 'warn');
  else if (st.level === 'warming') (text = 'Camera on, getting ready…'), (tone = '');
  else if (st.level === 'rhythmic') (text = `Watching: rhythmic movement (${Math.round(st.progress * 100)}%)`), (tone = 'warn');
  else (text = 'Watching. Video stays on this device.'), (tone = 'good');
  if (!g.contacts?.length) (text += ' Add a contact so alerts reach someone.'), (tone = tone || 'warn');
  // live readout for tuning (as in shake_proxy_detector.py): motion energy, rhythm 0..1, rate
  if (st.camera === 'ok' && st.level !== 'warming' && st.motion != null) text += ` (motion ${st.motion.toFixed(1)} · rhythm ${st.rhythm.toFixed(2)}${st.freqHz ? ` · ${st.freqHz.toFixed(1)} Hz` : ''})`;
  el.textContent = text;
  el.dataset.tone = tone;
}
$('guardian-enabled').addEventListener('click', () => patchGuardian({ enabled: !guardian().enabled }));
$('g-name').addEventListener('input', (e) => {
  settings = { ...settings, guardian: { ...guardian(), userName: e.target.value.trim() } };
  save({ guardian: settings.guardian });
});
$('g-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('g-contact-name').value.trim();
  if (!name) return;
  const topic = shield ? await shield.guardianNewTopic() : `shield-demo${Math.random().toString(36).slice(2, 12)}`;
  patchGuardian({ contacts: [...(guardian().contacts ?? []), { name, topic }] });
  $('g-contact-name').value = '';
});
$('g-duration').addEventListener('input', (e) => patchGuardian({ minDurationSec: Number(e.target.value) }));
$('g-countdown').addEventListener('input', (e) => patchGuardian({ countdownSec: Number(e.target.value) }));
$('g-test').addEventListener('click', async () => {
  if (!shield) return;
  $('g-test-out').textContent = 'Sending…';
  if (timer) await new Promise((r) => setTimeout(r, 200)); // let a pending save land first
  const res = await shield.guardianTest();
  $('g-test-out').textContent = res.map((r) => (r.ok ? `Sent to ${r.name}.` : `${r.name}: not sent (${r.error}).`)).join(' ');
});
$('g-preview').addEventListener('click', () => shield?.guardianPreview());

// --- start ---
settings = await getSettings();
if (shield) {
  status = await shield.getStatus();
  shield.onStats(renderStats);
  shield.onGuardianStatus((st) => {
    guardianStatus = st;
    renderGuardianStatus();
  });
  guardianStatus = await shield.guardianStatus();
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
buildTriggers();
buildSafety();
render();
console.log(`SELFTEST settings ok: ${Object.keys(settings.profiles).length} profiles`);
