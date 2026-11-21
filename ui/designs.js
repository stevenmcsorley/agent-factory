// The Designs tab: ask the designer agent for a mockup, look at it, ask for changes, edit it, approve it.
// Only approved designs reach the builder. The mockup is shown in a frame with `sandbox=""` (no scripts) loaded from a short-lived address the server hands out.
// SECURITY: all text through h(); the mockup itself never touches this page's DOM, only the frame.
import { h, icon, api, toast, ago, act } from './lib.js';
import { shotImg } from './autopilot.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const STATUS = { drafting: ['working…', 'info'], proposed: ['waiting for you', 'warn'], approved: ['approved', 'solid'], rejected: ['rejected', ''], failed: ['failed', 'bad'] };
let selected = null; let width = 'wide'; let shownVersion = null; let tab = 'preview';

export async function loadDesigns(id) { const [d, screens] = await Promise.all([api(`/projects/${id}/designs`).catch(() => ({ designs: [] })), api(`/projects/${id}/screens`).catch(() => null)]); return { ...d, screens }; }

function newForm(id, rerender) {
  const kind = h('select', { 'aria-label': 'What to make' }, [['screen', 'A screen (HTML mockup)'], ['assets', 'Artwork: logo, icons, illustrations (SVG files)']].map(([v, l]) => h('option', { value: v }, l)));
  const title = h('input', { placeholder: 'e.g. Booking screen, or Brand set', maxlength: 100, 'aria-label': 'Title' });
  const req = h('textarea', { rows: 4, placeholder: 'What to make: for a screen, who uses it and what they must do; for artwork, what it is for and the feel you want. The designer also reads your brief, your approved designs and the screenshots of the current app, if captured.', 'aria-label': 'What to make' });
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('plus', 17), 'Ask the designer')), h('label', {}, 'What to make'), kind, h('label', {}, 'Title'), title, h('label', {}, 'Details'), req,
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { const d = await api(`/projects/${id}/designs`, { method: 'POST', body: { title: title.value, request: req.value, kind: kind.value } }); selected = d.id; shownVersion = null; tab = 'preview'; }, 'The designer is on it. This takes a few minutes.', rerender) }, icon('spark', 14), 'Start'),
      h('span', { class: 'muted small' }, 'It drafts one version. You review it, ask for changes, then approve.')));
}

