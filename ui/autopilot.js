// The Autopilot tab of a project: why it may be waiting, when it may work (schedule), the reviewer, and autonomous mode.
// SECURITY: every string reaches the DOM through h() (textContent).
import { h, icon, api, toast, ago, act } from './lib.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hours = (ms) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);
const lbl = (text, ctl, help) => h('div', { class: 'sfield' }, h('label', {}, text), ctl, help ? h('small', { class: 'help muted' }, help) : null);

export async function loadAutopilot(id) {
  const [waiting, auto, roles] = await Promise.all([api(`/projects/${id}/waiting`), api(`/projects/${id}/autonomy`), api('/roles')]);
  return { waiting, auto, roles };
}

function waitingCard(w) {
  const reasons = w.reasons ?? [];
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('clock', 17), 'Right now')),
    reasons.length ? h('div', {}, h('p', {}, 'Ready tickets are not being picked up, because:'), h('ul', { class: 'reasons' }, reasons.map((r) => h('li', {}, h('b', {}, r.reason), r.nextAt ? h('span', { class: 'muted small' }, ` · resumes ${new Date(r.nextAt).toLocaleString()}`) : null))))
      : h('p', {}, h('span', { class: 'pill2 solid' }, 'clear'), ' Nothing is holding this project back. Ready tickets are taken on the next cycle.'),
    w.heldTickets?.length ? h('div', {}, h('p', {}, 'Tickets held so they do not collide with an open pull request:'), h('ul', { class: 'reasons' }, w.heldTickets.map((t) => h('li', {}, h('b', {}, `#${t.ticket}`), h('span', { class: 'muted small' }, ` ${t.reason}`))))) : null,
    w.schedule?.hoursPerDay ? h('p', { class: 'muted small' }, `Agent time used today: ${hours(w.usedTodayMs)} of ${w.schedule.hoursPerDay} h.`) : null);
}

function scheduleCard(id, w, rerender) {
  const s = w.schedule ?? {}; const windows = (s.windows ?? []).map((x) => ({ days: [...x.days], from: x.from, to: x.to }));
  const start = h('input', { type: 'date', value: s.startAt?.slice(0, 10) ?? '', 'aria-label': 'Start date' });
  const hrs = h('input', { type: 'number', min: '0.25', max: '24', step: '0.25', value: s.hoursPerDay ?? '', placeholder: 'no limit', 'aria-label': 'Hours per day' });
  const prio = h('select', { 'aria-label': 'Priority' }, [['', 'Normal (5)'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), n === 1 ? '1 (first)' : n === 9 ? '9 (last)' : String(n)])].map(([v, l]) => h('option', { value: v, selected: String(s.priority ?? '') === v }, l)));
  const stop = h('input', { type: 'checkbox', id: 'sch-stop' }); stop.checked = !!s.stopWhenDone;
  const wbox = h('div', { class: 'windows' });
  const drawW = () => wbox.replaceChildren(...windows.map((x, i) => h('div', { class: 'wrow' },
    h('div', { class: 'days', role: 'group', 'aria-label': 'Days' }, DAYS.map((d, k) => { const b = h('button', { type: 'button', class: x.days.includes(k) ? 'on' : '', 'aria-pressed': String(x.days.includes(k)), onclick: () => { x.days = x.days.includes(k) ? x.days.filter((y) => y !== k) : [...x.days, k]; drawW(); } }, d); return b; })),
    h('input', { type: 'time', value: x.from, 'aria-label': 'From', onchange: (e) => { x.from = e.target.value; } }), h('span', { class: 'muted' }, 'to'), h('input', { type: 'time', value: x.to, 'aria-label': 'To', onchange: (e) => { x.to = e.target.value; } }),
    h('button', { type: 'button', class: 'btn small ghost', onclick: () => { windows.splice(i, 1); drawW(); } }, 'Remove'))), windows.length ? null : h('p', { class: 'muted small' }, 'No working hours: it may work at any time of day.'));
  drawW();
  const save = act(async () => {
    const schedule = { ...(start.value ? { startAt: start.value } : {}), ...(hrs.value ? { hoursPerDay: Number(hrs.value) } : {}), ...(prio.value ? { priority: Number(prio.value) } : {}), ...(windows.length ? { windows } : {}), ...(stop.checked ? { stopWhenDone: true } : {}) };
    await api(`/projects/${id}/schedule`, { method: 'POST', body: { schedule: Object.keys(schedule).length ? schedule : null } }); }, 'Schedule saved', rerender);
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('clock', 17), 'Schedule')), h('p', { class: 'muted small' }, 'Say when this project may be worked on. Useful when many projects share one subscription: give each some hours, and the most important a lower priority number. Times are this machine\'s local time.'),
    h('div', { class: 'sfields' }, lbl('Start on', start, 'Nothing runs before this date.'), lbl('Agent hours per day', hrs, 'Counted from the runs already recorded. Empty means no limit.'), lbl('Priority', prio, 'Who goes first when several projects are due.')),
    h('label', {}, 'Working hours'), wbox, h('button', { type: 'button', class: 'btn small', onclick: () => { windows.push({ days: [], from: '22:00', to: '06:00' }); drawW(); } }, icon('plus', 12), 'Add working hours'),
    h('label', { class: 'check gap-t', for: 'sch-stop' }, stop, ' Pause this project by itself when its plan is complete'),
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: save }, icon('check', 13), 'Save schedule'), w.schedule ? h('button', { class: 'btn', onclick: act(() => api(`/projects/${id}/schedule`, { method: 'POST', body: { schedule: null } }), 'Schedule cleared', rerender) }, 'Clear') : null));
}

