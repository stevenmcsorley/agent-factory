// The Library page: the catalog of reusable parts shared by every project, the repeated code that should become parts, and upgrades.
import { h, icon, api, toast, ago, num, ext, act } from './lib.js';

const op = (name, body = {}) => api(`/op/${name}`, { method: 'POST', body });
const card = (cls, ...kids) => h('section', { class: `card ${cls ?? ''}` }, ...kids);
const pill = (text, cls = '') => h('span', { class: `pill2 ${cls}` }, text);
const KIND = { component: 'Component', hook: 'Hook', util: 'Utility', service: 'Service', schema: 'Schema', style: 'Style', config: 'Config', other: 'Other' };
const view = { sub: 'parts', q: '', kind: '', open: null, file: 0, promote: null };
const copy = async (text, label) => { try { await navigator.clipboard.writeText(text); toast(`${label} copied`, 'ok'); } catch { toast('Copy failed', 'bad'); } };
const ghUrl = (repo, base, file) => (/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') ? `https://github.com/${repo}/blob/${encodeURIComponent(base || 'main')}/${String(file).split('/').map(encodeURIComponent).join('/')}` : null);

export const library = {
  async load() {
    const [status, projects] = await Promise.all([op('library_status'), api('/overview').catch(() => [])]);
    if (!status.configured) return { status, projects };
    const [parts, candidates, upgrades] = await Promise.all([op('library_list').catch(() => []), op('library_candidates').catch(() => []), op('library_upgrades').catch(() => [])]);
    return { status, projects, parts, candidates, upgrades };
  },
  draw(d, ctx) {
    const head = h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Library'), h('p', { class: 'sub' }, 'Reusable parts shared by every project. When something is built, the factory tells the agent what already exists, so it reuses instead of rewriting.')));
    if (!d.status.configured) return [head, setup(ctx)];
    const { status, parts, candidates, upgrades, projects } = d;
    const open = candidates.filter((c) => !c.inLibrary);
    const tabs = [['parts', 'Parts', parts.length], ['candidates', 'Repeated code', open.length], ['upgrades', 'Upgrades', upgrades.length], ['how', 'How it works']];
    const body = h('div', { class: 'codebody' }); const nav = h('div', { class: 'subtabs', role: 'tablist' });
    const go = (sub) => { view.sub = sub; view.open = null; drawNav(); drawBody(); };
    const drawNav = () => nav.replaceChildren(...tabs.map(([k, l, n]) => h('button', { role: 'tab', 'aria-selected': String(view.sub === k), class: view.sub === k ? 'on' : '', onclick: () => go(k) }, l, n ? h('span', { class: 'badge' }, String(n)) : null)));
    const drawBody = () => body.replaceChildren(...({ parts: partsTab, candidates: candidatesTab, upgrades: upgradesTab, how: howTab }[view.sub])({ parts, candidates, upgrades, projects, status, ctx, redraw: drawBody, go }));
    drawNav(); drawBody();
    const refresh = act(() => op('library_refresh'), 'Library refreshed', ctx.rerender);
    return [head, card('', h('div', { class: 'card-h' }, h('h2', {}, status.repo ?? 'Library'), h('div', { class: 'row' }, status.url ? ext(status.url, 'Open the repo', 'btn small') : null, h('button', { class: 'btn small ghost', onclick: refresh }, 'Refresh'))),
      h('div', { class: 'facts' }, [[status.parts, 'parts'], [status.tested, 'with tests'], [status.uses, 'recorded uses'], [open.length, 'repeated-code candidates']].map(([n, l]) => h('div', { class: 'fact' }, h('b', {}, String(n)), h('span', {}, l)))),
      h('p', { class: 'muted small' }, status.pulledAt ? `Last synced ${ago(status.pulledAt)}. Parts you promote arrive as pull requests in the library repo; merge them and they appear here.` : 'Not synced yet.'), nav), body];
  },
};

// ------------------------------------------------------------ not set up yet
function setup(ctx) {
  const name = h('input', { value: 'factory-library', 'aria-label': 'Repository name' }); const repo = h('input', { placeholder: 'owner/name, or a git URL', 'aria-label': 'Existing repository' });
  return h('div', { class: 'codebody' }, card('', h('div', { class: 'card-h' }, h('h2', {}, 'Build a library your projects share')),
    h('div', { class: 'flow3' }, [['1', 'Detect', 'The factory finds the same component or logic repeated across your projects'], ['2', 'Promote', 'One click turns it into a tested part in a library repo you own (as a pull request)'], ['3', 'Reuse', 'Before every build the agent is told "you already have these" and copies the part instead of writing it again'], ['4', 'Maintain', 'Version a part and the factory opens upgrade tickets in the projects using the old one']].map(([n, t, x]) => h('div', { class: 'step3' }, h('b', {}, n), h('div', {}, h('strong', {}, t), h('p', { class: 'muted small' }, x)))))),
  h('div', { class: 'bgrid' },
    card('', h('h2', {}, 'Create a new library'), h('p', { class: 'muted small' }, 'Creates a private GitHub repository under your account with the folder structure and a CI check that validates parts and runs their tests.'), h('label', {}, 'Repository name'), name,
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(() => op('library_setup', { action: 'create', name: name.value.trim() }), 'Library created', ctx.rerender) }, icon('plus', 14), 'Create the library'))),
    card('', h('h2', {}, 'Connect an existing repository'), h('p', { class: 'muted small' }, 'Point at a repo that already holds parts (or an empty one: it is set up for you).'), h('label', {}, 'Repository'), repo,
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: act(() => { const v = repo.value.trim(); if (!v) throw new Error('Enter a repository first'); return op('library_setup', { action: 'connect', ...(/^[\w.-]+\/[\w.-]+$/.test(v) ? { repo: v } : { remote: v }) }); }, 'Library connected', ctx.rerender) }, 'Connect')))));
}

