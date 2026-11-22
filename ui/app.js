import { h, icon, s, api, session, saveToken, clearToken, toast, dur, anim, openStream } from './lib.js';
import { agentsPage } from './agents.js';
import { usagePage } from './usage.js';
import { overview, inboxPage, projectsPage, project, runPage, runsPage, connect, health, newProject, act } from './views.js';
import { library } from './library.js';
import { portfolio } from './portfolio.js';
import { scenarios } from './scenarios.js';
import { studio } from './studio.js';
import { settings } from './settings.js';
import { skillsPage } from './skills.js';

const $app = document.getElementById('app');
const ROUTES = [[/^$/, overview, 'overview'], [/^inbox$/, inboxPage, 'inbox'], [/^projects$/, projectsPage, 'projects'], [/^library$/, library, 'library'], [/^portfolio$/, portfolio, 'portfolio'], [/^scenarios$/, scenarios, 'scenarios'], [/^studio$/, studio, 'studio'], [/^project\/([\w-]+)$/, project, 'projects'], [/^run\/([a-f0-9]{8})$/, runPage, 'runs'], [/^runs$/, runsPage, 'runs'], [/^connect$/, connect, 'connect'], [/^health$/, health, 'health'], [/^settings$/, settings, 'settings'], [/^agents(?:\/([a-z]+))?$/, agentsPage, 'agents'], [/^usage$/, usagePage, 'usage'], [/^openrouter$/, { load: async () => { location.hash = '#/agents/free'; return {}; }, draw: () => [] }, 'agents'], [/^skills$/, skillsPage, 'settings'], [/^new$/, newProject, 'studio']];
// The menu is grouped so the top bar stays calm: three things you use all day, then three menus. A narrow screen shows everything in one scrolling row.
const NAV_GROUPS = [
  { k: 'overview', href: '#/', name: 'Control room' }, { k: 'inbox', href: '#/inbox', name: 'Inbox' }, { k: 'runs', href: '#/runs', name: 'Orders' },
  { group: 'projects', name: 'Projects', items: [['portfolio', '#/portfolio', 'Portfolio', 'All projects at a glance'], ['studio', '#/studio', 'Studio', 'Start a new project'], ['library', '#/library', 'Library', 'Code shared between projects'], ['scenarios', '#/scenarios', 'Scenarios', 'Ready-made workflows']] },
  { group: 'agents', name: 'Agents', items: [['agents', '#/agents', 'Agents and models', 'Who does the work, and the settings'], ['usage', '#/usage', 'Usage', 'What was used, when, and limits']] },
  { group: 'system', name: 'System', items: [['connect', '#/connect', 'Connect', 'Link Claude and other tools'], ['health', '#/health', 'Health', 'Checks that everything works'], ['settings', '#/settings', 'Settings', 'Limits, alerts and autonomy']] },
];
const NAV = NAV_GROUPS.flatMap((g) => (g.group ? g.items.map(([k, href, name]) => [k, href, name]) : [[g.k, g.href, g.name]]));
let inboxCount = 0;
const THEME_KEY = 'agent-factory-theme';
let theme = null; try { theme = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
if (theme) document.documentElement.dataset.theme = theme;
const isLight = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'light' : matchMedia('(prefers-color-scheme: light)').matches);
const toggleTheme = () => { const next = isLight() ? 'dark' : 'light'; document.documentElement.dataset.theme = next; try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ } refresh(true); };

