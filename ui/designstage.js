// The design stage in the UI: where it stands for a project (shown in the Plan tab and the Designs tab), approving all designs at once,
// and the restyle / "make the pages match the designs" controls for a project that already exists.
import { h, icon, api, act } from './lib.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const op = (name, body) => api(`/op/${name}`, { method: 'POST', body });
const lbl = (text, ctl, help) => h('div', { class: 'sfield' }, h('label', {}, text), ctl, help ? h('small', { class: 'help muted' }, help) : null);
const STATE = { none: ['', 'no design stage'], pending: ['warn', 'designs being made'], running: ['warn', 'the designer is working'], review: ['warn', 'waiting for you to approve'], approved: ['ok', 'approved: builders follow them'], failed: ['bad', 'the designer stopped'], skipped: ['', 'skipped for this plan'] };

export function designStageCard(id, st, rerender, { poll } = {}) {
  if (!st) return null; if (st.state === 'running' || st.state === 'pending') poll?.();
  const [cls, text] = STATE[st.state] ?? ['', st.state]; const mode = h('select', { 'aria-label': 'Design stage' }, [['auto', 'Automatic (when the project has pages to design)'], ['on', 'Always design first'], ['off', 'Never: build straight from the written plan']].map(([v, l]) => h('option', { value: v, selected: st.mode === v }, l)));
  const saveMode = act(async () => { await op('set_design_phase', { project: id, mode: mode.value }); }, 'Saved. It applies to plans launched from now on.', rerender);
  const waiting = st.designs.filter((d) => d.status !== 'approved' && d.versions);
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Design stage'), h('span', { class: `stamp ${cls}` }, text)),
    h('p', { class: 'muted' }, 'Like a studio, a project with pages starts with its designs: the designer makes one screen per page and the artwork, you approve them, and only then are build tickets released. Every ticket is told which approved screen it builds, and reviewers check the change against it.'),
    st.state === 'none' && st.wants && !st.required ? h('div', { class: 'note info' }, icon('spark', 14), h('div', {}, 'When a plan is launched for this project, the designer makes the screens and artwork first, and nothing is built until you approve them (or automatically, when it runs unattended).')) : null,
    st.state === 'failed' ? h('div', { class: 'note bad' }, icon('alert', 14), h('div', {}, `The designer stopped: ${st.error ?? 'unknown reason'}. Tickets are waiting. Retry, or skip the designs for this plan.`)) : null,
    st.state === 'review' ? h('div', { class: 'note warn' }, icon('alert', 14), h('div', {}, h('b', {}, 'Your decision: '), 'the designs are ready. Look at them in the Designs tab, ask for changes, or approve them all. Nothing is built until they are approved.')) : null,
    st.designs.length ? h('ul', { class: 'reasons' }, st.designs.map((d) => h('li', {}, h('b', {}, d.title), h('span', { class: 'muted small' }, ` · ${d.kind === 'assets' ? 'artwork' : 'screen'} · ${d.status}${d.version ? ` · v${d.version}` : ''}${d.error ? ` · ${d.error}` : ''}`)))) : null,
    h('div', { class: 'row gap-t' },
      waiting.length ? h('button', { class: 'btn primary', onclick: act(async () => { await op('approve_designs', { project: id }); }, 'All designs approved', rerender) }, icon('check', 13), `Approve all designs (${waiting.length})`) : null,
      st.state === 'failed' ? h('button', { class: 'btn primary', onclick: act(async () => { await op('retry_design_phase', { project: id }); }, 'The designer is on it', rerender) }, 'Try again') : null,
      ['failed', 'review', 'pending', 'running'].includes(st.state) ? h('button', { class: 'btn', title: 'Release the build tickets without the designs, for this plan only', onclick: act(async () => { if (!confirm('Skip the designs for this plan? Builders will work from the written plan only.')) return; await op('skip_design_phase', { project: id }); }, 'Skipped', rerender) }, 'Skip the designs') : null),
    h('div', { class: 'sfields' }, lbl('Design stage for new plans', mode, 'Applies to plans launched from now on.')), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: saveMode }, 'Save')),
    st.drift?.length ? h('div', { class: 'note warn gap-t' }, icon('alert', 14), h('div', {}, h('b', {}, `${st.drift.length} page${st.drift.length === 1 ? '' : 's'} no longer match${st.drift.length === 1 ? 'es' : ''} the approved design: `), st.drift.map((x) => `${x.page} (built from ${x.builtFrom ? `v${x.builtFrom}` : 'no design'}, design is v${x.current})`).join('; '), '. Plan tickets to bring them back in line from the Designs tab.')) : null);
}

// For a project that already exists: a new direction, new designs, then tickets that make the real pages match.
export function restyleCard(id, st, rerender) {
  const dir = h('textarea', { rows: 4, maxlength: 1500, placeholder: 'What should the new look be? For example: warmer and more editorial, larger type, a calmer palette, a new logo and simpler illustrations. Say what to keep.', 'aria-label': 'New direction' });
  const pages = h('select', { 'aria-label': 'Pages' }, [['key', 'The key pages first (home and one more)'], ['all', 'Every page']].map(([v, l]) => h('option', { value: v }, l)));
  const auto = h('input', { type: 'checkbox', id: 'rs-auto' }); const drift = st?.drift ?? []; const approved = st?.designs?.some((d) => d.status === 'approved' && d.kind !== 'assets');
  const start = act(async () => { await op('restyle_project', { project: id, direction: dir.value, pages: pages.value === 'all' ? 'all' : undefined, approve: auto.checked || undefined, match: auto.checked || undefined }); }, 'The designer is looking at what exists and designing the new direction', rerender);
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Restyle or rebrand')),
    h('p', { class: 'muted' }, 'Describe the new direction. The designer looks at what the project is today (screenshots when the visual check is set up), designs the pages and any new artwork, you approve them, and then tickets make the real pages match.'),
    h('label', {}, 'New direction'), dir, h('div', { class: 'sfields' }, lbl('Pages to design', pages)),
    h('label', { class: 'check', for: 'rs-auto' }, auto, ' Approve the designs myself later: no, do it all automatically (approve, then plan and start the matching tickets)'),
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: start }, icon('spark', 13), 'Start the restyle'),
      approved ? h('button', { class: 'btn', title: 'Plan tickets: the shared look first, then the artwork, then one per page', onclick: act(async () => { const r = await op('match_designs', { project: id, all: !drift.length, launch: false }); if (!r.created) throw new Error(r.reason ?? 'Nothing to plan'); }, 'A plan to match the designs is ready to review in the Plan tab', rerender) }, drift.length ? `Plan tickets for the ${drift.length} drifted page${drift.length === 1 ? '' : 's'}` : 'Plan tickets to match the approved designs') : null),
    st?.restyle ? h('p', { class: 'small muted' }, `Last restyle: ${st.restyle.direction.slice(0, 160)}${st.restyle.direction.length > 160 ? '…' : ''}`) : null);
}
