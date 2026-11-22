// The Scenarios page: custom workflows (prototype, ship, deploy to Cloudflare, your own), their runs with human approval gates, and the extensions that add steps.
import { h, icon, api, toast, ago, ext, act } from './lib.js';
import { codeBlock } from './codeblock.js';

const op = (name, body = {}) => api(`/op/${name}`, { method: 'POST', body });
const card = (cls, ...kids) => h('section', { class: `card ${cls ?? ''}` }, ...kids);
const pill = (text, cls = '') => h('span', { class: `pill2 ${cls}` }, text);
const view = { sub: 'scenarios', apply: {} };
const STATUS = { pending: ['pending', 'muted'], running: ['running', 'warn'], waiting: ['waiting', 'warn'], 'waiting-approval': ['needs your approval', 'bad'], approved: ['approved', 'ok'], done: ['done', 'ok solid'], failed: ['failed', 'bad'], skipped: ['skipped', 'muted'], cancelled: ['cancelled', 'muted'] };
const statusPill = (s) => { const [l, c] = STATUS[s] ?? [s, '']; return pill(l, c); };
const PLUGIN = { loaded: ['loaded', 'ok'], available: ['not enabled', 'muted'], changed: ['changed: review it', 'bad'], error: ['error', 'bad'], invalid: ['invalid', 'bad'], missing: ['missing', 'bad'] };

export const scenarios = {
  async load() {
    const [defs, plugins, projects] = await Promise.all([op('scenario_list'), api('/plugins').catch(() => ({ plugins: [], stepTypes: [] })), api('/overview').catch(() => [])]);
    const runs = (await Promise.all(projects.map((p) => op('scenario_runs', { project: p.id }).catch(() => [])))).flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
    return { defs, plugins, projects, runs };
  },
  draw(d, ctx) {
    const active = d.runs.filter((r) => ['running', 'waiting', 'waiting-approval'].includes(r.status)); const gates = d.runs.filter((r) => r.status === 'waiting-approval');
    if (active.length) setTimeout(() => { if (location.hash === '#/scenarios') ctx.rerender(); }, 6000);
    const tabs = [['scenarios', 'Scenarios', d.defs.length], ['runs', 'Runs', active.length], ['ext', 'Extensions', d.plugins.plugins.filter((p) => p.status === 'loaded').length]];
    const body = h('div', { class: 'codebody' }); const nav = h('div', { class: 'subtabs', role: 'tablist' });
    const go = (k) => { view.sub = k; drawNav(); drawBody(); }; const drawNav = () => nav.replaceChildren(...tabs.map(([k, l, n]) => h('button', { role: 'tab', 'aria-selected': String(view.sub === k), class: view.sub === k ? 'on' : '', onclick: () => go(k) }, l, n ? h('span', { class: 'badge' }, String(n)) : null)));
    const drawBody = () => body.replaceChildren(...({ scenarios: scenariosTab, runs: runsTab, ext: extTab }[view.sub])(d, ctx, go));
    drawNav(); drawBody();
    return [h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Scenarios'), h('p', { class: 'sub' }, 'Your own repeatable workflows, such as prototype only, ship to production, or deploy to Cloudflare, with human approval gates before anything goes live. Scenarios are files and extensions are plugins, so you can change how this works and which services it uses.'))),
      gates.length ? card('banner warn', h('div', {}, h('b', {}, `${gates.length} step${gates.length > 1 ? 's' : ''} waiting for your approval`), h('p', { class: 'muted small' }, 'A human has to say yes before these continue.')), h('button', { class: 'btn', onclick: () => go('runs') }, 'Review')) : null,
      card('', nav), body];
  },
};

