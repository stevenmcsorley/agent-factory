// Usage: an accounting of what every agent and model has used, when, and what happened when a limit was hit or lifted. Reads /api/accounts (src/accounts.mjs).
// Written for a person, not a developer: plain words, a line of explanation where a term is unavoidable, and every figure can be hovered.
import { h, icon, api, ago, toast, session } from './lib.js';
import { gauge, splitBar, dayBars, timeline, chip, compact, percent, money, clock, when, span } from './viz.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const head = (title, sub, ...right) => h('div', { class: 'page-head between' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), right.length ? h('div', { class: 'row' }, ...right) : null);
const PROVIDER = { codex: 'Codex', openrouter: 'Free models', none: 'Not run' };
const OUTCOME = { ok: ['solid', 'Done'], escalated: ['warn', 'Handed to Codex'], limited: ['bad', 'Hit a limit'], 'not run': ['', 'Could not run'] };
const EVENT_ICON = { 'codex-limit': 'alert', 'codex-resume': 'play', fallback: 'spark', escalation: 'refresh', policy: 'plug', 'free-rest': 'clock', 'free-daily': 'alert', 'free-down': 'alert' };
const RANGES = [[1, 'Last 24 hours'], [7, '7 days'], [30, '30 days']];
const state = { days: 7, provider: '', role: '', project: '', outcome: '', page: 0 };
const PAGE = 20;
const tip = (text, label) => h('span', { class: 'hint', title: text, tabindex: '0', 'aria-label': text }, label ?? '?');
const th = (text, help) => h('th', {}, text, help ? tip(help) : null);

async function downloadCsv() {
  try { const res = await fetch(`/api/accounts.csv?days=${state.days}`, { headers: { Authorization: `Bearer ${session.token}` } }); if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob()); const a = h('a', { href: url, download: 'agent-factory-usage.csv' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); toast('Downloaded', 'ok'); } catch (e) { toast(`Could not download: ${e.message}`, 'bad'); }
}

function tiles(a) {
  const t = a.totals; const free = a.byProvider.openrouter; const codex = a.byProvider.codex;
  const cells = [[t.calls, 'jobs run', 'Every time an agent was asked to do something.'], [compact(t.input), 'tokens read', 'Tokens are the small pieces of text (about three quarters of a word) an AI model reads or writes. Providers measure usage in tokens. "Read" is what the agent was shown, including what it re-read.'],
    [compact(t.output), 'tokens written', 'What the agents wrote back: code, reviews, plans.'], [percent(t.freeShare), 'done by free models', 'Share of the work, measured by cost. Free models cost nothing but count towards the share so you can see how much Codex usage they save.'],
    [a.events.filter((e) => e.kind === 'codex-limit').length, 'times Codex ran out', 'How often the Codex plan hit its usage limit in this period.'], [t.escalated, 'jobs a free model could not do', 'The free model could not give a usable answer, so Codex did the job instead.']];
  return h('div', { class: 'kpis' }, cells.map(([n, label, help]) => h('div', { class: 'kpi', title: help }, h('b', {}, String(n)), h('span', {}, label))));
}

function daysCard(a) {
  const days = a.byDay.map((d) => ({ day: d.day, a: d.codex.input + d.codex.output, b: d.openrouter.input + d.openrouter.output }));
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('pulse', 17), 'Day by day'), h('div', { class: 'splitlegend' }, h('span', {}, h('i', { class: 'codex' }), 'Codex'), h('span', {}, h('i', { class: 'free' }), 'Free models'))),
    dayBars(days, { aClass: 'codex', bClass: 'free', aLabel: 'Codex', bLabel: 'Free models', height: 170 }), h('p', { class: 'muted small' }, 'Tokens read and written each day. A quiet day shows as an empty slot.'));
}

