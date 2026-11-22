// "Are you OK?" window. Main owns the timer and the alert; this page only shows the state and the button.
const shield = window.shield;
const $ = (id) => document.getElementById(id);
let ladder = { phase: 'idle' };
let skew = 0; // main clock - page clock

// ---- sound: a soft two-note chime during the check, a steady alarm once an alert is out ----
let audio = null;
function tone(freq, start, dur, gain) {
  audio ??= new AudioContext();
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  const t = audio.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}
let beat = 0;
setInterval(() => {
  beat++;
  if (ladder.phase === 'check' && beat % 2 === 0) {
    tone(660, 0, 0.5, 0.12);
    tone(880, 0.25, 0.6, 0.12);
  } else if (ladder.phase === 'sent' && !ladder.preview) {
    tone(880, 0, 0.35, 0.35);
    tone(880, 0.45, 0.35, 0.35);
  }
}, 1000);

function render() {
  const left = Math.max(0, Math.ceil((ladder.deadline - (Date.now() + skew)) / 1000));
  const names = ladder.contacts?.length ? ladder.contacts.join(', ') : 'nobody yet (add a contact in Settings)';
  if (ladder.phase === 'check') {
    $('title').textContent = ladder.reason === 'manual' ? 'Sending a help alert' : 'Are you OK?';
    $('why').textContent =
      ladder.reason === 'manual'
        ? 'You pressed the help hotkey.'
        : ladder.reason === 'worse'
          ? 'The movement got stronger after you said you were OK.'
          : ladder.reason === 'preview'
          ? 'This is a preview of the check. Nothing will be sent.'
          : 'Guardian noticed strong rhythmic movement.';
    $('count').textContent = String(left);
    $('next').textContent = ladder.reason === 'preview' ? 'In a real check, an alert would go out when this reaches 0.' : `If there is no answer, ${names} will be alerted.`;
    $('ok').textContent = ladder.reason === 'manual' ? 'Cancel' : "I'm OK";
    $('results').replaceChildren();
  } else if (ladder.phase === 'sent') {
    $('title').textContent = ladder.preview ? 'Preview finished' : 'Help alert sent';
    $('why').textContent = ladder.preview ? 'A real check would now alert your contacts and sound an alarm.' : 'Your trusted contacts are being told to check on you.';
    $('count').textContent = '';
    $('next').textContent = '';
    $('ok').textContent = ladder.preview ? 'Close' : "I'm OK now: tell them";
    const res = ladder.results;
    $('results').replaceChildren(
      ...(res == null
        ? [li('Sending…')]
        : res.length === 0 && !ladder.preview
          ? [li('No contacts set up, so nothing could be sent. Add one in Settings.', true)]
          : res.map((r) => li(r.ok ? `Sent to ${r.name}` : `${r.name}: not sent yet (${r.error}). Retrying every 30 s.`, !r.ok))),
    );
  } else if (ladder.phase === 'cleared') {
    $('title').textContent = 'All clear sent';
    $('why').textContent = 'Your contacts were told you are OK.';
    $('count').textContent = '';
    $('next').textContent = '';
    $('results').replaceChildren();
    $('ok').hidden = $('holdhint').hidden = true;
  }
}
function li(text, bad = false) {
  const el = document.createElement('li');
  el.textContent = text;
  if (bad) el.className = 'bad';
  return el;
}

shield.onGuardianLadder((l) => {
  if (l.phase !== ladder.phase) armedAt = performance.now() + 800;
  ladder = l;
  skew = l.now - Date.now();
  $('ok').hidden = $('holdhint').hidden = false;
  render();
});
setInterval(render, 250);
// Answering takes a deliberate press-and-hold (1 s) with a real pointer, and not in the first 800 ms of a new
// phase. The window takes focus, so keys from someone typing, a stray click where the window popped up, or
// hands hitting keys / the mouse during a seizure must not answer for them.
const HOLD_MS = 1000;
let armedAt = performance.now() + 800;
let holdTimer = 0;
const btn = $('ok');
btn.addEventListener('keydown', (e) => e.preventDefault());
btn.addEventListener('pointerdown', (e) => {
  if (!e.isTrusted || btn.disabled || performance.now() < armedAt) return;
  btn.setPointerCapture(e.pointerId);
  btn.classList.add('holding');
  holdTimer = setTimeout(() => {
    btn.classList.remove('holding');
    btn.disabled = true;
    shield.guardianOk();
    setTimeout(() => (btn.disabled = false), 1000);
  }, HOLD_MS);
});
const release = () => {
  clearTimeout(holdTimer);
  btn.classList.remove('holding');
};
btn.addEventListener('pointerup', release);
btn.addEventListener('pointercancel', release);
btn.addEventListener('lostpointercapture', release);
