// The Designs tab: ask the designer agent for a mockup, look at it, ask for changes, edit it, approve it.
// Only approved designs reach the builder. The mockup is shown in a frame with `sandbox=""` (no scripts) loaded from a short-lived address the server hands out.
// SECURITY: all text through h(); the mockup itself never touches this page's DOM, only the frame.
import { h, icon, api, toast, ago, act } from './lib.js';
import { codeBlock } from './codeblock.js';
import { designStageCard, restyleCard } from './designstage.js';
import { shotImg } from './autopilot.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const STATUS = { drafting: ['working…', 'info'], proposed: ['waiting for you', 'warn'], approved: ['in use', 'solid'], rejected: ['rejected', ''], failed: ['failed', 'bad'], archived: ['archived', ''] };
let selected = null; let width = 'wide'; let shownVersion = null; let tab = 'preview'; let query = ''; let kindFilter = 'all';
const latestOf = (d) => d.versions.at(-1)?.n ?? 0;
const newer = (d) => d.status === 'approved' && d.approvedVersion && latestOf(d) > d.approvedVersion;   // a later version exists that has not been approved
// One line that says what the builder does with this design.
const stateLine = (d) => d.working ? 'designer working…' : d.status === 'approved' ? `in use · v${d.approvedVersion}${newer(d) ? ` · newer v${latestOf(d)} waiting for you` : ''}` : d.status === 'proposed' ? `waiting for you · v${latestOf(d)}` : d.status === 'archived' ? `archived${d.supersededBy ? ' · replaced by a newer design' : ''}` : d.status === 'failed' ? 'failed' : d.status;

export async function loadDesigns(id) { const [d, screens, stage] = await Promise.all([api(`/projects/${id}/designs`).catch(() => ({ designs: [] })), api(`/projects/${id}/screens`).catch(() => null), api('/op/design_phase_status', { method: 'POST', body: { project: id } }).catch(() => null)]); return { ...d, screens, stage }; }

function newForm(id, rerender) {
  const kind = h('select', { 'aria-label': 'What to make' }, [['screen', 'A screen (HTML mockup)'], ['assets', 'Artwork: logo, icons, illustrations (SVG files)']].map(([v, l]) => h('option', { value: v }, l)));
  const title = h('input', { placeholder: 'e.g. Booking screen, or Brand set', maxlength: 100, 'aria-label': 'Title' }); const area = h('input', { placeholder: 'optional: Login screen, Brand, Dashboard…', maxlength: 40, 'aria-label': 'Area' });
  const req = h('textarea', { rows: 4, placeholder: 'What to make: for a screen, who uses it and what they must do; for artwork, what it is for and the feel you want. The designer also reads your brief, your approved designs and the screenshots of the current app, if captured.', 'aria-label': 'What to make' });
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('plus', 17), 'Ask the designer')), h('label', {}, 'What to make'), kind, h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Title'), title), h('div', {}, h('label', {}, 'Area (what it is for)'), area, h('small', { class: 'help muted' }, 'Only one approved design per area guides the builder, so a newer one replaces the old.'))), h('label', {}, 'Details'), req,
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { const d = await api(`/projects/${id}/designs`, { method: 'POST', body: { title: title.value, request: req.value, kind: kind.value, ...(area.value.trim() ? { area: area.value.trim() } : {}) } }); selected = d.id; shownVersion = null; tab = 'preview'; }, 'The designer is on it. This takes a few minutes.', rerender) }, icon('spark', 14), 'Start'),
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