// Zoom the strip to where the events are (padded), so a week with one busy day is not a row of overlapping dots in the last corner.
function tlFrom(events, a) { const first = Math.min(...events.map((e) => Date.parse(e.at))); const full = Date.parse(a.range.from); const padded = first - 3_600_000; return new Date(Math.max(full, Math.min(padded, Date.parse(a.range.to) - 6 * 3_600_000))).toISOString(); }
function limitsCard(a) {
  const L = a.limits; const free = L.free; const codex = L.codex; const b = free.budget; const events = a.events;
  const codexNow = codex.current ? chip('warn', `Limited until ${codex.current.untilText}`) : chip('ok', 'Working normally');
  const reset = (() => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return clock(d.toISOString()); })();
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('clock', 17), 'Limits and resets')),
    h('div', { class: 'limitrow' },
      h('div', { class: 'limitbox' }, h('h3', {}, 'Codex'), codexNow, h('p', { class: 'muted small' }, codex.history.length ? `Hit its limit ${codex.history.length} time${codex.history.length === 1 ? '' : 's'} in this period.` : 'No limits hit in this period.')),
      h('div', { class: 'limitbox' }, h('h3', {}, 'Free models, today'), b?.cap ? gauge({ value: b.cap - (b.remaining ?? 0), max: b.cap, label: String(b.remaining ?? '–'), sub: 'requests left', tone: (b.remaining ?? 0) < b.cap * 0.1 ? 'bad' : (b.remaining ?? 0) < b.cap * 0.3 ? 'warn' : 'ok', size: 112, title: `${b.used} of ${b.cap} free-model requests used today` }) : h('p', { class: 'muted small' }, 'Not set up.'), h('p', { class: 'muted small' }, b?.cap ? `${b.used} of ${b.cap} used. The allowance resets at ${reset} (midnight UTC).` : '')),
      h('div', { class: 'limitbox' }, h('h3', {}, 'OpenRouter credit'), free.credits ? h('div', {}, h('b', { class: 'bignum' }, money(free.credits.remaining)), h('p', { class: 'muted small' }, `of ${money(free.credits.total)} bought. Free models do not use it; only paid models would.`)) : h('p', { class: 'muted small' }, 'Credit details are not available.'))),
    h('h3', { class: 'gap-t' }, 'What happened'), events.length ? timeline(events, tlFrom(events, a), a.range.to) : null,
    events.length ? h('ul', { class: 'eventlist' }, events.slice(0, 12).map((e) => h('li', {}, h('span', { class: `evdot ev-${e.kind}` }, icon(EVENT_ICON[e.kind] ?? 'pulse', 13)), h('div', {}, h('b', {}, e.title), e.detail && e.kind !== 'codex-limit' ? h('span', { class: 'muted small' }, ` · ${e.detail}`) : null), h('time', { class: 'muted small', datetime: e.at, title: new Date(e.at).toLocaleString() }, ago(e.at))))) : h('p', { class: 'muted' }, 'Nothing has hit a limit in this period.'),
    codex.history.length ? h('div', {}, h('h3', { class: 'gap-t' }, 'Codex limits, in detail'), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Hit', 'Expected back', 'Work resumed', 'Lasted'].map((x) => h('th', {}, x)))),
      h('tbody', {}, ...codex.history.map((r) => h('tr', {}, h('td', {}, when(r.at)), h('td', {}, r.expected ? when(r.expected) : 'not stated'), h('td', {}, r.resumedAt ? when(r.resumedAt) : h('span', { class: 'muted' }, 'still limited')), h('td', {}, r.durationMs != null ? span(r.durationMs) : '–'))))))) : null);
}

