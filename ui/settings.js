// Settings: which model builds the tickets, how hard it reasons, and the guardrail limits. Every change is validated by the
// server (src/settings.mjs), saved to the config file and applies from the next run, so there is nothing to restart.
// SECURITY: all text reaches the DOM through h() (textContent); the model list comes from Codex's own cache but is still treated as untrusted.
import { h, icon, api, toast, ago } from './lib.js';

const KIND = { codexContainer: 'Codex, in a container', claudeContainer: 'Claude Code, in a container', shell: 'Shell (tests)', codex: 'Codex on the host', claude: 'Claude Code on the host' };
const card = (...kids) => h('section', { class: 'card' }, ...kids);
const head = (title, sub) => h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null));
const field = (label, control, help) => h('div', { class: 'sfield' }, h('label', { for: control.id }, label), control, help ? h('small', { class: 'help muted' }, help) : null);
const fmt = (v) => (v === null || v === undefined || v === '' ? 'default' : String(v));
const STANDARD_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

function agentCard(s, ctx) {
  const a = s.agent; const known = s.models.length > 0;
  if (!a.acceptsModel) return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Agent'), h('span', { class: 'stamp' }, KIND[a.kind] ?? a.kind)),
    h('p', { class: 'muted' }, `The ${KIND[a.kind] ?? a.kind} agent has no model setting. To change which agent is used, edit agent.kind in the config file.`));

  const bySlug = new Map(s.models.map((m) => [m.slug, m]));
  const model = known ? h('select', { id: 'set-model', 'aria-label': 'Model' }) : h('input', { id: 'set-model', 'aria-label': 'Model', placeholder: 'leave empty for the default', value: a.model ?? '', autocomplete: 'off', spellcheck: 'false' });
  if (known) {
    model.append(h('option', { value: '' }, 'Codex default (not pinned)'));
    for (const m of s.models) model.append(h('option', { value: m.slug }, m.name));
    if (a.model && !bySlug.has(a.model)) model.append(h('option', { value: a.model }, `${a.model} (not in this login's list)`));
    model.value = a.model ?? '';
  }
  const effort = h('select', { id: 'set-effort', 'aria-label': 'Reasoning effort', disabled: !a.acceptsEffort });
  const modelHelp = h('small', { class: 'help muted' }); const effortHelp = h('small', { class: 'help muted' });
  const currentModel = () => (model.value || '').trim() || null;
  const fillEffort = (keep) => {
    const m = bySlug.get(currentModel()); const options = m?.efforts.length ? m.efforts : STANDARD_EFFORTS.map((e) => ({ effort: e, description: '' }));
    effort.replaceChildren(h('option', { value: '' }, m?.defaultEffort ? `Default for this model (${m.defaultEffort})` : 'Default'), ...options.map((o) => h('option', { value: o.effort }, o.description ? `${o.effort}: ${o.description}` : o.effort)));
    effort.value = options.some((o) => o.effort === keep) ? keep : '';
    modelHelp.textContent = m ? m.description : currentModel() ? 'Not in this login\'s model list: it will be passed to Codex as typed.' : 'Not pinned: Codex picks its own default, which can change when Codex is updated. Pin a model to make runs repeatable.';
    effortHelp.textContent = a.acceptsEffort ? 'Higher effort thinks longer: better on hard tickets, slower, and uses more of your subscription.' : '';
  };
  fillEffort(a.reasoningEffort); model.addEventListener('change', () => { fillEffort(effort.value); mark(); }); model.addEventListener('input', mark); effort.addEventListener('change', mark);

  const save = h('button', { class: 'btn primary', disabled: true }, icon('check', 13), 'Save');
  function mark() { save.disabled = (currentModel() ?? null) === (a.model ?? null) && (effort.value || null) === (a.reasoningEffort ?? null); }
  save.addEventListener('click', async () => {
    save.disabled = true;
    try { const r = await api('/settings', { method: 'POST', body: { agent: { model: currentModel(), ...(a.acceptsEffort ? { reasoningEffort: effort.value || null } : {}) } } }); toast(r.changed ? 'Saved. It applies from the next run.' : 'Nothing changed.', 'ok'); ctx.rerender(); }
    catch (e) { toast(e.message, 'bad'); mark(); }
  });

  const result = h('div', {}); drawProbe(result, s.probe, a);
  const check = h('button', { class: 'btn' }, icon('search', 13), 'Check what a run will use');
  check.addEventListener('click', async () => {
    check.disabled = true; check.textContent = 'Asking Codex…';
    try { const r = await api('/settings/probe', { method: 'POST', body: {} }); drawProbe(result, r, a); if (!r.ok) toast('The check failed', 'bad'); }
    catch (e) { toast(e.message, 'bad'); } finally { check.disabled = false; check.replaceChildren(icon('search', 13), 'Check what a run will use'); }
  });

  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Agent'), h('span', { class: 'stamp' }, KIND[a.kind] ?? a.kind)),
    h('div', { class: 'sfields' }, field('Model', model, null), field('Reasoning effort', effort, null)), modelHelp, effortHelp,
    h('div', { class: 'row', style: { marginTop: '14px' } }, save, check), h('p', { class: 'muted small' }, 'Applies from the next run; a run already in progress keeps what it started with. The check sends one tiny prompt through the same container and login the factory uses.'), result);
}