// ------------------------------------------------------------ parts
function partsTab({ parts, projects, ctx, redraw }) {
  if (!parts.length) return [card('', h('p', { class: 'muted' }, 'The library is empty. Open the Repeated code tab to see what should be promoted, or promote any file from a project with '), h('code', {}, 'agent-factory library promote <project> <file> --name="…"'))];
  const search = h('input', { type: 'search', placeholder: 'Search parts by name, tag, function or summary…', value: view.q, 'aria-label': 'Search parts', oninput: (e) => { view.q = e.target.value; paint(); } });
  const kinds = [...new Set(parts.map((p) => p.kind))]; const chips = h('div', { class: 'chips' }, [['', 'All'], ...kinds.map((k) => [k, KIND[k] ?? k])].map(([k, l]) => h('button', { class: `chip ${view.kind === k ? 'on' : ''}`, onclick: (e) => { view.kind = k; chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); e.currentTarget.classList.add('on'); paint(); } }, l)));
  const list = h('div', { class: 'pgrid' }); const detail = h('div', {});
  const paint = () => {
    const q = view.q.trim().toLowerCase();
    const rows = parts.filter((p) => (!view.kind || p.kind === view.kind) && (!q || `${p.name} ${p.slug} ${p.summary} ${p.tags.join(' ')} ${p.exports.map((e) => e.name).join(' ')}`.toLowerCase().includes(q)));
    if (!rows.length) { list.replaceChildren(h('div', { class: 'empty-s' }, icon('search', 22), h('b', {}, 'No parts match'))); return; }
    list.replaceChildren(...rows.map((p) => h('article', { class: `part ${view.open === p.slug ? 'sel' : ''}`, onclick: () => { view.open = p.slug; view.file = 0; paint(); drawDetail(); } },
      h('div', { class: 'f-head' }, h('b', { class: 'f-title' }, p.name), pill(`v${p.version}`, 'muted'), pill(KIND[p.kind] ?? p.kind, 'muted'), p.tested ? pill('tested', 'ok') : pill('no tests', 'warn'), p.deprecated ? pill('deprecated', 'bad') : null),
      h('p', { class: 'f-msg' }, p.summary || 'No summary yet.'), p.exports.length ? h('code', { class: 'sigs' }, p.exports.slice(0, 3).map((e) => e.signature || e.name).join('  ·  ')) : null,
      h('div', { class: 'chips' }, p.tags.slice(0, 5).map((t) => pill(t, 'muted')), p.usedBy.length ? pill(`used by ${p.usedBy.length} project${p.usedBy.length === 1 ? '' : 's'}`, 'info') : null))));
  };
  const drawDetail = () => { const p = parts.find((x) => x.slug === view.open); detail.replaceChildren(...(p ? [partDetail(p, projects, ctx, () => { view.open = null; paint(); drawDetail(); })] : [])); if (p) detail.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); };
  paint(); drawDetail();
  return [card('', h('div', { class: 'toolbar' }, search), chips, list), detail];
}

