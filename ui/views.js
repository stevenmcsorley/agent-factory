import { h, icon, api, toast, ago, dur, num, pct, ext, pill, STAGES, STATES, session } from './lib.js';
import { ring, spark, bars, timeline } from './charts.js';

// Each view: load(arg) -> data (fetch everything it needs), draw(data, ctx) -> DOM nodes. The router re-draws only when data changes.
export const act = (fn, done, rerender) => async (e) => { const b = e?.currentTarget; if (b) b.disabled = true; try { const r = await fn(); if (done) toast(done, 'ok'); rerender?.(); return r; } catch (err) { toast(err.message, 'bad'); } finally { if (b) b.disabled = false; } };
const since = (iso) => h('span', { class: 'since', 'data-since': iso }, dur(Date.now() - new Date(iso)));
const empty = (title, body, action) => h('div', { class: 'empty' }, h('div', { class: 'empty-art' }, icon('spark', 28)), h('b', {}, title), body ? h('p', {}, body) : null, action);
const card = (cls, ...kids) => h('section', { class: `card ${cls ?? ''}` }, ...kids);
const head = (title, sub, ...actions) => h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), h('div', { class: 'row' }, actions));
const ATTENTION = ['failed', 'needs-info', 'needs-human'];

const HOST_LABEL = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', git: 'git' }; const SRC_LABEL = { github: 'GitHub Issues', ossicone: 'Ossicone', jira: 'Jira', linear: 'Linear', file: 'file' };
// ---- live pipeline: claim → sandbox → agent → verify → push → PR
export function pipeline(run, { active = false } = {}) {
  const order = STAGES.map(([k]) => k); const reached = run.phases.map((p) => p.name);
  const cur = active ? run.phase : reached.at(-1); const ci = order.indexOf(cur);
  const failed = !active && run.status && !['ok', 'running'].includes(run.status);
  return h('ol', { class: 'pipe' }, STAGES.map(([k, label], i) => {
    const seen = reached.includes(k); const ms = run.phases.find((p) => p.name === k)?.ms;
    const state = active ? (i < ci ? 'done' : i === ci ? 'active' : 'todo') : (failed && k === cur ? 'bad' : seen ? 'done' : 'todo');
    return h('li', { class: `stage ${state}` }, h('span', { class: 'node' }, state === 'done' ? icon('check', 13) : state === 'bad' ? icon('x', 13) : i + 1), h('span', { class: 'lbl' }, label), ms != null && !active ? h('small', {}, dur(ms)) : null);
  }));
}

// ---- prompt bar: the "tell the factory what to do" box
function promptBar(projects, rerender) {
  const sel = h('select', { 'aria-label': 'Project' }, projects.map((p) => h('option', { value: p.id }, p.id)), h('option', { value: '__new' }, '+ New project…'));
  const title = h('input', { placeholder: 'What should the factory build or fix? e.g. “Add rate limiting to the login endpoint”', maxlength: 200, 'aria-label': 'Ticket title' });
  const body = h('textarea', { rows: 3, placeholder: 'Details: which files or functions, expected behaviour, and how we will know it is done.', 'aria-label': 'Ticket details', hidden: true });
  const hint = h('div', { class: 'hint' }); let t;
  const check = () => { clearTimeout(t); t = setTimeout(async () => { if (!title.value && !body.value) return hint.replaceChildren(); try { const r = await api('/check-ticket', { method: 'POST', body: { title: title.value, body: body.value } });
    hint.replaceChildren(r.ok ? h('span', { class: 'ok' }, icon('check', 14), ' Clear enough to start') : h('span', { class: 'warn' }, icon('alert', 14), ' Add detail: ', r.problems.join('; '))); } catch { /* ignore */ } }, 300); };
  title.addEventListener('focus', () => { body.hidden = false; }); title.addEventListener('input', check); body.addEventListener('input', check);
  const go = act(async () => { if (sel.value === '__new') { location.hash = '#/new'; return; } await api(`/projects/${sel.value}/tickets`, { method: 'POST', body: { title: title.value, body: body.value } }); title.value = body.value = ''; hint.replaceChildren(); },
    'Queued. The factory picks it up on its next cycle.', rerender);
  return h('section', { class: 'prompt card' }, h('div', { class: 'prompt-top' }, icon('spark', 18), h('b', {}, 'Tell the factory what to do'), h('span', { class: 'kbd-hint' }, 'or press ', h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'K'))),
    h('div', { class: 'prompt-row' }, title), body, h('div', { class: 'prompt-foot' }, sel, hint, h('button', { class: 'btn primary', onclick: go }, 'Queue it', icon('arrow', 15))));
}