function drawProbe(el, p, a) {
  if (!p) { el.replaceChildren(); return; }
  const stale = p.configuredModel !== (a.model ?? null) || p.configuredEffort !== (a.reasoningEffort ?? null);
  if (!p.ok) { el.replaceChildren(h('div', { class: 'callout bad probe' }, icon('alert', 16), h('div', {}, h('b', {}, 'The check did not work'), h('p', { class: 'small' }, p.error ?? 'No model was reported.')))); return; }
  el.replaceChildren(h('div', { class: 'probe' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('b', {}, 'Codex reports'), h('span', { class: 'muted small' }, `checked ${ago(p.at)}`)),
    h('dl', {}, h('dt', {}, 'Model'), h('dd', { class: 'mono' }, p.model), h('dt', {}, 'Reasoning effort'), h('dd', { class: 'mono' }, p.reasoningEffort ?? '–'), h('dt', {}, 'Codex version'), h('dd', { class: 'mono' }, p.codexVersion ?? '–'),
      h('dt', {}, 'Asked for'), h('dd', { class: 'mono' }, `${fmt(p.configuredModel)} / ${fmt(p.configuredEffort)}`)),
    stale ? h('p', { class: 'small warn' }, icon('alert', 13), ' The settings have changed since this check. Check again to see what the new ones give.') : null));
}

function limitsCard(s, st, ctx) {
  const inputs = {}; const f = s.limitFields; const today = st?.today;
  const row = (k) => {
    const def = f[k]; const ms = def.unit === 'ms'; const cur = s.limits[k];
    const input = h('input', { type: 'number', id: `set-${k}`, 'aria-label': def.label, min: ms ? def.min / 60000 : def.min, max: ms ? def.max / 60000 : def.max, step: def.int || ms ? 1 : 0.5, inputmode: 'decimal',
      value: cur === null || cur === undefined ? '' : ms ? Math.round(cur / 60000) : cur, placeholder: def.nullable ? 'no cap' : '' });
    inputs[k] = { input, ms, def }; input.addEventListener('input', mark);
    const extra = k === 'maxRunsPerDay' && today ? ` Today: ${today.runs} used.` : '';
    return field(`${def.label}${ms ? ' (minutes)' : ''}`, input, def.hint + extra);
  };
  const keys = Object.keys(f); const save = h('button', { class: 'btn primary', disabled: true }, icon('check', 13), 'Save limits');
  const read = (k) => { const { input, ms } = inputs[k]; const v = input.value.trim(); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? (ms ? Math.round(n * 60000) : n) : NaN; };
  function mark() { save.disabled = keys.every((k) => (read(k) ?? null) === (s.limits[k] ?? null)); }
  save.addEventListener('click', async () => {
    const body = {}; for (const k of keys) if ((read(k) ?? null) !== (s.limits[k] ?? null)) body[k] = read(k);
    save.disabled = true;
    try { await api('/settings', { method: 'POST', body: { limits: body } }); toast('Limits saved. They apply from the next run.', 'ok'); ctx.rerender(); } catch (e) { toast(e.message, 'bad'); mark(); }
  });
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('shield', 17), 'Limits')), h('p', { class: 'muted small' }, 'Guardrails around every run. Raising one is your call, and each change is logged below.'),
    h('div', { class: 'sfields' }, keys.map(row)), h('div', { class: 'row', style: { marginTop: '14px' } }, save));
}

function historyCard(s) {
  const lines = (e) => Object.entries(e.changes ?? {}).flatMap(([group, fields]) => Object.entries(fields).map(([k, v]) => `${group}.${k}: ${fmt(v.from)} → ${fmt(v.to)}`));
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'Recent changes')),
    s.history.length ? h('ul', { class: 'hist' }, s.history.map((e) => h('li', {}, h('span', { class: 'muted small' }, ago(e.at)), h('span', { class: 'mono small' }, lines(e).join(' · '))))) : h('p', { class: 'muted small' }, 'Nothing changed from this page yet.'));
}