function partDetail(p, projects, ctx, close) {
  const body = h('div', {}); const fileBox = h('div', {}); let full = null;
  const showFile = () => { if (!full) return; const f = full.files[view.file] ?? full.files[0]; fileBox.replaceChildren(h('div', { class: 'tabs2' }, full.files.map((x, i) => h('button', { class: `chip ${i === view.file ? 'on' : ''}`, onclick: () => { view.file = i; showFile(); } }, x.path, x.role === 'test' ? ' (test)' : ''))), h('pre', { class: 'code big' }, h('code', {}, f?.content ?? '')), h('div', { class: 'row' }, h('button', { class: 'btn small ghost', onclick: () => copy(f.content, 'File') }, icon('copy', 12), 'Copy file'))); };
  const proj = h('select', { 'aria-label': 'Project' }, [h('option', { value: '' }, 'Choose a project…'), ...projects.map((x) => h('option', { value: x.id }, x.id))]); const note = h('input', { placeholder: 'What do you need it for? (optional)', 'aria-label': 'Purpose' });
  const use = act(async () => { if (!proj.value) throw new Error('Choose a project first'); await op('use_part', { part: p.slug, project: proj.value, note: note.value.trim() || undefined }); }, 'Ticket queued: the agent will add the part', null);
  op('library_get', { part: p.slug }).then((r) => { full = r; showFile(); body.replaceChildren(
    r.usage ? h('div', {}, h('h3', {}, 'Usage'), h('pre', { class: 'code' }, h('code', {}, r.usage)), h('button', { class: 'btn small ghost', onclick: () => copy(r.usage, 'Usage') }, icon('copy', 12), 'Copy')) : null,
    r.exports.length ? h('div', {}, h('h3', {}, 'API'), h('ul', { class: 'plain' }, r.exports.map((e) => h('li', {}, h('code', {}, e.signature || e.name), h('span', { class: 'muted small' }, ` ${e.kind}`))))) : null,
    h('h3', {}, 'Files'), fileBox,
    r.usedBy.length ? h('div', {}, h('h3', {}, 'Used by'), h('ul', { class: 'plain' }, r.usedBy.map((u) => h('li', { class: 'small' }, h('b', {}, u.project), ` v${u.version}`, u.version !== r.version ? pill(`latest is ${r.version}`, 'warn') : pill('current', 'ok'), h('span', { class: 'muted' }, ` · ${ago(u.at)}`))))) : h('p', { class: 'muted small' }, 'No project has used this part yet.'),
    r.origin?.repo ? h('p', { class: 'muted small' }, 'Extracted from ', h('b', {}, r.origin.repo), ': ', r.origin.files.map((f, i) => [i ? ', ' : '', ghUrl(r.origin.repo, r.origin.base, f) ? ext(ghUrl(r.origin.repo, r.origin.base, f), f, 'loc') : f])) : null,
    r.changelog.length ? h('details', {}, h('summary', {}, `Changelog (${r.changelog.length})`), h('ul', { class: 'plain' }, r.changelog.slice().reverse().map((c) => h('li', { class: 'small' }, h('b', {}, c.version), ` ${c.date.slice(0, 10)} · ${c.note}`)))) : null); }).catch((e) => body.replaceChildren(h('div', { class: 'note bad' }, e.message)));
  return card('detail', h('div', { class: 'card-h' }, h('h2', {}, `${p.name} `, h('span', { class: 'muted mono' }, `${p.slug}@${p.version}`)), h('button', { class: 'btn small ghost', onclick: close }, 'Close')), h('p', {}, p.summary),
    h('div', { class: 'usebox' }, h('b', {}, 'Use it in a project'), h('div', { class: 'toolbar' }, proj, note, h('button', { class: 'btn primary', onclick: use }, 'Queue a ticket to add it')), h('p', { class: 'muted small' }, 'Creates a normal ticket. The agent is given the part’s files and copies them in, then tests, the quality gate and your review apply as usual.')), body);
}

