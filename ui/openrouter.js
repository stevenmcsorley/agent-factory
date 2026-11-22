// The OpenRouter agent page: is the key working, which free models are ready or resting (and when each is expected back, learned from how long it took last time),
// what is running on them right now, what each role would use, and the recent calls. The page re-draws every few seconds with the rest of the app, so it is a live view.
// SECURITY: the key is typed into a password field and sent once; nothing on this page can read it back (the server never returns it).
import { h, icon, api, ago, dur, act } from './lib.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const head = (title, sub) => h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null));
const ROLES = ['builder', 'reviewer', 'security', 'tester', 'spec-writer', 'designer', 'planner', 'fixer', 'skill-writer'];
const post = (path, body = {}) => api(`/openrouter${path}`, { method: 'POST', body });
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0));
const STATE_CLS = { ready: 'solid', resting: 'warn', 'free allowance used': 'warn', banned: 'bad', 'not allowed': '', 'no tool calling': '' };
const back = (m) => (m.backAt ? `back in ${dur(Math.max(0, m.backAt - Date.now()))}${m.learnedRestMs ? ` · usually rests ${dur(m.learnedRestMs)}` : ''}` : '');
const KIND = { 'rate-limit': 'rate limited', 'daily-limit': 'daily allowance used', unavailable: 'unavailable', 'bad-request': 'bad tool calls', timeout: 'timed out', network: 'network', auth: 'key refused', 'bad-tool-call': 'bad tool call', credits: 'needs credits', other: 'error' };

function keyCard(d, rerender) {
  const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-or-v1-…', 'aria-label': 'OpenRouter API key' });
  const save = act(async () => { const r = await post('/key', { key: input.value.trim() }); input.value = ''; if (r.error) throw new Error(r.error); }, 'Key saved. Models loaded.', rerender);
  const info = d.key.info; const bits = [d.key.set ? (d.key.authFailed ? 'The key was refused. Check it and save it again.' : 'A key is set.') : 'No key yet.', info?.freeTier ? 'Free tier.' : null, info ? `Credit used: $${Number(info.usage ?? 0).toFixed(2)}` : null, d.refreshedAt ? `Catalogue read ${ago(new Date(d.refreshedAt).toISOString())}.` : null].filter(Boolean);
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('plug', 17), 'API key'), h('span', { class: `stamp ${d.key.set && !d.key.authFailed ? 'ok' : 'bad'}` }, d.key.set ? (d.key.authFailed ? 'refused' : 'set') : 'not set')),
    h('p', { class: 'muted small' }, bits.join(' ')), h('p', { class: 'muted small' }, 'Keys are created at openrouter.ai/keys. It is stored in the factory\'s protected secret file and is never shown again, logged, or sent to a container.'),
    h('div', { class: 'row gap-t nowrap' }, input, h('button', { class: 'btn primary', onclick: save }, d.key.set ? 'Replace key' : 'Save key'), d.key.set ? h('button', { class: 'btn', onclick: act(async () => { await post('/refresh'); }, 'Catalogue refreshed', rerender) }, icon('refresh', 13), 'Refresh models') : null));
}