// ---- overview
export const overview = {
  async load() { const [status, projects, metrics, activity, runs] = await Promise.all([api('/status'), api('/overview'), api('/metrics?days=14'), api('/activity'), api('/runs?limit=8')]); return { status, projects, metrics, activity, runs }; },
  draw({ status: st, projects, metrics, activity, runs }, ctx) {
    const attention = projects.reduce((n, p) => n + ATTENTION.reduce((a, k) => a + (p.queue[k] ?? 0), 0), 0), inReview = projects.reduce((n, p) => n + (p.queue.review ?? 0), 0);
    const t = metrics.totals; const nextIn = st.nextAt ? Math.max(0, Math.round((new Date(st.nextAt) - Date.now()) / 1000)) : null;
    return [
      promptBar(projects, ctx.rerender),
      h('div', { class: 'kpis' },
        card('kpi', ring(st.today.runs, st.today.maxRuns ?? Math.max(5, st.today.runs), { label: String(st.today.runs), sub: st.today.maxRuns ? `of ${st.today.maxRuns}` : 'today' }), h('div', {}, h('small', {}, 'Agent runs today'), h('b', {}, st.today.maxRuns ? `${st.today.maxRuns - st.today.runs} left` : 'no cap'), h('em', {}, st.today.maxCostUsd ? `$${st.today.costUsd} of $${st.today.maxCostUsd}` : 'subscription: no cost reported'))),
        card('kpi', ring(t.successRate ?? 0, 1, { label: pct(t.successRate), tone: t.successRate == null ? 'muted' : t.successRate > 0.7 ? 'ok' : t.successRate > 0.4 ? 'warn' : 'bad' }), h('div', {}, h('small', {}, 'Success rate · 14 days'), h('b', {}, `${t.ok} of ${t.runs} runs`), h('em', {}, t.failed ? `${t.failed} failed` : 'no failures'))),
        card('kpi', h('div', { class: 'kpi-ico' }, icon('clock', 22)), h('div', {}, h('small', {}, 'Time to pull request'), h('b', {}, t.runs ? dur(t.p50Ms) : '–'), h('em', {}, t.runs ? `median · mean ${dur(t.avgMs)}` : 'no runs yet'))),
        card('kpi', h('div', { class: `kpi-ico ${attention ? 'warn' : ''}` }, icon(attention ? 'alert' : 'pr', 22)), h('div', {}, h('small', {}, 'Waiting on you'), h('b', {}, `${inReview} to review`), h('em', {}, attention ? `${attention} need attention` : 'nothing stuck')))),
      h('div', { class: 'cols-2' },
        card('now', h('div', { class: 'card-h' }, h('h2', {}, icon('pulse', 17), 'Right now'), activity.active.length ? h('span', { class: 'pill live' }, h('i', { class: 'dot' }), `${activity.active.length} running`) : h('span', { class: 'muted small' }, st.paused ? 'paused' : nextIn != null ? `next check in ${nextIn}s` : '')),
          activity.active.length ? activity.active.map((r) => h('a', { class: 'live-run', href: `#/project/${r.project}` }, h('div', { class: 'row between' }, h('b', {}, r.title ?? `#${r.ticket}`), h('span', { class: 'muted small' }, r.project, ' · ', since(r.started))), pipeline({ phase: r.phase, phases: r.phases }, { active: true }), h('div', { class: 'muted small' }, r.phase === 'agent' ? 'The agent is working in its sandbox…' : r.phase === 'verify' ? 'Running your tests…' : `${r.phase}${r.detail ? ` · ${String(r.detail).slice(0, 60)}` : ''}`)))
            : empty(st.paused ? 'Paused' : 'Idle', st.paused ? 'Resume to let the factory claim work.' : `Watching ${projects.length} project${projects.length === 1 ? '' : 's'} for tickets labelled agent-ready.`)),
        card('chart-card', h('div', { class: 'card-h' }, h('h2', {}, icon('pulse', 17), 'Last 14 days'), h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'sw ok' }), 'PR opened'), h('span', {}, h('i', { class: 'sw bad' }), 'failed'), h('span', {}, h('i', { class: 'sw neu' }), 'needed info'))), bars(metrics.days))),
      h('div', { class: 'page-head slim' }, h('h2', {}, 'Projects'), h('a', { class: 'btn', href: '#/new' }, icon('plus', 14), 'Add project')),
      projects.length ? h('div', { class: 'grid' }, projects.map((p) => projectCard(p))) : card('', empty('No projects yet', 'Add a repository, or have the factory create a new one.', h('a', { class: 'btn primary', href: '#/new' }, 'Add a project'))),
      h('div', { class: 'cols-2' },
        card('', h('div', { class: 'card-h' }, h('h2', {}, icon('bolt', 17), 'Activity')), activity.events.length ? h('ul', { class: 'feed' }, activity.events.slice(0, 12).map(feedItem)) : empty('Nothing yet', 'Events appear here as the factory works.')),
        card('', h('div', { class: 'card-h' }, h('h2', {}, icon('git', 17), 'Recent runs'), h('a', { href: '#/runs', class: 'small' }, 'All runs')), runsList(runs)))];
  },
};