function modelsCard(a) {
  if (!a.byModel.length) return null;
  const rows = a.byModel.map((m) => { const reread = m.input ? m.cached / m.input : 0; return h('tr', {}, h('td', {}, chip(m.provider === 'openrouter' ? 'ok' : 'off', PROVIDER[m.provider]), h('div', { class: 'small mono' }, m.model.length > 34 ? `${m.model.slice(0, 33)}…` : m.model)), h('td', { class: 'tnum' }, String(m.calls)), h('td', { class: 'tnum' }, compact(m.input)), h('td', { class: 'tnum' }, compact(m.output)),
    h('td', { class: 'tnum' }, m.input ? percent(reread) : '–'), h('td', { class: 'tnum' }, m.steps ? String(m.avgSteps) : '–'), h('td', { class: 'tnum' }, m.tokensPerStep != null ? compact(m.tokensPerStep) : '–'), h('td', { class: 'tnum' }, m.toolFailures ? h('span', { class: 'bad' }, String(m.toolFailures)) : '0'), h('td', { class: 'tnum' }, m.avgMs ? `${(m.avgMs / 1000).toFixed(1)}s` : '–'), h('td', { class: 'tnum' }, m.limited ? String(m.limited) : '–'), h('td', { class: 'small muted' }, m.last ? ago(m.last) : '–')); });
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'By model'), h('span', { class: 'muted small' }, 'Use the tool-call columns to see which models work efficiently')), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, [th('Model'), th('Jobs'), th('Read', 'Tokens the model was shown, including text it re-read.'), th('Written', 'Tokens the model wrote.'), th('Re-read', 'The share of what was read that the provider had already seen and charges a tenth for. High is good.'), th('Steps per job', 'Steps are actions an agent takes with its tools: read a file, search, edit, run a command. Fewer steps for the same result means a more efficient model.'), th('Read per step', 'How much text is read on each step. High numbers mean each step re-reads a lot.'), th('Bad tool calls', 'Times the model asked to use a tool in a way that could not be run.'), th('Avg time', 'Average time per job.'), th('Limited', 'Jobs that stopped because of a limit.'), th('Last used')]))
    , h('tbody', {}, ...rows))));
}

function rolesCard(a) {
  if (!a.byRole.length) return null; const maxW = Math.max(1, ...a.byRole.map((r) => r.codex.weighted + r.openrouter.weighted));
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'By agent'), h('span', { class: 'muted small' }, 'Which provider each agent used')), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, [th('Agent'), th('Codex jobs'), th('Codex tokens'), th('Free jobs'), th('Free tokens'), th('Split', 'Blue is Codex, green is free models, measured by cost.')])),
    h('tbody', {}, ...a.byRole.map((r) => { const w = r.codex.weighted + r.openrouter.weighted; return h('tr', {}, h('td', {}, h('b', {}, r.role)), h('td', { class: 'tnum' }, String(r.codex.calls)), h('td', { class: 'tnum' }, compact(r.codex.input + r.codex.output)), h('td', { class: 'tnum' }, String(r.openrouter.calls)), h('td', { class: 'tnum' }, compact(r.openrouter.input + r.openrouter.output)),
      h('td', { class: 'splitcell' }, splitBar([{ label: 'Codex', value: r.codex.weighted, cls: 'codex' }, { label: 'Free', value: r.openrouter.weighted, cls: 'free' }]), h('i', { class: 'scale', style: { width: `${(100 * w) / maxW}%` } }))); })))));
}

function projectsCard(a) {
  if (!a.byProject.length) return null; return card(h('div', { class: 'card-h' }, h('h2', {}, 'By project')), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Project', 'Jobs', 'Tokens read', 'Tokens written'].map((x) => h('th', {}, x)))),
    h('tbody', {}, ...a.byProject.map((p) => h('tr', {}, h('td', {}, h('a', { href: `#/project/${p.project}` }, p.project)), h('td', { class: 'tnum' }, String(p.calls)), h('td', { class: 'tnum' }, compact(p.input)), h('td', { class: 'tnum' }, compact(p.output))))))));
}