function configCard(d, rerender) {
  const c = d.config; const on = h('input', { type: 'checkbox', id: 'or-on' }); on.checked = c.enabled; const fb = h('input', { type: 'checkbox', id: 'or-fb' }); fb.checked = c.fallback.enabled; const paid = h('input', { type: 'checkbox', id: 'or-paid' }); paid.checked = c.allowPaid;
  const all = c.roles.includes('*'); const boxes = ROLES.map((r) => { const b = h('input', { type: 'checkbox', id: `or-r-${r}` }); b.checked = all || c.roles.includes(r); return [r, b]; }); const allBox = h('input', { type: 'checkbox', id: 'or-r-all' }); allBox.checked = all;
  const save = act(async () => { const roles = allBox.checked ? ['*'] : boxes.filter(([, b]) => b.checked).map(([r]) => r); await post('/config', { enabled: on.checked, roles, fallback: { enabled: fb.checked, roles: 'all' }, allowPaid: paid.checked }); }, 'Saved', rerender);
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'How it is used'), h('span', { class: `stamp ${d.usable ? 'ok' : ''}` }, d.usable ? 'ON' : 'off')),
    h('label', { class: 'check', for: 'or-on' }, on, ' Switch the OpenRouter agent on'),
    h('label', { class: 'check', for: 'or-fb' }, fb, ' Carry on with free models when the Codex plan is limited or unavailable', h('small', { class: 'help muted' }, ' (nothing pauses; the same job is done on a free model)')),
    h('h3', { class: 'gap-t' }, 'Use free models FIRST for these agents'), h('div', { class: 'rolebox' }, h('label', { class: 'check', for: 'or-r-all' }, allBox, ' All agents'), ...boxes.map(([r, b]) => h('label', { class: 'check', for: `or-r-${r}` }, b, ` ${r}`))),
    h('p', { class: 'muted small' }, 'The rest keep using Codex. The router picks the model for each job itself: bigger, tool-capable, reliable and fast first.'),
    h('label', { class: 'check', for: 'or-paid' }, paid, ' Allow paid models too ', h('small', { class: 'help muted' }, '(off: free models only, so nothing here can cost money)')),
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: save }, icon('check', 13), 'Save')));
}

function overviewCard(d) {
  const lim = d.codexLimit; const cells = [[d.ready, 'ready'], [d.resting, 'resting'], [d.today, 'calls today'], [d.models.filter((m) => m.calls).length, 'models used']];
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('pulse', 17), 'Right now')), h('div', { class: 'facts' }, cells.map(([n, t]) => h('div', {}, h('b', {}, String(n)), h('span', {}, t)))),
    lim ? h('div', { class: `note ${d.covering ? 'info' : 'warn'}` }, icon('alert', 14), h('div', {}, `The Codex plan is limited until ${lim.untilText}. `, d.covering ? h('b', {}, 'OpenRouter is carrying on, so nothing is paused.') : 'OpenRouter is not set to stand in, so work is paused.')) : h('p', { class: 'muted small' }, 'The Codex plan is fine right now.'),
    d.freeUntil ? h('div', { class: 'note warn' }, icon('alert', 14), h('div', {}, `The free allowance for today is used. Free models are back at ${new Date(d.freeUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Adding a little credit to the OpenRouter account lifts the daily limit.`)) : null,
    d.live.length ? h('ul', { class: 'reasons' }, d.live.map((x) => h('li', {}, h('b', {}, x.role), h('span', { class: 'muted small' }, ` · ${x.project ?? 'no project'} · `), h('code', {}, x.model ?? 'choosing a model…'), h('span', { class: 'muted small' }, ` · ${dur(Date.now() - x.since)}${x.lastFail ? ` · swapped away from ${x.lastFail}` : ''}`)))) : h('p', { class: 'muted small' }, 'No OpenRouter run is active.'),
    h('h3', { class: 'gap-t' }, 'What each agent would use now'), h('div', { class: 'rolegrid' }, ROLES.map((r) => h('div', {}, h('b', {}, r), h('code', {}, d.roleModels[r] ? d.roleModels[r].split('/').pop() : 'none ready')))));
}