function screensCard(id, sc, rerender, poll) {
  if (!sc) return null; const job = sc.job; if (job?.state === 'running') poll?.();
  const shots = sc.pages.filter((x) => x.scheme === 'light' && [360, 1280].includes(x.width)).slice(0, 8);
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('shield', 17), 'Current screens'), sc.at ? h('span', { class: 'muted small' }, `captured ${ago(sc.at)}`) : null),
    h('p', { class: 'muted small' }, 'Screenshots of the app as it is today, taken from its base branch. The designer starts from them (and from a summary of each page\'s real text, fonts and colours), so a redesign keeps the product\'s identity. Works for any project whose visual check is set up.'),
    sc.configured ? h('div', { class: 'row' }, h('button', { class: 'btn', disabled: job?.state === 'running', onclick: act(() => api(`/projects/${id}/screens/capture`, { method: 'POST', body: {} }), 'Capturing…', rerender) }, icon('play', 13), job?.state === 'running' ? 'Capturing…' : sc.at ? 'Capture again' : 'Capture now'))
      : h('div', { class: 'note info' }, icon('plug', 14), h('div', {}, 'Set up the visual check first (how to start the app, its port, the routes) on the ', h('b', {}, 'Autopilot'), ' tab. The same set-up takes the screenshots.')),
    job?.state === 'running' ? h('div', { class: 'note info' }, icon('clock', 14), ` ${job.phase}`) : null, job?.state === 'error' ? h('div', { class: 'note bad' }, icon('alert', 14), ` ${job.error}`) : null,
    shots.length ? h('details', { open: !!job || shots.length < 5 }, h('summary', {}, `${sc.pages.length} screenshots`), h('div', { class: 'vshots' }, shots.map((x) => h('figure', {}, shotImg(id, 'screens', x.shot, x.shot), h('figcaption', { class: 'muted small' }, `${x.route} · ${x.width}px`))))) : null);
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
  const isAssets = d.kind === 'assets'; const nameIn = h('input', { placeholder: 'name for a new file, e.g. icon-search', 'aria-label': 'New file name' }); const fileSel = h('select', { 'aria-label': 'File' }); let fileData = []; const svgArea = h('textarea', { rows: 12, class: 'mono', spellcheck: 'false', 'aria-label': 'SVG' });
  const loadFiles = async () => { const r = await api(`/projects/${id}/designs/${d.id}/files?version=${v}`); fileData = r.files; fileSel.replaceChildren(...fileData.map((f) => h('option', { value: f.name }, `${f.name}.svg`)), h('option', { value: '' }, '+ new file…')); const show = () => { const f = fileData.find((x) => x.name === fileSel.value); svgArea.value = f?.svg ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  \n</svg>'; }; fileSel.onchange = show; show(); };
  if (tab === 'edit' && cur && isAssets) loadFiles().catch((e) => toast(e.message, 'bad'));
  const loadHtml = async () => { const r = await api(`/projects/${id}/designs/${d.id}/view`, { method: 'POST', body: { version: v } }); html.value = await (await fetch(r.path)).text(); };
  if (tab === 'edit' && cur && !isAssets) loadHtml().catch((e) => toast(e.message, 'bad'));
  const mode = (k, text) => h('button', { type: 'button', class: tab === k ? 'on' : '', 'aria-pressed': String(tab === k), onclick: () => { tab = k; rerender(); } }, text);
  return card(h('div', { class: 'card-h' }, h('h2', {}, d.title), h('span', { class: `pill2 ${cls}` }, label)),
    h('p', { class: 'muted small' }, d.request),
    d.error ? h('div', { class: 'note bad' }, icon('alert', 14), ' ', d.error) : null,
    d.working ? h('div', { class: 'note info' }, icon('clock', 14), ' The designer is working. This page refreshes by itself.') : null,
    cur ? h('div', {}, h('div', { class: 'row dtools' }, h('div', { class: 'segb' }, mode('preview', 'Preview'), mode('edit', isAssets ? 'Edit files' : 'Edit HTML')),
      d.versions.length > 1 ? h('select', { 'aria-label': 'Version', onchange: (e) => { shownVersion = Number(e.target.value); rerender(); } }, d.versions.map((x) => h('option', { value: x.n, selected: x.n === v }, `Version ${x.n}${x.by === 'you' ? ' (yours)' : ''}${x.n === d.approvedVersion ? ' · approved' : ''}`))) : null,
      tab === 'preview' ? h('div', { class: 'segb' }, [['wide', 'Desktop'], ['phone', 'Phone']].map(([k, t]) => h('button', { type: 'button', class: width === k ? 'on' : '', 'aria-pressed': String(width === k), onclick: () => { width = k; rerender(); } }, t))) : null),
      tab === 'preview' ? frame(id, d, v) : (isAssets ? h('div', {}, fileSel, nameIn, svgArea, h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { let name = fileSel.value || nameIn.value.trim(); if (!name) throw new Error('Give the new file a name'); await api(`/projects/${id}/designs/${d.id}/edit`, { method: 'POST', body: { files: [{ name, svg: svgArea.value }] } }); shownVersion = null; tab = 'preview'; }, 'Saved as a new version', rerender) }, 'Save as a new version'), fileSel.value ? h('button', { class: 'btn', onclick: act(async () => { await api(`/projects/${id}/designs/${d.id}/edit`, { method: 'POST', body: { files: [{ name: fileSel.value, svg: null }] } }); shownVersion = null; tab = 'preview'; }, 'File removed in a new version', rerender) }, 'Remove this file') : null, h('span', { class: 'muted small' }, 'Scripts and outside references are removed.')))
        : h('div', {}, html, h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { await api(`/projects/${id}/designs/${d.id}/edit`, { method: 'POST', body: { html: html.value } }); shownVersion = null; tab = 'preview'; }, 'Saved as a new version', rerender) }, 'Save as a new version'), h('span', { class: 'muted small' }, 'Scripts and outside requests are removed.')))),
      cur.rationale ? h('p', { class: 'small' }, h('b', {}, cur.by === 'you' ? 'Your note: ' : 'Designer\'s notes: '), cur.rationale) : null,
      cur.feedback ? h('p', { class: 'small muted' }, `Asked for: ${cur.feedback}`) : null) : (d.working ? null : null),
    d.versions.length && !d.working ? h('div', {}, h('label', {}, 'Ask for changes'), fb,
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: act(async () => { await api(`/projects/${id}/designs/${d.id}/revise`, { method: 'POST', body: { feedback: fb.value } }); shownVersion = null; tab = 'preview'; }, 'Sent. The designer is making the next version.', rerender) }, icon('spark', 13), 'Request changes'),
        d.status === 'approved' && d.approvedVersion === v ? h('button', { class: 'btn', onclick: act2('reopen', {}, 'Approval withdrawn') }, 'Withdraw approval') : h('button', { class: 'btn primary', onclick: act2('approve', { version: v }, `Version ${v} approved. The builder will follow it from the next run.`) }, icon('check', 13), `Approve version ${v}`),
        d.status !== 'rejected' ? h('button', { class: 'btn', onclick: act2('reject', {}, 'Rejected') }, 'Reject') : null,
        h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Delete "${d.title}" and all its versions?`)) { await act2('delete', {}, 'Deleted')(); selected = null; rerender(); } } }, 'Delete'))) : h('div', { class: 'row gap-t' }, h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Delete "${d.title}"?`)) { await act2('delete', {}, 'Deleted')(); selected = null; rerender(); } } }, 'Delete')),
    isAssets && d.status === 'approved' ? publishBox(id, d, rerender) : null,
    d.comments.length ? h('details', {}, h('summary', {}, `${d.comments.length} comment${d.comments.length === 1 ? '' : 's'}`), h('ul', { class: 'reasons' }, d.comments.map((c) => h('li', {}, h('span', { class: 'muted small' }, `${ago(c.at)} · ${c.by}: `), c.text)))) : null);
}

