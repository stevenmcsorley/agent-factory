// The Portfolio page: every project on one screen, from brief to shipped, with the next step for each.
import { h, icon, api, num, ext } from './lib.js';
import { goProject } from './views.js';

const card = (cls, ...kids) => h('section', { class: `card ${cls ?? ''}` }, ...kids);
const meter = (frac, cls = '') => { const e = h('i', { class: 'mfill' }); e.style.width = `${Math.max(frac > 0 ? 2 : 0, Math.min(100, Math.round(frac * 100)))}%`; return h('span', { class: `mtrack ${cls}` }, e); };
const pill = (text, cls = '') => h('span', { class: `pill2 ${cls}` }, text);
const QUEUE = { review: 'in review', working: 'building', ready: 'queued', failed: 'failed', 'needs-info': 'need info', 'needs-human': 'need you' };

// What should happen next on this project, and where to do it.
export function nextStep(r) {
  const q = r.queue ?? {}; const stuck = (q.failed ?? 0) + (q['needs-info'] ?? 0) + (q['needs-human'] ?? 0);
  if (r.plan?.status === 'proposed') return { text: `Approve the plan (${r.plan.total} tickets)`, tab: 'plan', cls: 'warn' };
  if (stuck) return { text: `${stuck} ticket${stuck > 1 ? 's' : ''} stuck: open the inbox`, href: '#/inbox', cls: 'bad' };
  if (!r.brief.ready && !r.plan) return { text: 'Write the brief', tab: 'brief', cls: 'warn' };
  if (r.brief.ready && !r.plan) return { text: 'Draft a plan from the brief', tab: 'plan', cls: 'info' };
  if ((q.review ?? 0) > 0) return { text: `Review and merge ${q.review} PR${q.review > 1 ? 's' : ''}${r.plan && r.plan.planned ? ` to release ${r.plan.planned} more ticket${r.plan.planned > 1 ? 's' : ''}` : ''}`, tab: 'prs', cls: 'ok' };
  if (r.plan?.status === 'complete') return { text: 'Plan complete: add the next piece of work', tab: 'new', cls: 'ok' };
  if (r.plan) return { text: 'The line is working through the plan', tab: 'plan', cls: 'info' };
  return { text: 'Add a ticket', tab: 'new', cls: 'info' };
}

const stage = (label, state, sub) => h('div', { class: `stg ${state}` }, h('i', {}), h('b', {}, label), h('span', { class: 'muted small' }, sub));