function rolesCard(r, s, ctx) {
  const known = s.models.length > 0; const shown = Object.entries(r.roles).filter(([, v]) => v.toggle || s.agent.acceptsModel);   // an agent with no model setting has nothing to configure on the always-on roles
  const rows = shown.map(([k, v]) => {
    const model = known ? h('select', { 'aria-label': `${v.label} model` }, [h('option', { value: '' }, `Same as the default (${r.default.model ?? 'Codex default'})`), ...s.models.map((m) => h('option', { value: m.slug, selected: m.slug === v.agent.model }, m.name))]) : h('input', { value: v.agent.model ?? '', placeholder: 'same as the default', 'aria-label': `${v.label} model` });
    const eff = h('select', { 'aria-label': `${v.label} reasoning effort` }, [['', 'default'], ...['minimal', 'low', 'medium', 'high', 'xhigh'].map((e) => [e, e])].map(([x, l]) => h('option', { value: x, selected: (v.agent.reasoningEffort ?? '') === x }, l)));
    const on = h('input', { type: 'checkbox', id: `role-${k}`, 'aria-label': `${v.label} on` }); on.checked = v.enabled; on.disabled = !v.toggle; if (!v.toggle) on.hidden = true;
    const save = h('button', { class: 'btn small', onclick: async () => { try { await api('/roles', { method: 'POST', body: { roles: { [k]: { ...(v.toggle ? { enabled: on.checked } : {}), ...(s.agent.acceptsModel ? { agent: { model: model.value.trim() || null, ...(s.agent.acceptsEffort ? { reasoningEffort: eff.value || null } : {}) } } : {}) } } } }); toast(`${v.label} saved`, 'ok'); ctx.rerender(); } catch (e) { toast(e.message, 'bad'); } } }, 'Save');
    return h('div', { class: 'rolerow' }, h('div', {}, h('label', { class: 'check', for: `role-${k}` }, on, h('b', {}, `${v.toggle ? ' ' : ''}${v.label}`), v.toggle ? null : h('span', { class: 'muted small' }, ' · always on')), h('small', { class: 'help muted' }, v.blurb)), s.agent.acceptsModel ? model : null, s.agent.acceptsEffort ? eff : null, save);
  });
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Agent roles')), h('p', { class: 'muted small' }, 'The same agent can do different jobs, each with its own model and effort: a cheaper one to review, a stronger one to design. Roles you leave alone use the default above. The reviewer can also be switched per project, on its Autopilot tab.'), h('div', { class: 'roles' }, rows), s.agent.acceptsModel ? null : h('p', { class: 'muted small' }, 'The other roles (builder, designer, fixer, planner, skill writer) are always on and use the agent above.'),
    h('p', { class: 'muted small' }, h('a', { href: '#/skills' }, 'Edit the skills each role receives')));
}

function autonomyCard(a, ctx) {
  const ack = h('input', { type: 'checkbox', id: 'au-ack' }); const cap = h('input', { type: 'number', min: '1', max: '500', value: a.maxMergesPerDay, 'aria-label': 'Automatic merges per day, all projects' });
  const set = (body, done) => async (e) => { e.currentTarget.disabled = true; try { await api('/autonomy', { method: 'POST', body }); toast(done, 'ok'); ctx.rerender(); } catch (err) { toast(err.message, 'bad'); e.currentTarget.disabled = false; } };
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('shield', 17), 'Autonomous merging'), a.allow ? h('span', { class: 'stamp warn' }, 'ALLOWED') : h('span', { class: 'stamp ok' }, 'off')),
    h('p', { class: 'muted small' }, 'Off by default: the factory never merges. Switching this on only makes it POSSIBLE; each project still has to be put in autonomous mode on its own Autopilot tab. Switching it off again stops every project at once.'),
    a.allow ? h('div', {}, h('p', {}, `Merged automatically today: ${a.mergedToday}.`), h('div', { class: 'sfield' }, h('label', {}, 'Most automatic merges per day, all projects'), cap),
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: set({ maxMergesPerDay: Number(cap.value) }, 'Limit saved') }, 'Save limit'), h('button', { class: 'btn danger', onclick: set({ allow: false }, 'Autonomous merging is off. Nothing will merge without you.') }, 'Switch off for everything')))
      : h('div', {}, h('label', { class: 'check', for: 'au-ack' }, ack, ' I understand that projects set to autonomous mode will merge pull requests with no human approval, and that I can switch this off at any time.'),
        h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: (e) => { if (!ack.checked) { toast('Tick the box first', 'bad'); return; } return set({ allow: true }, 'Allowed. Now choose which projects use it.')(e); } }, 'Allow autonomous merging'))));
}

