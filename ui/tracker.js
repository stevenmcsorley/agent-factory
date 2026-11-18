// Views for the built-in tracker: epics with progress, and one ticket with its comments and actions.
import { h, api, ago, act } from './lib.js';

const LABEL = { 'agent-ready': 'In the hopper', 'agent-working': 'On the line', 'agent-review': 'In review', 'agent-failed': 'Failed', 'agent-needs-info': 'Needs info', 'agent-needs-human': 'Needs a human' };
const meter = (frac) => { const e = h('i', { class: 'mfill' }); e.style.width = `${Math.max(frac > 0 ? 2 : 0, Math.min(100, Math.round(frac * 100)))}%`; return h('span', { class: 'mtrack' }, e); };
const card = (...kids) => h('section', { class: 'card' }, ...kids);
const TONE = { 'agent-failed': 'bad', 'agent-needs-human': 'bad', 'agent-needs-info': 'warn', 'agent-review': 'ok', 'agent-working': 'live' };
const stateTag = (t) => { const l = t.labels.find((x) => LABEL[x]); return h('span', { class: `stamp ${t.state === 'CLOSED' ? '' : (TONE[l] ?? '')}` }, t.state === 'CLOSED' ? 'closed' : (LABEL[l] ?? 'open')); };

// Epics, each with a progress bar and its tickets.
export function trackerTab(overview, tickets, { open }) {
  const link = (t) => h('button', { class: 'linklike', onclick: () => open(t.id) }, `#${t.id} ${t.title}`);
  if (!overview.epics.length && !tickets.length) return card(h('div', { class: 'empty' }, h('b', {}, 'Nothing here yet'), h('p', {}, 'Create a ticket, or launch a plan to get epics with their tickets.')));
  const epicIds = new Set(overview.epics.map((e) => String(e.id)));
  const loose = tickets.filter((t) => !t.epic || !epicIds.has(String(t.epic)));
  const epic = (e) => { const kids = tickets.filter((t) => String(t.epic) === String(e.id)); const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
    return card(h('div', { class: 'row between' }, h('h2', {}, e.title), h('span', { class: 'muted small mono' }, `${e.done}/${e.total} done`)),
      meter(pct / 100),
      kids.length ? h('ul', { class: 'plain' }, kids.map((t) => h('li', { class: 'row between' }, link(t), stateTag(t)))) : h('p', { class: 'muted small' }, 'No open tickets (finished ones are closed).')); };
  return [...overview.epics.map(epic), loose.length ? card(h('h2', {}, 'Tickets without an epic'), h('ul', { class: 'plain' }, loose.map((t) => h('li', { class: 'row between' }, link(t), stateTag(t))))) : null];
}

// One ticket: description, comments, add a comment, close or reopen.
export function ticketPage(t, { id, back, rerender, open }) {
  const text = h('textarea', { rows: 3, placeholder: 'Add a comment. The agent sees comments when the ticket is re-queued.' });
  const post = (action, body, msg) => act(async () => { await api(`/projects/${id}/tickets/${t.id}/${action}`, { method: 'POST', body }); }, msg, rerender);
  return [h('button', { class: 'btn', onclick: back }, 'Back'),
    card(h('div', { class: 'row between' }, h('h1', {}, `#${t.id} ${t.title}`), stateTag(t)),
      t.epicInfo ? h('p', { class: 'small muted' }, 'In epic ', h('button', { class: 'linklike', onclick: () => open(t.epicInfo.id) }, t.epicInfo.title)) : null,
      h('div', { class: 'row' }, t.labels.filter((l) => !l.startsWith('repo:')).map((l) => h('span', { class: 'tag' }, l))), h('pre', { class: 'log-pre' }, t.body || '(no description)'),
      h('div', { class: 'row gap-t' }, t.type === 'epic' ? null : t.state === 'CLOSED' ? h('button', { class: 'btn', onclick: post('reopen', {}, 'Reopened') }, 'Reopen') : h('button', { class: 'btn', onclick: post('close', {}, 'Closed') }, 'Close'),
        t.type !== 'epic' && t.labels.some((l) => ['agent-failed', 'agent-needs-info', 'agent-needs-human'].includes(l)) ? h('button', { class: 'btn primary', onclick: post('requeue', {}, 'Back in the hopper') }, 'Requeue') : null)),
    t.children ? card(h('h2', {}, 'Tickets in this epic'), h('ul', { class: 'plain' }, t.children.map((c) => h('li', { class: 'row between' }, h('button', { class: 'linklike', onclick: () => open(c.id) }, `#${c.id} ${c.title}`), stateTag(c))))) : null,
    card(h('h2', {}, `Comments (${t.comments?.length ?? 0})`), h('ul', { class: 'plain' }, (t.comments ?? []).map((c) => h('li', { class: 'cmt' }, h('div', { class: 'small muted' }, `${c.author}${c.at ? ` · ${ago(c.at)}` : ''}`), h('div', {}, c.body)))),
      text, h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: () => { if (!text.value.trim()) return; return post('comment', { text: text.value }, 'Comment added')(); } }, 'Comment')))];
}
