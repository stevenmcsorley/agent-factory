import { h, icon, api, toast, ago, dur, num, pct, ext, pill, act, STAGES, STATES, session, keyed, persist } from './lib.js';
export { act };
import { codeTab, openCode } from './code.js';
import { briefTab, planTab } from './pack.js';
import { trackerTab, ticketPage } from './tracker.js';
import { prRowsLocal, prPage, publishCard } from './forge.js';
import { createLine, odometer, miniBars, bars, barcode, stationGlyph } from './charts.js';

// Each view: load(arg) -> data (fetch everything it needs), draw(data, ctx) -> DOM nodes. The router re-draws only when data changes.
const since = (iso) => h('span', { class: 'since', 'data-since': iso }, dur(Date.now() - new Date(iso)));
const empty = (title, body, action) => h('div', { class: 'empty' }, h('div', { class: 'empty-art' }, icon('spark', 24)), h('b', {}, title), body ? h('p', {}, body) : null, action);
const card = (cls, ...kids) => h('section', { class: `card ${cls ?? ''}` }, ...kids);
const head = (title, sub, ...actions) => h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), h('div', { class: 'row' }, actions));
const ATTENTION = ['failed', 'needs-info', 'needs-human'];
const HOST_LABEL = { local: 'This machine', github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', git: 'git' }; const SRC_LABEL = { local: 'Built-in tracker', github: 'GitHub Issues', ossicone: 'Ossicone', jira: 'Jira', linear: 'Linear', file: 'file' };
// The pre-check only blocks tickets too short to act on. Anything else is fine: the agent proceeds on reasonable assumptions, or asks a specific
// question if the request is genuinely open-ended. So the live hint is encouraging, with an optional tip, never a scary refusal.
const hintFor = (r) => (r.ok ? h('span', { class: 'ok' }, icon('check', 14), ' Good to go', r.tips?.length ? h('span', { class: 'tip' }, ` · tip: ${r.tips[0]}`) : null)
  : h('span', { class: 'warn' }, icon('alert', 14), ' ', r.problems.join('; ')));
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
const woId = (id) => `WO-${String(id).toUpperCase()}`;

// ---- live pipeline (used on a run page while the run is in flight)
export function pipeline(run, { active = false } = {}) {
  const order = STAGES.map(([k]) => k); const reached = run.phases.map((p) => p.name);
  const cur = active ? run.phase : reached.at(-1); const ci = order.indexOf(cur);
  return h('ol', { class: 'pipe' }, STAGES.map(([k, label], i) => { const state = active ? (i < ci ? 'done' : i === ci ? 'active' : 'todo') : (reached.includes(k) ? 'done' : 'todo');
    return h('li', { class: `stage ${state}` }, h('span', { class: 'node' }, state === 'done' ? icon('check', 13) : i + 1), h('span', { class: 'lbl' }, label)); }));
}

// ---- quick ticket (lives in the Studio as "Add work to a project")
export function intake(projects, rerender) {
  const sel = h('select', { 'aria-label': 'Project' }, projects.map((p) => h('option', { value: p.id }, p.id)), h('option', { value: '__new' }, '+ new project…'));
  const title = h('input', { placeholder: 'What should the factory build or fix?', maxlength: 200, 'aria-label': 'Ticket title', autocomplete: 'off' });
  const body = h('textarea', { rows: 3, placeholder: 'Which files or functions, the expected behaviour, and how we will know it is done.', 'aria-label': 'Ticket details', hidden: true });
  const hint = h('div', { class: 'hint' }); let t;
  const check = () => { clearTimeout(t); t = setTimeout(async () => { if (!title.value && !body.value) return hint.replaceChildren(); try { const r = await api('/check-ticket', { method: 'POST', body: { title: title.value, body: body.value } });
    hint.replaceChildren(hintFor(r)); } catch { /* ignore */ } }, 300); };
  title.addEventListener('focus', () => { body.hidden = false; }); title.addEventListener('input', check); body.addEventListener('input', check);
  const go = act(async () => { if (sel.value === '__new') { location.hash = '#/new'; return; } await api(`/projects/${sel.value}/tickets`, { method: 'POST', body: { title: title.value, body: body.value } }); title.value = body.value = ''; hint.replaceChildren(); }, 'Work order issued. The factory picks it up on its next cycle.', rerender);
  return h('section', { class: 'card intake reg' }, h('div', { class: 'eyebrow' }, icon('spark', 13), 'Quick ticket', h('span', { class: 'kbd-hint' }, 'for a single, specific change')), h('span', { class: 'caret' }, '›'), title, body,
    h('div', { class: 'intake-foot' }, sel, hint, h('button', { class: 'btn primary', onclick: go }, 'Issue work order', icon('arrow', 14))));
}

// The line card lives for the whole page visit and is updated in place (see persist()).
function lineCard(state0) {
  const L = createLine(STAGES);
  const stamp = h('span', { class: 'stamp' }); const follow = h('a', { class: 'btn small', href: '#/', hidden: true }, 'Follow', icon('arrow', 12));
  const el = h('section', { class: 'card line-card reg' }, h('div', { class: 'line-head' }, h('h2', {}, 'The line'), h('div', { class: 'row' }, stamp, follow)), h('div', { class: 'stage-wrap' }, L.svg));
  el.__update = (st) => {
    L.update(st);
    stamp.className = `stamp ${st.active.length ? 'live' : st.paused ? 'warn' : ''}`;
    stamp.replaceChildren(...(st.active.length ? [h('i', { class: 'dot' }), `${st.active.length} on the line`] : [st.paused ? 'paused' : st.nextIn != null ? `idle · next check in ${st.nextIn}s` : 'idle']));
    follow.hidden = !st.active.length; if (st.active[0]) follow.href = `#/run/${st.active[0].run}`;
  };
  el.__update(state0); return el;
}

// Chart and log in one persistent grid: each half is swapped only when ITS data changed (a new log line must not rebuild the chart).
function outputSection(st0) {
  const chartSlot = h('div'), logSlot = h('div'); let cs = '', ls = ''; const el = h('div', { class: 'cols-2' }, chartSlot, logSlot);
  el.__update = ({ days, events }) => {
    const c = JSON.stringify(days); if (c !== cs) { cs = c; chartSlot.replaceChildren(card('', h('div', { class: 'card-h' }, h('h2', {}, 'Output · 14 days'), h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'sw ok' }), 'shipped'), h('span', {}, h('i', { class: 'sw bad' }), 'failed'), h('span', {}, h('i', { class: 'sw neu' }), 'needed info'))), bars(days))); }
    const l = JSON.stringify(events); if (l !== ls) { ls = l; const old = logSlot.querySelector('.log'); const top = old ? old.scrollTop : 0;
      logSlot.replaceChildren(card('', h('div', { class: 'card-h' }, h('h2', {}, 'Line log')), events.length ? h('div', { class: 'log' }, events.slice(0, 40).map(logRow)) : empty('Quiet', 'Events appear here as the factory works.'))); const nl = logSlot.querySelector('.log'); if (nl) nl.scrollTop = top; }
  };
  el.__update(st0); return el;
}