function publishBox(id, d, rerender) {
  const dir = h('input', { value: d.published?.dir ?? 'assets', 'aria-label': 'Folder in the repository', placeholder: 'assets/brand' });
  return h('div', { class: 'note info' }, icon('git', 14), h('div', {}, h('b', {}, 'Put these files in the project. '), 'Opens a pull request that adds the approved SVGs to the repository, for you to review and merge. Pick the folder that suits the project (assets/brand, public/images, src/assets). Works for new and existing projects.',
    d.published ? h('p', { class: 'small' }, `Last published to ${d.published.dir}/ · ${d.published.pr}`) : null, h('div', { class: 'row nowrap gap-t' }, dir, h('button', { class: 'btn primary', onclick: act(async () => { const r = await api(`/projects/${id}/designs/${d.id}/publish`, { method: 'POST', body: { dir: dir.value.trim() } }); if (!r.published) throw new Error(r.message); toast(`Pull request opened: ${r.pr}`, 'ok'); }, null, rerender) }, 'Open a pull request'))));
}

export function designsTab(data, { id, rerender, poll }) {
  const list = data?.designs ?? []; if (list.some((d) => d.working)) poll?.();
  const cur = list.find((d) => d.id === selected) ?? (selected === null ? list[0] : null); if (cur) selected = cur.id;
  return h('div', { class: 'stack' },
    h('div', { class: 'note info' }, icon('spark', 14), h('div', {}, 'The designer drafts screens and artwork (logos, icons, illustrations as SVG) for you to approve. ', h('b', {}, 'Approved designs become what the builder follows'), ': its colours, type and layout patterns go into every ticket\'s instructions. Nothing is built from a design you have not approved.')),
    list.length ? h('div', { class: 'dlist', role: 'tablist', 'aria-label': 'Designs' }, list.map((d) => { const [label, cls] = STATUS[d.status] ?? [d.status, '']; return h('button', { role: 'tab', 'aria-selected': String(d.id === selected), class: d.id === selected ? 'on' : '', onclick: () => { selected = d.id; shownVersion = null; tab = 'preview'; rerender(); } }, h('b', {}, d.title), h('span', { class: `pill2 ${cls}` }, label)); })) : null,
    screensCard(id, data?.screens, rerender, poll), cur ? detail(id, cur, rerender) : null, newForm(id, rerender));
}
