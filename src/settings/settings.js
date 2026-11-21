// OWNER: Agent D. SCAFFOLD placeholder: proves store + IPC round trip. D builds the real UI here.
import { getSettings, setSettings, onChange } from '../shared/store.js';

const $ = (id) => document.getElementById(id);

function render(s) {
  $('enabled').checked = s.enabled;
  $('profile').replaceChildren(
    ...Object.values(s.profiles).map((p) => new Option(p.name, p.id, false, p.id === s.activeProfileId)),
  );
  $('status').textContent = `Shield ${s.enabled ? 'on' : 'off'}, profile: ${s.profiles[s.activeProfileId]?.name}`;
}

$('enabled').addEventListener('change', (e) => setSettings({ enabled: e.target.checked }));
$('profile').addEventListener('change', (e) => setSettings({ activeProfileId: e.target.value }));
onChange(render);
window.shield?.onStats((st) => ($('status').dataset.stats = `${st.modelHz.toFixed(1)} checks/s`));

const s = await getSettings();
render(s);
console.log(`SELFTEST settings ok: ${Object.keys(s.profiles).length} profiles`);