// ---- overview: the control room
export const overview = {
  async load() { const [status, projects, metrics, activity, runs] = await Promise.all([api('/status'), api('/overview'), api('/metrics?days=14'), api('/activity'), api('/runs?limit=7')]); return { status, projects, metrics, activity, runs }; },
  draw({ status: st, projects, metrics, activity, runs }, ctx) {
    const queued = projects.reduce((n, p) => n + (p.queue.ready ?? 0), 0), inReview = projects.reduce((n, p) => n + (p.queue.review ?? 0), 0);
    const attention = projects.reduce((n, p) => n + ATTENTION.reduce((a, k) => a + (p.queue[k] ?? 0), 0), 0);
    const t = metrics.totals, shipped = metrics.days.at(-1)?.ok ?? 0; const cap = st.today.maxRuns; const left = cap ? Math.max(0, cap - st.today.runs) : null;
    const ticks = cap ? Math.min(cap, 24) : 0, usedTicks = cap ? Math.round((st.today.runs / cap) * ticks) : 0;
    const nextIn = st.nextAt ? Math.max(0, Math.round((new Date(st.nextAt) - Date.now()) / 1000)) : null;
    const stable = (node, key, sig) => keyed(node, key, sig);
    return [
      stable(launcher(projects, st), 'launcher', [projects.length, st.lanes?.running?.length ?? 0, st.lanes?.parallel ?? 1, st.active]),
      persist('line', { queued, shipped, active: activity.active, paused: st.paused, nextIn }, lineCard),
      stable(h('section', { class: 'spec' },
        h('div', {}, h('span', { class: 'eyebrow' }, 'Shipped today'), h('div', { class: 'num orange' }, odometer(shipped, 2)), h('div', { class: 'foot' }, `${t.ok} PRs in 14 days`)),
        h('div', {}, h('span', { class: 'eyebrow' }, 'Success rate · 14d'), h('div', { class: `num ${t.successRate == null ? '' : t.successRate > 0.7 ? 'green' : t.successRate > 0.4 ? '' : 'red'}` }, t.successRate == null ? '–' : odometer(Math.round(t.successRate * 100), 1), t.successRate == null ? null : h('small', {}, '%')), h('div', { class: 'foot' }, `${t.ok} of ${t.runs} runs${t.failed ? ` · ${t.failed} failed` : ''}`)),
        h('div', {}, h('span', { class: 'eyebrow' }, 'Median time to PR'), h('div', { class: 'num' }, t.runs ? dur(t.p50Ms) : '–'), h('div', { class: 'foot' }, t.runs ? `mean ${dur(t.avgMs)}` : 'no runs yet')),
        h('a', { class: 'spec-link', href: '#/inbox', title: 'Open your inbox' }, h('span', { class: 'eyebrow' }, 'Waiting on you'), h('div', { class: `num ${attention ? 'red' : ''}` }, odometer(inReview, 1), h('small', {}, 'to review')), h('div', { class: 'foot' }, attention ? `${attention} stuck or need info` : 'nothing stuck', ' ', h('b', { class: 'go' }, inReview + attention ? 'Open inbox →' : ''))),
        h('div', {}, h('span', { class: 'eyebrow' }, 'Capacity today'), h('div', { class: 'num' }, left == null ? '∞' : odometer(left, 1), left == null ? null : h('small', {}, `of ${cap}`)), cap ? h('div', { class: 'cap' }, Array.from({ length: ticks }, (_, i) => h('i', { class: i < usedTicks ? 'on' : '' }))) : null, h('div', { class: 'foot' }, st.today.maxCostUsd ? `$${st.today.costUsd} of $${st.today.maxCostUsd}` : 'subscription: no cost reported'))),
        'spec', [shipped, t, left, inReview, attention, st.today.costUsd]),
      stable(planningStrip(projects), 'planning', projects.map((p) => [p.id, p.brief?.ready, p.plan?.status, p.plan?.done]),),
      stable(h('div', { class: 'page-head slim' }, h('h2', {}, 'Cells'), h('a', { class: 'btn small', href: '#/new' }, icon('plus', 12), 'Add project')), 'cellshead', 'x'),
      stable(projects.length ? h('div', { class: 'cells' }, projects.map(cell)) : card('', empty('No projects yet', 'Connect a repository and a ticket tracker to start the line.', h('a', { class: 'btn primary', href: '#/new' }, 'Add a project'))), 'cells', projects),
      persist('cols', { days: metrics.days, events: activity.events }, outputSection),
      stable(card('', h('div', { class: 'card-h' }, h('h2', {}, 'Recent work orders'), h('a', { href: '#/runs', class: 'small' }, 'All work orders →')), workOrders(runs)), 'orders', runs)];
  },
};

function cell(p) {
  const q = p.queue, attn = ATTENTION.reduce((a, k) => a + (q[k] ?? 0), 0); const state = p.paused ? 'off' : p.error || attn ? 'bad' : (q.working ?? 0) > 0 ? 'busy' : 'ok';
  const tally = (label, n, cls) => h('div', { class: n ? cls : 'z' }, h('b', {}, String(n).padStart(2, '0')), h('small', {}, label));
  return h('a', { class: `cell ${p.paused ? 'paused' : ''}`, href: `#/project/${p.id}` },
    h('div', { class: 'cell-top' }, h('i', { class: `lamp ${state}` }), h('h3', {}, p.id), p.paused ? h('span', { class: 'stamp warn' }, 'paused') : null), h('span', { class: 'repo' }, p.repo),
    h('div', { class: 'row' }, h('span', { class: 'tag' }, HOST_LABEL[p.host] ?? p.host), h('span', { class: 'tag' }, SRC_LABEL[p.source] ?? p.source)),
    p.metrics ? miniBars(p.metrics.spark) : h('div', { class: 'small muted', style: { margin: '14px 0' } }, 'No runs yet'), p.error ? h('div', { class: 'small', style: { color: 'var(--red)' } }, p.error) : null,
    h('div', { class: 'tally' }, tally('queued', q.ready ?? 0, 'hot'), tally('working', q.working ?? 0, 'hot'), tally('review', q.review ?? p.prs ?? 0, 'good'), tally('faults', attn, 'bad')));
}

function logRow(e) {
  const bad = e.type === 'end' && e.status !== 'ok'; const kind = bad ? 'bad' : e.type === 'end' ? 'ok' : e.type;
  const label = e.type === 'phase' ? e.phase : e.type === 'start' ? 'picked up' : e.status === 'ok' ? 'shipped' : e.status;
  return h('div', { class: `log-row ${kind}` }, h('time', {}, clock(e.at)), h('span', { class: 'p' }, label), h('span', { class: 'm' }, (e.title ?? `#${e.ticket ?? e.pr ?? ''}`), h('small', {}, e.project ?? '')));
}

function workOrders(runs) {
  if (!runs.length) return empty('No work orders yet', 'Issue one above and it will appear here.');
  return h('table', { class: 'wo' }, h('thead', {}, h('tr', {}, ['Order', 'Work', 'Result', 'Time', 'When'].map((x, i) => h('th', { class: i > 2 ? 'r' : '' }, x)))), h('tbody', {}, runs.map((r) => h('tr', {},
    h('td', { class: 'id' }, r.id ? h('a', { href: `#/run/${r.id}`, style: { color: 'inherit' } }, woId(r.id)) : '—'), h('td', {}, h('a', { href: r.id ? `#/run/${r.id}` : '#/runs' }, r.title ?? (r.round ? `Feedback on PR #${r.pr}` : `Ticket #${r.ticket}`)), h('small', { style: { display: 'block' } }, r.project ?? '')),
    h('td', {}, pill(r.status)), h('td', { class: 'r' }, r.finished ? dur(new Date(r.finished) - new Date(r.started)) : '–'), h('td', { class: 'r' }, ago(r.finished ?? r.started))))));
}