function scenariosTab(d, ctx) {
  if (!d.defs.length) return [card('', h('p', { class: 'muted' }, 'No scenarios found. Put a JSON file in the scenarios folder next to your config (see docs/EXTENDING.md).'))];
  return d.defs.map((s) => {
    if (s.error) return card('', h('div', { class: 'card-h' }, h('h2', {}, s.id), pill('invalid', 'bad')), h('div', { class: 'note bad' }, icon('alert', 14), ' ', s.error));
    const proj = h('select', { 'aria-label': 'Project' }, [h('option', { value: '' }, 'Choose a project…'), ...d.projects.map((p) => h('option', { value: p.id }, p.id))]); const inputs = {};
    const fields = Object.entries(s.params).map(([k, p]) => { inputs[k] = h('input', { value: p.default ?? '', placeholder: p.help || p.label, 'aria-label': p.label }); return h('div', {}, h('label', {}, `${p.label}${p.required ? ' *' : ''}`), inputs[k]); });
    const start = (apply) => act(async () => { if (!proj.value) throw new Error('Choose a project first'); const params = {}; for (const [k, i] of Object.entries(inputs)) if (i.value.trim()) params[k] = i.value.trim(); const r = await op('scenario_run', { project: proj.value, scenario: s.id, params, apply }); toast(apply ? 'Scenario started' : 'Dry run finished: nothing was changed', 'ok'); view.sub = 'runs'; return r; }, null, ctx.rerender);
    let armed = false; const live = h('button', { class: 'btn primary', onclick: async (e) => { if (!armed) { armed = true; live.textContent = 'Confirm: run for real'; setTimeout(() => { armed = false; live.textContent = 'Run for real'; }, 5000); return; } await start(true)(e); } }, 'Run for real');
    return card('', h('div', { class: 'card-h' }, h('h2', {}, s.name), h('span', { class: 'muted small mono' }, s.id)), s.description ? h('p', { class: 'muted small' }, s.description) : null,
      h('div', { class: 'pipe' }, s.steps.map((x, i) => [i ? h('i', { class: 'arr' }, '→') : null, h('span', { class: `stp ${x.type.includes('.') ? 'plug' : x.type}`, title: x.title }, x.title)])),
      s.secrets.length || s.allowHosts.length ? h('p', { class: 'muted small' }, s.allowHosts.length ? `Calls: ${s.allowHosts.join(', ')}. ` : '', s.secrets.length ? `Secrets used: ${s.secrets.join(', ')}.` : '') : null,
      h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Project'), proj), ...fields.slice(0, 1)), fields.length > 1 ? h('div', { class: 'bgrid' }, fields.slice(1)) : null,
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: start(false) }, 'Dry run (safe)'), live, h('span', { class: 'muted small' }, 'A dry run checks things for real and only describes the rest.')));
  });
}

function runsTab(d, ctx) {
  if (!d.runs.length) return [card('', h('p', { class: 'muted' }, 'No runs yet. Start a scenario from the Scenarios tab; a dry run is the safe way to see exactly what it would do.'))];
  return d.runs.map((r) => card(`run ${r.status}`, h('div', { class: 'card-h' }, h('div', {}, h('h2', {}, r.scenarioName ?? r.scenario), h('span', { class: 'muted small mono' }, `${r.project} · ${r.id} · ${ago(r.createdAt)}`)), h('div', { class: 'row' }, r.dryRun ? pill('dry run', 'info') : pill('LIVE', 'warn'), statusPill(r.status),
      ['running', 'waiting', 'waiting-approval'].includes(r.status) ? h('button', { class: 'btn small ghost', onclick: act(() => op('scenario_cancel', { project: r.project, run: r.id }), 'Cancelled', ctx.rerender) }, 'Cancel') : null)),
    Object.keys(r.params ?? {}).length ? h('p', { class: 'muted small mono' }, Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join('  ')) : null,
    h('ol', { class: 'stepsrun' }, Object.entries(r.steps).map(([id, s]) => h('li', { class: s.status }, h('div', { class: 'srow' }, statusPill(s.status), h('b', {}, s.title), h('span', { class: 'muted small mono' }, s.type)),
      s.detail && /waiting/.test(s.status) ? h('p', { class: 'muted small' }, s.detail) : null, s.error ? h('div', { class: 'note bad' }, icon('x', 14), ' ', s.error) : null,
      s.output?.would ? h('p', { class: 'small' }, h('b', {}, 'Would: '), s.output.would, s.output.plan ? h('code', { class: 'mono small' }, ` ${JSON.stringify(s.output.plan)}`) : null) : null,
      s.status === 'done' && s.output && !s.output.would && !s.output.dryRun ? h('p', { class: 'muted small mono' }, JSON.stringify(s.output).slice(0, 220)) : null,
      s.status === 'waiting-approval' ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(() => api(`/projects/${r.project}/scenario-runs/${r.id}/approve/${id}`, { method: 'POST', body: {} }), 'Approved', ctx.rerender) }, 'Approve'), h('span', { class: 'muted small' }, 'Only a human can approve; agents cannot.')) : null))),
    r.approvals?.length ? h('p', { class: 'muted small' }, 'Approved: ', r.approvals.map((a) => `${a.step} by ${a.by} ${ago(a.at)}`).join(' · ')) : null));
}