function projectCard(p) {
  const q = p.queue, attn = ATTENTION.reduce((a, k) => a + (q[k] ?? 0), 0), m = p.metrics;
  return h('a', { class: `card pcard ${p.paused ? 'paused' : ''}`, href: `#/project/${p.id}` },
    h('div', { class: 'row between' }, h('h3', {}, p.id), p.paused ? h('span', { class: 'pill warn' }, 'paused') : p.error ? h('span', { class: 'pill bad' }, 'error') : null),
    h('div', { class: 'muted small mono' }, p.repo), h('div', { class: 'row tight' }, h('span', { class: 'badge' }, HOST_LABEL[p.host] ?? p.host), h('span', { class: 'badge' }, SRC_LABEL[p.source] ?? p.source)), m ? spark(m.spark) : h('div', { class: 'spark-empty' }, 'no runs yet'),
    h('div', { class: 'chips' }, chip('Queued', q.ready ?? 0, 'info'), chip('Working', q.working ?? 0, 'live'), chip('Review', q.review ?? p.prs ?? 0, 'ok'), attn ? chip('Attention', attn, 'bad') : null),
    p.error ? h('div', { class: 'small bad-t' }, p.error) : null);
}
const chip = (label, n, tone) => h('span', { class: `chip ${n ? tone : ''}` }, h('b', {}, n), label);

const FEED = { start: ['info', 'play', 'Started'], end: ['', 'check', 'Finished'], phase: ['info', 'bolt', ''] };
function feedItem(e) {
  const [tone, ic] = FEED[e.type] ?? ['', 'pulse']; const bad = e.type === 'end' && e.status !== 'ok';
  const text = e.type === 'phase' ? `${e.phase}${e.detail ? ` · ${String(e.detail).slice(0, 50)}` : ''}` : e.type === 'start' ? 'picked up' : `finished: ${e.status}`;
  return h('li', { class: bad ? 'bad' : e.type === 'end' ? 'ok' : '' }, h('span', { class: `fi ${bad ? 'bad' : tone}` }, icon(bad ? 'x' : ic, 13)), h('div', {}, h('span', { class: 'ft' }, h('b', {}, e.title ? String(e.title).slice(0, 48) : `#${e.ticket ?? e.pr ?? ''}`), ' ', h('span', { class: 'muted' }, text)), h('small', {}, e.project, ' · ', ago(e.at))));
}

function runsList(runs) {
  if (!runs.length) return empty('No runs yet', 'Queue a ticket to see the first one.');
  return h('ul', { class: 'runs' }, runs.map((r) => h('li', {}, h('a', { href: r.id ? `#/run/${r.id}` : '#/runs', class: 'run-row' }, pill(r.status), h('div', { class: 'grow' }, h('b', {}, r.title ?? (r.round ? `PR #${r.pr} feedback` : `Ticket #${r.ticket}`)), h('small', {}, r.project, ' · ', ago(r.finished ?? r.started))), h('span', { class: 'muted small' }, r.finished ? dur(new Date(r.finished) - new Date(r.started)) : '')))));
}

