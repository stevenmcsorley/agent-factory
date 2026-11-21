// Skills: reusable instructions agents receive for a kind of work. List, edit, preview what an agent would actually get, and have the skill-writer draft one.
// A draft is only ever loaded into the editor for you to read and save; nothing is applied automatically.
// SECURITY: all text through h().
import { h, icon, api, toast, act } from './lib.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const lbl = (text, ctl, help) => h('div', { class: 'sfield' }, h('label', {}, text), ctl, help ? h('small', { class: 'help muted' }, help) : null);
let current = null; let draftJob = null; let preview = null; let banner = '';

export const skillsPage = {
  async load() { const [s, st] = await Promise.all([api('/skills'), api('/status').catch(() => null)]); return { s, projects: st?.projects?.map((p) => p.project) ?? [] }; },
  draw({ s, projects }, ctx) {
    const byName = new Map(s.skills.map((k) => [k.name, k]));
    if (draftJob) { api(`/skills/draft/${draftJob}`).then((j) => { if (j.state === 'running') setTimeout(() => ctx.rerender(), 2500); else { draftJob = null; if (j.state === 'done') { current = { ...j.draft, draft: true, existing: byName.has(j.draft.name) }; banner = 'Drafted by the skill-writer. Read it, change what you like, then save. Nothing is saved yet.'; } else toast(`The draft failed: ${j.error}`, 'bad'); ctx.rerender(); } }).catch(() => { draftJob = null; }); }
    const open = (k) => { current = { ...k, existing: true }; preview = null; banner = ''; ctx.rerender(); };
    const list = card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Skills')),
      h('p', { class: 'muted small' }, 'Instructions an agent reads before a kind of work. Each goes only to the roles (and projects) you choose.'),
      h('div', { class: 'slist', role: 'list' }, s.skills.map((k) => h('button', { class: current?.name === k.name ? 'on' : '', onclick: () => open(k) }, h('b', {}, k.name), h('span', { class: 'muted small' }, k.description || '—'),
        h('span', { class: 'pills' }, k.builtin ? h('span', { class: 'pill2' }, k.overridden ? 'built-in, changed' : 'built-in') : h('span', { class: 'pill2 info' }, 'yours'), ...k.roles.map((r) => h('span', { class: 'pill2' }, r)))))),
      h('button', { class: 'btn gap-t', onclick: () => { current = { name: '', description: '', roles: ['builder'], projects: 'all', body: '', existing: false }; preview = null; banner = ''; ctx.rerender(); } }, icon('plus', 12), 'New skill'));

    const ask = h('textarea', { rows: 3, placeholder: 'e.g. "Help agents write safe database migrations in this stack"', 'aria-label': 'What the skill should help with' });
    const writer = card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Skill writer')), h('p', { class: 'muted small' }, 'Describe what you want and the skill-writer agent drafts the file. To improve the skill you have open, tick the box.'),
      ask, current?.existing ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'sk-improve' }), ` Improve “${current.name}” instead of writing a new one`) : null,
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn', disabled: !!draftJob, onclick: act(async () => { const improve = document.getElementById('sk-improve')?.checked ? current.name : undefined; const j = await api('/skills/draft', { method: 'POST', body: { request: ask.value, ...(improve ? { improve } : {}) } }); draftJob = j.id; }, 'Drafting… this takes a minute or two.', ctx.rerender) }, icon('spark', 13), draftJob ? 'Drafting…' : 'Draft with the skill-writer')));

    if (!current) return [h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Skills'), h('p', { class: 'sub' }, 'Reusable instructions for your agents: how to review, fix a bug, write tests, design. Edit the built-in ones or write your own.'))), h('div', { class: 'two-col' }, list, writer)];

    const k = current; const name = h('input', { value: k.name, readonly: k.existing && !k.draft, placeholder: 'lowercase-with-dashes', 'aria-label': 'Name' }); const src = h('input', { value: k.source ?? '', maxlength: 200, placeholder: 'Where the ideas came from (optional)', 'aria-label': 'Source' }); const desc = h('input', { value: k.description, maxlength: 240, placeholder: 'What this is for, in a sentence', 'aria-label': 'Description' });
    const roles = new Set(k.roles); const rbox = h('div', { class: 'rolebox', role: 'group', 'aria-label': 'Roles' }, ['any', ...s.roles].map((r) => { const c = h('input', { type: 'checkbox', id: `sk-r-${r}` }); c.checked = roles.has(r); c.addEventListener('change', () => { c.checked ? roles.add(r) : roles.delete(r); }); return h('label', { class: 'check', for: `sk-r-${r}` }, c, ` ${r}`); }));
    const proj = h('input', { value: k.projects === 'all' ? 'all' : (k.projects ?? []).join(', '), placeholder: 'all, or project ids separated by commas', 'aria-label': 'Projects', list: 'sk-projects' });
    const body = h('textarea', { rows: 16, class: 'mono', spellcheck: 'false', 'aria-label': 'Instructions' }); body.value = k.body;
    const pvRole = h('select', { 'aria-label': 'Role' }, s.roles.map((r) => h('option', { value: r }, r))); const pvProj = h('select', { 'aria-label': 'Project' }, [h('option', { value: '' }, '(no project)'), ...projects.map((p) => h('option', { value: p }, p))]);
    const editor = card(h('div', { class: 'card-h' }, h('h2', {}, k.existing && !k.draft ? k.name : 'Skill'), k.builtin && !k.overridden ? h('span', { class: 'stamp' }, 'built-in: saving makes your own copy') : null),
      banner ? h('div', { class: 'note info' }, icon('spark', 14), ' ', banner) : null,
      h('div', { class: 'sfields' }, lbl('Name', name), lbl('Description', desc)), lbl('Source', src), h('label', {}, 'Goes to these roles'), rbox, h('datalist', { id: 'sk-projects' }, projects.map((p) => h('option', { value: p }))), lbl('Projects', proj), h('label', {}, 'Instructions'), body,
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { const saved = await api('/skills', { method: 'POST', body: { name: name.value.trim(), description: desc.value, source: src.value, roles: [...roles].join(',') || 'any', projects: proj.value.trim() || 'all', body: body.value } }); current = { ...saved, existing: true }; banner = ''; }, 'Skill saved. Agents get it from their next run.', ctx.rerender) }, icon('check', 13), 'Save'),
        k.existing && (k.overridden || !k.builtin) && !k.draft ? h('button', { class: 'btn', onclick: act(async () => { const r = await api(`/skills/${k.name}/delete`, { method: 'POST', body: {} }); current = r.restoredBuiltin ? null : null; }, k.builtin ? 'Back to the built-in text' : 'Deleted', ctx.rerender) }, k.builtin ? 'Restore the built-in' : 'Delete') : null,
        h('button', { class: 'btn ghost', onclick: () => { current = null; banner = ''; preview = null; ctx.rerender(); } }, 'Close')),
      h('h3', {}, 'What would an agent get?'), h('p', { class: 'muted small' }, 'Pick a role and project to see the exact skill text that agent would receive, with the same limits applied.'),
      h('div', { class: 'row nowrap' }, pvRole, pvProj, h('button', { class: 'btn', onclick: act(async () => { preview = await api(`/skills/preview?role=${encodeURIComponent(pvRole.value)}${pvProj.value ? `&project=${encodeURIComponent(pvProj.value)}` : ''}`); preview.role = pvRole.value; }, null, ctx.rerender) }, 'Preview')),
      preview ? h('div', {}, h('p', { class: 'small muted' }, preview.names.length ? `${preview.role} gets: ${preview.names.join(', ')}` : `${preview.role} gets no skills here.`), preview.text ? h('pre', { class: 'preview' }, preview.text) : null) : null);
    return [h('a', { class: 'back', href: '#/skills', onclick: () => { current = null; banner = ''; preview = null; } }, icon('arrow', 12, 'flip'), 'All skills'), h('div', { class: 'two-col' }, list, h('div', {}, editor, writer))];
  },
};