function extTab(d) {
  const P = d.plugins;
  return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'Plugins'), pill(`${P.plugins.filter((p) => p.status === 'loaded').length} loaded`, 'ok')),
    h('p', { class: 'muted small' }, 'Plugins add step types (deploy targets, notifiers), operations, quality rules, part kinds, ticket trackers and code hosts. They are trusted code, so enabling one is a deliberate, offline step: the factory records a hash of its files and refuses it if anything changes afterwards. Agents cannot enable plugins.'),
    P.plugins.length ? h('ul', { class: 'plain plugs' }, P.plugins.map((p) => { const [l, c] = PLUGIN[p.status] ?? [p.status, '']; return h('li', {}, h('div', { class: 'srow' }, h('b', {}, p.name), p.version ? h('span', { class: 'muted small mono' }, `v${p.version}`) : null, pill(l, c)), p.description ? h('p', { class: 'muted small' }, p.description) : null,
      p.provides?.length ? h('p', { class: 'small mono' }, `provides: ${p.provides.join(', ')}`) : null, p.secrets?.length ? h('p', { class: 'muted small mono' }, `secrets: ${p.secrets.join(', ')}`) : null, p.error ? h('div', { class: 'note bad' }, icon('alert', 14), ' ', p.error) : null,
      p.status === 'available' ? codeBlock(`agent-factory plugin enable ${p.name}   # then restart`, { lang: 'sh', title: 'Terminal', label: 'Command', numbers: false }) : null); })) : h('p', { class: 'muted' }, 'No plugins found. Create one with: agent-factory plugin new my-plugin')),
  card('', h('h2', {}, 'Step types available to scenarios'), h('div', { class: 'chips' }, ['ticket', 'check', 'approve', 'http', 'note', ...P.stepTypes].map((t) => pill(t, t.includes('.') ? 'info' : 'muted'))), h('p', { class: 'muted small' }, 'Built in: ticket (queue work for the agent), check (is the project ready?), approve (a human says yes), http (an allow-listed HTTPS call), note. Plugin steps look like cloudflare.dns.')),
  card('', h('h2', {}, 'Change how it works'), h('ul', { class: 'plain' }, [['Scenarios', 'JSON files in the scenarios folder: your own workflows and gates.'], ['Plugins', 'plugins/<name>/ folders: new services and step types.'], ['Prompts', 'prompts/<name>.md next to your config: change what agents are told.'], ['Rules, ignore patterns, quality gate', 'In agent-factory.json or a repo’s .agent-factory.json.'], ['The whole app', 'The factory can manage its own repository; its security core is protected from self-edits.']].map(([a, b]) => h('li', { class: 'small' }, h('b', {}, `${a}: `), b))), h('p', { class: 'muted small' }, 'Full guide: docs/EXTENDING.md'))];
}
