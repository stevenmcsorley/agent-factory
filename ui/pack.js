// The Brief tab (what we are building, conventions, decisions, source material) and the Plan tab (brief -> epics -> tickets -> done).
import { h, icon, api, toast, ago, num, ext, act } from './lib.js';
import { codeBlock } from './codeblock.js';
import { designStageCard } from './designstage.js';

const card = (cls, ...kids) => h('section', { class: `card ${cls ?? ''}` }, ...kids);
const pill = (text, cls = '') => h('span', { class: `pill2 ${cls}` }, text);
const meter = (frac, cls = '') => { const e = h('i', { class: 'mfill' }); e.style.width = `${Math.max(frac > 0 ? 2 : 0, Math.min(100, Math.round(frac * 100)))}%`; return h('span', { class: `mtrack ${cls}` }, e); };
const KIND = { prd: 'PRD', research: 'Research', design: 'Design', reference: 'Reference', other: 'Other' };
const b64 = (buf) => { let s = ''; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// ================================================================== ATTACHMENTS (new-project wizard)
// Files and links picked before a project exists. They are held in the browser and sent to the project's source material the moment it is created.
export const ACCEPT = '.md,.txt,.json,.csv,.html,.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg';
export const MAX_FILE = 5 * 1024 * 1024;
export function attachments(list, repaint) {
  const pickFiles = (files) => { for (const f of files) { if (f.size > MAX_FILE) { toast(`${f.name} is over 5 MB`, 'bad'); continue; } if (list.length >= 10) { toast('Ten attachments at most; add more later in the Brief tab', 'bad'); break; } list.push({ file: f, kind: /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name) ? 'design' : /\.(pdf|md|txt|docx?)$/i.test(f.name) ? 'prd' : 'reference' }); } repaint(); };
  const input = h('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'sr-only', 'aria-label': 'Attach files', onchange: () => { pickFiles([...input.files]); input.value = ''; } });
  const link = h('input', { placeholder: 'Or paste a link: Figma, Notion, a Google Doc…', 'aria-label': 'Link' });
  const addLink = () => { const v = link.value.trim(); if (!v) return; try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw new Error('x'); } catch { toast('That is not a valid link (include https://)', 'bad'); return; } list.push({ url: v, kind: 'reference' }); link.value = ''; repaint(); };
  link.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } });
  const drop = h('label', { class: 'dropzone' }, icon('plus', 14), ' Drop files here or choose them ', h('small', { class: 'muted' }, 'PDF, Markdown, images, text, JSON, CSV · 5 MB each'), input);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); }); drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); pickFiles([...(e.dataTransfer?.files ?? [])]); });
  return h('div', { class: 'attach' }, drop,
    h('div', { class: 'row nowrap gap-t' }, link, h('button', { class: 'btn', type: 'button', onclick: addLink }, 'Add link')),
    list.length ? h('ul', { class: 'attach-list' }, list.map((a, i) => h('li', {}, h('span', { class: 'mono small' }, a.file ? `${a.file.name} · ${size(a.file.size)}` : a.url),
      h('select', { 'aria-label': 'Kind', onchange: (e) => { a.kind = e.target.value; } }, Object.entries(KIND).map(([v, l]) => h('option', { value: v, selected: v === a.kind }, l))),
      h('button', { class: 'btn small ghost', type: 'button', 'aria-label': `Remove ${a.file?.name ?? a.url}`, onclick: () => { list.splice(i, 1); repaint(); } }, 'Remove')))) : null);
}
// Send queued attachments to a project that now exists. Returns the ones that failed, so the caller can say so instead of silently dropping them.
export async function uploadAttachments(list, id) {
  const failed = [];
  for (const a of list) {
    try { const body = a.file ? { kind: a.kind, title: a.file.name, filename: a.file.name, dataBase64: b64(await a.file.arrayBuffer()) } : { kind: a.kind, url: a.url };
      await api(`/projects/${id}/pack/sources`, { method: 'POST', body }); } catch (e) { failed.push(`${a.file?.name ?? a.url}: ${e.message}`); }
  }
  list.length = 0; return failed;
}