const logo = (size = 28) => s('svg', { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true' }, s('rect', { width: 32, height: 32, fill: '#ff5a1f' }), s('path', { d: 'M6 24V12l5 3V12l5 3V8h4v16z', fill: '#140700' }), s('rect', { x: 6, y: 24, width: 20, height: 3, fill: '#140700' }));

let lastKey = '', status = null, view = null, header = null, main = null, ticker = null;
const match = () => { const p = location.hash.replace(/^#\/?/, ''); for (const [re, v, nav] of ROUTES) { const m = re.exec(p); if (m) return { v, arg: m[1], nav }; } return { v: overview, nav: 'overview' }; };
const typing = () => { const a = document.activeElement; return a && main?.contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName); };

let tickerKey = '';
function drawTicker(events, st) {
  const key = JSON.stringify([events.slice(0, 12).map((e) => e.at + e.type + (e.phase ?? '')), st?.paused, st?.active]); if (key === tickerKey) return; tickerKey = key;
  const items = events.slice(0, 14).map((e) => { const t = new Date(e.at).toLocaleTimeString([], { hour12: false });
    const PH = { claim: 'picked up', sandbox: 'setting up', agent: 'writing the change', verify: 'running the tests', visual: 'checking how it looks', review: 'being reviewed', push: 'uploading', pr: 'opening the pull request' }; const msg = e.type === 'phase' ? (PH[e.phase] ?? e.phase) : e.type === 'role' ? (e.detail ?? 'working') : e.type === 'start' ? 'picked up' : e.status === 'ok' ? 'shipped' : e.status ? `stopped (${e.status})` : 'stopped'; const cls = e.type === 'end' ? (e.status === 'ok' ? 't-ok' : 't-bad') : 't-run';
    return h('span', {}, h('em', {}, t), h('b', {}, `${(e.title ?? `#${e.ticket ?? e.pr ?? ''}`).slice(0, 38)}`), ' ', h('i', { class: cls, style: { fontStyle: 'normal' } }, `› ${msg}`)); });
  const idle = h('span', {}, st?.paused ? 'Paused · no new work will start until you press Resume' : st?.limit ? `Codex has run out of usage · back ${st.limit.untilText}${st.autoResume ? ' · work resumes by itself' : ''}` : `Quiet right now · watching ${st?.projects?.length ?? 0} project${st?.projects?.length === 1 ? '' : 's'} for new work`);
  ticker.className = `ticker ${items.length < 4 ? 'static' : ''}`;
  ticker.replaceChildren(h('div', { class: 'ticker-track' }, ...(items.length ? (items.length < 4 ? items : [...items, ...items]) : [idle])));
}
const narrow = () => matchMedia('(max-width: 900px)').matches;
const badge = (k) => (k === 'inbox' && inboxCount > 0 ? h('b', { class: 'nbadge', title: `${inboxCount} waiting on you` }, String(inboxCount)) : null);
function navEl(nav) {
  if (narrow()) return h('nav', { 'aria-label': 'Main' }, NAV.map(([k, href, name]) => h('a', { href, class: nav === k ? 'on' : '' }, h('span', {}, name), badge(k))));
  return h('nav', { 'aria-label': 'Main' }, NAV_GROUPS.map((g) => {
    if (!g.group) return h('a', { href: g.href, class: nav === g.k ? 'on' : '' }, h('span', {}, g.name), badge(g.k));
    const on = g.items.some(([k]) => k === nav) || (g.group === 'projects' && nav === 'projects'); const d = h('details', { class: `navmenu ${on ? 'on' : ''}` }, h('summary', {}, h('span', {}, g.name), icon('chevron', 11)),
      h('div', { class: 'menu' }, g.items.map(([k, href, label, hint]) => h('a', { href, class: nav === k ? 'on' : '', onclick: () => d.removeAttribute('open') }, h('b', {}, label), hint ? h('span', {}, hint) : null))));
    d.addEventListener('toggle', () => { if (d.open) document.querySelectorAll('.navmenu[open]').forEach((o) => { if (o !== d) o.removeAttribute('open'); }); }); return d;
  }));
}
addEventListener('click', (e) => document.querySelectorAll('.navmenu[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); }));
addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.navmenu[open]').forEach((d) => d.removeAttribute('open')); });
let headerKey = '';
function drawHeader(nav) {
  const key = JSON.stringify([nav, status?.paused, status?.busy, status?.active, inboxCount, isLight(), status?.demo, narrow(), liveState]); if (key === headerKey && header?.firstChild) return; headerKey = key;
  const st = status; const state = !st ? 'off' : st.paused ? 'warn' : st.busy || st.active ? 'busy' : 'ok';
  const label = !st ? '…' : st.paused ? 'Paused' : st.active ? `${st.active} live` : st.busy ? 'Checking' : 'Ready';
  header.replaceChildren(h('div', { class: 'bar' }, h('a', { class: 'brand', href: '#/' }, logo(), h('span', {}, 'Agent Factory')),
    navEl(nav),
    h('div', { class: 'bar-r' }, st ? h('span', { class: 'line-state' }, h('i', { class: `lamp ${state}` }), label) : null, h('span', { class: `livedot ${liveState}`, title: liveState === 'live' ? 'Live: changes appear as they happen' : 'Reconnecting to live updates…' }),
      st ? h('button', { class: 'btn small', disabled: st.busy || st.paused, onclick: act(() => api('/control/tick', { method: 'POST', body: {} }), 'Checking for work…', () => refresh(true)) }, icon('play', 11), 'Run') : null,
      st ? h('button', { class: 'btn small', onclick: act(() => api(`/control/${st.paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} }), st.paused ? 'Line resumed' : 'Line paused', () => refresh(true)) }, icon(st.paused ? 'play' : 'pause', 11), st.paused ? 'Resume' : 'Pause') : null,
      h('button', { class: 'btn small ghost', onclick: toggleTheme, 'aria-label': 'Toggle light/dark theme', title: 'Toggle theme' }, icon(isLight() ? 'moon' : 'sun', 13)),
      h('button', { class: 'btn small ghost', onclick: openPalette, 'aria-label': 'Command palette' }, icon('search', 12), h('kbd', {}, 'Ctrl K')))), st?.demo ? h('div', { class: 'demo-strip' }, 'Demo: sample data in a throwaway folder. Pull requests, tickets, the plan and the code analysis are real; the agent runs and history are pre-recorded. No agent will run.') : '');
  try { header.querySelector('nav a.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch { /* cosmetic */ }
  document.title = st?.active ? `(${st.active}) Agent Factory` : 'Agent Factory';
}

// Reconcile instead of rebuild: sections keep their DOM (and any running CSS animation) unless their own data changed.
function mount(nodes, navigated) {
  const list = nodes.flat(Infinity).filter(Boolean);
  const existing = new Map(); if (!navigated) for (const n of main.children) if (n.dataset.key) existing.set(n.dataset.key, n);
  const next = list.map((n) => {
    const key = n.dataset?.key; const ex = key ? existing.get(key) : null;
    if (n.__persist) { if (ex?.__update) { ex.__update(n.__persist.state); return ex; } const real = n.__persist.create(n.__persist.state); real.dataset.key = key; return real; }
    if (ex && n.dataset.sig !== undefined && ex.dataset.sig === n.dataset.sig) return ex; // unchanged: leave the live node alone
    return n;
  });
  // Swap changed sections IN PLACE and never move unchanged ones: moving a node detaches it, which resets hover state and CSS animations.
  const keep = new Set(next);
  for (let i = 0; i < next.length; i++) {
    const n = next[i]; const cur = main.children[i];
    if (cur === n) continue;
    if (!cur) main.append(n); else if (!keep.has(cur)) cur.replaceWith(n); else main.insertBefore(n, cur);
  }
  while (main.children.length > next.length) main.lastChild.remove();
}

let lastRoute = null, enterTimer = null;
let buildId = null;
// The factory was upgraded while this tab was open: the old interface is still in memory, so say so and offer a reload.
function showUpdate() {
  if (document.querySelector('.updatebar')) return;
  document.body.prepend(h('div', { class: 'updatebar', role: 'status' }, h('span', {}, 'The factory was updated. Reload to get the new interface.'), h('button', { class: 'btn small primary', onclick: () => location.reload() }, 'Reload now')));
}
let badgeBusy = false;
function updateInboxBadge() { if (badgeBusy) return; badgeBusy = true; api('/inbox/count').then((ic) => { if (ic.count !== inboxCount) { inboxCount = ic.count; headerKey = ''; if (header && status) drawHeader(lastNav); } }).catch(() => {}).finally(() => { badgeBusy = false; }); }
async function refresh(force = false) {
  if (!session.token) return login();
  const r = match(); view = r.v;
  try {
    const [data, st, act2] = await Promise.all([r.v.load(r.arg), api('/status'), api('/activity').catch(() => ({ events: [] }))]);
    updateInboxBadge();   // never waited for: the count arrives when it arrives
    if (st.build) { if (!buildId) buildId = st.build; else if (st.build !== buildId) showUpdate(); }
    status = st; if (!header) { shell(); lastRoute = null; } lastNav = r.nav; drawHeader(r.nav); drawTicker(act2.events, st); startStream();
    const key = JSON.stringify([location.hash, data]);
    if (!force && key === lastKey) return;
    if (!force && typing()) return;
    lastKey = key;
    const navigated = location.hash !== lastRoute; lastRoute = location.hash;
    anim.on = navigated; // entrance + roll-up animations play on arrival only
    const ctx = { rerender: () => refresh(true) };
    mount(r.v.draw(data, ctx), navigated);
    if (navigated) { main.classList.remove('enter'); void main.offsetWidth; main.classList.add('enter'); clearTimeout(enterTimer); enterTimer = setTimeout(() => main.classList.remove('enter'), 1000); } // arrival animation only: expire it so sections inserted later by a refresh never replay it
  } catch (e) { if (e.auth) return login(e.message); if (!header) shell(); main.replaceChildren(h('div', { class: 'callout bad' }, icon('alert', 16), e.message)); }
}
function shell() { header = h('header', {}); ticker = h('div', { class: 'ticker static', 'aria-label': 'Live activity' }); main = h('main', { id: 'main' }); $app.replaceChildren(header, ticker, main); tickerKey = ''; }

function login(msg) {
  header = main = ticker = null; lastKey = '';
  const input = h('input', { type: 'password', placeholder: 'UI token', autocomplete: 'off', 'aria-label': 'UI token' });
  const go = () => { saveToken(input.value.trim()); refresh(true); };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  $app.replaceChildren(h('div', { class: 'login card reg' }, h('div', { class: 'login-logo' }, logo(44)), h('h1', {}, 'Agent Factory'), h('p', { class: 'sub' }, 'Enter the UI token. It is printed by ', h('code', {}, 'npm start'), ' and stored in ', h('code', {}, 'state/ui-token'), '.'), msg ? h('div', { class: 'callout bad' }, msg) : null, input, h('button', { class: 'btn primary wide', onclick: go }, 'Sign in')));
  input.focus();
}

// ---- command palette
let palette = null;
async function openPalette() {
  if (palette || !session.token) return;
  let projects = []; try { projects = await api('/projects'); } catch { /* ignore */ }
  const items = [
    ...NAV.map(([k, href, label]) => ({ label: `Go to ${label}`, ic: { overview: 'pulse', inbox: 'alert', projects: 'folder', library: 'plug', portfolio: 'folder', scenarios: 'pulse', studio: 'spark', openrouter: 'spark', runs: 'git', connect: 'plug', health: 'shield' }[k], run: () => { location.hash = href; } })),
    ...projects.map((p) => ({ label: `Open project ${p.id}`, ic: 'folder', hint: p.repo, run: () => { location.hash = `#/project/${p.id}`; } })),
    { label: 'Add or create a project', ic: 'plus', run: () => { location.hash = '#/new'; } },
    { label: status?.paused ? 'Resume the factory' : 'Pause the factory', ic: status?.paused ? 'play' : 'pause', run: () => api(`/control/${status?.paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} }).then(() => refresh(true)).catch((e) => toast(e.message, 'bad')) },
    { label: 'Open the inbox', ic: 'alert', run: () => { location.hash = '#/inbox'; } },
    { label: 'Run a cycle now', ic: 'bolt', run: () => api('/control/tick', { method: 'POST', body: {} }).then(() => toast('Checking for work…', 'ok')).catch((e) => toast(e.message, 'bad')) },
  ];
  let sel = 0, shown = items; const input = h('input', { placeholder: 'Type a command or project…', 'aria-label': 'Command' }); const list = h('ul', { role: 'listbox' });
  const close = () => { palette?.remove(); palette = null; };
  const draw = () => list.replaceChildren(...shown.map((it, i) => h('li', { role: 'option', class: i === sel ? 'on' : '', 'aria-selected': String(i === sel), onclick: () => { close(); it.run(); }, onmousemove: () => { sel = i; draw(); } }, icon(it.ic, 15), h('span', {}, it.label), it.hint ? h('small', {}, it.hint) : null)));
  input.addEventListener('input', () => { const q = input.value.toLowerCase(); shown = items.filter((it) => (it.label + (it.hint ?? '')).toLowerCase().includes(q)); sel = 0; draw(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); } else if (e.key === 'Enter' && shown[sel]) { const it = shown[sel]; close(); it.run(); } });
  palette = h('div', { class: 'palette-bg', onclick: (e) => { if (e.target === palette) close(); } }, h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' }, input, list));
  document.body.append(palette); draw(); input.focus();
}
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette ? palette.remove() || (palette = null) : openPalette(); } });

// ---- live elapsed timers + polling
setInterval(() => document.querySelectorAll('.since').forEach((el) => { el.textContent = dur(Date.now() - new Date(el.dataset.since)); }), 1000);
// Live updates: the server tells us when something changed (src/server.mjs /api/stream), so the page refreshes then, not on a timer. A slow refresh stays as a safety net (things that
// change in other systems, like a ticket edited on GitHub, never reach the server's change bus), and the old quick polling returns while the stream is down.
let liveState = 'connecting'; let pushT = null; let stopStream = null;
const pushRefresh = () => { clearTimeout(pushT); pushT = setTimeout(() => { if (document.visibilityState === 'visible' && !palette) refresh(false); }, 350); };
const startStream = () => { if (stopStream || !session.token) return; stopStream = openStream({ onChange: pushRefresh, onState: (st) => { const was = liveState; liveState = st; if (was !== st) { headerKey = ''; if (header && status) drawHeader(lastNav); } if (st === 'live' && was !== 'live') pushRefresh(); }, onAuthFail: () => { stopStream?.(); stopStream = null; } }); };
let lastNav = 'overview';
let timer; const loop = async () => { if (document.visibilityState === 'visible' && !palette) await refresh(false); startStream(); timer = setTimeout(loop, liveState === 'live' ? 30000 : (status?.active || status?.busy ? 2500 : 7000)); };
addEventListener('hashchange', () => { lastKey = ''; refresh(true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(false); });
refresh(true).then(() => { timer = setTimeout(loop, 3000); });
