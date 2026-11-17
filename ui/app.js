import { h, icon, s, api, session, saveToken, clearToken, toast, dur } from './lib.js';
import { overview, projectsPage, project, runPage, runsPage, connect, health, newProject, act } from './views.js';

const $app = document.getElementById('app');
const ROUTES = [[/^$/, overview, 'overview'], [/^projects$/, projectsPage, 'projects'], [/^project\/([\w-]+)$/, project, 'projects'], [/^run\/([a-f0-9]{8})$/, runPage, 'runs'], [/^runs$/, runsPage, 'runs'], [/^connect$/, connect, 'connect'], [/^health$/, health, 'health'], [/^new$/, newProject, 'projects']];
const NAV = [['overview', '#/', 'Overview', 'pulse'], ['projects', '#/projects', 'Projects', 'folder'], ['runs', '#/runs', 'Runs', 'git'], ['connect', '#/connect', 'Connect AI', 'plug'], ['health', '#/health', 'Health', 'shield']];

const logo = () => s('svg', { viewBox: '0 0 32 32', width: 26, height: 26 }, s('defs', {}, s('linearGradient', { id: 'lg', x1: 0, y1: 0, x2: 1, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#22d3ee' }), s('stop', { offset: 1, 'stop-color': '#8b5cf6' }))), s('rect', { width: 32, height: 32, rx: 8, fill: 'url(#lg)' }), s('path', { d: 'M9 21V11l7-4 7 4v10l-7 4z', fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-linejoin': 'round' }), s('circle', { cx: 16, cy: 16, r: 2.6, fill: '#fff' }));

let lastKey = '', status = null, view = null, header = null, main = null;
const match = () => { const p = location.hash.replace(/^#\/?/, ''); for (const [re, v, nav] of ROUTES) { const m = re.exec(p); if (m) return { v, arg: m[1], nav }; } return { v: overview, nav: 'overview' }; };
const typing = () => { const a = document.activeElement; return a && main?.contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName); };

function drawHeader(nav) {
  const st = status; const state = !st ? 'idle' : st.paused ? 'paused' : st.busy || st.active ? 'busy' : 'ok';
  header.replaceChildren(h('div', { class: 'bar' }, h('a', { class: 'brand', href: '#/' }, logo(), h('span', {}, 'Agent Factory')),
    h('nav', {}, NAV.map(([k, href, label, ic]) => h('a', { href, class: nav === k ? 'on' : '' }, icon(ic, 15), h('span', {}, label)))),
    h('div', { class: 'bar-r' }, st ? h('span', { class: `orb ${state}`, title: state }, h('i', {}), state === 'paused' ? 'Paused' : st.active ? `${st.active} running` : st.busy ? 'Working' : 'Watching') : null,
      st ? h('button', { class: 'btn small', disabled: st.busy || st.paused, onclick: act(() => api('/control/tick', { method: 'POST', body: {} }), 'Checking for work…', () => refresh(true)) }, icon('play', 12), 'Run now') : null,
      st ? h('button', { class: 'btn small', onclick: act(() => api(`/control/${st.paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} }), st.paused ? 'Resumed' : 'Paused', () => refresh(true)) }, icon(st.paused ? 'play' : 'pause', 12), st.paused ? 'Resume' : 'Pause') : null,
      h('button', { class: 'btn small ghost', onclick: openPalette, 'aria-label': 'Command palette' }, icon('search', 13), h('kbd', {}, 'Ctrl K')))));
  document.title = st?.active ? `(${st.active}) Agent Factory` : 'Agent Factory';
}

async function refresh(force = false) {
  if (!session.token) return login();
  const r = match(); view = r.v;
  try {
    const [data, st] = await Promise.all([r.v.load(r.arg), api('/status')]);
    status = st; if (!header) { shell(); } drawHeader(r.nav);
    const key = r.v === overview || true ? JSON.stringify([location.hash, data]) : '';
    if (!force && key === lastKey) return;
    if (!force && typing()) return;
    lastKey = key;
    const ctx = { rerender: () => refresh(true) };
    main.replaceChildren(...r.v.draw(data, ctx).flat(Infinity).filter(Boolean)); main.classList.remove('enter'); void main.offsetWidth; main.classList.add('enter');
  } catch (e) { if (e.auth) return login(e.message); if (!header) shell(); main.replaceChildren(h('div', { class: 'callout bad' }, icon('alert', 16), e.message)); }
}
function shell() { header = h('header', {}); main = h('main', { id: 'main' }); $app.replaceChildren(header, main); }

function login(msg) {
  header = main = null; lastKey = '';
  const input = h('input', { type: 'password', placeholder: 'UI token', autocomplete: 'off', 'aria-label': 'UI token' });
  const go = () => { saveToken(input.value.trim()); refresh(true); };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  $app.replaceChildren(h('div', { class: 'login card' }, h('div', { class: 'login-logo' }, logo()), h('h1', {}, 'Agent Factory'), h('p', { class: 'sub' }, 'Enter the UI token. It is printed by ', h('code', {}, 'npm start'), ' and stored in ', h('code', {}, 'state/ui-token'), '.'), msg ? h('div', { class: 'callout bad' }, msg) : null, input, h('button', { class: 'btn primary wide', onclick: go }, 'Sign in')));
  input.focus();
}

// ---- command palette
let palette = null;
async function openPalette() {
  if (palette || !session.token) return;
  let projects = []; try { projects = await api('/projects'); } catch { /* ignore */ }
  const items = [
    ...NAV.map(([, href, label, ic]) => ({ label: `Go to ${label}`, ic, run: () => { location.hash = href; } })),
    ...projects.map((p) => ({ label: `Open project ${p.id}`, ic: 'folder', hint: p.repo, run: () => { location.hash = `#/project/${p.id}`; } })),
    { label: 'Add or create a project', ic: 'plus', run: () => { location.hash = '#/new'; } },
    { label: status?.paused ? 'Resume the factory' : 'Pause the factory', ic: status?.paused ? 'play' : 'pause', run: () => api(`/control/${status?.paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} }).then(() => refresh(true)).catch((e) => toast(e.message, 'bad')) },
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
let timer; const loop = async () => { if (document.visibilityState === 'visible' && !palette) await refresh(false); timer = setTimeout(loop, status?.active || status?.busy ? 2500 : 7000); };
addEventListener('hashchange', () => { lastKey = ''; refresh(true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(false); });
refresh(true).then(() => { timer = setTimeout(loop, 3000); });