export const portfolio = {
  async load() { return { rows: await api('/portfolio'), library: await api('/op/library_status', { method: 'POST', body: {} }).catch(() => ({ configured: false })) }; },
  draw({ rows, library }) {
    const head = h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Portfolio'), h('p', { class: 'sub' }, 'Every project from brief to shipped: what it is for, where its plan stands, and what needs you next.')), h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/new' }, icon('plus', 12), 'New project')));
    if (!rows.length) return [head, card('', h('div', { class: 'empty' }, h('b', {}, 'No projects yet'), h('p', {}, 'Create a project with a brief, or add an existing repository.'), h('a', { class: 'btn primary', href: '#/new' }, 'Add a project')))];
    const sum = (f) => rows.reduce((n, r) => n + (f(r) ?? 0), 0);
    const tile = (label, value, sub, cls = '') => h('div', { class: `tile ${cls}` }, h('span', { class: 'tile-l' }, label), h('b', {}, value), sub ? h('span', { class: 'tile-s' }, sub) : null);
    const waiting = rows.filter((r) => r.plan?.status === 'proposed').length, running = rows.filter((r) => r.plan && ['launched'].includes(r.plan.status)).length, done = rows.filter((r) => r.plan?.status === 'complete').length;
    const todo = rows.map((r) => ({ r, n: nextStep(r) })).filter((x) => x.n.cls !== 'info' || !x.r.plan).slice(0, 12);
    return [head,
      card('', h('div', { class: 'tiles' }, tile('Projects', String(rows.length), `${sum((r) => (r.paused ? 1 : 0))} paused`), tile('Briefs ready', `${rows.filter((r) => r.brief.ready).length}/${rows.length}`, `${sum((r) => r.sources)} source${sum((r) => r.sources) === 1 ? '' : 's'} attached`),
        tile('Plans', `${waiting + running + done}`, `${waiting} to approve · ${running} running · ${done} complete`, waiting ? 'bad' : ''), tile('In review', String(sum((r) => r.queue.review)), 'PRs waiting for you'), tile('Library', library.configured ? `${library.parts} parts` : 'not set up', library.configured ? `${sum((r) => r.partsUsed.length)} reuse${sum((r) => r.partsUsed.length) === 1 ? '' : 's'} across projects` : 'create one to reuse code', library.configured ? '' : 'warn'))),
      todo.length ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Needs you')), h('ul', { class: 'steps' }, todo.map(({ r, n }) => h('li', { class: n.cls === 'bad' ? 'bad' : 'warn' }, h('i', { class: 'dot' }), h('div', {}, h('b', {}, r.id), h('p', { class: 'muted small' }, n.text)), h('button', { class: 'btn small', onclick: () => (n.href ? (location.hash = n.href) : goProject(r.id, n.tab)) }, 'Open'))))) : card('', h('p', { class: 'ok-note big' }, icon('check', 20), ' Nothing needs you right now.')),
      h('div', { class: 'prows' }, rows.map((r) => { const n = nextStep(r); const pl = r.plan; const q = r.queue ?? {};
        const brief = r.brief.ready ? (r.brief.filled === r.brief.total ? 'done' : 'part') : 'todo'; const plan = !pl ? 'todo' : pl.status === 'proposed' ? 'now' : 'done'; const build = !pl || pl.status === 'proposed' ? 'todo' : pl.status === 'complete' ? 'done' : 'now'; const ship = pl?.status === 'complete' ? 'done' : (q.review ?? 0) > 0 || (pl?.done ?? 0) > 0 ? 'now' : 'todo';
        return card('prow', h('div', { class: 'card-h' }, h('div', {}, h('h2', {}, h('a', { href: `#/project/${r.id}`, onclick: (e) => { e.preventDefault(); goProject(r.id, 'board'); } }, r.id)), h('span', { class: 'muted small mono' }, r.repo)), h('div', { class: 'row' }, r.paused ? pill('paused', 'warn') : null, r.quality ? pill(`gate ${r.quality.gate === 'OK' ? 'passed' : 'failed'}`, r.quality.gate === 'OK' ? 'ok' : 'bad') : pill('not analyzed', 'muted'), r.tests ? pill(`tests ${r.tests}`, 'muted') : null, r.partsUsed.length ? pill(`${r.partsUsed.length} library part${r.partsUsed.length > 1 ? 's' : ''}`, 'info') : null)),
          h('div', { class: 'stages' }, stage('Brief', brief, `${r.brief.filled}/${r.brief.total} sections${r.sources ? ` · ${r.sources} source${r.sources > 1 ? 's' : ''}` : ''}`), stage('Plan', plan, pl ? `${pl.total} tickets · ${pl.status}` : 'not drafted'), stage('Build', build, pl ? `${pl.working + pl.queued} building · ${pl.planned} waiting` : `${(q.working ?? 0) + (q.ready ?? 0)} on the line`), stage('Ship', ship, `${q.review ?? 0} in review · ${pl?.done ?? 0} done`)),
          pl ? h('div', { class: 'planbar' }, meter(pl.total ? pl.done / pl.total : 0), h('span', { class: 'mono small' }, `${pl.done}/${pl.total} tickets done`)) : null,
          h('div', { class: 'row gap-t' }, h('span', { class: `pill2 ${n.cls}` }, n.text), h('span', { class: 'sp' }), Object.entries(q).filter(([k, v]) => v && QUEUE[k]).map(([k, v]) => pill(`${v} ${QUEUE[k]}`, k === 'failed' || k === 'needs-info' || k === 'needs-human' ? 'bad' : 'muted')), h('button', { class: 'btn small', onclick: () => (n.href ? (location.hash = n.href) : goProject(r.id, n.tab)) }, 'Go'), h('button', { class: 'btn small ghost', onclick: () => goProject(r.id, 'brief') }, 'Brief'), h('button', { class: 'btn small ghost', onclick: () => goProject(r.id, 'plan') }, 'Plan'))); }))];
  },
};