// ================================================================== BRIEF
// A URL other tools can POST alerts to; each alert becomes a ticket (with the same clarity check, de-duplication and a rate limit).
function hookCard(id) {
  const box = h('div', {}); const op = (name) => api(`/op/${name}`, { method: 'POST', body: { project: id } });
  const draw = (info) => { const url = `${location.origin}${info.path}`; const curl = `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(info.example)}'`;
    box.replaceChildren(h('label', {}, 'Webhook URL (keep it private: it contains a secret)'), h('div', { class: 'snip2' }, h('code', {}, url), h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('URL copied', 'ok'); } catch { toast('Copy failed', 'bad'); } } }, icon('copy', 12), 'Copy')),
      h('details', {}, h('summary', {}, 'Example request'), codeBlock(curl, { lang: 'sh', title: 'curl', label: 'Request' })), h('p', { class: 'muted small' }, `${info.received} alert${info.received === 1 ? '' : 's'} received in the last 24 hours. The server listens on this machine only: to receive alerts from the internet, put an HTTPS tunnel or reverse proxy in front of it.`),
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn small ghost', onclick: act(async () => draw(await op('webhook_rotate')), 'New secret generated; the old URL no longer works') }, 'Generate a new secret'))); };
  op('webhook_info').then(draw).catch((e) => box.replaceChildren(h('div', { class: 'note bad' }, e.message)));
  return card('', h('div', { class: 'card-h' }, h('h2', {}, 'Alerts become tickets')), h('p', { class: 'muted small' }, 'Point an error tracker, a monitor (Skylark, Vantage, Sentry…) or any script at this URL. Each alert is checked, de-duplicated by its key, and queued as a ticket the factory fixes; you still review every PR.'), box);
}