// ---- inbox: everything that needs a human
const STATE_LABEL = { 'needs-info': ['warn', 'Needs detail'], failed: ['bad', 'Failed'], 'needs-human': ['bad', 'Needs a human'], review: ['ok', 'Ready to review'] };
function decisionCard(it, ctx) {
  const lastFactory = [...(it.comments ?? [])].reverse().find((c) => c.factory);
  const reason = lastFactory?.body?.replace(/\*\*/g, '') ?? (it.run?.error ? `Last run: ${it.run.status} (${it.run.error})` : it.run ? `Last run: ${it.run.status}` : 'The factory stopped on this ticket.');
  const note = h('textarea', { rows: 3, placeholder: it.state === 'needs-info' ? 'Say exactly what should change and how we will know it is done: name the files or functions and the expected behaviour.' : 'Optional: add guidance for the retry, e.g. “use exponential backoff, and test the failure path”.' });
  const hint = h('div', { class: 'hint' }); let t;
  const check = () => { clearTimeout(t); t = setTimeout(async () => { const r = await api('/check-ticket', { method: 'POST', body: { title: it.title, body: `${it.body ?? ''}\n${note.value}` } }).catch(() => null); if (r) hint.replaceChildren(hintFor(r)); }, 300); };
  note.addEventListener('input', check);
  const base = `/projects/${it.project}/tickets/${it.id}`; const rerender = ctx.rerender;
  const [tone, label] = STATE_LABEL[it.state] ?? ['', it.state];
  return h('article', { class: `slip ${tone}` },
    h('div', { class: 'slip-top' }, h('span', { class: `stamp ${tone}` }, label), ext(it.url, `#${it.id}`, 'tid'), h('span', { class: 'tag' }, it.project), h('span', { class: 'muted small mono' }, ago(it.updatedAt)), it.run?.id ? h('a', { class: 'small', href: `#/run/${it.run.id}` }, 'Last work order →') : null),
    h('h3', {}, it.title),
    h('div', { class: 'why' }, h('span', { class: 'eyebrow' }, 'What the factory said'), h('p', {}, reason)),
    it.body ? h('details', { class: 'ticket-text' }, h('summary', {}, 'Ticket text'), h('pre', { class: 'log-pre wrap' }, it.body)) : null,
    h('label', {}, it.state === 'needs-info' ? 'Add the missing detail' : 'Add guidance (optional)'), note, hint,
    h('div', { class: 'row gap-t' },
      h('button', { class: 'btn primary', onclick: act(async () => { await api(`${base}/requeue`, { method: 'POST', body: { details: note.value } }); }, 'Back on the line. The factory will pick it up.', rerender) }, icon('play', 12), note.value || it.state !== 'needs-info' ? 'Requeue' : 'Requeue'),
      h('button', { class: 'btn', onclick: act(async () => { if (!note.value.trim()) throw new Error('Write a comment first'); await api(`${base}/comment`, { method: 'POST', body: { text: note.value } }); note.value = ''; }, 'Comment added to the ticket.', rerender) }, 'Just comment'),
      ext(it.url, [icon('arrow', 12), ' Open in tracker'], 'btn ghost'),
      h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Close “${it.title}”? You can reopen it in your tracker.`)) await act(() => api(`${base}/close`, { method: 'POST', body: {} }), 'Ticket closed.', rerender)(); } }, 'Close ticket')));
}
function reviewCard(it, ctx) {
  const base = `/projects/${it.project}/tickets/${it.id}`;
  return h('article', { class: 'slip ok' },
    h('div', { class: 'slip-top' }, h('span', { class: 'stamp ok' }, 'Ready to review'), ext(it.url, `#${it.id}`, 'tid'), h('span', { class: 'tag' }, it.project), h('span', { class: 'muted small mono' }, ago(it.updatedAt)), it.run?.id ? h('a', { class: 'small', href: `#/run/${it.run.id}` }, 'Work order →') : null),
    h('h3', {}, it.title),
    h('div', { class: 'row gap-t' }, it.pr ? ext(it.pr.url, [icon('pr', 13), ` Review PR #${it.pr.number}`], 'btn primary') : h('span', { class: 'muted small' }, 'PR link unavailable (it may have been merged or closed)'),
      h('button', { class: 'btn', onclick: async () => { if (confirm(`Mark “${it.title}” done by closing the ticket? Merge the PR first.`)) await act(() => api(`${base}/close`, { method: 'POST', body: {} }), 'Ticket closed.', ctx.rerender)(); } }, 'Done: close ticket')));
}
export const inboxPage = {
  async load() { return { inbox: await api('/inbox') }; },
  draw({ inbox }, ctx) {
    const dec = inbox.items.filter((i) => i.kind === 'decision'), rev = inbox.items.filter((i) => i.kind === 'review');
    const sec = (key, items, node) => keyed(node, key, items);
    return [head('Inbox', dec.length || rev.length ? `${dec.length} need${dec.length === 1 ? 's' : ''} a decision · ${rev.length} ready to review. Nothing here is merged for you.` : 'Nothing is waiting on you.'),
      inbox.errors.length ? h('div', { class: 'callout bad' }, icon('alert', 16), inbox.errors.map((e) => `${e.project}: ${e.error}`).join(' · ')) : null,
      !dec.length && !rev.length ? card('reg', empty('All clear', 'No tickets are stuck and no PRs are waiting. Issue a work order from the control room.', h('a', { class: 'btn primary', href: '#/' }, 'Back to the control room'))) : null,
      dec.length ? sec('decisions', dec, h('section', { class: 'slips' }, h('div', { class: 'page-head slim' }, h('h2', {}, `Needs your decision · ${dec.length}`)), dec.map((i) => decisionCard(i, ctx)))) : null,
      rev.length ? sec('reviews', rev, h('section', { class: 'slips' }, h('div', { class: 'page-head slim' }, h('h2', {}, `Ready to review · ${rev.length}`)), rev.map((i) => reviewCard(i, ctx)))) : null];
  },
};

// ---- all projects
export const projectsPage = {
  async load() { return { projects: await api('/overview') }; },
  draw({ projects }) { return [head('Cells', 'Each project is a work cell: a repository, a ticket source and its own queue.', h('a', { class: 'btn primary', href: '#/new' }, icon('plus', 13), 'Add project')),
    projects.length ? h('div', { class: 'cells' }, projects.map(cell)) : card('', empty('No projects yet', null, h('a', { class: 'btn primary', href: '#/new' }, 'Add one')))]; },
};

// ---- repository analysis ("code health"): A–E ratings from a fast heuristic scan (and it says so)
const RATING_LABEL = { size: 'Size', tests: 'Tests', duplication: 'Duplication', maintainability: 'Upkeep', security: 'Secrets' };
const RATING_HELP = { size: 'Smaller code is easier for an agent to work in', tests: 'Test code relative to source code', duplication: 'Repeated blocks across files', maintainability: 'Very large files and TODO/FIXME count', security: 'Committed keys or tokens' };
const SEV = { BLOCKER: 'bad', CRITICAL: 'bad', MAJOR: 'warn', MINOR: '', INFO: '' };
const qualityBlock = (q, history, { onInspect } = {}) => {
  if (!q) return null; const ok = q.gate.status === 'OK'; const pts = (history ?? []).map((x) => x.findings).filter((v) => Number.isFinite(v));
  return h('div', { class: 'quality' }, h('div', { class: 'card-h' }, h('h3', {}, 'Quality gate'), h('span', { class: `stamp ${ok ? 'ok' : 'bad'}` }, ok ? 'passed' : 'failed')),
    q.gate.failed?.length ? q.gate.failed.map((f) => h('div', { class: 'note bad' }, icon('x', 14), ' ', f)) : h('p', { class: 'muted small' }, 'No committed secrets, no critical findings, duplication within limits.'),
    h('div', { class: 'facts' }, [[q.counts.secrets, 'secrets'], [q.counts.vulnerabilities, 'vulnerabilities'], [q.counts.bugs, 'bugs'], [q.counts.smells, 'code smells']].map(([x, l]) => h('div', { class: 'fact' }, h('b', {}, num(x)), h('span', {}, l)))),
    pts.length > 1 ? h('div', { class: 'trend' }, miniBars(pts.slice(-20), { w: 240, h: 30 }), h('span', { class: 'muted small' }, `findings over the last ${Math.min(pts.length, 20)} analyses`)) : h('p', { class: 'muted small' }, 'A trend appears after the next analysis.'),
    onInspect && q.counts.total ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn small', onclick: () => onInspect('findings') }, `See all ${num(q.counts.total)} findings with the code →`)) : null);
};
const healthCard = (pr, { onReanalyze, verifyInput, job, onInspect } = {}) => {
  const running = job?.state === 'running';
  const reBtn = onReanalyze ? h('button', { class: 'btn', disabled: running, onclick: onReanalyze }, running ? `Analyzing… ${job.phase ?? ''}` : pr ? 'Re-analyze' : 'Analyze now') : null;
  if (job?.state === 'error' && !pr) pr = null;
  if (!pr) return card('', h('div', { class: 'card-h' }, h('h2', {}, 'Code health'), reBtn), job?.state === 'error' ? h('div', { class: 'note bad' }, icon('alert', 14), ' ', job.error) : null, h('p', { class: 'muted' }, 'This repository has not been analyzed yet.'));
  const m = pr.metrics;
  return card('health', h('div', { class: 'card-h' }, h('h2', {}, 'Code health'), h('span', { class: 'muted small mono' }, [pr.languages?.join(' · ') || 'no recognised language', pr.packageManager ? ` · ${pr.packageManager}` : '', pr.framework ? ` · ${pr.framework}` : ''].join('')), reBtn),
    job?.state === 'error' ? h('div', { class: 'note bad' }, icon('alert', 14), ' Last analysis failed: ', job.error) : null,
    pr.warnings?.length ? pr.warnings.map((w) => h('div', { class: 'note bad' }, icon('alert', 14), ' ', w)) : null,
    m ? h('div', { class: 'ratings' }, Object.entries(m.ratings).map(([k, v]) => h('div', { class: 'rating', title: RATING_HELP[k] }, h('b', { class: `grade r-${v}` }, v), h('span', {}, RATING_LABEL[k])))) : null,
    m ? h('div', { class: 'facts' }, [[num(m.codeLines), 'lines of code'], [num(m.sourceFiles), 'source files'], [`${m.testFiles} (${m.testRatioPct}%)`, 'test files'], [`${m.duplicatedPct}%`, 'duplicated'], [num(m.todoCount), 'TODO / FIXME']].map(([v, l]) => h('div', { class: 'fact' }, h('b', {}, v), h('span', {}, l)))) : null,
    h('div', { class: 'verify-row' }, h('label', {}, 'How changes are verified'), verifyInput ?? h('code', {}, pr.verify || 'nothing: pull requests will be unverified'), pr.verifyReason && !verifyInput ? h('span', { class: 'muted small' }, ` (${pr.verifyReason})`) : null),
    qualityBlock(pr.quality, pr.history, { onInspect }),
    (pr.notes ?? []).length ? h('ul', { class: 'plain notes' }, pr.notes.map((n) => h('li', { class: 'muted small' }, n))) : null,
    onInspect ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: () => onInspect('overview') }, 'Inspect the code in detail →'), m?.hotspots?.length ? h('span', { class: 'muted small' }, `largest file: ${m.hotspots[0].file} (${num(m.hotspots[0].lines)} lines)`) : null) : null);
};