// ---- projects list
export const projectsPage = {
  async load() { return { projects: await api('/overview') }; },
  draw({ projects }) { return [head('Projects', 'Repositories the factory builds in.', h('a', { class: 'btn primary', href: '#/new' }, icon('plus', 14), 'Add project')),
    projects.length ? h('div', { class: 'grid' }, projects.map(projectCard)) : card('', empty('No projects yet', null, h('a', { class: 'btn primary', href: '#/new' }, 'Add one')))]; },
};

// ---- single project
let projTab = 'board';
export const project = {
  async load(id) { const base = await Promise.all([api('/overview'), api('/runs?limit=30&project=' + id), api('/metrics?days=14')]); const [ov, runs, metrics] = base; const p = ov.find((x) => x.id === id);
    const extra = {}; if (p) { if (projTab === 'board' || projTab === 'prs') [extra.tickets, extra.prs] = await Promise.all([api(`/projects/${id}/tickets`).catch(() => []), api(`/projects/${id}/prs`).catch(() => [])]); if (projTab === 'log') extra.log = (await api(`/projects/${id}/log`)).lines; }
    return { id, p, runs, metrics, tab: projTab, ...extra }; },
  draw(d, ctx) {
    const { id, p } = d; if (!p) return [card('', empty('No such project', `“${id}” is not registered.`, h('a', { class: 'btn', href: '#/projects' }, 'Back to projects')))];
    const m = d.metrics.projects[id]; const tabs = [['board', 'Board'], ['prs', 'Pull requests'], ['runs', 'Runs'], ['new', 'New ticket'], ['log', 'Log']];
    const body = d.tab === 'board' ? board(d.tickets, p) : d.tab === 'prs' ? prsList(d.prs, p) : d.tab === 'runs' ? card('', runsList(d.runs)) : d.tab === 'new' ? ticketForm(id, ctx) : h('pre', { class: 'log' }, d.log.join('\n') || 'No log yet.');
    return [head(id, null,
      h('button', { class: 'btn', onclick: act(() => api(`/projects/${id}/${p.paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} }), p.paused ? 'Project resumed' : 'Project paused', ctx.rerender) }, icon(p.paused ? 'play' : 'pause', 14), p.paused ? 'Resume' : 'Pause'),
      h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Remove ${id} from the factory? The repository itself is untouched.`)) { await act(() => api(`/projects/${id}`, { method: 'DELETE' }), 'Removed')(); location.hash = '#/projects'; } } }, 'Remove')),
      h('div', { class: 'proj-meta' }, ext(p.repoUrl, [icon('git', 14), p.repo], 'repo-link'), h('span', { class: 'badge' }, HOST_LABEL[p.host] ?? p.host), h('span', { class: 'badge' }, `tickets: ${SRC_LABEL[p.source] ?? p.source}`), h('span', { class: 'muted' }, `base ${p.base}`), p.paused ? h('span', { class: 'pill warn' }, 'paused') : null,
        m ? [h('span', { class: 'muted' }, `${m.ok}/${m.runs} runs succeeded`), m.avgMs ? h('span', { class: 'muted' }, `avg ${dur(m.avgMs)}`) : null, spark(m.spark, { w: 90, h: 24 })] : null),
      h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, t]) => h('button', { role: 'tab', 'aria-selected': String(d.tab === k), class: d.tab === k ? 'on' : '', onclick: () => { projTab = k; ctx.rerender(); } }, t))), body]; },
};