// ------------------------------------------------------------ repeated code -> promote
function candidatesTab({ candidates, projects, ctx }) {
  if (!candidates.length) return [card('', h('p', { class: 'ok-note big' }, icon('check', 20), ' No repeated code found across your projects yet.'), h('p', { class: 'muted small' }, 'Candidates appear after each project is analyzed (Code tab → Re-analyze). The factory compares fingerprints of every source file, so renamed copies are found too.'))];
  return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'Repeated code worth promoting'), pill(`${candidates.length} found`, 'warn')), h('p', { class: 'muted small' }, 'The same code appears more than once. Promote the best copy to the library, then the factory points every future build at it.'),
    h('div', { class: 'dups' }, candidates.map((c) => candidate(c, ctx))))];
}
function candidate(c, ctx) {
  const box = h('div', {});
  const form = () => {
    const byProject = [...new Set(c.locations.map((l) => l.project))]; const from = h('select', { 'aria-label': 'Take the code from' }, byProject.map((x) => h('option', { value: x }, x)));
    const name = h('input', { value: c.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (x) => x.toUpperCase()), 'aria-label': 'Part name' }); const summary = h('input', { placeholder: 'What it does and when to use it', 'aria-label': 'Summary' }); const tags = h('input', { placeholder: 'tags, comma separated', 'aria-label': 'Tags' });
    const files = h('div', { class: 'checks2' }); const drawFiles = () => files.replaceChildren(...c.locations.filter((l) => l.project === from.value).map((l) => { const cb = h('input', { type: 'checkbox', value: l.file }); cb.checked = true; return h('label', { class: 'check' }, cb, ` ${l.file} `, h('span', { class: 'muted small' }, `${l.lines} lines`)); })); from.addEventListener('change', drawFiles); drawFiles();
    const direct = h('input', { type: 'checkbox' }); const go = act(async () => { const sel = [...files.querySelectorAll('input:checked')].map((i) => i.value); if (!sel.length) throw new Error('Pick at least one file'); if (!name.value.trim()) throw new Error('Give the part a name');
      const r = await op('promote_part', { project: from.value, files: sel, name: name.value.trim(), summary: summary.value.trim() || undefined, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean), direct: direct.checked }); toast(r.changed === false ? r.message : r.direct ? 'Added to the library' : r.pr ? `Pull request opened: ${r.pr}` : `Branch pushed: ${r.branch}`, 'ok'); box.replaceChildren(); ctx.rerender(); }, null);
    box.replaceChildren(h('div', { class: 'promote' }, h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Part name'), name), h('div', {}, h('label', {}, 'Take the code from'), from)), h('label', {}, 'Summary'), summary, h('label', {}, 'Tags'), tags, h('label', {}, 'Files (matching tests are added automatically)'), files,
      h('label', { class: 'check' }, direct, ' Add straight to the library without a pull request (your own library)'), h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: go }, 'Promote to the library'), h('button', { class: 'btn ghost', onclick: () => box.replaceChildren() }, 'Cancel'))));
  };
  return h('article', { class: 'dup' }, h('div', { class: 'dup-h' }, h('div', { class: 'row' }, h('b', { class: 'f-title' }, c.name), pill(`${c.similarity}% similar`, 'warn'), pill(c.reason, 'muted'), c.inLibrary ? pill(`already in the library: ${c.inLibrary}`, 'ok') : null), c.inLibrary ? null : h('button', { class: 'btn small', onclick: form }, icon('plus', 12), 'Promote…')),
    h('ul', { class: 'plain' }, c.locations.map((l) => h('li', { class: 'small mono' }, h('b', {}, l.project), ` · ${l.file} · ${l.lines} lines`))), box);
}

