// The Designs tab: ask the designer agent for a mockup, look at it, ask for changes, edit it, approve it.
// Only approved designs reach the builder. The mockup is shown in a frame with `sandbox=""` (no scripts) loaded from a short-lived address the server hands out.
// SECURITY: all text through h(); the mockup itself never touches this page's DOM, only the frame.
import { h, icon, api, toast, ago, act } from './lib.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const STATUS = { drafting: ['working…', 'info'], proposed: ['waiting for you', 'warn'], approved: ['approved', 'solid'], rejected: ['rejected', ''], failed: ['failed', 'bad'] };
let selected = null; let width = 'wide'; let shownVersion = null; let tab = 'preview';

export async function loadDesigns(id) { return api(`/projects/${id}/designs`).catch(() => ({ designs: [] })); }

function newForm(id, rerender) {
  const title = h('input', { placeholder: 'e.g. Booking screen', maxlength: 100, 'aria-label': 'Title' });
  const req = h('textarea', { rows: 4, placeholder: 'What to design: the screen, who uses it, what they must do on it, anything it has to show. The designer also reads your brief and your approved designs.', 'aria-label': 'What to design' });
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('plus', 17), 'Ask the designer')), h('label', {}, 'Title'), title, h('label', {}, 'What to design'), req,
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { const d = await api(`/projects/${id}/designs`, { method: 'POST', body: { title: title.value, request: req.value } }); selected = d.id; shownVersion = null; tab = 'preview'; }, 'The designer is on it. This takes a few minutes.', rerender) }, icon('spark', 14), 'Draft a design'),
      h('span', { class: 'muted small' }, 'It drafts one mockup. You review it, ask for changes, then approve.')));
}

function frame(id, d, version) {
  const holder = h('div', { class: `dframe ${width}` }, h('p', { class: 'muted small' }, 'Loading the mockup…'));
  api(`/projects/${id}/designs/${d.id}/view`, { method: 'POST', body: { version } }).then((r) => holder.replaceChildren(h('iframe', { src: r.path, sandbox: '', title: `${d.title}, version ${version}`, loading: 'lazy' }))).catch((e) => holder.replaceChildren(h('p', { class: 'muted' }, e.message)));
  return holder;
}

