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

export const settings = {
  async load() { const [s, st] = await Promise.all([api('/settings'), api('/status').catch(() => null)]); return { s, st }; },
  draw({ s, st }, ctx) {
    return [head('Settings', 'Which model builds your tickets, and the guardrails around it. Changes apply from the next run and are saved to the config file: no restart.'),
      agentCard(s, ctx), limitsCard(s, st, ctx), historyCard(s),
      h('p', { class: 'muted small' }, `Not editable here on purpose: the agent type, sandbox and network allowlist, and the projects. Those are security boundaries and live in the config file.`)];
  },
};
