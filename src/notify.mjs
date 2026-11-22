// Outbound notifications: tell a person (or a tool) when something needs them, without watching the UI.
// One destination (an https URL, or http to this machine), a list of events, JSON POSTed. Works as-is with ntfy.sh topics, Slack-style incoming webhooks (send the `text` field) and any HTTP endpoint.
// Best effort by design: a failing destination never affects the factory, and nothing is retried forever.
export const EVENTS = {
  'pr-ready': 'A pull request is ready for review',
  merged: 'A pull request was merged automatically',
  failed: 'A ticket failed',
  parked: 'A ticket needs more detail or a decision',
  'deploy-failing': 'A pipeline is failing after a merge',
  'cap-reached': 'The daily run cap was reached',
  held: 'An automatic merge was held back',
  'limit-reached': 'The agent plan hit its usage limit (agents paused)',
  'plan-resumed': 'Agents are working again after a usage limit',
};
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export function normalizeNotify(input) {
  if (input === null || input === undefined || input === false) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('notify must be an object like { url, events }');
  const unknown = Object.keys(input).filter((k) => !['url', 'events', 'enabled'].includes(k)); if (unknown.length) throw bad(`"${unknown[0]}" is not a notify setting`);
  let u; try { u = new URL(String(input.url ?? '')); } catch { throw bad('url must be a full web address, like https://ntfy.sh/my-topic'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw bad('url must be https (http is only allowed for this machine)');
  if (u.username || u.password) throw bad('Do not put credentials in the url');
  const events = (Array.isArray(input.events) ? input.events : Object.keys(EVENTS)).map(String); const badEv = events.find((e) => !EVENTS[e]); if (badEv) throw bad(`Unknown event "${badEv}". Events: ${Object.keys(EVENTS).join(', ')}`);
  return { url: u.toString(), events: [...new Set(events)], enabled: input.enabled !== false };
}

export const payload = (e) => ({ event: e.event, project: e.project ?? null, title: e.title ?? EVENTS[e.event], detail: e.detail ?? null, url: e.url ?? null, at: new Date().toISOString(),
  text: `${e.project ? `[${e.project}] ` : ''}${e.title ?? EVENTS[e.event]}${e.detail ? `: ${e.detail}` : ''}${e.url ? ` ${e.url}` : ''}`.slice(0, 400) });

// Returns { sent, why? }. `fetchImpl` is injectable for tests.
export function makeNotifier(getCfg, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const recent = new Map(); let window = []; 
  return async function notify(e) {
    const c = getCfg(); if (!c || c.enabled === false || !c.events.includes(e.event)) return { sent: false, why: 'not subscribed' };
    const key = `${e.event}|${e.project}|${e.title}`; const t = now(); if (recent.get(key) > t - 60_000) return { sent: false, why: 'duplicate' }; recent.set(key, t);
    window = window.filter((x) => x > t - 60_000); if (window.length >= 30) return { sent: false, why: 'rate limited' }; window.push(t);
    try { const r = await fetchImpl(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Title: String(payload(e).title).slice(0, 120).replace(/[^\x20-\x7e]/g, '') }, body: JSON.stringify(payload(e)), signal: AbortSignal.timeout(5000), redirect: 'error' }); return { sent: r.ok, ...(r.ok ? {} : { why: `HTTP ${r.status}` }) }; }
    catch (err) { return { sent: false, why: String(err.message ?? err).slice(0, 120) }; }
  };
}