function callsCard(a, rerender) {
  const all = a.calls; const opts = (key) => [...new Set(all.map((c) => c[key]).filter(Boolean))].sort();
  const sel = (key, label, values, fmt = (v) => v) => h('select', { 'aria-label': label, onchange: (e) => { state[key] = e.target.value; state.page = 0; rerender(); } }, h('option', { value: '' }, label), ...values.map((v) => h('option', { value: v, selected: state[key] === v }, fmt(v))));
  const rows = all.filter((c) => (!state.provider || c.provider === state.provider) && (!state.role || c.role === state.role) && (!state.project || c.project === state.project) && (!state.outcome || c.outcome === state.outcome));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE)); state.page = Math.min(state.page, pages - 1); const view = rows.slice(state.page * PAGE, (state.page + 1) * PAGE);
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'Every call'), h('span', { class: 'muted small' }, `${rows.length} of ${all.length} shown`)),
    h('div', { class: 'row filters' }, sel('provider', 'Any provider', opts('provider'), (v) => PROVIDER[v] ?? v), sel('role', 'Any agent', opts('role')), sel('project', 'Any project', opts('project')), sel('outcome', 'Any result', opts('outcome'), (v) => OUTCOME[v]?.[1] ?? v)),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, [th('When'), th('Agent'), th('Provider'), th('Project'), th('Read'), th('Written'), th('Steps'), th('Time'), th('Result')])),
      h('tbody', {}, ...view.map((c) => h('tr', {}, h('td', { class: 'small', title: new Date(c.at).toLocaleString() }, ago(c.at)), h('td', {}, c.role), h('td', {}, h('span', { title: c.model ?? '' }, PROVIDER[c.provider] ?? c.provider), c.model && c.provider !== 'none' ? h('div', { class: 'small muted mono' }, c.model.split('/').pop().slice(0, 26)) : null),
        h('td', {}, c.project ? h('a', { href: `#/project/${c.project}` }, c.project) : '–', c.run ? h('a', { class: 'small', href: `#/run/${c.run}`, title: 'The work order for this run' }, ' ↗') : null), h('td', { class: 'tnum' }, c.input ? compact(c.input) : '–'), h('td', { class: 'tnum' }, c.output ? compact(c.output) : '–'), h('td', { class: 'tnum' }, c.steps || '–'), h('td', { class: 'tnum' }, c.ms ? `${(c.ms / 1000).toFixed(1)}s` : '–'),
        h('td', {}, h('span', { class: `pill2 ${OUTCOME[c.outcome]?.[0] ?? ''}` }, OUTCOME[c.outcome]?.[1] ?? c.outcome), c.why ? h('div', { class: 'small muted', title: c.why }, c.why.length > 70 ? `${c.why.slice(0, 69)}…` : c.why) : null)))))),
    view.length ? null : h('p', { class: 'muted' }, 'No calls match.'),
    pages > 1 ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn small', disabled: state.page === 0, onclick: () => { state.page--; rerender(); } }, 'Newer'), h('span', { class: 'muted small' }, `Page ${state.page + 1} of ${pages}`), h('button', { class: 'btn small', disabled: state.page >= pages - 1, onclick: () => { state.page++; rerender(); } }, 'Older')) : null);
}

export const usagePage = {
  async load() { return { a: await api(`/accounts?days=${state.days}&calls=500`) }; },
  draw({ a }, ctx) {
    const range = h('div', { class: 'segctl', role: 'group', 'aria-label': 'Time range' }, RANGES.map(([d, label]) => h('button', { type: 'button', class: state.days === d ? 'on' : '', 'aria-pressed': String(state.days === d), onclick: () => { state.days = d; state.page = 0; ctx.rerender(); } }, label)));
    return [head('Usage', 'What every agent and model has used, when, and what happened when a limit was hit or lifted.', range, h('button', { class: 'btn small', onclick: downloadCsv }, icon('copy', 12), 'Download as CSV')),
      tiles(a), a.totals.calls ? null : h('div', { class: 'note info' }, icon('alert', 14), h('div', {}, 'No agent has run in this period yet.')), daysCard(a), limitsCard(a), modelsCard(a), rolesCard(a), projectsCard(a), callsCard(a, ctx.rerender)].filter(Boolean);
  },
};