// The Control room's front door: start something, and see what is being built right now.
const launcher = (projects, st) => {
  const running = st.lanes?.running ?? []; const cap = st.lanes?.parallel ?? 1;
  return h('section', { class: 'card launcher' }, h('div', {}, h('b', {}, 'What do you want to do?'), h('p', { class: 'muted small' }, projects.length ? 'Start a project from a brief, add work to one, or run a workflow such as shipping it.' : 'Start your first project: describe it, plan it, and let the line build it.')),
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/studio' }, icon('spark', 14), 'Open the Studio'), h('a', { class: 'btn', href: '#/new' }, icon('plus', 12), 'New project'), h('a', { class: 'btn', href: '#/portfolio' }, 'Portfolio'), h('a', { class: 'btn', href: '#/scenarios' }, 'Scenarios')),
    h('div', { class: 'lanes' }, h('span', { class: 'tile-l' }, `Building now · ${running.length} of ${cap} lane${cap === 1 ? '' : 's'}`), running.length ? running.map((id) => pill(id, 'warn')) : h('span', { class: 'muted small' }, 'the line is idle')));
};
// A one-glance status of the brief and the plan, with the next step, on the project's Board.
// On the Control room: which projects still need a brief or a plan decision (the planning features live in each project's Brief and Plan tabs).
const planningStrip = (projects) => {
  const needs = projects.filter((p) => !p.brief?.ready && !p.plan), waiting = projects.filter((p) => p.plan?.status === 'proposed'), ready = projects.filter((p) => p.brief?.ready && !p.plan);
  if (!projects.length || (!needs.length && !waiting.length && !ready.length)) return h('span', { class: 'hidden' });
  const bits = [waiting.length ? `${waiting.length} plan${waiting.length > 1 ? 's' : ''} waiting for your approval` : null, ready.length ? `${ready.length} project${ready.length > 1 ? 's' : ''} ready to plan` : null, needs.length ? `${needs.length} without a brief` : null].filter(Boolean);
  return h('section', { class: 'card banner info' }, h('div', {}, h('b', {}, 'Planning'), h('p', { class: 'muted small' }, `${bits.join(' · ')}. Briefs, plans and the reuse library are the new way to start and steer projects.`)), h('a', { class: 'btn', href: '#/portfolio' }, 'Open the portfolio'));
};
const planBanner = (p, go) => {
  const b = p.brief, pl = p.plan; let title, text, cta, tab, cls = 'info';
  if (!b?.ready && !pl) { title = 'This project has no brief yet'; text = 'Tell the factory what you are building (goal, scope, conventions) and attach the PRD, research or designs. Every agent run will use it, and it can plan the work for you.'; cta = 'Write the brief'; tab = 'brief'; cls = 'warn'; }
  else if (!pl) { title = 'Brief ready: draft a plan'; text = 'The agent can turn the brief into epics and small tickets for you to approve.'; cta = 'Draft a plan'; tab = 'plan'; }
  else if (pl.status === 'proposed') { title = `A plan is waiting for your approval (${pl.total} tickets)`; text = 'Review it, edit anything, then launch.'; cta = 'Review the plan'; tab = 'plan'; cls = 'warn'; }
  else { title = pl.status === 'complete' ? 'Plan complete' : `Plan in progress: ${pl.done} of ${pl.total} tickets done`; text = `${pl.review} in review · ${pl.queued + pl.working} building · ${pl.planned} not started`; cta = 'Open the plan'; tab = 'plan'; cls = pl.status === 'complete' ? 'ok' : 'info'; }
  return h('section', { class: `card banner ${cls}` }, h('div', {}, h('b', {}, title), h('p', { class: 'muted small' }, text)), h('button', { class: 'btn', onclick: () => go(tab) }, cta));
};
let pollT = null; const pollSoon = (ctx, ms = 3000) => { clearTimeout(pollT); pollT = setTimeout(() => { if (/^#\/(project|health)/.test(location.hash)) ctx.rerender(); }, ms); };
// ---- single project
let projTab = 'board'; let openPrNo = null; let openId = null; let openRef = () => {};
// Jump to a project and open a given tab (used by the Portfolio page).
export const goProject = (id, tab = 'board') => { projTab = tab; location.hash = `#/project/${id}`; };
export const project = {
  async load(id) { const [ov, runs, metrics] = await Promise.all([api('/overview'), api('/runs?limit=30&project=' + id), api('/metrics?days=14')]); const p = ov.find((x) => x.id === id);
    const extra = {}; if (p) { if (projTab === 'brief' || projTab === 'plan') extra.pack = await api(`/projects/${id}/pack`).catch(() => null); if (projTab === 'plan') extra.planData = await api(`/projects/${id}/plan`).catch(() => null);
    if (projTab === 'board' || projTab === 'code') extra.job = await api(`/projects/${id}/analyze`).catch(() => null); if (p.source === 'local' && projTab === 'tracker') [extra.tracker, extra.tickets] = await Promise.all([api(`/projects/${id}/tracker`), api(`/projects/${id}/tickets`)]); if (p.host === 'local' && projTab === 'prs') { extra.publish = await api(`/projects/${id}/publish`).catch(() => null); if (openPrNo) extra.prDetail = await api(`/projects/${id}/prs/${openPrNo}`).catch(() => null); }
    if (projTab === 'ticket' && openId) extra.ticket = await api(`/projects/${id}/tickets/${openId}`).catch(() => null);
    if (projTab === 'board' || projTab === 'prs') [extra.tickets, extra.prs] = await Promise.all([api(`/projects/${id}/tickets`).catch(() => []), api(`/projects/${id}/prs`).catch(() => [])]); if (projTab === 'log') extra.log = (await api(`/projects/${id}/log`)).lines; }
    return { id, p, runs, metrics, tab: projTab, ...extra }; },
  draw(d, ctx) {
    const { id, p } = d; if (!p) return [card('', empty('No such project', `“${id}” is not registered.`, h('a', { class: 'btn', href: '#/projects' }, 'Back to cells')))];
    if (d.job?.state === 'running') pollSoon(ctx);
    const m = d.metrics.projects[id]; openRef = (tid) => { openId = tid; projTab = 'ticket'; ctx.rerender(); };
    const tabs = [['board', 'Board'], ...(p.source === 'local' ? [['tracker', 'Tracker']] : []), ['plan', 'Plan'], ['brief', 'Brief'], ['prs', 'Pull requests'], ['runs', 'Work orders'], ['code', 'Code'], ['log', 'Log']];
    const body = d.tab === 'tracker' ? trackerTab(d.tracker, d.tickets, { open: openRef }) : d.tab === 'ticket' ? (d.ticket ? ticketPage(d.ticket, { id, back: () => { projTab = p.source === 'local' ? 'tracker' : 'board'; ctx.rerender(); }, rerender: ctx.rerender, open: openRef }) : empty('Could not load that ticket', '')) : d.tab === 'board' ? board(d.tickets, p.source === 'local' ? openRef : null) : d.tab === 'prs' ? (p.host === 'local' ? (openPrNo ? (d.prDetail ? prPage(d.prDetail, { id, back: () => { openPrNo = null; ctx.rerender(); }, rerender: ctx.rerender }) : empty('Could not load that pull request', '')) : [prRowsLocal(d.prs, { open: (n) => { openPrNo = n; ctx.rerender(); } }), d.publish ? publishCard(d.publish, { id, rerender: ctx.rerender }) : null]) : prsList(d.prs)) : d.tab === 'runs' ? card('', workOrders(d.runs)) : d.tab === 'new' ? ticketForm(id, ctx) : d.tab === 'brief' ? (d.pack ? briefTab(d.pack, { id, rerender: ctx.rerender }) : empty('Could not load the brief', '')) : d.tab === 'plan' ? (d.pack && d.planData ? planTab(d.planData, d.pack, { id, rerender: ctx.rerender, poll: (ms) => pollSoon(ctx, ms), openBrief: () => { projTab = 'brief'; ctx.rerender(); } }) : empty('Could not load the plan', '')) : d.tab === 'code' ? codeTab(p.profile, { proj: p, job: d.job, onReanalyze: act(() => api(`/projects/${id}/analyze`, { method: 'POST', body: {} }), 'Analysis started', ctx.rerender), onVerify: (body) => act(() => api(`/projects/${id}/verify`, { method: 'POST', body }), 'Saved', ctx.rerender)(), onIgnore: (body) => act(() => api(`/projects/${id}/analysis-ignore`, { method: 'POST', body }), 'Saved. Re-analyzing…', ctx.rerender)(), onFix: (i) => act(() => api(`/projects/${id}/finding-ticket`, { method: 'POST', body: { key: i.key } }), 'Queued as a new ticket', ctx.rerender)() }) : h('pre', { class: 'log-pre' }, d.log.join('\n') || 'No log yet.');
    const attn = ATTENTION.reduce((a, k) => a + (p.queue[k] ?? 0), 0); const state = p.paused ? 'off' : attn || p.error ? 'bad' : (p.queue.working ?? 0) ? 'busy' : 'ok';
    return [h('a', { class: 'back', href: '#/projects' }, icon('arrow', 12, 'flip'), 'All cells'),
      h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'row' }, h('i', { class: `lamp ${state}` }), h('h1', {}, id)),
        h('div', { class: 'proj-meta' }, ext(p.repoUrl, [icon('git', 14), p.repo], 'repo-link'), h('span', { class: 'tag' }, HOST_LABEL[p.host] ?? p.host), h('span', { class: 'tag' }, `tickets · ${SRC_LABEL[p.source] ?? p.source}`), h('span', { class: 'tag' }, `base ${p.base}`), p.paused ? h('span', { class: 'stamp warn' }, 'paused') : null,
          m ? h('span', { class: 'muted small mono' }, `${m.ok}/${m.runs} shipped${m.avgMs ? ` · avg ${dur(m.avgMs)}` : ''}`) : null)),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { projTab = 'new'; ctx.rerender(); } }, icon('plus', 12), 'New ticket'), h('button', { class: 'btn', onclick: act(() => api(`/projects/${id}/${p.paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} }), p.paused ? 'Cell resumed' : 'Cell paused', ctx.rerender) }, icon(p.paused ? 'play' : 'pause', 12), p.paused ? 'Resume' : 'Pause'),
          h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Remove ${id} from the factory? The repository itself is untouched.`)) { await act(() => api(`/projects/${id}`, { method: 'DELETE' }), 'Removed')(); location.hash = '#/projects'; } } }, 'Remove'))),
      h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, t]) => h('button', { role: 'tab', 'aria-selected': String(d.tab === k), class: d.tab === k ? 'on' : '', onclick: () => { projTab = k; openPrNo = null; ctx.rerender(); } }, t))), d.tab === 'board' ? planBanner(p, (t) => { projTab = t; ctx.rerender(); }) : null, d.tab === 'board' ? healthCard(p.profile, { job: d.job, onReanalyze: act(() => api(`/projects/${id}/analyze`, { method: 'POST', body: {} }), 'Analysis started', ctx.rerender), onInspect: (sub) => { openCode(sub); projTab = 'code'; ctx.rerender(); } }) : null, body]; },
};

