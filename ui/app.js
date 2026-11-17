'use strict';
// Agent Factory UI. No framework, no build step. SECURITY: every piece of server/ticket text goes through textContent
// (via h()); nothing is ever assigned to innerHTML, and links are only created for validated https://github.com/ URLs.
const $app = document.getElementById('app');
const TOKEN_KEY = 'agent-factory-token';
let token = null; try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
{ const m = /(?:^|[#&])token=([^&]+)/.exec(location.hash); if (m) { token = decodeURIComponent(m[1]); try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ } history.replaceState(null, '', location.pathname); } }

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/github\.com\/[\w.\-/#]+$/.test(u) ? u : null);
const link = (u, text) => (safeUrl(u) ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, text) : text);
const ago = (iso) => { if (!iso) return '–'; const s = (Date.now() - new Date(iso)) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { token = null; try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } throw Object.assign(new Error('Sign in again'), { auth: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
let toastTimer; function toast(msg) { document.querySelector('.toast')?.remove(); const t = h('div', { class: 'toast' }, msg); document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 4500); }
const act = (fn, done) => async (e) => { const b = e?.currentTarget; if (b) b.disabled = true; try { const r = await fn(); if (done) toast(done); render(); return r; } catch (err) { toast(err.message); } finally { if (b) b.disabled = false; } };

const STATUS = { ok: ['ok', 'PR opened'], 'verify-failed': ['bad', 'tests failed'], 'no-change': ['warn', 'no change'], timeout: ['bad', 'timed out'], error: ['bad', 'error'], 'needs-info': ['warn', 'needs info'],
  'protected-path': ['bad', 'blocked: protected path'], 'repo-not-allowed': ['warn', 'repo not allowed'], 'budget-exhausted': ['warn', 'budget reached'], stopped: ['info', 'paused'], running: ['info', 'running'] };
const statusPill = (s) => { const [c, t] = STATUS[s] ?? ['', s]; return h('span', { class: `pill ${c}` }, t); };
const LABELS = { 'agent-ready': ['info', 'queued'], 'agent-working': ['warn', 'working'], 'agent-review': ['ok', 'PR ready for review'], 'agent-failed': ['bad', 'failed'], 'agent-needs-info': ['warn', 'needs info'], 'agent-needs-human': ['bad', 'needs a human'] };
const labelPill = (labels) => { const l = Object.keys(LABELS).find((k) => labels.includes(k)); return l ? h('span', { class: `pill ${LABELS[l][0]}` }, LABELS[l][1]) : h('span', { class: 'pill' }, '–'); };

function shell(active, ...content) {
  return [h('header', {}, h('div', { class: 'bar' }, h('span', { class: 'brand' }, 'Agent Factory'),
    h('nav', {}, [['#/', 'Overview'], ['#/projects', 'Projects'], ['#/runs', 'Runs'], ['#/health', 'Health']].map(([href, t]) => h('a', { href, class: active === href ? 'on' : '' }, t))),
    h('div', { id: 'ctl', class: 'row' }))), h('main', {}, ...content)];
}
async function controls() {
  const s = await api('/status'); const ctl = document.getElementById('ctl'); if (!ctl) return s;
  ctl.replaceChildren(h('span', { class: `pill ${s.paused ? 'warn' : s.busy ? 'info' : 'ok'}` }, s.paused ? 'paused' : s.busy ? 'working…' : 'running'),
    h('button', { disabled: s.busy || s.paused, onclick: act(() => api('/control/tick', { method: 'POST', body: {} }), 'Checking for work…') }, 'Run now'),
    h('button', { onclick: act(() => api(`/control/${s.paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} }), s.paused ? 'Resumed' : 'Paused') }, s.paused ? 'Resume' : 'Pause'));
  return s;
}

const bar = (v, max) => h('div', { class: 'meter' }, h('i', { style: `width:${max ? Math.min(100, (v / max) * 100) : 0}%` }));

async function overview() {
  const s = await controls();
  const cards = s.projects.map((p) => h('a', { class: 'card', href: `#/project/${p.project}` }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, p.project), p.paused ? h('span', { class: 'pill warn' }, 'paused') : null),
    h('div', { class: 'muted small' }, p.repo), h('div', { class: 'row gap small' }, h('span', {}, `${p.ok} PRs`), h('span', { class: 'muted' }, `${p.failed} failed`), h('span', { class: 'muted' }, `last: ${ago(p.lastRun?.finished ?? p.lastRun?.started)}`))));
  return shell('#/', h('h1', {}, 'Overview'), h('p', { class: 'sub' }, 'Tickets in, reviewed pull requests out. Nothing merges without you.'),
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Agent runs today'), h('h3', {}, s.today.maxRuns ? `${s.today.runs} / ${s.today.maxRuns}` : String(s.today.runs)), bar(s.today.runs, s.today.maxRuns)),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Agent'), h('h3', {}, s.agent), h('div', { class: 'muted small' }, s.today.maxCostUsd ? `$${s.today.costUsd} of $${s.today.maxCostUsd} today` : 'Subscription auth reports no cost')),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Last cycle'), h('h3', {}, s.last.tick ? ago(s.last.tick.at) : 'not yet'), h('div', { class: 'muted small' }, s.last.tick ? `${s.last.tick.results} result(s)` : 'Click "Run now"'))),
    h('div', { class: 'row gap' }, h('h2', { class: 'grow' }, 'Projects'), h('a', { class: 'btn primary', href: '#/new' }, 'Add a project')),
    cards.length ? h('div', { class: 'grid' }, cards) : h('div', { class: 'card empty' }, 'No projects yet. ', h('a', { href: '#/new' }, 'Add your first one')),
    h('h2', {}, 'Recent runs'), await runsTable(await api('/runs?limit=8')));
}

async function runsTable(runs) {
  if (!runs.length) return h('div', { class: 'card empty' }, 'No runs yet.');
  return h('table', {}, h('thead', {}, h('tr', {}, ['Project', 'Ticket / PR', 'Result', 'When', 'Cost'].map((t) => h('th', {}, t)))),
    h('tbody', {}, runs.map((r) => h('tr', {}, h('td', {}, r.project ?? '–'), h('td', {}, r.pr ? (typeof r.pr === 'string' ? link(r.pr, `PR for #${r.ticket}`) : `PR #${r.pr}`) : `#${r.ticket ?? '–'}`, r.round ? ` (feedback round ${r.round})` : ''),
      h('td', {}, statusPill(r.status), r.error ? h('div', { class: 'muted small' }, String(r.error).slice(0, 120)) : null), h('td', { class: 'muted' }, ago(r.finished ?? r.started)), h('td', { class: 'muted' }, r.costUsd ? `$${r.costUsd.toFixed(3)}` : '–')))));
}

async function projectsPage() {
  await controls(); const ps = await api('/projects');
  return shell('#/projects', h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Projects'), h('a', { class: 'btn primary', href: '#/new' }, 'Add a project')),
    ps.length ? h('div', { class: 'grid gap' }, ps.map((p) => h('a', { class: 'card', href: `#/project/${p.id}` }, h('h3', {}, p.id), h('div', { class: 'muted small' }, `${p.repo} · base ${p.base}`), h('div', { class: 'muted small' }, `tickets from ${p.tickets.kind}`)))) : h('div', { class: 'card empty' }, 'No projects yet.'));
}

let tab = 'queue';
async function projectPage(id) {
  await controls(); const ps = await api('/projects'); const p = ps.find((x) => x.id === id);
  if (!p) return shell('#/projects', h('div', { class: 'note bad' }, `No project "${id}"`));
  const body = h('div', {});
  const tabs = h('div', { class: 'tabs' }, [['queue', 'Queue'], ['prs', 'Pull requests'], ['runs', 'Runs'], ['new', 'New ticket'], ['log', 'Log']].map(([k, t]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; render(); } }, t)));
  if (tab === 'queue') { const ts = await api(`/projects/${id}/tickets`);
    body.append(ts.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Ticket', 'Status', 'Updated'].map((t) => h('th', {}, t)))), h('tbody', {}, ts.map((t) => h('tr', {}, h('td', {}, link(t.url, `#${t.id}`), ' ', t.title), h('td', {}, labelPill(t.labels)), h('td', { class: 'muted' }, ago(t.updatedAt)))))) : h('div', { class: 'card empty' }, 'Nothing queued. Create a ticket, or label an issue ', h('code', {}, 'agent-ready'), '.')); }
  if (tab === 'prs') { const prs = await api(`/projects/${id}/prs`);
    body.append(prs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['PR', 'Branch'].map((t) => h('th', {}, t)))), h('tbody', {}, prs.map((x) => h('tr', {}, h('td', {}, link(x.url, `#${x.number}`), ' ', x.title), h('td', { class: 'muted' }, x.branch))))) : h('div', { class: 'card empty' }, 'No open agent pull requests.')); }
  if (tab === 'runs') body.append(await runsTable(await api(`/runs?project=${id}`)));
  if (tab === 'log') body.append(h('pre', { class: 'log' }, (await api(`/projects/${id}/log`)).lines.join('\n') || 'No log yet.'));
  if (tab === 'new') body.append(ticketForm(id));
  return shell('#/projects', h('div', { class: 'row' }, h('h1', { class: 'grow' }, id, ' ', p.paused ? h('span', { class: 'pill warn' }, 'paused') : null),
    h('button', { onclick: act(() => api(`/projects/${id}/${p.paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} }), p.paused ? 'Project resumed' : 'Project paused') }, p.paused ? 'Resume project' : 'Pause project'),
    h('button', { class: 'danger', onclick: async () => { if (confirm(`Remove ${id} from the factory? The repository itself is untouched.`)) { await act(() => api(`/projects/${id}`, { method: 'DELETE' }), 'Removed')(); location.hash = '#/projects'; } } }, 'Remove')),
    h('p', { class: 'sub' }, link(`https://github.com/${p.repo}`, p.repo), ` · base ${p.base} · tickets from ${p.tickets.kind}`), tabs, body);
}

function checker(getTitle, getBody, out) {
  let t; return () => { clearTimeout(t); t = setTimeout(async () => { const title = getTitle(), body = getBody();
    if (!title && !body) return out.replaceChildren();
    try { const r = await api('/check-ticket', { method: 'POST', body: { title, body } }); out.replaceChildren(r.ok ? h('div', { class: 'note ok small' }, 'Clear enough to start.') : h('div', { class: 'note warn small' }, 'The factory will ask for more detail: ', r.problems.join('; '), '.')); } catch { /* ignore */ } }, 350); };
}
function ticketForm(id) {
  const title = h('input', { placeholder: 'Short title, e.g. "Add a clamp function"', maxlength: 200 }); const body = h('textarea', { placeholder: 'What should change, and how will we know it is done? Name files/functions and the expected behaviour.' });
  const hint = h('div', {}); const check = checker(() => title.value, () => body.value, hint); title.addEventListener('input', check); body.addEventListener('input', check);
  return h('div', { class: 'card' }, h('label', {}, 'Title'), title, h('label', {}, 'Details'), body, hint,
    h('div', { class: 'row gap' }, h('button', { class: 'primary', onclick: act(async () => { await api(`/projects/${id}/tickets`, { method: 'POST', body: { title: title.value, body: body.value } }); title.value = body.value = ''; hint.replaceChildren(); tab = 'queue'; }, 'Queued. The factory picks it up on its next cycle.') }, 'Queue for the factory'),
      h('span', { class: 'muted small' }, 'Creates a GitHub issue labelled agent-ready.')));
}

async function newProject() {
  await controls(); const templates = await api('/templates'); const who = await api('/whoami').catch(() => ({ login: '' }));
  let mode = 'existing'; const box = h('div', {});
  const draw = () => {
    box.replaceChildren();
    const f = {};
    if (mode === 'existing') {
      f.repo = h('input', { placeholder: `${who.login || 'owner'}/repository` }); f.id = h('input', { placeholder: 'short-name (auto from repo)' }); f.base = h('input', { placeholder: 'default branch (auto)' });
      box.append(h('div', { class: 'card' }, h('label', {}, 'GitHub repository'), f.repo, h('label', {}, 'Name in the factory (optional)'), f.id, h('label', {}, 'Base branch (optional)'), f.base,
        h('p', { class: 'muted small' }, `Only issues authored by ${who.login || 'you'} can queue work. The factory needs write access to the repo and will create its agent-* labels.`),
        h('button', { class: 'primary', onclick: act(async () => { const repo = f.repo.value.trim(); const id = (f.id.value.trim() || repo.split('/')[1] || '').toLowerCase().replace(/[^a-z0-9-]/g, '-'); const r = await api('/projects', { method: 'POST', body: { id, repo, ...(f.base.value.trim() ? { base: f.base.value.trim() } : {}) } }); location.hash = `#/project/${r.id}`; }, 'Project added') }, 'Add project')));
    } else {
      f.name = h('input', { placeholder: 'my-new-app' }); f.desc = h('input', { placeholder: 'One-line description' }); f.tpl = h('select', {}, templates.map((t) => h('option', { value: t }, t))); f.vis = h('select', {}, h('option', { value: 'private' }, 'private'), h('option', { value: 'public' }, 'public'));
      f.spec = h('textarea', { placeholder: 'Describe what to build: features, behaviour, what "done" looks like. This becomes the first ticket and the factory starts on it.' });
      const hint = h('div', {}); const check = checker(() => 'Build ' + f.name.value, () => f.spec.value, hint); f.spec.addEventListener('input', check);
      box.append(h('div', { class: 'card' }, h('label', {}, 'Repository name'), f.name, h('label', {}, 'Description'), f.desc, h('div', { class: 'grid' }, h('div', {}, h('label', {}, 'Starter template'), f.tpl), h('div', {}, h('label', {}, 'Visibility'), f.vis)),
        h('label', {}, 'What should it do?'), f.spec, hint,
        h('p', { class: 'muted small' }, `Creates ${who.login || 'your'}/<name> on GitHub, scaffolds the template, and queues your description as the first ticket.`),
        h('button', { class: 'primary', onclick: act(async () => { const name = f.name.value.trim(); const r = await api('/projects/new', { method: 'POST', body: { id: name.toLowerCase().replace(/[^a-z0-9-]/g, '-'), name, description: f.desc.value, visibility: f.vis.value, template: f.tpl.value, spec: f.spec.value.trim() || undefined } }); location.hash = `#/project/${r.project.id}`; }, 'Project created') }, 'Create project')));
    }
  };
  draw();
  const tabs = h('div', { class: 'tabs' }, [['existing', 'Add an existing repo'], ['create', 'Create a new project']].map(([k, t]) => h('button', { class: mode === k ? 'on' : '', onclick: (e) => { mode = k; tabs.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); draw(); } }, t)));
  return shell('#/projects', h('h1', {}, 'Add a project'), h('p', { class: 'sub' }, 'Point the factory at a repo you already have, or have it start a new one.'), tabs, box);
}

async function runsPage() { await controls(); return shell('#/runs', h('h1', {}, 'Runs'), h('p', { class: 'sub' }, 'Every agent run and feedback round, newest first.'), await runsTable(await api('/runs?limit=200'))); }
async function healthPage() {
  await controls(); const checks = await api('/health');
  return shell('#/health', h('h1', {}, 'Health'), h('p', { class: 'sub' }, 'Everything the factory needs to run safely.'),
    checks.map((c) => h('div', { class: `note ${c.ok ? 'ok' : 'bad'}` }, h('strong', {}, c.ok ? '✓ ' : '✗ ', c.id), ': ', c.detail, c.fix ? h('div', { class: 'small' }, 'Fix: ', c.fix) : null)));
}

function login(msg) {
  const input = h('input', { type: 'password', placeholder: 'UI token', autocomplete: 'off' });
  const go = () => { token = input.value.trim(); try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ } render(); };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  $app.replaceChildren(h('div', { class: 'login card' }, h('h1', {}, 'Agent Factory'), h('p', { class: 'sub' }, 'Enter the UI token printed by ', h('code', {}, 'agent-factory start'), ' (also in ', h('code', {}, 'state/ui-token'), ').'), msg ? h('div', { class: 'note bad' }, msg) : null, input, h('div', { class: 'row gap' }, h('button', { class: 'primary', onclick: go }, 'Sign in'))));
}

let rendering = 0;
async function render() {
  if (!token) return login();
  const mine = ++rendering; const [, route = '', arg] = location.hash.slice(1).split('/');
  try {
    const page = route === '' ? await overview() : route === 'projects' ? await projectsPage() : route === 'project' ? await projectPage(arg) : route === 'new' ? await newProject()
      : route === 'runs' ? await runsPage() : route === 'health' ? await healthPage() : await overview();
    if (mine === rendering) { const keep = document.activeElement?.tagName; if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(keep)) { $app.replaceChildren(...page); controls().catch(() => {}); } }
  } catch (e) { if (e.auth) login(e.message); else $app.replaceChildren(...shell('', h('div', { class: 'note bad' }, e.message))); }
}
addEventListener('hashchange', () => { if (location.hash.startsWith('#/project/')) tab = 'queue'; render(); });
render(); setInterval(() => { if (document.visibilityState === 'visible' && !location.hash.startsWith('#/new')) render(); }, 6000);
