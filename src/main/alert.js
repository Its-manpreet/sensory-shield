// Guardian alerts: a short TEXT push notification to trusted people through ntfy (https://ntfy.sh, or the
// user's own ntfy server). The contact installs the free ntfy app and subscribes to the topic shown in Settings.
//
// This is the app's ONE deliberate network call (docs/DECISIONS.md). It carries text only: who, what, when.
// Never an image, never a frame. It runs in the main process with Node's fetch, which the renderer network
// lock (session.webRequest) does not touch, and only when the user turned Guardian on and added a contact.

const TIMEOUT_MS = 8000;

/** random, hard-to-guess topic: anyone who knows a ntfy topic can read it */
export function newTopic() {
  const abc = 'abcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `shield-${[...bytes].map((b) => abc[b % abc.length]).join('')}`;
}

/**
 * @param {{ server?: string, contacts: {name?: string, topic: string}[] }} guardian
 * @param {{ title: string, message: string, urgent?: boolean }} msg
 * @returns {Promise<{ name: string, ok: boolean, error?: string }[]>}
 */
export async function sendAlert(guardian, msg) {
  const server = (guardian.server || 'https://ntfy.sh').replace(/\/+$/, '');
  const contacts = (guardian.contacts ?? []).filter((c) => /^[\w-]{1,64}$/.test(c.topic ?? ''));
  return Promise.all(
    contacts.map(async (c) => {
      const name = c.name || c.topic;
      try {
        const res = await fetch(`${server}/${encodeURIComponent(c.topic)}`, {
          method: 'POST',
          body: msg.message,
          headers: {
            Title: msg.title,
            Priority: msg.urgent ? 'urgent' : 'default',
            Tags: msg.urgent ? 'rotating_light' : 'white_check_mark',
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return res.ok ? { name, ok: true } : { name, ok: false, error: `HTTP ${res.status}` };
      } catch (err) {
        return { name, ok: false, error: err?.name === 'TimeoutError' ? 'timed out (offline?)' : String(err?.message ?? err) };
      }
    }),
  );
}