function board(tickets, openTicket) {
  const cols = [['ready', 'Hopper', 'info'], ['working', 'On the line', 'live'], ['review', 'In review', 'ok'], ['attn', 'Faults', 'bad']];
  const bucket = (t) => { const s2 = stateOfLabels(t.labels); return ATTENTION.includes(s2) ? 'attn' : s2; };
  const open = tickets.filter((t) => t.state !== 'CLOSED'), done = tickets.filter((t) => t.state === 'CLOSED');
  const column = ([k, label, tone]) => { const items = open.filter((t) => bucket(t) === k);
    return h('div', { class: `col ${tone}` }, h('div', { class: 'col-h' }, h('span', {}, label), h('span', { class: 'count' }, items.length)),
      h('div', { class: 'items' }, items.length ? items.map((t) => h('div', { class: 'tcard' }, h('div', { class: 'row between' }, (openTicket ? h('button', { class: 'linklike tid', onclick: () => openTicket(t.id) }, `#${t.id}`) : ext(t.url, `#${t.id}`, 'tid')), k === 'attn' ? h('span', { class: `stamp ${STATES[stateOfLabels(t.labels)]?.[0] ?? ''}` }, STATES[stateOfLabels(t.labels)]?.[1] ?? '') : null), h('div', { class: 'ttitle' }, t.title), h('small', { class: 'mono' }, ago(t.updatedAt)))) : h('div', { class: 'col-empty' }, k === 'ready' ? 'Hopper empty' : 'Clear'))); };
  return [h('div', { class: 'board' }, cols.map(column)), done.length ? h('details', { class: 'closed' }, h('summary', {}, `${done.length} closed`), h('ul', { class: 'plain' }, done.map((t) => h('li', {}, ext(t.url, `#${t.id}`, 'tid'), ' ', t.title)))) : null];
}
const stateOfLabels = (labels = []) => ['agent-needs-human', 'agent-failed', 'agent-needs-info', 'agent-review', 'agent-working', 'agent-ready'].find((l) => labels.includes(l))?.replace('agent-', '') ?? 'other';
const prRow = (x) => h('li', {}, h('div', { class: 'run-row' }, icon('pr', 18), h('div', { class: 'grow' }, ext(x.url, `#${x.number} ${x.title}`, 'tid'), h('small', {}, x.branch)), h('span', { class: 'stamp ok' }, 'draft')));
const prsList = (prs) => card('', prs.length ? h('ul', { class: 'runs' }, prs.map(prRow)) : empty('No open agent pull requests', 'PRs appear here when the factory finishes a ticket.'));

function ticketForm(id, ctx) {
  const title = h('input', { placeholder: 'Short title', maxlength: 200 }), body = h('textarea', { rows: 6, placeholder: 'What should change, and how will we know it is done? Name files/functions and expected behaviour.' }), hint = h('div', { class: 'hint' }); let t;
  const check = () => { clearTimeout(t); t = setTimeout(async () => { if (!title.value && !body.value) return hint.replaceChildren(); const r = await api('/check-ticket', { method: 'POST', body: { title: title.value, body: body.value } }).catch(() => null); if (r) hint.replaceChildren(hintFor(r)); }, 300); };
  title.addEventListener('input', check); body.addEventListener('input', check);
  return card('form', h('label', {}, 'Title'), title, h('label', {}, 'Details'), body, hint, h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { await api(`/projects/${id}/tickets`, { method: 'POST', body: { title: title.value, body: body.value } }); title.value = body.value = ''; projTab = 'board'; }, 'Work order issued.', ctx.rerender) }, 'Issue work order'), h('span', { class: 'muted small' }, 'Creates a ticket labelled agent-ready in your tracker.')));
}

// ---- run detail: the work-order traveler
export const runPage = {
  async load(id) { const [run, activity] = await Promise.all([api(`/runs/${id}`).catch(() => null), api('/activity')]); return { id, run, live: activity.active.find((a) => a.run === id) }; },
  draw({ id, run, live }) {
    if (!run && !live) return [card('', empty('Work order not found', `No run “${id}”.`, h('a', { class: 'btn', href: '#/runs' }, 'All work orders')))];
    if (!run) return [head(live.title ?? woId(id), `${live.project} · on the line now`), card('reg', h('div', { class: 'card-h' }, h('h2', {}, 'Route')), pipeline(live, { active: true }), h('p', { class: 'muted mono small' }, 'In progress… ', since(live.started)))];
    const ms = run.finished ? new Date(run.finished) - new Date(run.started) : null; const ok = run.status === 'ok';
    const verdict = ok ? ['ok', 'Shipped', 'PR opened'] : ['needs-info', 'repo-not-allowed', 'stopped', 'budget-exhausted'].includes(run.status) ? ['warn', 'Held', (OUT[run.status] ?? run.status)] : ['bad', 'Rejected', OUT[run.status] ?? run.status];
    const link = run.prLink ?? (typeof run.pr === 'string' ? run.pr : null);
    const reached = run.phases.map((p) => p.name); const maxMs = Math.max(1, ...run.phases.map((p) => p.ms ?? 0));
    return [h('a', { class: 'back', href: `#/project/${run.project}` }, icon('arrow', 12, 'flip'), run.project),
      h('div', { class: 'wo-head' }, h('div', {}, h('span', { class: 'wo-id' }, `Work order ${woId(run.id)}`), h('h1', {}, run.title ?? woId(run.id)), h('p', { class: 'sub mono small' }, `${run.round ? `Feedback round ${run.round} · ` : ''}${new Date(run.started).toLocaleString()}`), barcode(run.id), h('div', { class: 'row gap-t' }, link ? ext(link, [icon('pr', 13), ' Open pull request'], 'btn primary') : null)),
        h('div', { class: `rubber ${verdict[0]}` }, verdict[1], h('small', {}, verdict[2]))),
      h('div', { class: 'stats' }, stat('Duration', dur(ms)), stat('Attempts', run.attempts ?? run.round ?? '–'), stat('Files changed', run.changed?.length ?? 0), stat('Tokens', run.tokens ? num(run.tokens.input + run.tokens.output) : '–'), stat('Cost', run.costUsd ? `$${run.costUsd.toFixed(3)}` : '–')),
      card('reg', h('div', { class: 'card-h' }, h('h2', {}, 'Route sheet')), h('ol', { class: 'route' }, STAGES.map(([k, label], i) => { const ph = run.phases.find((p) => p.name === k); const last = reached.at(-1) === k && !ok;
        return h('li', { class: ph ? (last ? 'bad' : 'done') : 'todo' }, h('span', { class: 'n' }, ph ? (last ? icon('x', 14) : icon('check', 14)) : `0${i + 1}`), h('span', { class: 'pn' }, stationGlyph(k, 22), label, ph?.detail ? h('small', {}, String(ph.detail).slice(0, 60)) : null),
          h('div', { class: `bar-x ph-${k}` }, ph ? h('i', { style: { width: `${Math.max(3, ((ph.ms ?? 0) / maxMs) * 100)}%` } }) : null), h('span', { class: 't' }, ph ? dur(ph.ms) : '–')); }))),
      run.error ? h('div', { class: 'callout bad' }, icon('alert', 16), run.error) : null,
      run.assumptions ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Assumptions the agent made'), h('span', { class: 'stamp warn' }, 'please check')), h('pre', { class: 'log-pre wrap' }, run.assumptions)) : null,
      run.question ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'What the agent asked'), h('span', { class: 'stamp warn' }, 'needs your answer')), h('pre', { class: 'log-pre wrap' }, run.question), h('div', { class: 'row gap-t' }, h('a', { class: 'btn primary', href: '#/inbox' }, 'Answer in the inbox'))) : null,
      h('div', { class: 'cols-2' },
        run.agentSummary ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Operator notes')), h('pre', { class: 'log-pre wrap' }, run.agentSummary)) : null,
        run.changed?.length ? card('', h('div', { class: 'card-h' }, h('h2', {}, `Parts changed · ${run.changed.length}`)), h('div', { class: 'files' }, run.changed.map((f) => h('code', {}, f)))) : null),
      (run.briefRev || run.commit || run.verifyCmd) ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Built from, and what was checked')), h('ul', { class: 'plain' },
        run.briefRev ? h('li', { class: 'small' }, 'Brief revision ', h('code', {}, run.briefRev)) : null, run.verifyCmd ? h('li', { class: 'small' }, h('code', {}, run.verifyCmd), ' passed on the working tree committed as ', h('code', {}, String(run.commit ?? '').slice(0, 10) || 'this branch')) : h('li', { class: 'small muted' }, 'No verify command was available: this change was not machine-checked.'),
        h('li', { class: 'small muted' }, 'A pass belongs to the revision it names. If the branch changes afterwards, it no longer applies.'))) : null,
      run.quality ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Quality gate on this change'), h('span', { class: `stamp ${run.quality.status === 'OK' ? 'ok' : run.quality.status === 'WARN' ? 'warn' : 'bad'}` }, run.quality.status === 'OK' ? 'passed' : run.quality.status === 'WARN' ? 'flagged' : 'blocked')),
        h('p', { class: 'muted small' }, `Only the lines this run added or changed were checked (${run.quality.files} file${run.quality.files === 1 ? '' : 's'}).`),
        [...(run.quality.blockers ?? []), ...(run.quality.warnings ?? [])].map((m) => h('div', { class: 'note bad' }, icon('x', 14), ' ', m)),
        run.quality.findings?.length ? h('ul', { class: 'plain issues' }, run.quality.findings.map((i) => h('li', {}, h('span', { class: `stamp ${SEV[i.severity] ?? ''}` }, i.severity.toLowerCase()), h('span', { class: 'small' }, i.message), h('span', { class: 'mono muted small' }, `${i.file}:${i.line}`), i.snippet ? h('code', { class: 'snip-line' }, i.snippet) : null))) : h('p', { class: 'muted small' }, 'No new secrets, vulnerabilities or bugs.')) : null,
      run.verifyTail ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Quality check'), h('span', { class: `stamp ${ok ? 'ok' : 'bad'}` }, ok ? 'passed' : 'see output')), h('pre', { class: `log-pre ${ok ? 'good' : 'fail'}` }, run.verifyTail)) : null]; },
};
const OUT = { 'verify-failed': 'Tests failed', timeout: 'Timed out', error: 'Error', 'no-change': 'No change', 'protected-path': 'Protected path', 'needs-info': 'Needs info', 'repo-not-allowed': 'Repo not allowed', stopped: 'Paused', 'budget-exhausted': 'Budget reached' };
const stat = (l, v) => h('div', { class: 'stat' }, h('span', { class: 'eyebrow' }, l), h('b', {}, String(v)));