function limitCard(s, ctx) {
  const on = h('input', { type: 'checkbox', id: 'auto-resume' }); on.checked = !!s.autoResume;
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('clock', 17), 'When the plan\'s usage limit is hit'), s.autoResume ? h('span', { class: 'stamp ok' }, 'auto-resume on') : h('span', { class: 'stamp warn' }, 'auto-resume off')),
    h('p', { class: 'muted small' }, 'Your agent plan has a usage limit that resets at a set time. The moment any agent reports it, the factory pauses every agent (instead of failing tickets one by one), says when it resumes, and keeps the queue. With auto-resume on it starts again by itself at that time and puts back the tickets the limit stopped. With it off it stays paused until you press Resume.'),
    h('label', { class: 'check', for: 'auto-resume' }, on, ' Resume by itself when the limit resets (recommended)'),
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: async (e) => { e.currentTarget.disabled = true; try { await api('/settings', { method: 'POST', body: { autoResume: on.checked } }); toast(on.checked ? 'Auto-resume on' : 'Auto-resume off: agents stay paused after a limit until you press Resume', 'ok'); ctx.rerender(); } catch (err) { toast(err.message, 'bad'); e.currentTarget.disabled = false; } } }, icon('check', 13), 'Save')));
}

function notifyCard(n, ctx) {
  const c = n.notify; const url = h('input', { type: 'url', value: c?.url ?? '', placeholder: 'https://ntfy.sh/your-private-topic', 'aria-label': 'Notification address', autocomplete: 'off', spellcheck: 'false' });
  const boxes = Object.entries(n.events).map(([k, label]) => { const b = h('input', { type: 'checkbox', id: `nt-${k}`, 'data-ev': k }); b.checked = c ? c.events.includes(k) : true; return h('label', { class: 'check', for: `nt-${k}` }, b, ` ${label}`); });
  const body = () => ({ url: url.value.trim(), events: [...document.querySelectorAll('input[data-ev]')].filter((b) => b.checked).map((b) => b.dataset.ev) });
  const run = (fn, done) => async (e) => { e.currentTarget.disabled = true; try { const r = await fn(); if (done) toast(typeof done === 'function' ? done(r) : done, r?.sent === false ? 'bad' : 'ok'); ctx.rerender(); } catch (err) { toast(err.message, 'bad'); e.currentTarget.disabled = false; } };
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('plug', 17), 'Notifications'), c ? h('span', { class: 'stamp ok' }, 'on') : h('span', { class: 'stamp' }, 'off')),
    h('p', { class: 'muted small' }, 'Get told when something needs you, without watching this page. The factory POSTs a small JSON message to one address: an ntfy.sh topic works as-is (it shows on your phone), and so does any webhook. Use a private, hard-to-guess address, because anyone who knows it can read the messages. https only.'),
    h('div', { class: 'sfield' }, h('label', {}, 'Address'), url), h('label', {}, 'Tell me when'), h('div', { class: 'rolebox' }, boxes),
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: run(() => api('/notify', { method: 'POST', body: { notify: body() } }), 'Saved') }, icon('check', 13), 'Save'),
      c ? h('button', { class: 'btn', onclick: run(() => api('/notify/test', { method: 'POST', body: {} }), (r) => (r.sent ? 'Sent. Check your device.' : `Not sent: ${r.why}`)) }, 'Send a test') : null,
      c ? h('button', { class: 'btn ghost', onclick: run(() => api('/notify', { method: 'POST', body: { notify: null } }), 'Notifications off') }, 'Turn off') : null));
}

export const settings = {
  async load() { const [s, st, roles, au, nt] = await Promise.all([api('/settings'), api('/status').catch(() => null), api('/roles'), api('/autonomy'), api('/notify')]); return { s, st, roles, au, nt }; },
  draw({ s, st, roles, au, nt }, ctx) {
    return [head('Settings', 'Which model builds your tickets, and the guardrails around it. Changes apply from the next run and are saved to the config file: no restart.'),
      agentCard(s, ctx), rolesCard(roles, s, ctx), limitsCard(s, st, ctx), limitCard(s, ctx), notifyCard(nt, ctx), autonomyCard(au, ctx), historyCard(s),
      h('p', { class: 'muted small' }, `Not editable here on purpose: the agent type, sandbox and network allowlist, and the projects. Those are security boundaries and live in the config file.`)];
  },
};