export function briefTab(pack, { id, rerender }) {
  const drafts = {}; const status = h('span', { class: 'muted small' }, 'All changes saved'); const done = h('div', { class: 'chips' }); const bar = h('div', {});
  const paintDone = (c) => {
    done.replaceChildren(...pack.fields.map((f) => { const ok = !c.missing.includes(f.label); return h('span', { class: `pill2 ${ok ? 'ok' : ''}` }, ok ? '✓ ' : '○ ', f.label); }));
    bar.replaceChildren(meter(c.filled / c.total, c.ready ? '' : 'warn'), h('span', { class: 'mono small' }, `${c.filled} of ${c.total} sections filled${c.ready ? ' · ready to plan' : ' · add at least Goal and In scope to plan'}`));
  };
  paintDone(pack.completeness);
  let saving = null;
  const save = async () => {
    if (!Object.keys(drafts).length) return; const body = { brief: {} }; for (const [k, v] of Object.entries(drafts)) { if (k === 'stack' || k === 'decisions') body[k] = v; else body.brief[k] = v; }
    status.textContent = 'Saving…'; saving = api(`/projects/${id}/pack`, { method: 'POST', body }); try { const r = await saving; for (const k of Object.keys(drafts)) delete drafts[k]; paintDone(r.completeness); status.textContent = 'All changes saved'; saveBtn.disabled = true; } catch (e) { status.textContent = 'Not saved'; toast(e.message, 'bad'); }
  };
  const saveBtn = h('button', { class: 'btn primary', disabled: true, onclick: save }, 'Save');
  const field = (key, label, hint, value, rows = 3) => { const ta = h('textarea', { rows, placeholder: hint, spellcheck: 'true' }, value ?? ''); ta.addEventListener('input', () => { drafts[key] = ta.value; saveBtn.disabled = false; status.textContent = 'Unsaved changes'; }); ta.addEventListener('blur', save);
    return h('div', { class: 'bfield' }, h('label', {}, label), ta, h('p', { class: 'muted small' }, hint)); };

  // sources
  let mode = 'file'; const addBox = h('div', { class: 'addsrc' });
  const kindSel = h('select', { 'aria-label': 'Kind' }, Object.entries(KIND).map(([v, l]) => h('option', { value: v }, l))); const titleIn = h('input', { placeholder: 'Title (e.g. "Booking flow PRD")', 'aria-label': 'Title' });
  const drawAdd = () => {
    const file = h('input', { type: 'file', accept: '.md,.txt,.json,.csv,.html,.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg', 'aria-label': 'File' }); const url = h('input', { placeholder: 'https://www.figma.com/file/…  or a Notion / Google Docs / Jira link', 'aria-label': 'Link' }); const text = h('textarea', { rows: 5, placeholder: 'Paste the PRD, research notes, or anything the agent should know…' });
    const submit = act(async () => {
      await save(); const body = { kind: kindSel.value, title: titleIn.value.trim() || undefined };
      if (mode === 'file') { const f = file.files?.[0]; if (!f) throw new Error('Choose a file first'); if (f.size > 5 * 1024 * 1024) throw new Error('Files can be at most 5 MB'); body.filename = f.name; body.title ||= f.name; body.dataBase64 = b64(await f.arrayBuffer()); }
      else if (mode === 'link') { if (!url.value.trim()) throw new Error('Paste a link first'); body.url = url.value.trim(); }
      else { if (!text.value.trim()) throw new Error('Paste some text first'); body.text = text.value; body.title ||= 'Pasted notes'; }
      await api(`/projects/${id}/pack/sources`, { method: 'POST', body }); }, 'Source added', rerender);
    addBox.replaceChildren(h('div', { class: 'seg' }, [['file', 'Upload a file'], ['link', 'Add a link'], ['text', 'Paste text']].map(([k, l]) => h('button', { class: mode === k ? 'on' : '', onclick: () => { mode = k; drawAdd(); } }, l))),
      h('div', { class: 'two' }, h('div', {}, h('label', {}, 'What is it?'), kindSel), h('div', {}, h('label', {}, 'Title'), titleIn)),
      h('div', { class: 'srcin' }, ...(mode === 'file' ? [file, h('p', { class: 'muted small' }, 'Markdown, text, JSON, CSV, HTML, PDF or images (PNG, JPG, GIF, WebP, SVG), up to 5 MB each.')] : mode === 'link' ? [url, h('p', { class: 'muted small' }, 'Links are stored as references; the factory never fetches them. Paste the key text too if the agent needs to read it.')] : [text])),
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: submit }, icon('plus', 14), 'Add source')));
  };
  drawAdd();
  const publish = act(async () => { await save(); const r = await api(`/projects/${id}/pack/publish`, { method: 'POST', body: {} }); toast(r.published ? `Pull request opened: ${r.pr}` : r.message, 'ok'); }, null, rerender);

  return [
    card('', h('div', { class: 'card-h' }, h('h2', {}, 'Project brief'), h('div', { class: 'row' }, status, saveBtn)), bar, done,
      h('p', { class: 'muted small' }, 'This is what the factory knows about the project beyond its tickets. Every agent run receives the brief, the conventions, the decisions and the sources that match its ticket, and the Plan tab turns it into epics and tickets.')),
    card('', h('div', { class: 'card-h' }, h('h2', {}, 'What are we building?')), h('div', { class: 'bgrid' }, pack.fields.map((f) => field(f.key, f.label, f.hint, pack.brief[f.key], f.key === 'goal' ? 3 : 5)))),
    card('', h('div', { class: 'card-h' }, h('h2', {}, 'How we build it')), h('div', { class: 'bgrid' },
      field('stack', 'Stack and conventions', 'Language, frameworks, test runner, folder layout, naming, "always / never" rules. The agent follows these.', pack.stack, 7), field('decisions', 'Decisions already made', 'One per line, with the reason. The agent will not reopen these. e.g. "Use SQLite, no server to run."', pack.decisions, 7))),
    card('', h('div', { class: 'card-h' }, h('h2', {}, 'Source material'), pill(`${pack.sources.length} attached`, pack.sources.length ? 'ok' : 'muted')),
      h('p', { class: 'muted small' }, 'PRDs, research, designs and references. The agent gets an index of everything and the text of the sources that match each ticket; files are also readable on disk during a run.'),
      pack.sources.length ? h('ul', { class: 'plain srclist' }, pack.sources.map((s) => h('li', {}, pill(KIND[s.kind] ?? s.kind, 'muted'), h('span', { class: 'srctitle' }, s.url ? ext(s.url, s.title, 'loc') : s.title), h('span', { class: 'muted small mono' }, s.file ? `${size(s.bytes)} · ${s.type}` : 'link'), h('span', { class: 'muted small' }, ago(s.added)),
        h('button', { class: 'btn small ghost', onclick: act(() => api(`/projects/${id}/pack/sources/${s.id}/remove`, { method: 'POST', body: {} }), 'Removed', rerender) }, 'Remove')))) : h('p', { class: 'muted' }, 'Nothing attached yet.'), addBox),
    card('', h('div', { class: 'card-h' }, h('h2', {}, 'Keep it with the code'), pack.publishedAt ? pill(`published ${ago(pack.publishedAt)}`, 'ok') : pill('not in the repo yet', 'muted')),
      h('p', { class: 'muted small' }, 'Publishing opens a pull request that adds a `.factory/` folder (brief, conventions, decisions, sources, plan) to the repository, so it is versioned with the code and readable by any teammate or agent, including Claude or Codex run by hand.'),
      pack.publishedPr && /^https?:/.test(pack.publishedPr) ? h('p', { class: 'small' }, 'Last pull request: ', ext(pack.publishedPr, pack.publishedPr, 'loc')) : null, h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: publish }, 'Publish to the repo (opens a PR)'))),
    hookCard(id),
  ];
}