// ---- all work orders
let runFilter = 'all';
export const runsPage = {
  async load() { return { runs: await api('/runs?limit=300') }; },
  draw({ runs }, ctx) {
    const f = { all: () => true, ok: (r) => r.status === 'ok', failed: (r) => !['ok', 'needs-info', 'stopped', 'budget-exhausted', 'recovered-requeued', 'repo-not-allowed'].includes(r.status), info: (r) => ['needs-info', 'repo-not-allowed'].includes(r.status) };
    const shown = runs.filter(f[runFilter]);
    return [head('Work orders', 'Every agent run and feedback round, newest first.'),
      h('div', { class: 'seg' }, [['all', 'All'], ['ok', 'Shipped'], ['failed', 'Failed'], ['info', 'Needed info']].map(([k, t]) => h('button', { class: runFilter === k ? 'on' : '', onclick: () => { runFilter = k; ctx.rerender(); } }, t))),
      card('', shown.length ? workOrders(shown) : empty('No work orders match', null))]; },
};

// ---- connect (MCP)
export const connect = {
  async load() { return { info: await api('/connect') }; },
  draw({ info }) {
    const origin = location.origin; const tok = session.token; let shown = false;
    const copy = (text, label) => h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(text); toast(`${label} copied`, 'ok'); } catch { toast('Copy failed: select and copy manually', 'bad'); } } }, icon('copy', 13), 'Copy');
    // The snippet SHOWS a placeholder but COPIES the real token, so the secret is never on screen by accident.
    const code = (text) => h('div', { class: 'snip' }, h('pre', {}, text.split(tok).join('<your-token>')), copy(text, 'Snippet (with your token)'));
    const tokenView = h('code', { class: 'tok' }, '•'.repeat(24)); const reveal = h('button', { class: 'btn small', onclick: () => { shown = !shown; tokenView.textContent = shown ? tok : '•'.repeat(24); reveal.textContent = shown ? 'Hide' : 'Reveal'; } }, 'Reveal');
    const cmd = (path, name) => `claude mcp add --transport http ${name} ${origin}${path} --header "Authorization: Bearer ${tok}"`;
    const max = Math.max(info.directTokens, info.codeTokens);
    return [head('Connect an AI', 'Drive the factory by prompt from Claude, ChatGPT or any MCP client: “create a project that…”, “what is the factory doing?”, “queue a fix for…”.'),
      card('', h('div', { class: 'card-h' }, h('h2', {}, icon('shield', 17), 'Your access token'), h('div', { class: 'row' }, tokenView, reveal, copy(tok, 'Token'))), h('p', { class: 'muted small' }, 'Treat it like a password: anyone with it can queue work. It never leaves this machine unless you paste it somewhere. Rotate it by deleting ', h('code', {}, 'state/ui-token'), ' and restarting.')),
      h('div', { class: 'cols-2' },
        card('', h('div', { class: 'card-h' }, h('h2', {}, icon('plug', 17), 'Code Mode (recommended)'), h('span', { class: info.codeAvailable ? 'stamp ok' : 'stamp warn' }, info.codeAvailable ? 'ready' : 'needs quickjs')), h('p', {}, 'Two tools: ', h('code', {}, 'search'), ' and ', h('code', {}, 'execute'), '. The AI writes a few lines of JavaScript that run in a sandbox, so a whole workflow costs a fraction of the tokens.'), h('div', { class: 'row' }, h('code', { class: 'url' }, `${origin}/mcp-code`), copy(`${origin}/mcp-code`, 'URL')), code(cmd('/mcp-code', 'agent-factory'))),
        card('', h('div', { class: 'card-h' }, h('h2', {}, icon('plug', 17), `Direct tools (${info.directTools})`)), h('p', {}, 'One tool per operation. Simpler for small clients, but the tool list is larger.'), h('div', { class: 'row' }, h('code', { class: 'url' }, `${origin}/mcp`), copy(`${origin}/mcp`, 'URL')), code(cmd('/mcp', 'agent-factory-direct')))),
      card('', h('div', { class: 'card-h' }, h('h2', {}, 'What each costs your AI in context, every session')),
        h('div', { class: 'cmp' }, [['Direct tools', info.directTokens, 'info'], ['Code Mode', info.codeTokens, 'ok']].map(([l, n, tone]) => h('div', { class: 'cmp-row' }, h('span', {}, l), h('div', { class: 'cmp-bar' }, h('i', { class: tone, style: { width: `${(n / max) * 100}%` } })), h('b', {}, `~${num(n)} tokens`))))),
      card('', h('div', { class: 'card-h' }, h('h2', {}, 'Claude Desktop / other clients')), code(JSON.stringify({ mcpServers: { 'agent-factory': { command: 'npx', args: ['-y', 'mcp-remote', `${origin}/mcp-code`, '--header', `Authorization: Bearer ${tok}`] } } }, null, 2)),
        h('p', { class: 'muted small' }, 'ChatGPT connectors need a public HTTPS URL and OAuth, which this local server does not provide yet. Use Claude Code/Desktop, or any client that supports a bearer token.'))]; },
};

// ---- health
export const health = {
  async load() { return { checks: await api('/health') }; },
  draw({ checks }) { const bad = checks.filter((c) => !c.ok).length;
    return [head('Health', bad ? `${bad} thing${bad > 1 ? 's' : ''} to fix before the factory can run safely.` : 'Every system the factory needs is in place.'),
      h('div', { class: 'checks' }, checks.map((c) => h('div', { class: 'card check' }, h('i', { class: `lamp ${c.ok ? 'ok' : 'bad'}` }), h('b', {}, c.id), h('p', { class: 'small' }, c.detail), c.fix ? h('div', { class: 'fix' }, h('small', { class: 'eyebrow' }, 'Fix'), h('code', {}, c.fix)) : null)))]; },
};