function detail(id, d, rerender) {
  const v = shownVersion && d.versions.some((x) => x.n === shownVersion) ? shownVersion : (d.approvedVersion ?? d.versions.at(-1)?.n); const cur = d.versions.find((x) => x.n === v);
  const act2 = (path, body, done) => act(() => api(`/projects/${id}/designs/${d.id}/${path}`, { method: 'POST', body: body ?? {} }), done, rerender);
  const [label, cls] = STATUS[d.status] ?? [d.status, '']; const fb = h('textarea', { rows: 3, placeholder: 'What should change? The designer keeps everything you do not mention.', 'aria-label': 'Feedback' });
  const html = h('textarea', { rows: 14, class: 'mono', spellcheck: 'false', 'aria-label': 'HTML' }); html.value = '';
  const loadHtml = async () => { const r = await api(`/projects/${id}/designs/${d.id}/view`, { method: 'POST', body: { version: v } }); html.value = await (await fetch(r.path)).text(); };
  if (tab === 'edit' && cur) loadHtml().catch((e) => toast(e.message, 'bad'));
  const mode = (k, text) => h('button', { type: 'button', class: tab === k ? 'on' : '', 'aria-pressed': String(tab === k), onclick: () => { tab = k; rerender(); } }, text);
  return card(h('div', { class: 'card-h' }, h('h2', {}, d.title), h('span', { class: `pill2 ${cls}` }, label)),
    h('p', { class: 'muted small' }, d.request),
    d.error ? h('div', { class: 'note bad' }, icon('alert', 14), ' ', d.error) : null,
    d.working ? h('div', { class: 'note info' }, icon('clock', 14), ' The designer is working. This page refreshes by itself.') : null,
    cur ? h('div', {}, h('div', { class: 'row dtools' }, h('div', { class: 'segb' }, mode('preview', 'Preview'), mode('edit', 'Edit HTML')),
      d.versions.length > 1 ? h('select', { 'aria-label': 'Version', onchange: (e) => { shownVersion = Number(e.target.value); rerender(); } }, d.versions.map((x) => h('option', { value: x.n, selected: x.n === v }, `Version ${x.n}${x.by === 'you' ? ' (yours)' : ''}${x.n === d.approvedVersion ? ' · approved' : ''}`))) : null,
      tab === 'preview' ? h('div', { class: 'segb' }, [['wide', 'Desktop'], ['phone', 'Phone']].map(([k, t]) => h('button', { type: 'button', class: width === k ? 'on' : '', 'aria-pressed': String(width === k), onclick: () => { width = k; rerender(); } }, t))) : null),
      tab === 'preview' ? frame(id, d, v) : h('div', {}, html, h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { await api(`/projects/${id}/designs/${d.id}/edit`, { method: 'POST', body: { html: html.value } }); shownVersion = null; tab = 'preview'; }, 'Saved as a new version', rerender) }, 'Save as a new version'), h('span', { class: 'muted small' }, 'Scripts and outside requests are removed.'))),
      cur.rationale ? h('p', { class: 'small' }, h('b', {}, cur.by === 'you' ? 'Your note: ' : 'Designer\'s notes: '), cur.rationale) : null,
      cur.feedback ? h('p', { class: 'small muted' }, `Asked for: ${cur.feedback}`) : null) : (d.working ? null : null),
    d.versions.length && !d.working ? h('div', {}, h('label', {}, 'Ask for changes'), fb,
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: act(async () => { await api(`/projects/${id}/designs/${d.id}/revise`, { method: 'POST', body: { feedback: fb.value } }); shownVersion = null; tab = 'preview'; }, 'Sent. The designer is making the next version.', rerender) }, icon('spark', 13), 'Request changes'),
        d.status === 'approved' && d.approvedVersion === v ? h('button', { class: 'btn', onclick: act2('reopen', {}, 'Approval withdrawn') }, 'Withdraw approval') : h('button', { class: 'btn primary', onclick: act2('approve', { version: v }, `Version ${v} approved. The builder will follow it from the next run.`) }, icon('check', 13), `Approve version ${v}`),
        d.status !== 'rejected' ? h('button', { class: 'btn', onclick: act2('reject', {}, 'Rejected') }, 'Reject') : null,
        h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Delete "${d.title}" and all its versions?`)) { await act2('delete', {}, 'Deleted')(); selected = null; rerender(); } } }, 'Delete'))) : h('div', { class: 'row gap-t' }, h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Delete "${d.title}"?`)) { await act2('delete', {}, 'Deleted')(); selected = null; rerender(); } } }, 'Delete')),
    d.comments.length ? h('details', {}, h('summary', {}, `${d.comments.length} comment${d.comments.length === 1 ? '' : 's'}`), h('ul', { class: 'reasons' }, d.comments.map((c) => h('li', {}, h('span', { class: 'muted small' }, `${ago(c.at)} · ${c.by}: `), c.text)))) : null);
}

export function designsTab(data, { id, rerender, poll }) {
  const list = data?.designs ?? []; if (list.some((d) => d.working)) poll?.();
  const cur = list.find((d) => d.id === selected) ?? (selected === null ? list[0] : null); if (cur) selected = cur.id;
  return h('div', { class: 'stack' },
    h('div', { class: 'note info' }, icon('spark', 14), h('div', {}, 'The designer drafts mockups for you to approve. ', h('b', {}, 'Approved designs become what the builder follows'), ': its colours, type and layout patterns go into every ticket\'s instructions. Nothing is built from a design you have not approved.')),
    list.length ? h('div', { class: 'dlist', role: 'tablist', 'aria-label': 'Designs' }, list.map((d) => { const [label, cls] = STATUS[d.status] ?? [d.status, '']; return h('button', { role: 'tab', 'aria-selected': String(d.id === selected), class: d.id === selected ? 'on' : '', onclick: () => { selected = d.id; shownVersion = null; tab = 'preview'; rerender(); } }, h('b', {}, d.title), h('span', { class: `pill2 ${cls}` }, label)); })) : null,
    cur ? detail(id, cur, rerender) : null, newForm(id, rerender));
}
