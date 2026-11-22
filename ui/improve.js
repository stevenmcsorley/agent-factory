// Improvements: the factory scores every finished job, shows what keeps going wrong, and suggests fixes for you to approve. After a fix is applied it measures whether the problem got rarer.
// Written for a person: plain words, nothing is applied without a click, and a suggestion's wording can be edited before it is used. Reads /api/improvements and /api/runscores (src/improve.mjs).
import { h, icon, api, ago, act } from './lib.js';
import { meter, chip, percent } from './viz.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const RANGES = [[7, '7 days'], [14, '14 days'], [30, '30 days']];
const PROVIDER = { codex: 'Codex', openrouter: 'Free models', local: 'Local models' };
const ROLES = { builder: 'the builder', fixer: 'the fixer', tester: 'the tester', designer: 'the designer', reviewer: 'the reviewer' };
const state = { days: 14 };
const post = (path, body = {}) => api(path, { method: 'POST', body });
const tone = (s) => (s >= 90 ? 'ok' : s >= 70 ? 'warn' : 'bad');
const head = (right) => h('div', { class: 'page-head between' }, h('div', {}, h('h1', {}, 'Improvements'), h('p', { class: 'sub' }, 'The factory scores every finished job, finds what keeps going wrong, and suggests fixes. Nothing changes until you approve it.')), right);

function tiles(d) {
  const x = d.health; const p = (v) => (v == null ? '–' : percent(v));
  const cells = [[x.jobs, 'jobs scored', 'Finished build jobs in this period. Jobs stopped by a usage limit are not counted.'], [x.average ?? '–', 'average score', 'Out of 100. Each problem takes points off: needing a retry, failing its own tests, the reviewer asking for changes, and so on.'], [p(x.cleanFirstTime), 'done right first time', 'Jobs with nothing wrong at all.'],
    [p(x.retried), 'needed a retry', 'Jobs that took more than one attempt.'], [p(x.reviewerChanges), 'reviewer asked for changes', 'Jobs where the second agent found something to fix.'], [x.trend == null ? '–' : `${x.trend > 0 ? '+' : ''}${x.trend}`, 'change this week', 'Average score this week compared with the week before.']];
  return h('div', { class: 'kpis' }, cells.map(([n, label, help]) => h('div', { class: 'kpi', title: help }, h('b', {}, String(n)), h('span', {}, label))));
}