// ---- add / create project
// The wizard is driven by /api/catalog, so a new tracker or code host appears here automatically once it is registered on the server.
let npMode = 'create';   // the Studio's "New project" lands on the brief-first form; "Connect an existing repo" sets sessionStorage np=existing
const wiz = { host: { kind: 'github', fields: {}, token: '' }, repo: '', hostCheck: null, source: { kind: 'github', fields: {}, token: '', pick: '' }, srcCheck: null, signup: null, id: '', base: '', analysis: null, verify: '' };
const slugId = (r) => (r.split(/[?#]/)[0].replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/:]/).pop() || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');

export const newProject = {
  async load() { const [catalog, who] = await Promise.all([api('/catalog'), api('/whoami').catch(() => ({ login: '' }))]); return { catalog, who, templates: await api('/templates') }; },
  draw({ catalog, who, templates }, ctx) {
    try { const m = sessionStorage.getItem('np'); if (m === 'existing' || m === 'create') { npMode = m; sessionStorage.removeItem('np'); } } catch { /* storage unavailable */ }
    const box = h('div', {});
    const hostDef = () => catalog.hosts.find((x) => x.kind === wiz.host.kind); const srcDef = () => catalog.sources.find((x) => x.kind === wiz.source.kind);
    const paint = () => box.replaceChildren(...[].concat(npMode === 'existing' ? existing() : create()));

    const fieldRow = (def, st, onChange) => {
      if (def.showIf && Object.entries(def.showIf).some(([k, v]) => (st.fields[k] ?? catalogDefault(st, k)) !== v)) return null;
      const val = def.secret ? st.token : (st.fields[def.key] ?? def.default ?? '');
      const input = def.type === 'select' ? h('select', { onchange: (e) => { st.fields[def.key] = e.target.value; paint(); } }, def.options.map((o) => h('option', { value: o, selected: o === val }, o)))
        : h('input', { type: def.secret ? 'password' : 'text', value: val, placeholder: def.placeholder ?? '', autocomplete: 'off', spellcheck: 'false', oninput: (e) => { def.secret ? (st.token = e.target.value) : (st.fields[def.key] = e.target.value); onChange?.(); }, onblur: () => def.key === 'baseUrl' && st === wiz.source && wiz.source.kind === 'ossicone' && probeSignup() });
      return h('div', {}, h('label', {}, def.label, def.required ? ' *' : ''), input, def.help ? h('small', { class: 'help' }, def.help) : null);
    };
    const catalogDefault = (st, k) => (st === wiz.source ? srcDef() : hostDef()).fields.find((f) => f.key === k)?.default;
    const probeSignup = async () => { const u = wiz.source.fields.baseUrl; if (!u) return; try { wiz.signup = await api('/sources/signup-info', { method: 'POST', body: { baseUrl: u } }); } catch (e) { wiz.signup = { error: e.message }; } paint(); };
    const check = (ok, msg) => h('div', { class: `note ${ok ? 'ok' : 'bad'}` }, icon(ok ? 'check' : 'x', 14), ' ', msg);

    const hostCard = (hh) => h('button', { class: `opt ${wiz.host.kind === hh.kind ? 'on' : ''}`, onclick: () => { wiz.host = { kind: hh.kind, fields: {}, token: '' }; wiz.hostCheck = null; if (hh.kind !== 'github' && wiz.source.kind === 'github') { wiz.source = { kind: 'ossicone', fields: {}, token: '', pick: '' }; wiz.srcCheck = null; } paint(); } }, h('b', {}, hh.label), h('small', {}, hh.blurb));
    const srcCard = (ss) => { const blocked = ss.kind === 'github' && wiz.host.kind !== 'github';
      return h('button', { class: `opt ${wiz.source.kind === ss.kind ? 'on' : ''}`, disabled: blocked, title: blocked ? 'GitHub Issues only works with a GitHub repository' : '', onclick: () => { wiz.source = { kind: ss.kind, fields: {}, token: '', pick: '' }; wiz.srcCheck = null; wiz.signup = null; paint(); } }, h('b', {}, ss.label), h('small', {}, blocked ? 'Needs a GitHub repository' : ss.blurb)); };

    const signupPanel = () => { const sg = wiz.signup; if (!sg && !wiz.source.fields.baseUrl) return null;
      return h('div', { class: 'note info' }, h('b', {}, 'Account & token'),
        !sg ? h('p', {}, 'Enter the URL above to check whether you can sign up on that server.') : sg.error ? h('p', {}, sg.error) : !sg.reachable ? h('p', {}, 'Could not reach that server. Check the URL, or run your own Ossicone (docker compose up).')
          : h('div', {}, h('p', {}, sg.openSignup ? 'New accounts can be created on this server.' : 'This server does not allow self-service sign-up. Ask its administrator for an account.'),
            h('div', { class: 'row' }, sg.openSignup ? ext(sg.registerUrl, [icon('plus', 13), ' Create an account'], 'btn small') : null, ext(sg.loginUrl, 'Sign in', 'btn small'), ext(sg.tokenUrl, [icon('plug', 13), ' Get an API token'], 'btn small')),
            h('p', { class: 'small muted' }, 'Sign in, open the AI Agent page, click Generate token (read + write), and paste it above.')));
    };

    const existing = () => {
      const hd = hostDef(), sd = srcDef();
      const repoInput = h('input', { value: wiz.repo, placeholder: hd.repoHint ?? 'owner/name', oninput: (e) => { wiz.repo = e.target.value; wiz.analysis = null; wiz.hostCheck = null; if (!wiz.id) wiz.idAuto = true; } });
      const runAnalysis = async () => { wiz.analysis = { loading: true }; paint(); wiz.analysis = await api('/hosts/analyze', { method: 'POST', body: { kind: wiz.host.kind, fields: wiz.host.fields, token: wiz.host.token, repo: wiz.repo.trim(), base: wiz.base.trim() || undefined } }).catch((e) => ({ error: e.message })); wiz.verify = wiz.analysis.profile?.verify ?? ''; paint(); };
      const testHost = h('button', { class: 'btn', onclick: act(async () => { wiz.hostCheck = await api('/hosts/test', { method: 'POST', body: { kind: wiz.host.kind, fields: wiz.host.fields, token: wiz.host.token, repo: wiz.repo.trim() } }).catch((e) => ({ error: e.message })); if (wiz.hostCheck.repo) wiz.repo = wiz.hostCheck.repo; /* show the canonical owner/name */ wiz.analysis = null; paint(); if (!wiz.hostCheck.error) runAnalysis(); }) }, 'Check access');
      const testSrc = h('button', { class: 'btn', onclick: act(async () => { wiz.srcCheck = await api('/sources/test', { method: 'POST', body: { kind: wiz.source.kind, fields: wiz.source.fields, token: wiz.source.token } }).catch((e) => ({ error: e.message })); if (wiz.srcCheck.projects?.length && !wiz.source.pick) wiz.source.pick = String(wiz.srcCheck.projects[0].id); paint(); }) }, sd.kind === 'github' ? 'Check' : 'Test connection');
      const ready = wiz.hostCheck && !wiz.hostCheck.error && (sd.kind === 'github' || (wiz.srcCheck && !wiz.srcCheck.error && (!sd.pick || wiz.source.pick)));
      const name = h('input', { value: wiz.id || slugId(wiz.repo), placeholder: 'short-name', oninput: (e) => { wiz.id = e.target.value; } });
      const base = h('input', { value: wiz.base, placeholder: wiz.hostCheck?.defaultBranch ? `${wiz.hostCheck.defaultBranch} (detected)` : 'default branch (detected)', oninput: (e) => { wiz.base = e.target.value; } });
      const add = h('button', { class: 'btn primary', disabled: !ready, onclick: act(async () => {
        const id = (wiz.id || slugId(wiz.repo)); const body = { id, repo: wiz.repo.trim(), ...(wiz.base.trim() ? { base: wiz.base.trim() } : {}),
          ...(wiz.host.kind !== 'github' ? { host: { kind: wiz.host.kind, ...wiz.host.fields }, hostSecret: wiz.host.token || undefined } : {}),
          source: { kind: wiz.source.kind, fields: wiz.source.fields, ...(sd.pick ? { pick: wiz.source.pick } : {}) }, ...(wiz.source.token ? { secret: wiz.source.token } : {}),
          ...(wiz.analysis?.profile ? { profile: wiz.analysis.profile, ...(wiz.verify.trim() && wiz.verify.trim() !== wiz.analysis.profile.verify ? { verify: wiz.verify.trim() } : {}) } : {}) };
        const r = await api('/projects', { method: 'POST', body }); wiz.host.token = wiz.source.token = ''; wiz.analysis = null; wiz.verify = ''; location.hash = `#/project/${r.id}`; }, 'Project added') }, icon('plus', 15), 'Add project');
      return h('div', { class: 'wiz' },
        card('step', h('div', { class: 'step-h' }, h('span', { class: 'sn' }, '1'), h('div', {}, h('h2', {}, 'Where does your code live?'), h('p', { class: 'muted small' }, 'The factory pushes a branch and opens a draft pull request here. It never merges.'))),
          h('div', { class: 'opts' }, catalog.hosts.map(hostCard)), h('div', { class: 'fields' }, hd.fields.map((f) => fieldRow(f, wiz.host))),
          h('label', {}, 'Repository *'), h('div', { class: 'row nowrap' }, repoInput, testHost), wiz.hostCheck ? (wiz.hostCheck.error ? check(false, wiz.hostCheck.error) : check(true, `Connected as ${wiz.hostCheck.user} · default branch ${wiz.hostCheck.defaultBranch} · ${wiz.hostCheck.private ? 'private' : 'public'}${wiz.hostCheck.supportsPrs === false ? ' · no PR automation (a branch is pushed for you to open a PR)' : ''}`)) : null),
        wiz.analysis ? (wiz.analysis.loading ? card('', h('p', { class: 'muted' }, 'Analyzing the repository (a quick read-only look at the code)…')) : wiz.analysis.error ? card('', check(false, `Could not analyze: ${wiz.analysis.error}. You can still add the project.`)) : healthCard(wiz.analysis.profile, { verifyInput: h('input', { value: wiz.verify, placeholder: 'e.g. npm ci && npm test (leave empty for none)', oninput: (e) => { wiz.verify = e.target.value; } }) })) : null,
        card('step', h('div', { class: 'step-h' }, h('span', { class: 'sn' }, '2'), h('div', {}, h('h2', {}, 'Where do your tickets live?'), h('p', { class: 'muted small' }, 'Where you write the work you want done. Only tickets by you can queue work.'))),
          h('div', { class: 'opts' }, catalog.sources.map(srcCard)), h('div', { class: 'fields' }, sd.fields.map((f) => fieldRow(f, wiz.source))), sd.signup ? signupPanel() : null,
          sd.kind !== 'github' ? h('div', { class: 'row gap-t' }, testSrc) : null,
          wiz.srcCheck ? (wiz.srcCheck.error ? check(false, wiz.srcCheck.error) : check(true, `Connected as ${wiz.srcCheck.user.name}`)) : null,
          wiz.srcCheck?.projects?.length && sd.pick ? h('div', {}, h('label', {}, `${sd.pick.label} *`), h('select', { onchange: (e) => { wiz.source.pick = e.target.value; paint(); } }, wiz.srcCheck.projects.map((p) => h('option', { value: String(p.id), selected: String(p.id) === wiz.source.pick }, p.name)))) : null,
          sd.kind === 'github' ? h('p', { class: 'muted small' }, 'Issues in the repository itself. Label one ', h('code', {}, 'agent-ready'), ' (or queue one from the prompt bar).') : h('p', { class: 'muted small' }, 'Tokens are stored in an owner-only file on this machine, never in the config, and are checked before anything is saved.')),
        card('step', h('div', { class: 'step-h' }, h('span', { class: 'sn' }, '3'), h('div', {}, h('h2', {}, 'Name it'))), h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Name in the factory'), name), h('div', {}, h('label', {}, 'Base branch'), base)),
          h('div', { class: 'row gap-t' }, add, !ready ? h('span', { class: 'muted small' }, 'Check access (step 1) and test the connection (step 2) first.') : null)));
    };

    const create = () => { const f = {}; f.name = h('input', { placeholder: 'my-new-app' }); f.where = h('select', {}, h('option', { value: 'local' }, 'On this machine (no account; publish later)'), h('option', { value: 'github' }, 'A new private GitHub repository')); f.desc = h('input', { placeholder: 'One-line description' }); f.verify = h('input', { placeholder: 'npm test   (how to check the work; optional)' }); f.tpl = h('select', {}, templates.map((t) => h('option', { value: t }, t))); f.vis = h('select', {}, h('option', { value: 'private' }, 'private'), h('option', { value: 'public' }, 'public'));
      const bf = {}; const ta = (key, rows, ph) => { bf[key] = h('textarea', { rows, placeholder: ph }); return bf[key]; };
      f.spec = h('textarea', { rows: 5, placeholder: 'Quick start: one description that becomes the first ticket.' }); const hint = h('div', { class: 'hint' }); let t;
      f.spec.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => { const r = await api('/check-ticket', { method: 'POST', body: { title: `Build ${f.name.value}`, body: f.spec.value } }).catch(() => null); if (r) hint.replaceChildren(hintFor(r)); }, 300); });
      const plan = h('input', { type: 'checkbox' }); plan.checked = true; const target = h('select', { 'aria-label': 'Target' }, [['prototype', 'Prototype: build it and review it (no deployment)'], ['deploy', 'Deploy: aim to go live once the checks pass and I approve']].map(([v, l]) => h('option', { value: v }, l)));
      const step = (n, title, sub, ...kids) => card('step', h('div', { class: 'step-h' }, h('span', { class: 'sn' }, n), h('div', {}, h('h2', {}, title), h('p', { class: 'muted small' }, sub))), ...kids);
      const submit = act(async () => {
        const name = f.name.value.trim(); const brief = {}; for (const k of ['goal', 'users', 'scope', 'nonGoals', 'success', 'constraints']) if (bf[k].value.trim()) brief[k] = bf[k].value.trim();
        const hasBrief = brief.goal && brief.scope; if (!hasBrief && !f.spec.value.trim()) throw new Error('Describe the project: fill in at least Goal and In scope, or use the quick start box');
        const body = { id: slugId(name), name, host: f.where.value, ...(f.verify.value.trim() ? { verify: f.verify.value.trim() } : {}), description: f.desc.value, visibility: f.vis.value, template: f.tpl.value, target: target.value, ...(hasBrief ? { brief, stack: bf.stack.value.trim() || undefined, plan: plan.checked } : { spec: f.spec.value.trim() }) };
        const r = await api('/projects/new', { method: 'POST', body }); projTab = hasBrief ? (plan.checked ? 'plan' : 'brief') : 'board'; location.hash = `#/project/${r.project.id}`; }, 'Project created');
      return [
        step('1', 'The basics', 'Where the code lives, and what to call it.', h('label', {}, 'Where should the code live?'), f.where, h('div', { class: 'note info' }, 'On this machine needs no account: you review and merge here, then publish to GitHub or any git remote when ready. A GitHub repository is created from the starter template. For GitLab or Bitbucket, create the empty repo there and use “Existing repo”.'),
          h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Repository name'), f.name), h('div', {}, h('label', {}, 'Description'), f.desc)), h('label', {}, 'Test command'), f.verify, h('p', { class: 'small muted' }, 'A brand-new repository has nothing to detect, so without this the factory cannot check its own work and says so on every PR.'), h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Starter template'), f.tpl), h('div', {}, h('label', {}, 'Visibility'), f.vis))),
        step('2', 'The brief', 'What are we building? The more precise this is, the better the plan and every PR. You can refine it any time in the Brief tab.',
          h('label', {}, 'Goal *'), ta('goal', 2, 'What are we building, and why? One or two sentences a stranger would understand.'), h('label', {}, 'Users'), ta('users', 2, 'Who is it for, and what do they need to get done?'),
          h('label', {}, 'In scope *'), ta('scope', 5, 'The features and behaviour that must exist. A bullet list works well.'), h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Out of scope'), ta('nonGoals', 3, 'What we are deliberately NOT building.')), h('div', {}, h('label', {}, 'Done means'), ta('success', 3, 'How we will know it works: concrete, checkable criteria.'))),
          h('label', {}, 'Constraints'), ta('constraints', 2, 'Performance, security, compliance, deadlines, things that must not change.')),
        step('3', 'How to build it', 'Conventions the agent must follow.', h('label', {}, 'Stack and conventions'), ta('stack', 3, 'e.g. TypeScript strict, Fastify, Vitest, one module per feature, no default exports.'),
          h('p', { class: 'muted small' }, 'Have a PRD, designs or research? Create the project, then attach them in the Brief tab (files, links or pasted text).')),
        step('4', 'Target', 'Where is this going? You can change it later, and a human always approves a go-live.', h('label', {}, 'What are we aiming for?'), target),
        step('5', 'Plan and start', 'The agent turns the brief into epics and small tickets. Nothing is built until you approve the plan.',
          h('label', { class: 'check' }, plan, ' Draft a delivery plan from the brief as soon as the project is created (recommended)'),
          h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: submit }, icon('spark', 15), 'Create project'), h('span', { class: 'muted small' }, `Creates ${who.login || 'your'}/<name> on GitHub and scaffolds the template.`)),
          h('details', { class: 'quick' }, h('summary', {}, 'Just want to start fast? Use a one-box description instead'), h('p', { class: 'muted small' }, 'Skips the brief and plan: your description becomes the first ticket and the factory starts on it straight away.'), f.spec, hint)),
      ]; };
    paint();
    return [head('Add a project', 'Connect any code host and any ticket tracker. Mix freely, e.g. Jira tickets with a Bitbucket repo.'),
      h('div', { class: 'seg' }, [['existing', 'Existing repo'], ['create', 'Create new (GitHub)']].map(([k, t]) => h('button', { class: npMode === k ? 'on' : '', onclick: () => { npMode = k; paint(); ctx.rerender(); } }, t))), box];
  },
};
