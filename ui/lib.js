// Shared helpers. SECURITY: untrusted text (ticket titles, PR text, agent output) only ever reaches the DOM via textContent
// (through h()). There is no innerHTML anywhere, and links are only made for validated https://github.com/ URLs.
const SVG_NS = 'http://www.w3.org/2000/svg';
const TOKEN_KEY = 'agent-factory-token';
export const session = { token: null };
try { session.token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
{ const m = /(?:^|[#&])token=([^&]+)/.exec(location.hash); if (m) { session.token = decodeURIComponent(m[1]); try { localStorage.setItem(TOKEN_KEY, session.token); } catch { /* ignore */ } history.replaceState(null, '', location.pathname + location.search); } }
export const clearToken = () => { session.token = null; try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };
export const saveToken = (t) => { session.token = t; try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ } };

function apply(el, props) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v); // CSSOM: allowed under a strict CSP, unlike style="" attributes
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
}
const append = (el, kids) => { for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); return el; };
export const h = (tag, props, ...kids) => { const el = document.createElement(tag); apply(el, props); return append(el, kids); };
export const s = (tag, props, ...kids) => { const el = document.createElementNS(SVG_NS, tag); apply(el, props); return append(el, kids); };

// ---- icons: 24px stroke icons, hand-drawn paths
const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7.5', x: 'M6 6l12 12M18 6L6 18', clock: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z', pause: 'M9 6v12M15 6v12', play: 'M7 5l12 7-12 7z',
  pr: 'M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM18 21V9a3 3 0 00-3-3h-3M18 9a3 3 0 100-6 3 3 0 000 6z', ticket: 'M4 8a2 2 0 002-2h12a2 2 0 002 2v2a2 2 0 000 4v2a2 2 0 00-2 2H6a2 2 0 00-2-2v-2a2 2 0 000-4z',
  alert: 'M12 8v5M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z', spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  plug: 'M9 2v5M15 2v5M6 7h12v4a6 6 0 01-12 0zM12 17v5', pulse: 'M3 12h4l3-8 4 16 3-8h4', folder: 'M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  copy: 'M9 9h10v10H9zM5 15V5h10', arrow: 'M5 12h14M13 6l6 6-6 6', search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5', bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', plus: 'M12 5v14M5 12h14', git: 'M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9c0 6-12 3-12 6',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4M12 8a4 4 0 100 8 4 4 0 000-8z', moon: 'M20 14.5A8.5 8.5 0 119.5 4a7 7 0 0010.5 10.5z',
  cpu: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M7 6h10a1 1 0 011 1v10a1 1 0 01-1 1H7a1 1 0 01-1-1V7a1 1 0 011-1zM10 10h4v4h-4z', box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
};
export const icon = (name, size = 16, cls = '') => s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `icon ${cls}`, 'aria-hidden': 'true' }, s('path', { d: ICONS[name] ?? ICONS.spark }));

// ---- formatting
export const ago = (iso) => { if (!iso) return '–'; const t = (Date.now() - new Date(iso)) / 1000; if (t < 45) return 'just now'; if (t < 3600) return `${Math.round(t / 60)}m ago`; if (t < 86400) return `${Math.round(t / 3600)}h ago`; return `${Math.round(t / 86400)}d ago`; };
export const dur = (ms) => { if (ms == null || ms < 0) return '–'; const s2 = Math.round(ms / 1000); if (s2 < 60) return `${s2}s`; const m = Math.floor(s2 / 60); return m < 60 ? `${m}m ${String(s2 % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`; };
export const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0));
export const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
// Links come from our own adapters (host/tracker base URL + ids), never from ticket text; still allow only plain http(s) URLs.
export const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[\w.\-/#?=&%~+]*)?$/.test(u) ? u : null);
export const ext = (u, text, cls) => (safeUrl(u) ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: cls }, text) : h('span', { class: cls }, text));

// ---- api
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, { method, headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { clearToken(); throw Object.assign(new Error('Please sign in again'), { auth: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// ---- toasts
let toastTimer;
export function toast(msg, kind = '') { document.querySelector('.toast')?.remove(); const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg); document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 4500); }

// ---- run/ticket vocabulary
export const OUTCOME = {
  ok: ['ok', 'PR opened'], 'verify-failed': ['bad', 'Tests failed'], 'no-change': ['warn', 'No change'], timeout: ['bad', 'Timed out'], error: ['bad', 'Error'], 'needs-info': ['warn', 'Needs info'],
  'protected-path': ['bad', 'Blocked: protected path'], 'repo-not-allowed': ['warn', 'Repo not allowed'], 'budget-exhausted': ['warn', 'Budget reached'], stopped: ['info', 'Paused'], running: ['info', 'Running'],
  'recovered-requeued': ['info', 'Requeued'], 'recovered-failed': ['bad', 'Gave up'] };
export const pill = (status) => { const [c, t] = OUTCOME[status] ?? ['', status]; return h('span', { class: `stamp ${c}` }, h('i', { class: 'dot' }), t); };
export const STAGES = [['claim', 'Claim'], ['sandbox', 'Sandbox'], ['agent', 'Agent'], ['verify', 'Verify'], ['push', 'Push'], ['pr', 'Ship']];
export const STATES = { ready: ['info', 'Queued'], working: ['live', 'Working'], review: ['ok', 'In review'], failed: ['bad', 'Failed'], 'needs-info': ['warn', 'Needs info'], 'needs-human': ['bad', 'Needs a human'], other: ['', 'Other'] };

// ---- render continuity: entrance animations and number roll-ups play on NAVIGATION only, never on a background refresh.
export const anim = { on: true };
// Mark a top-level section so the router can keep it untouched when its signature has not changed.
export const keyed = (node, key, sig) => { node.dataset.key = key; if (sig !== undefined) node.dataset.sig = typeof sig === 'string' ? sig : JSON.stringify(sig); return node; };
// A section that lives for the whole page visit and is updated in place (so CSS animations and transitions are never restarted).
export const persist = (key, state, create) => { const n = document.createElement('div'); n.dataset.key = key; n.__persist = { state, create }; return n; };