// ================================================================== PLAN
const STATUS = { planned: ['Not started', ''], queued: ['Queued', 'info'], working: ['Building', 'warn'], review: ['In review', 'ok'], done: ['Done', 'ok solid'], failed: ['Needs attention', 'bad'], 'needs-info': ['Needs info', 'bad'], other: ['In progress', 'warn'] };
const statusPill = (s) => { const [l, c] = STATUS[s] ?? STATUS.other; return pill(l, c); };

export function planTab(data, pack, { id, rerender, poll, openBrief }) {
  const { plan, progress, job } = data; const c = pack.completeness;
  if (job?.state === 'running') { poll(); return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'Drafting the plan…')), h('div', { class: 'working' }, h('i', { class: 'spin' }), h('div', {}, h('b', {}, job.phase || 'working'), h('p', { class: 'muted small' }, 'The agent is reading your brief, conventions and sources and the existing code, then proposing epics and small tickets. This takes a few minutes. You can leave this page.'))))]; }
  if (!plan) return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'From brief to tickets')),
    h('div', { class: 'flow3' }, [['1', 'Brief', 'Goal, scope, conventions, sources'], ['2', 'Plan', 'The agent proposes epics and small tickets with acceptance criteria'], ['3', 'You approve', 'Edit, remove or reorder, then launch'], ['4', 'Build', 'Tickets are created as their dependencies merge; every PR is reviewed by you']].map(([n, t, d]) => h('div', { class: 'step3' }, h('b', {}, n), h('div', {}, h('strong', {}, t), h('p', { class: 'muted small' }, d))))),
    job?.state === 'error' ? h('div', { class: 'note bad' }, icon('alert', 14), ' The last attempt failed: ', job.error) : null,
    c.ready ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(() => api(`/projects/${id}/plan`, { method: 'POST', body: {} }), 'Planning started', rerender) }, 'Draft a plan from the brief'), h('span', { class: 'muted small' }, `Uses the brief (${c.filled}/${c.total} sections) and ${c.sources} source${c.sources === 1 ? '' : 's'}.`))
      : h('div', {}, h('div', { class: 'note bad' }, icon('alert', 14), ' The brief needs at least a Goal and what is In scope before a plan can be drafted.'), h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: openBrief }, 'Fill in the brief →'))))];

  const launched = plan.status !== 'proposed'; if (launched && plan.status !== 'complete') poll(8000);
  const epics = structuredClone(plan.epics); let dirty = false; const total = epics.reduce((n, e) => n + e.tickets.length, 0);
  const root = h('div', { class: 'planbody' }); const markDirty = () => { dirty = true; saveBtn.disabled = false; saveBtn.textContent = 'Save edits'; };
  const saveBtn = h('button', { class: 'btn', disabled: true, onclick: act(async () => { await persist(); }, 'Plan saved', rerender) }, 'Save edits');
  const persist = async () => { await api(`/projects/${id}/plan/edit`, { method: 'POST', body: { epics, summary: plan.summary } }); dirty = false; };
  let armed = false; const launchBtn = h('button', { class: 'btn primary', onclick: async (e) => { if (!armed) { armed = true; launchBtn.textContent = `Confirm: create ${epics.reduce((n, x) => n + x.tickets.length, 0)} tickets as their dependencies are done`; setTimeout(() => { armed = false; launchBtn.textContent = 'Launch plan'; }, 6000); return; }
    await act(async () => { if (dirty) await persist(); await api(`/projects/${id}/plan/launch`, { method: 'POST', body: {} }); }, 'Plan launched', rerender)(e); } }, 'Launch plan');

  const ticketRow = (e, t) => {
    if (launched) return h('li', { class: `tk ${t.status}` }, statusPill(t.status), pill(t.size, 'muted'), h('span', { class: 'tktitle' }, t.url ? ext(t.url, t.title, 'loc') : t.title), t.dependsOn.length ? h('span', { class: 'muted small mono' }, `after ${t.dependsOn.join(', ')}`) : h('span', {}));
    const title = h('input', { value: t.title, 'aria-label': 'Ticket title', oninput: () => { t.title = title.value; markDirty(); } }); const size = h('select', { 'aria-label': 'Size', onchange: () => { t.size = size.value; markDirty(); } }, ['S', 'M', 'L'].map((v) => { const o = h('option', { value: v }, v); o.selected = t.size === v; return o; }));
    const body = h('textarea', { rows: 6, 'aria-label': 'Ticket details', oninput: () => { t.body = body.value; markDirty(); } }, t.body);
    return h('li', { class: 'tk edit' }, h('div', { class: 'tk-row' }, size, title, t.dependsOn.length ? h('span', { class: 'muted small mono' }, `after ${t.dependsOn.join(', ')}`) : h('span', {}),
      h('button', { class: 'btn small ghost', title: 'Remove this ticket', onclick: () => { e.tickets = e.tickets.filter((x) => x !== t); for (const ep of epics) for (const x of ep.tickets) x.dependsOn = x.dependsOn.filter((d) => d !== t.id); markDirty(); draw(); } }, 'Remove')),
      h('details', {}, h('summary', {}, 'Details and acceptance criteria'), body));
  };
  const draw = () => root.replaceChildren(...epics.map((e) => card('epic', h('div', { class: 'card-h' }, h('h3', {}, e.title), h('div', { class: 'row' }, e.trackerUrl ? ext(e.trackerUrl, 'Epic in your tracker', 'btn small') : null, pill(`${e.tickets.length} ticket${e.tickets.length === 1 ? '' : 's'}`, 'muted'))), e.trackerError ? h('div', { class: 'note bad' }, icon('alert', 14), ` Could not create the epic in your tracker: ${e.trackerError}`) : null, e.goal ? h('p', { class: 'muted small' }, e.goal) : null, h('ul', { class: 'plain tks' }, e.tickets.map((t) => ticketRow(e, t))))));
  draw();

  const head = launched
    ? card('', h('div', { class: 'card-h' }, h('h2', {}, plan.status === 'complete' ? 'Plan complete' : 'Plan in progress'), pill(`${progress.done} of ${progress.total} done`, plan.status === 'complete' ? 'ok' : 'warn')), meter(progress.total ? progress.done / progress.total : 0, plan.status === 'complete' ? '' : 'warn'),
        h('div', { class: 'facts' }, [[progress.planned, 'not started'], [progress.queued + progress.working, 'building'], [progress.review, 'in review'], [progress.done, 'done'], [progress.failed, 'need attention']].map(([n, l]) => h('div', { class: 'fact' }, h('b', {}, String(n)), h('span', {}, l)))),
        h('p', { class: 'muted small' }, plan.summary), h('p', { class: 'muted small' }, 'A ticket is created when everything it depends on is merged and closed, so each one builds on real code. Review and merge the open PRs to release the next ones.'))
    : card('', h('div', { class: 'card-h' }, h('h2', {}, 'Proposed plan'), pill(`${total} tickets in ${epics.length} epics`, 'muted')), h('p', {}, plan.summary),
        h('p', { class: 'muted small' }, 'Read it, then edit titles and details, remove anything you do not want, and launch. Nothing is created in your tracker until you launch. Tickets with dependencies are created only after the tickets they depend on are merged.'),
        h('div', { class: 'row gap-t' }, launchBtn, saveBtn, h('button', { class: 'btn ghost', onclick: act(() => api(`/projects/${id}/plan/discard`, { method: 'POST', body: {} }), 'Plan discarded', rerender) }, 'Discard and re-draft')));
  return [head, designStageCard(id, data.designStage, rerender, { poll }), root].filter(Boolean);
}