function versionTable(id, d, v, rerender) {
  const rows = [...d.versions].reverse().map((x) => {
    const inUse = d.status === 'approved' && d.approvedVersion === x.n; const latest = x.n === latestOf(d); const act2 = (path, body, done) => act(() => api(`/projects/${id}/designs/${d.id}/${path}`, { method: 'POST', body: body ?? {} }), done, rerender);
    return h('tr', { class: x.n === v ? 'on' : '' }, h('td', {}, h('b', {}, `v${x.n}`), ' ', inUse ? h('span', { class: 'pill2 solid' }, 'in use') : null, latest ? h('span', { class: 'pill2' }, 'latest') : null, latest && !inUse && d.approvedVersion && x.n > d.approvedVersion ? h('span', { class: 'pill2 warn' }, 'not reviewed') : null),
      h('td', { class: 'muted small' }, `${x.by === 'you' ? 'you' : 'designer'} · ${ago(x.at)}`), h('td', { class: 'small' }, (x.feedback ? `Asked for: ${x.feedback}` : x.rationale || '').slice(0, 140)),
      h('td', { class: 'vact' }, h('button', { class: 'btn small ghost', onclick: () => { shownVersion = x.n; tab = 'preview'; rerender(); } }, x.n === v ? 'Viewing' : 'View'),
        inUse ? null : h('button', { class: 'btn small', onclick: act2('approve', { version: x.n }, `v${x.n} is now in use. The builder follows it from the next run.`) }, 'Use this one'),
        h('button', { class: 'btn small ghost danger', disabled: inUse || d.versions.length < 2, title: inUse ? 'In use: choose another version first' : d.versions.length < 2 ? 'The only version' : 'Delete this version for good', onclick: async () => { if (confirm(`Delete version ${x.n} of "${d.title}" for good?`)) await act(() => api(`/projects/${id}/designs/${d.id}/versions/${x.n}/delete`, { method: 'POST', body: {} }), `v${x.n} deleted`, rerender)(); } }, 'Delete')));
  });
  return h('div', { class: 'vwrap' }, h('table', { class: 'vtable' }, h('thead', {}, h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'Made'), h('th', {}, 'What changed'), h('th', {}, ''))), h('tbody', {}, rows)));
}

function metaBox(id, d, rerender) {
  const title = h('input', { value: d.title, maxlength: 100, 'aria-label': 'Title' }); const area = h('input', { value: d.area ?? '', maxlength: 40, placeholder: 'e.g. Login screen', 'aria-label': 'Area' });
  return h('details', {}, h('summary', {}, d.area ? `Area: ${d.area} · rename or change` : 'Rename, or set its area'), h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Title'), title), h('div', {}, h('label', {}, 'Area'), area)),
    h('p', { class: 'muted small' }, 'Approving a design retires any other approved design with the same area, so two versions of one screen never both guide the builder.'),
    h('button', { class: 'btn small', onclick: act(() => api(`/projects/${id}/designs/${d.id}/meta`, { method: 'POST', body: { title: title.value, area: area.value } }), 'Saved', rerender) }, 'Save'));
}