// ------------------------------------------------------------ upgrades and how it works
function upgradesTab({ upgrades, ctx }) {
  if (!upgrades.length) return [card('', h('p', { class: 'ok-note big' }, icon('check', 20), ' Every project is on the latest version of the parts it uses.'), h('p', { class: 'muted small' }, 'When you change a part and bump its version in the library repo, projects on the old version show up here and the factory can open an upgrade ticket in each.'))];
  const slugs = [...new Set(upgrades.map((u) => u.slug))];
  return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'Projects on an old version')), h('ul', { class: 'plain issues dup' }, upgrades.map((u) => h('li', {}, h('b', {}, u.slug), h('span', { class: 'mono small' }, `${u.project}: ${u.from} → ${u.to}`), u.deprecated ? pill('deprecated', 'bad') : h('span', {}), u.ticketed ? pill('ticket open', 'ok') : pill('no ticket yet', 'warn'), h('span', {})))),
    h('div', { class: 'row gap-t' }, slugs.map((s) => h('button', { class: 'btn', onclick: act(() => op('upgrade_part_users', { part: s }), 'Upgrade tickets opened', ctx.rerender) }, `Open upgrade tickets for ${s}`))))];
}
function howTab() {
  return [card('', h('h2', {}, 'How the library works'),
    h('ol', { class: 'howto' }, [
      ['It lives in a git repo you own.', 'Each part is a folder: part.json (name, kind, summary, tags, stack, version, API), src/, test/ and a README. The repo has a CI check that validates parts and runs their tests.'],
      ['Repeated code is detected for you.', 'Every analysis stores a fingerprint of each source file. The factory compares them across projects, so the same component or logic is found even when variables were renamed.'],
      ['Promote opens a pull request.', 'You choose the files; matching tests are added; the part gets its API and version. Merge the PR and it is in the catalog.'],
      ['Every build starts with "you already have these".', 'The factory searches the catalog against the ticket and project stack and tells the agent which parts fit, with their files. The agent copies them (keeping a provenance header) instead of writing new code.'],
      ['Reuse is recorded.', 'The PR lists the parts used and the project’s .factory/parts.lock.json records the version. New code that rewrites a part is flagged once, then sent back to the agent.'],
      ['Updates reach everyone.', 'Bump a part’s version and the Upgrades tab lists the projects still on the old one; one click opens an upgrade ticket in each.']].map(([t, x]) => h('li', {}, h('b', {}, t), h('p', { class: 'muted small' }, x)))),
    h('p', { class: 'muted small' }, 'From a terminal or an AI agent: '), h('pre', { class: 'code' }, h('code', {}, 'agent-factory library search "format money"\nagent-factory library promote my-app src/money.js --name="Money Format" --tags=currency\nagent-factory library use money-format other-app --note="cart totals"\nagent-factory library upgrades')))];
}