function board(tickets, p) {
  const cols = [['ready', 'Queued', 'info'], ['working', 'Working', 'live'], ['review', 'In review', 'ok'], ['attn', 'Needs attention', 'bad']];
  const bucket = (t) => { const s = stateOfLabels(t.labels); return ATTENTION.includes(s) ? 'attn' : s; };
  const open = tickets.filter((t) => t.state !== 'CLOSED'), done = tickets.filter((t) => t.state === 'CLOSED');
  const column = ([k, label, tone]) => { const items = open.filter((t) => bucket(t) === k); return h('div', { class: `col ${tone}` }, h('div', { class: 'col-h' }, h('b', {}, label), h('span', { class: 'count' }, items.length)),
    items.length ? items.map((t) => h('div', { class: 'tcard' }, h('div', { class: 'row between' }, ext(t.url, `#${t.id}`, 'tid'), k === 'attn' ? h('span', { class: `pill ${STATES[stateOfLabels(t.labels)]?.[0] ?? ''}` }, STATES[stateOfLabels(t.labels)]?.[1] ?? '') : null), h('div', { class: 'ttitle' }, t.title), h('small', {}, ago(t.updatedAt)))) : h('div', { class: 'col-empty' }, k === 'ready' ? 'Nothing queued' : '—')); };
  return [h('div', { class: 'board' }, cols.map(column)), done.length ? h('details', { class: 'closed' }, h('summary', {}, `${done.length} closed`), h('ul', { class: 'plain' }, done.map((t) => h('li', {}, ext(t.url, `#${t.id}`, 'tid'), ' ', t.title)))) : null];
}
const stateOfLabels = (labels = []) => ['agent-needs-human', 'agent-failed', 'agent-needs-info', 'agent-review', 'agent-working', 'agent-ready'].find((l) => labels.includes(l))?.replace('agent-', '') ?? 'other';
const prRow = (x) => h('li', {}, h('div', { class: 'run-row' }, icon('pr', 18), h('div', { class: 'grow' }, ext(x.url, `#${x.number} ${x.title}`, 'tid'), h('small', {}, x.branch)), h('span', { class: 'pill ok' }, 'draft')));
const prsList = (prs) => card('', prs.length ? h('ul', { class: 'runs' }, prs.map(prRow)) : empty('No open agent pull requests', 'PRs appear here when the factory finishes a ticket.'));

function ticketForm(id, ctx) {
  const title = h('input', { placeholder: 'Short title', maxlength: 200 }), body = h('textarea', { rows: 6, placeholder: 'What should change, and how will we know it is done? Name files/functions and expected behaviour.' }), hint = h('div', { class: 'hint' }); let t;
  const check = () => { clearTimeout(t); t = setTimeout(async () => { if (!title.value && !body.value) return hint.replaceChildren(); const r = await api('/check-ticket', { method: 'POST', body: { title: title.value, body: body.value } }).catch(() => null); if (r) hint.replaceChildren(r.ok ? h('span', { class: 'ok' }, icon('check', 14), ' Clear enough to start') : h('span', { class: 'warn' }, icon('alert', 14), ' The factory will ask for more detail: ', r.problems.join('; '))); }, 300); };
  title.addEventListener('input', check); body.addEventListener('input', check);
  return card('form', h('label', {}, 'Title'), title, h('label', {}, 'Details'), body, hint, h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { await api(`/projects/${id}/tickets`, { method: 'POST', body: { title: title.value, body: body.value } }); title.value = body.value = ''; projTab = 'board'; }, 'Queued. The factory picks it up on its next cycle.', ctx.rerender) }, 'Queue for the factory'), h('span', { class: 'muted small' }, 'Creates a GitHub issue labelled agent-ready.')));
}