function effectLine(i) {
  const e = i.effect; if (i.status !== 'applied') return null; if (!e) return h('p', { class: 'muted small' }, `Applied ${ago(i.appliedAt)}.`);
  if (!e.enough) return h('p', { class: 'muted small' }, `Applied ${ago(i.appliedAt)}. Too soon to tell: ${e.runsAfter} job${e.runsAfter === 1 ? '' : 's'} since, and it needs at least 4.`);
  const better = e.before != null && e.after < e.before; const same = e.before != null && e.after === e.before;
  return h('p', { class: `small ${better ? 'good' : ''}` }, `${better ? 'It helped. ' : same ? 'No change yet. ' : 'Not better yet. '}Before: ${e.before == null ? 'unknown' : percent(e.before)} of jobs had this problem. Since you applied it: ${percent(e.after)} (${e.runsAfter} jobs).`);
}
function ideaCard(i, rerender) {
  const isSkill = i.kind === 'skill'; const ta = isSkill ? h('textarea', { rows: '4', 'aria-label': 'What the agents will be told', spellcheck: 'true' }, i.change.skill.text) : null;
  const who = isSkill ? `Given to ${String(i.change.skill.roles).split(',').map((r) => ROLES[r.trim()] ?? r).join(', ').replace(/, ([^,]*)$/, ' and $1')}, on every project.` : null;
  const route = i.kind === 'tier' ? `This would start building and fixing on ${i.change.tiers.builder[0]}, and step up to ${i.change.tiers.builder[1]} only when an attempt fails.` : !isSkill ? `This would send building and fixing to ${i.change.routes.builder === 'codex' ? 'Codex' : 'the free models first, then Codex'}.` : null;
  return h('div', { class: `idea ${i.status}` }, h('div', { class: 'card-h' }, h('h3', {}, i.title), i.status === 'applied' ? chip('ok', 'Applied') : i.status === 'dismissed' ? chip('off', 'Not now') : chip('warn', 'New')),
    h('p', {}, i.why),
    i.examples?.length ? h('ul', { class: 'examples' }, i.examples.map((x) => h('li', {}, h('a', { href: `#/run/${x.run}` }, x.title ?? x.run), h('span', { class: 'muted small' }, ` · ${x.project} · ${String(x.detail).slice(0, 140)}`)))) : null,
    isSkill && i.status !== 'applied' ? h('div', {}, h('label', { class: 'small muted' }, 'What the agents will be told (you can change the wording):'), ta, h('p', { class: 'muted small' }, who)) : null, route ? h('p', { class: 'small' }, route) : null, effectLine(i),
    i.status === 'new' ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { await post(`/improvements/${i.id}/apply`, isSkill ? { text: ta.value } : {}); }, 'Applied', rerender) }, icon('check', 13), isSkill ? 'Give agents this instruction' : 'Make this change'), h('button', { class: 'btn ghost', onclick: act(async () => { await post(`/improvements/${i.id}/dismiss`, {}); }, 'Noted', rerender) }, 'Not now')) : null,
    i.status === 'dismissed' ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn small', onclick: act(async () => { await post(`/improvements/${i.id}/reopen`); }, 'Brought back', rerender) }, 'Bring it back')) : null);
}
const VERDICT = { early: ['off', 'Too early to say'], holding: ['ok', 'Holding up'], mixed: ['warn', 'Not clearly cheaper'], revert: ['bad', 'Not holding up'] };
const ROLE_NAME = { reviewer: 'reviewer', security: 'security reviewer', tester: 'tester', 'spec-writer': 'spec writer', 'skill-writer': 'skill writer', builder: 'builder', fixer: 'fixer', designer: 'designer', planner: 'planner' };
function harnessCard(hz) {
  if (!hz) return null; const [tone, label] = VERDICT[hz.verdict.state] ?? VERDICT.early; const p = (v) => (v == null ? '–' : percent(v)); const n = (v) => (v == null ? '–' : Number(v).toLocaleString());
  const tiles = [[hz.claims.caught, 'problems caught', 'Times the check on what an agent says it did found a mismatch: a test switched off, or tests claimed but not written.'], [hz.stepUps.count, 'jobs stepped up', 'Times a cheaper model\'s answer failed its check and a stronger model did the job instead.'], [hz.cheaperJobs, 'jobs on cheaper models', 'Build jobs that started on an older, cheaper Codex model.']];
  const b = hz.before, a = hz.after; const ba = [['Before the harness', b], ['Since it went live', a]].map(([t, x]) => h('tr', {}, h('td', {}, h('b', {}, t)), h('td', { class: 'tnum' }, x ? String(x.jobs) : '0'), h('td', { class: 'tnum' }, x ? p(x.firstTry) : '–'), h('td', { class: 'tnum' }, x ? p(x.reviewerChanges) : '–')));
  const models = hz.models.map((m) => h('tr', {}, h('td', {}, h('b', {}, m.model)), h('td', { class: 'tnum' }, String(m.jobs)), h('td', { class: 'tnum' }, String(m.average)), h('td', { class: 'tnum' }, n(m.medianTokens))));
  const events = [...hz.stepUps.recent.map((s) => h('li', {}, `${ROLE_NAME[s.role] ?? s.role}: ${s.from} gave way to ${s.to}, because ${s.why}.`)), ...hz.claims.recent.map((c) => h('li', {}, `${c.title ?? c.run}: ${c.findings[0] ?? 'a mismatch was found'}`))];
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('shield', 17), 'Is the harness working?'), chip(tone, label)), h('p', { class: 'big-line' }, hz.verdict.text),
    h('div', { class: 'kpis' }, tiles.map(([v, l, help]) => h('div', { class: 'kpi', title: help }, h('b', {}, String(v)), h('span', {}, l)))),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['', 'Jobs', 'Right first time', 'Reviewer asked for changes'].map((x) => h('th', {}, x)))), h('tbody', {}, ...ba))),
    hz.models.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Model that started the job', 'Jobs', 'Average score', h('span', {}, 'Typical tokens per job')].map((x) => h('th', {}, x)))), h('tbody', {}, ...models))) : null,
    events.length ? h('div', {}, h('h3', {}, 'Recent catches and step-ups'), h('ul', { class: 'examples' }, ...events)) : h('p', { class: 'muted small' }, 'Nothing has been caught or stepped up yet. That is normal while few jobs have run.'),
    h('p', { class: 'muted small' }, 'Tokens are the pieces of text an agent reads and writes. Fewer tokens does not always mean less of your Codex plan: older models may cost less per token, which this page cannot see. Check your plan usage as well.'));
}
function ideasCard(d, rerender) {
  if (!d.enough) return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Suggested fixes')), h('p', { class: 'muted' }, `Not enough finished jobs yet to say anything useful (${d.health.jobs} so far, it needs at least 5). Suggestions appear here as the factory does more work.`));
  if (!d.ideas.length) return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Suggested fixes')), h('p', { class: 'muted' }, 'Nothing needs fixing right now. A suggestion appears when the same problem shows up in several jobs.'));
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Suggested fixes'), h('span', { class: 'muted small' }, 'Each one is applied only when you say so')), ...d.ideas.map((i) => ideaCard(i, rerender)));
}
function problemsCard(d) {
  if (!d.problems.length) return null; const max = Math.max(...d.problems.map((p) => p.count));
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'What keeps going wrong'), h('span', { class: 'muted small' }, `In the last ${d.days} days`)),
    h('ul', { class: 'problems' }, d.problems.slice(0, 8).map((p) => h('li', {}, h('div', { class: 'prow' }, h('b', {}, p.label), h('span', { class: 'muted small' }, `${p.count} job${p.count === 1 ? '' : 's'} · ${percent(p.share)}`)), meter(p.count, max, p.share > 0.3 ? 'bad' : p.share > 0.15 ? 'warn' : 'ok', `${p.count} jobs`), p.examples[0] ? h('div', { class: 'muted small' }, 'For example: ', h('a', { href: `#/run/${p.examples[0].run}` }, p.examples[0].title ?? p.examples[0].run), ` · ${String(p.examples[0].detail).slice(0, 120)}`) : null))));
}
function modelsRows(d) { return (d.byModel ?? []).length > 1 ? d.byModel.map((m) => h('tr', {}, h('td', {}, h('b', {}, m.model), h('div', { class: 'muted small' }, 'Codex model')), h('td', { class: 'tnum' }, String(m.jobs)), h('td', {}, h('div', { class: 'row nowrap' }, meter(m.average, 100, tone(m.average), `${m.average} out of 100`), h('b', { class: 'tnum' }, String(m.average)))), h('td', { class: 'tnum' }, percent(m.cleanFirstTime)))) : []; }
function providersCard(d) {
  const rows = Object.entries(d.byProvider).filter(([, v]) => v.jobs); if (rows.length < 2 && modelsRows(d).length < 2) return null;
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'Who builds better'), h('span', { class: 'muted small' }, 'Same kind of job, compared by score')), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Built by', 'Jobs', 'Average score', 'Right first time'].map((x) => h('th', {}, x)))),
    h('tbody', {}, ...modelsRows(d), ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('b', {}, PROVIDER[k])), h('td', { class: 'tnum' }, String(v.jobs)), h('td', {}, h('div', { class: 'row nowrap' }, meter(v.average, 100, tone(v.average), `${v.average} out of 100`), h('b', { class: 'tnum' }, String(v.average)))), h('td', { class: 'tnum' }, percent(v.cleanFirstTime))))))),
    h('p', { class: 'muted small' }, 'Treat small numbers with care: a few jobs prove little. A suggestion to change who builds only appears when both sides have at least 6 jobs.'));
}
function jobRow(r) {
  const score = r.score == null ? h('span', { class: 'muted small' }, 'Stopped by a limit') : h('div', { class: 'row nowrap' }, meter(r.score, 100, tone(r.score), `${r.score} out of 100`), h('b', { class: 'tnum' }, String(r.score)));
  const tags = r.tags.length ? h('div', { class: 'row wrap' }, ...r.tags.slice(0, 3).map((t) => h('span', { class: 'pill2 warn', title: t.detail ?? '' }, t.label)), r.tags.length > 3 ? h('span', { class: 'muted small' }, `+${r.tags.length - 3} more`) : null) : (r.score == null ? null : h('span', { class: 'muted small' }, 'Nothing'));
  return h('tr', { class: r.outcome === 'stopped' ? 'dim' : '' }, h('td', { class: 'small' }, ago(r.at)), h('td', {}, h('a', { href: `#/run/${r.id}` }, r.title ?? r.id), h('div', { class: 'muted small' }, r.project)), h('td', {}, PROVIDER[r.provider] ?? r.provider), h('td', {}, score), h('td', {}, tags));
}
function jobsCard(rows) {
  if (!rows.length) return null;
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'Recent jobs')), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['When', 'Job', 'Built by', 'Score', 'What went wrong'].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows.slice(0, 30).map(jobRow)))));
}
export const improvePage = {
  async load() { const [d, rows, hz] = await Promise.all([api(`/improvements?days=${state.days}`), api(`/runscores?days=${state.days}&limit=60`).catch(() => []), api(`/harness?days=${state.days}`).catch(() => null)]); return { d, rows, hz }; },
  draw({ d, rows, hz }, ctx) {
    const range = h('div', { class: 'segctl', role: 'group', 'aria-label': 'Time range' }, RANGES.map(([n, label]) => h('button', { type: 'button', class: state.days === n ? 'on' : '', 'aria-pressed': String(state.days === n), onclick: () => { state.days = n; ctx.rerender(); } }, label)));
    return [head(range), tiles(d), harnessCard(hz), ideasCard(d, ctx.rerender), problemsCard(d), providersCard(d), jobsCard(rows)].filter(Boolean);
  },
};