function rolesCard(id, roles, rerender, projectRoles) {
  const r = roles.roles.reviewer; const own = projectRoles?.reviewer?.enabled;
  const sel = h('select', { 'aria-label': 'Reviewer for this project' }, [['', `Use the factory setting (${r.enabled ? 'on' : 'off'})`], ['on', 'On for this project'], ['off', 'Off for this project']].map(([v, l]) => h('option', { value: v, selected: (own === undefined ? '' : own ? 'on' : 'off') === v }, l)));
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('shield', 17), 'Reviewer agent')),
    h('p', { class: 'muted small' }, r.blurb), lbl('For this project', sel), h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: act(() => api(`/projects/${id}/roles`, { method: 'POST', body: { roles: { reviewer: sel.value === '' ? null : { enabled: sel.value === 'on' } } } }), 'Reviewer setting saved', rerender) }, 'Save'), h('a', { class: 'btn ghost', href: '#/settings' }, 'Model for each role')));
}

function autonomyCard(id, a, rerender) {
  const s = a.settings; const on = a.active;
  const mode = h('input', { type: 'checkbox', id: 'au-mode' }); mode.checked = s.mode === 'merge';
  const chk = (key, label, help) => { const c = h('input', { type: 'checkbox', id: `au-${key}` }); c.checked = !!s[key]; return { c, row: h('label', { class: 'check', for: `au-${key}` }, c, ' ', label, help ? h('small', { class: 'help muted' }, ` ${help}`) : null) }; };
  const rr = chk('requireReviewer', 'The reviewer agent must approve', 'recommended'); const rc = chk('requireChecks', 'A test command must have checked the change, covering the files it touched', 'recommended'); const ff = chk('fixFailures', 'File a fix ticket when the pipeline breaks after a merge');
  const per = h('input', { type: 'number', min: '1', max: '100', value: s.maxMergesPerDay, 'aria-label': 'Merges per day' }); const att = h('input', { type: 'number', min: '1', max: '5', value: s.fixAttemptsPerWorkflow, 'aria-label': 'Fix attempts' });
  const save = act(async () => { await api(`/projects/${id}/autonomy`, { method: 'POST', body: { settings: { mode: mode.checked ? 'merge' : 'off', requireReviewer: rr.c.checked, requireChecks: rc.c.checked, fixFailures: ff.c.checked, maxMergesPerDay: Number(per.value), fixAttemptsPerWorkflow: Number(att.value) } } }); }, 'Autonomy saved', rerender);
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Autonomous mode'), on ? h('span', { class: 'stamp warn' }, 'ACTIVE: merges on its own') : h('span', { class: 'stamp' }, 'off')),
    h('div', { class: 'note warn' }, icon('alert', 15), h('div', {}, h('b', {}, 'This merges pull requests without a human. '), 'By default the factory never merges. In this mode it merges a change only when its tests passed, the quality gate is clean, CI is green, no review comment is unhandled and (if ticked below) the reviewer agent approved. It then watches the pipeline and files a fix ticket if it breaks. Every merge is logged and commented on the ticket.')),
    a.global.allow ? null : h('div', { class: 'note info' }, icon('plug', 15), h('div', {}, 'Autonomous merging is switched off for the whole factory. ', h('a', { href: '#/settings' }, 'Turn it on in Settings'), ' first.')),
    h('label', { class: 'check gap-t', for: 'au-mode' }, mode, ' Let this project merge its own pull requests'), rr.row, rc.row, ff.row,
    h('div', { class: 'sfields' }, lbl('Automatic merges per day (this project)', per), lbl('Fix tickets per failing workflow', att, 'Then it stops and leaves it to you.')),
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: save }, icon('check', 13), 'Save')),
    a.held.length ? h('div', {}, h('h3', {}, 'Held back right now'), h('ul', { class: 'reasons' }, a.held.map((x) => h('li', {}, h('b', {}, `#${x.pr} ${x.title ?? ''}`), h('div', { class: 'muted small' }, x.blockers.join('; ')))))) : null,
    a.recent.length ? h('div', {}, h('h3', {}, 'Merged automatically'), h('ul', { class: 'reasons' }, a.recent.map((x) => h('li', {}, h('b', {}, `#${x.pr} ${x.title ?? ''}`), h('span', { class: 'muted small' }, ` · ${ago(x.at)}${x.review ? ` · reviewer ${x.review}` : ''}`))))) : null,
    a.fixes.length ? h('p', { class: 'muted small' }, `Fix tickets filed: ${a.fixes.map((f) => `${f.workflow} (${f.attempts})`).join(', ')}.`) : null);
}

export function autopilotTab(data, { id, rerender, project }) {
  if (!data) return h('div', { class: 'empty' }, h('b', {}, 'Could not load autopilot'));
  return h('div', { class: 'stack' }, waitingCard(data.waiting), scheduleCard(id, data.waiting, rerender), rolesCard(id, data.roles, rerender, project?.roles), autonomyCard(id, data.auto, rerender));
}