function detail(id, d, rerender) {
  const v = shownVersion && d.versions.some((x) => x.n === shownVersion) ? shownVersion : (d.approvedVersion ?? latestOf(d)); const cur = d.versions.find((x) => x.n === v);
  const act2 = (path, body, done) => act(() => api(`/projects/${id}/designs/${d.id}/${path}`, { method: 'POST', body: body ?? {} }), done, rerender);
  const [label, cls] = STATUS[d.status] ?? [d.status, '']; const fb = h('textarea', { rows: 3, placeholder: 'What should change? The designer keeps everything you do not mention.', 'aria-label': 'Feedback' });
  const html = h('textarea', { rows: 14, class: 'mono', spellcheck: 'false', 'aria-label': 'HTML' }); html.value = '';
  const isAssets = d.kind === 'assets'; const nameIn = h('input', { placeholder: 'name for a new file, e.g. icon-search', 'aria-label': 'New file name' }); const fileSel = h('select', { 'aria-label': 'File' }); let fileData = []; const svgArea = h('textarea', { rows: 12, class: 'mono', spellcheck: 'false', 'aria-label': 'SVG' });
  const loadFiles = async () => { const r = await api(`/projects/${id}/designs/${d.id}/files?version=${v}`); fileData = r.files; fileSel.replaceChildren(...fileData.map((f) => h('option', { value: f.name }, `${f.name}.svg`)), h('option', { value: '' }, '+ new file…')); const show = () => { const f = fileData.find((x) => x.name === fileSel.value); svgArea.value = f?.svg ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  \n</svg>'; }; fileSel.onchange = show; show(); };
  if (tab === 'edit' && cur && isAssets) loadFiles().catch((e) => toast(e.message, 'bad'));
  const loadHtml = async () => { const r = await api(`/projects/${id}/designs/${d.id}/view`, { method: 'POST', body: { version: v } }); html.value = await (await fetch(r.path)).text(); };
  if (tab === 'edit' && cur && !isAssets) loadHtml().catch((e) => toast(e.message, 'bad'));
  const mode = (k, text) => h('button', { type: 'button', class: tab === k ? 'on' : '', 'aria-pressed': String(tab === k), onclick: () => { tab = k; rerender(); } }, text);
  const archived = d.status === 'archived' || d.status === 'rejected';
  return card(h('div', { class: 'card-h' }, h('h2', {}, d.title, d.area ? h('span', { class: 'tag' }, d.area) : null, h('span', { class: 'tag' }, isAssets ? 'artwork' : 'screen')), h('span', { class: `pill2 ${cls}` }, label)),
    h('p', { class: 'muted small' }, d.request),
    d.status === 'approved' ? h('div', { class: 'note ok' }, icon('check', 14), h('div', {}, `The builder is following version ${d.approvedVersion} of this design.${newer(d) ? ` Version ${latestOf(d)} is newer and has not been reviewed: the builder keeps using v${d.approvedVersion} until you choose another.` : ''}`)) : archived ? h('div', { class: 'note' }, icon('x', 14), h('div', {}, `This design is ${d.status}: the builder does not follow it. Its versions are kept.`)) : null,
    d.error ? h('div', { class: 'note bad' }, icon('alert', 14), ' ', d.error) : null,
    d.working ? h('div', { class: 'note info' }, icon('clock', 14), ' The designer is working. This page refreshes by itself.') : null,
    d.versions.length ? h('div', {}, h('h3', {}, `Versions (${d.versions.length})`), versionTable(id, d, v, rerender)) : null,
    cur ? h('div', {}, h('div', { class: 'row dtools' }, h('div', { class: 'segb' }, mode('preview', 'Preview'), mode('edit', isAssets ? 'Edit files' : 'Edit HTML')), h('span', { class: 'muted small' }, `version ${v}`),
      tab === 'preview' ? h('div', { class: 'segb' }, [['wide', 'Desktop'], ['phone', 'Phone']].map(([k, t]) => h('button', { type: 'button', class: width === k ? 'on' : '', 'aria-pressed': String(width === k), onclick: () => { width = k; rerender(); } }, t))) : null),
      tab === 'preview' ? frame(id, d, v) : (isAssets ? h('div', {}, fileSel, nameIn, svgArea, h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { let name = fileSel.value || nameIn.value.trim(); if (!name) throw new Error('Give the new file a name'); await api(`/projects/${id}/designs/${d.id}/edit`, { method: 'POST', body: { files: [{ name, svg: svgArea.value }] } }); shownVersion = null; tab = 'preview'; }, 'Saved as a new version', rerender) }, 'Save as a new version'), fileSel.value ? h('button', { class: 'btn', onclick: act(async () => { await api(`/projects/${id}/designs/${d.id}/edit`, { method: 'POST', body: { files: [{ name: fileSel.value, svg: null }] } }); shownVersion = null; tab = 'preview'; }, 'File removed in a new version', rerender) }, 'Remove this file') : null, h('span', { class: 'muted small' }, 'Scripts and outside references are removed.')))
        : h('div', {}, html, h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { await api(`/projects/${id}/designs/${d.id}/edit`, { method: 'POST', body: { html: html.value } }); shownVersion = null; tab = 'preview'; }, 'Saved as a new version', rerender) }, 'Save as a new version'), h('span', { class: 'muted small' }, 'Scripts and outside requests are removed.')))),
      cur.rationale ? h('p', { class: 'small' }, h('b', {}, cur.by === 'you' ? 'Your note: ' : 'Designer\'s notes: '), cur.rationale) : null) : null,
    d.versions.length && !d.working && !archived ? h('div', {}, h('label', {}, 'Ask for changes'), fb, h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: act(async () => { await api(`/projects/${id}/designs/${d.id}/revise`, { method: 'POST', body: { feedback: fb.value } }); shownVersion = null; tab = 'preview'; }, 'Sent. The designer is making the next version.', rerender) }, icon('spark', 13), 'Request changes'))) : null,
    metaBox(id, d, rerender),
    h('div', { class: 'row gap-t dacts' }, d.status === 'approved' ? h('button', { class: 'btn', onclick: act2('reopen', {}, 'Withdrawn: the builder no longer follows it') }, 'Stop using') : null,
      archived ? h('button', { class: 'btn primary', onclick: act2('restore', {}, 'Restored, waiting for your approval') }, 'Restore') : h('button', { class: 'btn', disabled: d.working, onclick: act2('archive', {}, 'Archived: kept, but not followed') }, 'Archive'),
      !archived && d.status !== 'approved' ? h('button', { class: 'btn', onclick: act2('reject', {}, 'Rejected') }, 'Reject') : null,
      h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Delete "${d.title}" and all ${d.versions.length} version${d.versions.length === 1 ? '' : 's'} for good? This cannot be undone. (Archive keeps the history.)`)) { await act2('delete', {}, 'Deleted')(); selected = null; rerender(); } } }, 'Delete for good')),
    isAssets && d.status === 'approved' ? publishBox(id, d, rerender) : null,
    d.comments.length ? h('details', {}, h('summary', {}, `${d.comments.length} comment${d.comments.length === 1 ? '' : 's'}`), h('ul', { class: 'reasons' }, d.comments.map((c) => h('li', {}, h('span', { class: 'muted small' }, `${ago(c.at)} · ${c.by}: `), c.text)))) : null);
}

function publishBox(id, d, rerender) {
  const dir = h('input', { value: d.published?.dir ?? 'assets', 'aria-label': 'Folder in the repository', placeholder: 'assets/brand' });
  return h('div', { class: 'note info' }, icon('git', 14), h('div', {}, h('b', {}, 'Put these files in the project. '), 'Opens a pull request that adds the approved SVGs to the repository, for you to review and merge. Pick the folder that suits the project (assets/brand, public/images, src/assets). Works for new and existing projects.',
    d.published ? h('p', { class: 'small' }, `Last published to ${d.published.dir}/ · ${d.published.pr}`) : null, h('div', { class: 'row nowrap gap-t' }, dir, h('button', { class: 'btn primary', onclick: act(async () => { const r = await api(`/projects/${id}/designs/${d.id}/publish`, { method: 'POST', body: { dir: dir.value.trim() } }); if (!r.published) throw new Error(r.message); toast(`Pull request opened: ${r.pr}`, 'ok'); }, null, rerender) }, 'Open a pull request'))));
}

function builderPanel(id, data, rerender) {
  const u = data?.inUse; if (!u) return null; const box = codeBlock('Loading…', { lang: 'css', title: 'What the builder is told', label: 'Builder instructions', maxHeight: 420, wrap: true });
  const det = h('details', { ontoggle: () => { if (det.open && box.dataset.loaded !== '1') api(`/projects/${id}/designs/in-use`).then((r) => { box.dataset.loaded = '1'; box.setText(r.text || '(nothing: no approved designs)'); }).catch((e) => { box.setText(e.message); }); } }, h('summary', {}, 'Exactly what the builder is told'), h('p', { class: 'muted small' }, 'This text goes into every ticket\'s instructions, and the full files sit in the workspace.'), box);
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('check', 17), 'What the builder follows'), h('span', { class: `pill2 ${u.designs.length ? 'solid' : ''}` }, `${u.designs.length} in use`)),
    u.designs.length ? h('ul', { class: 'reasons' }, u.designs.map((x) => h('li', {}, h('button', { class: 'linklike', onclick: () => { selected = x.id; shownVersion = null; tab = 'preview'; rerender(); } }, h('b', {}, x.title)), h('span', { class: 'muted small' }, ` · ${x.kind === 'assets' ? 'artwork' : 'screen'}${x.area ? ` · ${x.area}` : ''} · v${x.version}`))))
      : h('p', { class: 'muted' }, 'Nothing yet. The builder only follows designs you have approved.'),
    u.overLimit ? h('div', { class: 'note warn' }, icon('alert', 14), h('div', {}, `${u.designs.length} designs are in use but the builder is told about the ${u.max} most recently updated. Archive the ones you no longer need, or give related designs the same area so a newer one replaces an older one.`)) : null, det);
}

function library(list, rerender) {
  const q = query.trim().toLowerCase(); const match = (d) => (kindFilter === 'all' || (d.kind ?? 'screen') === kindFilter) && (!q || `${d.title} ${d.area ?? ''} ${d.request}`.toLowerCase().includes(q));
  const shown = list.filter(match); const inUse = shown.filter((d) => d.status === 'approved'), waiting = shown.filter((d) => ['proposed', 'drafting', 'failed'].includes(d.status)), old = shown.filter((d) => ['archived', 'rejected'].includes(d.status));
  const row = (d) => h('button', { class: `drow ${d.id === selected ? 'on' : ''}`, onclick: () => { selected = d.id; shownVersion = null; tab = 'preview'; rerender(); } }, h('span', { class: 'dk' }, d.kind === 'assets' ? 'ART' : 'SCR'), h('span', { class: 'dt' }, h('b', {}, d.title), d.area ? h('span', { class: 'tag' }, d.area) : null), h('span', { class: `ds ${newer(d) || d.status === 'proposed' ? 'warn' : ''}` }, stateLine(d)), h('span', { class: 'muted small' }, ago(d.updatedAt)));
  const group = (title, items, { open = true, hint } = {}) => (items.length ? h('details', { class: 'dgroup', open }, h('summary', {}, h('b', {}, title), h('span', { class: 'count' }, items.length), hint ? h('span', { class: 'muted small' }, ` ${hint}`) : null), h('div', { class: 'dlib' }, items.map(row))) : null);
  const search = h('input', { type: 'search', value: query, placeholder: 'Search designs…', 'aria-label': 'Search designs', oninput: (e) => { query = e.target.value; rerender(); } }); const kinds = h('div', { class: 'segb' }, [['all', 'All'], ['screen', 'Screens'], ['assets', 'Artwork']].map(([k, t]) => h('button', { type: 'button', class: kindFilter === k ? 'on' : '', 'aria-pressed': String(kindFilter === k), onclick: () => { kindFilter = k; rerender(); } }, t)));
  return h('div', {}, h('div', { class: 'row dtools' }, search, kinds), group('In use', inUse, { hint: 'the builder follows these' }), group('Waiting for you', waiting, { hint: 'approve one to put it in use' }), group('Archived and rejected', old, { open: false, hint: 'kept, not followed' }), shown.length ? null : h('p', { class: 'muted' }, list.length ? 'No design matches that.' : 'No designs yet.'));
}

export function designsTab(data, { id, rerender, poll }) {
  const list = data?.designs ?? []; if (list.some((d) => d.working)) poll?.();
  const cur = list.find((d) => d.id === selected) ?? null; if (selected && !cur) selected = null;
  return h('div', { class: 'stack' },
    h('div', { class: 'note info' }, icon('spark', 14), h('div', {}, 'The designer drafts screens and artwork (logos, icons, illustrations as SVG) for you to approve. ', h('b', {}, 'Only designs marked "in use" guide the builder'), ': its colours, type, layout patterns and artwork go into every ticket\'s instructions.')),
    designStageCard(id, data?.stage, rerender, { poll }), builderPanel(id, data, rerender), list.length ? card(h('div', { class: 'card-h' }, h('h2', {}, 'Designs'), h('span', { class: 'muted small' }, `${list.length} in total`)), library(list, rerender)) : null,
    cur ? detail(id, cur, rerender) : (list.length ? h('p', { class: 'muted small' }, 'Pick a design above to see its versions and decide which one to use.') : null),
    screensCard(id, data?.screens, rerender, poll), restyleCard(id, data?.stage, rerender), newForm(id, rerender));
}