// ---- run detail
export const runPage = {
  async load(id) { const [run, activity] = await Promise.all([api(`/runs/${id}`).catch(() => null), api('/activity')]); return { id, run, live: activity.active.find((a) => a.run === id) }; },
  draw({ id, run, live }) {
    if (!run && !live) return [card('', empty('Run not found', `No run “${id}”.`, h('a', { class: 'btn', href: '#/runs' }, 'All runs')))];
    if (!run) return [head(live.title ?? `Run ${id}`, `${live.project} · running`), card('', pipeline(live, { active: true }), h('p', { class: 'muted' }, 'In progress… ', since(live.started)))];
    const ms = run.finished ? new Date(run.finished) - new Date(run.started) : null; const ok = run.status === 'ok';
    return [h('a', { class: 'back', href: `#/project/${run.project}` }, icon('arrow', 14, 'flip'), run.project),
      head(run.title ?? `Run ${id}`, `${run.round ? `Feedback round ${run.round} · ` : ''}${new Date(run.started).toLocaleString()}`, pill(run.status), (run.prLink ?? (typeof run.pr === 'string' ? run.pr : null)) ? ext(run.prLink ?? run.pr, [icon('pr', 14), ' Open PR'], 'btn primary') : null),
      h('div', { class: 'stats' }, stat('Duration', dur(ms)), stat('Attempts', run.attempts ?? run.round ?? '–'), stat('Files changed', run.changed?.length ?? 0), stat('Tokens', run.tokens ? num(run.tokens.input + run.tokens.output) : '–'), stat('Cost', run.costUsd ? `$${run.costUsd.toFixed(3)}` : '–')),
      card('', h('div', { class: 'card-h' }, h('h2', {}, 'Pipeline')), pipeline(run), run.phases.length ? timeline(run.phases, ms) : null),
      run.error ? h('div', { class: 'callout bad' }, icon('alert', 16), run.error) : null,
      run.changed?.length ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Files changed')), h('div', { class: 'files' }, run.changed.map((f) => h('code', {}, f)))) : null,
      run.agentSummary ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'What the agent said')), h('pre', { class: 'log wrap' }, run.agentSummary)) : null,
      run.verifyTail ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Verification output'), h('span', { class: `pill ${ok ? 'ok' : 'bad'}` }, ok ? 'passed' : 'see below')), h('pre', { class: 'log' }, run.verifyTail)) : null]; },
};
const stat = (l, v) => h('div', { class: 'stat' }, h('small', {}, l), h('b', {}, String(v)));

// ---- all runs
let runFilter = 'all';
export const runsPage = {
  async load() { return { runs: await api('/runs?limit=300') }; },
  draw({ runs }, ctx) {
    const f = { all: () => true, ok: (r) => r.status === 'ok', failed: (r) => !['ok', 'needs-info', 'stopped', 'budget-exhausted', 'recovered-requeued', 'repo-not-allowed'].includes(r.status), info: (r) => ['needs-info', 'repo-not-allowed'].includes(r.status) };
    const shown = runs.filter(f[runFilter]);
    return [head('Runs', 'Every agent run and feedback round, newest first.'),
      h('div', { class: 'seg' }, [['all', 'All'], ['ok', 'PRs opened'], ['failed', 'Failed'], ['info', 'Needed info']].map(([k, t]) => h('button', { class: runFilter === k ? 'on' : '', onclick: () => { runFilter = k; ctx.rerender(); } }, t))),
      card('', shown.length ? runsList(shown) : empty('No runs match', null))]; },
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
        card('', h('div', { class: 'card-h' }, h('h2', {}, icon('plug', 17), 'Code Mode (recommended)'), h('span', { class: info.codeAvailable ? 'pill ok' : 'pill warn' }, info.codeAvailable ? 'ready' : 'needs quickjs')), h('p', {}, 'Two tools: ', h('code', {}, 'search'), ' and ', h('code', {}, 'execute'), '. The AI writes a few lines of JavaScript that run in a sandbox, so a whole workflow costs a fraction of the tokens.'), h('div', { class: 'row' }, h('code', { class: 'url' }, `${origin}/mcp-code`), copy(`${origin}/mcp-code`, 'URL')), code(cmd('/mcp-code', 'agent-factory'))),
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
    return [head('Health', bad ? `${bad} thing${bad > 1 ? 's' : ''} to fix before the factory can run safely.` : 'Everything the factory needs is in place.'),
      h('div', { class: 'grid' }, checks.map((c) => h('div', { class: `card check ${c.ok ? 'good' : 'badc'}` }, h('div', { class: 'row' }, h('span', { class: 'ci' }, icon(c.ok ? 'check' : 'x', 16)), h('b', {}, c.id)), h('p', { class: 'small' }, c.detail), c.fix ? h('div', { class: 'fix' }, h('small', {}, 'Fix'), h('code', {}, c.fix)) : null)))]; },
};