function modelsCard(d, rerender) {
  const rows = d.models.map((m) => h('tr', { class: m.state === 'ready' ? '' : 'dim' },
    h('td', {}, h('code', {}, m.id), m.context ? h('div', { class: 'muted small' }, `${k(m.context)} context${m.input.includes('image') ? ' · images' : ''}${m.reasoning ? ' · reasoning' : ''}${m.free ? '' : ' · paid'}`) : null),
    h('td', {}, h('span', { class: `pill2 ${STATE_CLS[m.state] ?? ''}` }, m.state), m.backAt ? h('div', { class: 'muted small' }, back(m)) : null, m.lastMsg && m.state !== 'ready' ? h('div', { class: 'muted small' }, m.lastMsg.slice(0, 90)) : null),
    h('td', { class: 'num' }, String(m.score)), h('td', { class: 'num' }, m.calls ? `${m.ok}/${m.calls}` : '–'), h('td', { class: 'num' }, m.limited || m.unavailable ? `${m.limited} / ${m.unavailable}` : '–'), h('td', { class: 'num' }, m.badTools ? String(m.badTools) : '–'), h('td', { class: 'num' }, m.avgMs ? `${(m.avgMs / 1000).toFixed(1)}s` : '–'), h('td', { class: 'num' }, m.input || m.output ? `${k(m.input)} / ${k(m.output)}` : '–'),
    h('td', {}, h('div', { class: 'row nowrap' }, h('button', { class: 'btn small', title: 'One tiny real call to this model', onclick: act(async () => { const r = await post('/test', { model: m.id }); if (!r.ok) throw new Error(`${KIND[r.kind] ?? r.kind}: ${r.message}`); }, `${m.id.split('/').pop()} answered`, rerender) }, 'Test'),
      m.state === 'resting' || m.state === 'free allowance used' ? h('button', { class: 'btn small ghost', onclick: act(async () => { await post('/reset', { model: m.id }); }, 'Rest cleared', rerender) }, 'Wake') : null,
      h('button', { class: 'btn small ghost', onclick: act(async () => { const banned = new Set(d.config.banned); banned.has(m.id) ? banned.delete(m.id) : banned.add(m.id); await post('/config', { banned: [...banned] }); }, m.banned ? 'Allowed again' : 'Banned', rerender) }, m.banned ? 'Allow' : 'Ban')))));
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'Models'), h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Ordered: ready first, then by how good the router thinks each is'), d.resting ? h('button', { class: 'btn small', onclick: act(async () => { await post('/reset'); }, 'All rests cleared', rerender) }, 'Wake all') : null)),
    d.models.length ? h('div', { class: 'ortable-wrap' }, h('table', { class: 'ortable' }, h('thead', {}, h('tr', {}, ['Model', 'State', 'Score', 'OK', 'Limited / down', 'Bad tool calls', 'Speed', 'Tokens in / out', ''].map((t) => h('th', {}, t)))), h('tbody', {}, ...rows)))
      : h('p', { class: 'muted' }, d.key.set ? 'No models loaded yet. Press Refresh models.' : 'Add your key to load the models.'),
    h('p', { class: 'muted small' }, 'Score = a first guess from size, name and context, adjusted by what has really happened (success rate, bad tool calls, speed). A model that runs out rests, and the page shows how long this model usually takes to come back.'));
}

function recentCard(d) {
  if (!d.recent.length) return card(h('div', { class: 'card-h' }, h('h2', {}, 'Recent calls')), h('p', { class: 'muted' }, 'Nothing yet.'));
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'Recent calls'), h('span', { class: 'muted small' }, `last ${d.recent.length}`)), h('div', { class: 'ortable-wrap' }, h('table', { class: 'ortable' }, h('thead', {}, h('tr', {}, ['When', 'Agent', 'Model', 'Result', 'Time', 'Tokens'].map((t) => h('th', {}, t)))),
    h('tbody', {}, ...d.recent.map((r) => h('tr', {}, h('td', { class: 'small' }, ago(new Date(r.at).toISOString())), h('td', {}, r.role ?? '–', r.project ? h('span', { class: 'muted small' }, ` · ${r.project}`) : null), h('td', {}, h('code', {}, String(r.model).split('/').pop())),
      h('td', {}, h('span', { class: `pill2 ${r.ok ? 'solid' : 'warn'}` }, r.ok ? 'ok' : (KIND[r.kind] ?? r.kind)), r.err ? h('div', { class: 'muted small' }, r.err.slice(0, 80)) : null), h('td', { class: 'num' }, r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '–'), h('td', { class: 'num' }, r.in || r.out ? `${k(r.in)} / ${k(r.out)}` : '–')))))));
}

export const openrouterPage = {
  async load() { return { d: await api('/openrouter') }; },
  draw({ d }, ctx) {
    return [head('OpenRouter agent', 'Free models at full capacity. When one runs out it swaps to the next, remembers when the first should be back, and can carry on when the Codex plan is limited.'),
      overviewCard(d), d.key.set ? configCard(d, ctx.rerender) : null, keyCard(d, ctx.rerender), d.key.set ? modelsCard(d, ctx.rerender) : null, d.key.set ? recentCard(d) : null].filter(Boolean);
  },
};