// ---- add / create project
// The wizard is driven by /api/catalog, so a new tracker or code host appears here automatically once it is registered on the server.
let npMode = 'existing';
const wiz = { host: { kind: 'github', fields: {}, token: '' }, repo: '', hostCheck: null, source: { kind: 'github', fields: {}, token: '', pick: '' }, srcCheck: null, signup: null, id: '', base: '' };
const slugId = (r) => (r.split('/').pop() || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');

export const newProject = {
  async load() { const [catalog, who] = await Promise.all([api('/catalog'), api('/whoami').catch(() => ({ login: '' }))]); return { catalog, who, templates: await api('/templates') }; },
  draw({ catalog, who, templates }, ctx) {
    const box = h('div', {});
    const hostDef = () => catalog.hosts.find((x) => x.kind === wiz.host.kind); const srcDef = () => catalog.sources.find((x) => x.kind === wiz.source.kind);
    const paint = () => box.replaceChildren(npMode === 'existing' ? existing() : create());

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
      const repoInput = h('input', { value: wiz.repo, placeholder: hd.repoHint ?? 'owner/name', oninput: (e) => { wiz.repo = e.target.value; wiz.hostCheck = null; if (!wiz.id) wiz.idAuto = true; } });
      const testHost = h('button', { class: 'btn', onclick: act(async () => { wiz.hostCheck = await api('/hosts/test', { method: 'POST', body: { kind: wiz.host.kind, fields: wiz.host.fields, token: wiz.host.token, repo: wiz.repo.trim() } }).catch((e) => ({ error: e.message })); paint(); }) }, 'Check access');
      const testSrc = h('button', { class: 'btn', onclick: act(async () => { wiz.srcCheck = await api('/sources/test', { method: 'POST', body: { kind: wiz.source.kind, fields: wiz.source.fields, token: wiz.source.token } }).catch((e) => ({ error: e.message })); if (wiz.srcCheck.projects?.length && !wiz.source.pick) wiz.source.pick = String(wiz.srcCheck.projects[0].id); paint(); }) }, sd.kind === 'github' ? 'Check' : 'Test connection');
      const ready = wiz.hostCheck && !wiz.hostCheck.error && (sd.kind === 'github' || (wiz.srcCheck && !wiz.srcCheck.error && (!sd.pick || wiz.source.pick)));
      const name = h('input', { value: wiz.id || slugId(wiz.repo), placeholder: 'short-name', oninput: (e) => { wiz.id = e.target.value; } });
      const base = h('input', { value: wiz.base, placeholder: wiz.hostCheck?.defaultBranch ? `${wiz.hostCheck.defaultBranch} (detected)` : 'default branch (detected)', oninput: (e) => { wiz.base = e.target.value; } });
      const add = h('button', { class: 'btn primary', disabled: !ready, onclick: act(async () => {
        const id = (wiz.id || slugId(wiz.repo)); const body = { id, repo: wiz.repo.trim(), ...(wiz.base.trim() ? { base: wiz.base.trim() } : {}),
          ...(wiz.host.kind !== 'github' ? { host: { kind: wiz.host.kind, ...wiz.host.fields }, hostSecret: wiz.host.token || undefined } : {}),
          source: { kind: wiz.source.kind, fields: wiz.source.fields, ...(sd.pick ? { pick: wiz.source.pick } : {}) }, ...(wiz.source.token ? { secret: wiz.source.token } : {}) };
        const r = await api('/projects', { method: 'POST', body }); wiz.host.token = wiz.source.token = ''; location.hash = `#/project/${r.id}`; }, 'Project added') }, icon('plus', 15), 'Add project');
      return h('div', { class: 'wiz' },
        card('step', h('div', { class: 'step-h' }, h('span', { class: 'sn' }, '1'), h('div', {}, h('h2', {}, 'Where does your code live?'), h('p', { class: 'muted small' }, 'The factory pushes a branch and opens a draft pull request here. It never merges.'))),
          h('div', { class: 'opts' }, catalog.hosts.map(hostCard)), h('div', { class: 'fields' }, hd.fields.map((f) => fieldRow(f, wiz.host))),
          h('label', {}, 'Repository *'), h('div', { class: 'row nowrap' }, repoInput, testHost), wiz.hostCheck ? (wiz.hostCheck.error ? check(false, wiz.hostCheck.error) : check(true, `Connected as ${wiz.hostCheck.user} · default branch ${wiz.hostCheck.defaultBranch} · ${wiz.hostCheck.private ? 'private' : 'public'}${wiz.hostCheck.supportsPrs === false ? ' · no PR automation (a branch is pushed for you to open a PR)' : ''}`)) : null),
        card('step', h('div', { class: 'step-h' }, h('span', { class: 'sn' }, '2'), h('div', {}, h('h2', {}, 'Where do your tickets live?'), h('p', { class: 'muted small' }, 'Where you write the work you want done. Only tickets by you can queue work.'))),
          h('div', { class: 'opts' }, catalog.sources.map(srcCard)), h('div', { class: 'fields' }, sd.fields.map((f) => fieldRow(f, wiz.source))), sd.signup ? signupPanel() : null,
          sd.kind !== 'github' ? h('div', { class: 'row gap-t' }, testSrc) : null,
          wiz.srcCheck ? (wiz.srcCheck.error ? check(false, wiz.srcCheck.error) : check(true, `Connected as ${wiz.srcCheck.user.name}`)) : null,
          wiz.srcCheck?.projects?.length && sd.pick ? h('div', {}, h('label', {}, `${sd.pick.label} *`), h('select', { onchange: (e) => { wiz.source.pick = e.target.value; paint(); } }, wiz.srcCheck.projects.map((p) => h('option', { value: String(p.id), selected: String(p.id) === wiz.source.pick }, p.name)))) : null,
          sd.kind === 'github' ? h('p', { class: 'muted small' }, 'Issues in the repository itself. Label one ', h('code', {}, 'agent-ready'), ' (or queue one from the prompt bar).') : h('p', { class: 'muted small' }, 'Tokens are stored in an owner-only file on this machine, never in the config, and are checked before anything is saved.')),
        card('step', h('div', { class: 'step-h' }, h('span', { class: 'sn' }, '3'), h('div', {}, h('h2', {}, 'Name it'))), h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Name in the factory'), name), h('div', {}, h('label', {}, 'Base branch'), base)),
          h('div', { class: 'row gap-t' }, add, !ready ? h('span', { class: 'muted small' }, 'Check access (step 1) and test the connection (step 2) first.') : null)));
    };

    const create = () => { const f = {}; f.name = h('input', { placeholder: 'my-new-app' }); f.desc = h('input', { placeholder: 'One-line description' }); f.tpl = h('select', {}, templates.map((t) => h('option', { value: t }, t))); f.vis = h('select', {}, h('option', { value: 'private' }, 'private'), h('option', { value: 'public' }, 'public'));
      f.spec = h('textarea', { rows: 7, placeholder: 'Describe what to build: features, behaviour, what “done” looks like. This becomes the first ticket, and the factory starts on it straight away.' }); const hint = h('div', { class: 'hint' }); let t;
      f.spec.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => { const r = await api('/check-ticket', { method: 'POST', body: { title: `Build ${f.name.value}`, body: f.spec.value } }).catch(() => null); if (r) hint.replaceChildren(r.ok ? h('span', { class: 'ok' }, icon('check', 14), ' Clear enough to start') : h('span', { class: 'warn' }, icon('alert', 14), ' ', r.problems.join('; '))); }, 300); });
      return card('form', h('div', { class: 'note info' }, 'Creating a brand-new repository is available for GitHub. For GitLab, Bitbucket or another host, create the empty repo there and use “Existing repo”.'),
        h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Repository name'), f.name), h('div', {}, h('label', {}, 'Description'), f.desc)), h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Starter template'), f.tpl), h('div', {}, h('label', {}, 'Visibility'), f.vis)),
        h('label', {}, 'What should it do?'), f.spec, hint, h('p', { class: 'muted small' }, `Creates ${who.login || 'your'}/<name> on GitHub, scaffolds the template and queues your description as the first ticket.`),
        h('button', { class: 'btn primary', onclick: act(async () => { const name = f.name.value.trim(); const r = await api('/projects/new', { method: 'POST', body: { id: slugId(name), name, description: f.desc.value, visibility: f.vis.value, template: f.tpl.value, spec: f.spec.value.trim() || undefined } }); location.hash = `#/project/${r.project.id}`; }, 'Project created') }, icon('spark', 15), 'Create project')); };
    paint();
    return [head('Add a project', 'Connect any code host and any ticket tracker. Mix freely, e.g. Jira tickets with a Bitbucket repo.'),
      h('div', { class: 'seg' }, [['existing', 'Existing repo'], ['create', 'Create new (GitHub)']].map(([k, t]) => h('button', { class: npMode === k ? 'on' : '', onclick: () => { npMode = k; paint(); ctx.rerender(); } }, t))), box];
  },
};
