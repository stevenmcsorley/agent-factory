// Agents: who does the work (Codex, free models on OpenRouter, or both), how each is doing right now, and the settings for each. Four tabs: Overview, Who does what, Free models, Codex.
// Everything here is written for a person: plain words, status you can see at a glance (chips, gauges, dots), and a line of explanation where a term cannot be avoided.
// SECURITY: the API key goes into a password field, is sent once, and nothing on this page can read it back (the server never returns it).
import { h, icon, api, ago, dur, act } from './lib.js';
import { agentCard, rolesCard, limitCard, historyCard, setupCard } from './settings.js';
import { gauge, splitBar, dayBars, dots, meter, chip, compact, percent, money, clock, when } from './viz.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const head = (title, sub) => h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null));
const TABS = [['overview', 'Overview'], ['policy', 'Who does what'], ['free', 'Free models'], ['codex', 'Codex']];
const ROLE = { builder: ['Builder', 'Writes the code for a ticket'], reviewer: ['Reviewer', 'Checks each change before it goes in'], security: ['Security reviewer', 'Looks for security problems in a change'], tester: ['Tester', 'Adds tests for new code'], 'spec-writer': ['Spec writer', 'Fills in tickets that are too vague'], designer: ['Designer', 'Makes mockups and artwork'], planner: ['Planner', 'Breaks a brief into tickets'], fixer: ['Fixer', 'Repairs failing checks'], 'skill-writer': ['Skill writer', 'Writes reusable guidance for the agents'] };
const PROV = { codex: 'Codex', openrouter: 'Free models', none: 'Neither is available' };
const MODES = { mix: ['Both', 'Free models for the jobs they do well, Codex for the rest. If a free model cannot answer, Codex does it. If Codex runs out, the free models carry on.'], codex: ['Codex only', 'Everything uses your Codex plan. If it runs out, work waits until it is back.'], openrouter: ['Free models only', 'Everything uses free models. Your Codex plan is never used.'] };
const tabHref = (t) => (t === 'overview' ? '#/agents' : `#/agents/${t}`);
const post = (path, body = {}) => api(path, { method: 'POST', body });
const short = (id) => String(id).split('/').pop().replace(/:free$/, '');
const org = (id) => String(id).split('/')[0];
const tip = (text) => h('span', { class: 'hint', title: text, tabindex: '0', 'aria-label': text }, '?');

function tabs(active) { return h('nav', { class: 'subnav', 'aria-label': 'Agents sections' }, TABS.map(([k, name]) => h('a', { href: tabHref(k), class: active === k ? 'on' : '', 'aria-current': active === k ? 'page' : null }, name))); }

// ---- overview
function codexCard(d) {
  const lim = d.codex.limited; const a = d.settings?.agent; const week = d.acc?.byProvider.codex ?? { calls: 0, input: 0, output: 0 };
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Codex'), lim ? chip('warn', `Limited until ${lim.untilText}`) : chip('ok', 'Working normally')),
    lim ? h('p', { class: 'muted' }, `Your Codex plan has run out for now and is back ${d.codex.backIn ? `in about ${d.codex.backIn}` : `at ${lim.untilText}`}. ${d.policy.mode === 'codex' ? 'Work waits until then.' : d.openrouterReady ? 'The free models are carrying on in the meantime.' : 'Turn on the free models to keep working meanwhile.'}`) : h('p', { class: 'muted' }, 'Your Codex plan is available.'),
    a ? h('div', { class: 'pair' }, h('div', {}, h('span', {}, 'Model'), h('b', {}, a.model ?? 'Codex default')), h('div', {}, h('span', {}, 'Thinking effort'), h('b', {}, a.reasoningEffort ?? 'default'))) : null,
    h('div', { class: 'figs' }, [[week.calls, 'jobs this week'], [compact(week.input), 'tokens read'], [compact(week.output), 'tokens written']].map(([n, t]) => h('div', {}, h('b', {}, String(n)), h('span', {}, t)))),
    h('div', { class: 'row gap-t' }, h('a', { class: 'btn small', href: '#/agents/codex' }, 'Codex settings')));
}
function freeCard(d) {
  const or = d.or; const b = or.budget; const set = or.key.set && !or.key.authFailed; const textModels = or.models.filter((m) => m.tools);
  const dotsList = textModels.map((m) => ({ tone: m.state === 'ready' ? 'ok' : m.state === 'resting' || m.state === 'free allowance used' ? 'warn' : 'off', title: `${short(m.id)}: ${m.state === 'ready' ? 'ready' : m.state}` }));
  const reset = (() => { const x = new Date(); x.setUTCHours(24, 0, 0, 0); return clock(x.toISOString()); })();
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('plug', 17), 'Free models'), !set ? chip('off', or.key.authFailed ? 'Key refused' : 'Not set up') : !or.usable ? chip('off', 'Switched off') : or.ready ? chip('ok', `${or.ready} of ${textModels.length} ready`) : chip('warn', 'All resting')),
    !set ? h('p', { class: 'muted' }, 'Add an OpenRouter key to use free AI models alongside Codex. They take the jobs they do well, which saves your Codex plan.') : h('p', { class: 'muted' }, 'Free AI models through OpenRouter. When one runs out it rests, and the next takes over.'),
    set ? h('div', { class: 'freebody' }, dots(dotsList), b?.cap ? h('div', { class: 'allowance' }, gauge({ value: b.cap - (b.remaining ?? 0), max: b.cap, label: compact(b.remaining ?? 0), sub: 'left today', tone: (b.remaining ?? 0) < b.cap * 0.1 ? 'bad' : (b.remaining ?? 0) < b.cap * 0.3 ? 'warn' : 'ok', size: 104, title: `${b.used} of ${b.cap} free requests used today` }), h('p', { class: 'muted small' }, `${b.used} of ${b.cap} free requests used today. Resets at ${reset}.`)) : null) : null,
    or.credits ? h('p', { class: 'small muted' }, `OpenRouter credit: ${money(or.credits.remaining)}. Free models do not use it.`) : null,
    h('div', { class: 'row gap-t' }, h('a', { class: 'btn small', href: '#/agents/free' }, set ? 'Manage free models' : 'Set up')));
}
function workedCard(d) {
  const acc = d.acc; if (!acc) return null; const p = acc.byProvider; const days = acc.byDay.map((x) => ({ day: x.day, a: x.codex.input + x.codex.output, b: x.openrouter.input + x.openrouter.output }));
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('pulse', 17), 'Where the work went this week'), h('a', { class: 'btn small ghost', href: '#/usage' }, 'Full usage details')),
    splitBar([{ label: 'Codex', value: p.codex.weighted, cls: 'codex' }, { label: 'Free models', value: p.openrouter.weighted, cls: 'free' }], { empty: 'No agent has run this week yet.' }),
    p.codex.weighted + p.openrouter.weighted ? dayBars(days, { aClass: 'codex', bClass: 'free', aLabel: 'Codex', bLabel: 'Free models', height: 130 }) : null,
    acc.totals.escalated ? h('p', { class: 'muted small' }, `${acc.totals.escalated} time${acc.totals.escalated === 1 ? '' : 's'} a free model could not answer and Codex did the job instead.`) : null);
}
function nowCard(d) {
  const live = d.or.live; const running = d.agents ?? [];
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('clock', 17), 'Right now')),
    running.length ? h('ul', { class: 'nowlist' }, running.map((a) => { const free = live.find((l) => l.role === a.role && l.project === a.project); return h('li', {}, h('span', { class: 'spin-dot' }), h('div', {}, h('b', {}, (ROLE[a.role]?.[0] ?? a.role)), h('span', { class: 'muted small' }, ` ${a.project ? `on ${a.project}` : ''}${a.what ? ` · ${a.what}` : ''}`)), chip(free ? 'ok' : 'off', free ? `Free model: ${short(free.model ?? '…')}` : 'Codex')); }))
      : h('p', { class: 'muted' }, 'No agent is working right now.'));
}
function changesCard(d) {
  const ev = (d.acc?.events ?? []).filter((e) => ['codex-limit', 'codex-resume', 'fallback', 'escalation', 'free-daily'].includes(e.kind)).slice(0, 5); if (!ev.length) return null;
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'Recent changes'), h('a', { class: 'btn small ghost', href: '#/usage' }, 'See everything')), h('ul', { class: 'eventlist' }, ev.map((e) => h('li', {}, h('span', { class: `evdot ev-${e.kind}` }, icon(({ 'codex-limit': 'alert', 'codex-resume': 'play', fallback: 'spark', escalation: 'refresh', 'free-daily': 'alert' })[e.kind], 13)), h('div', {}, h('b', {}, e.title), e.detail && e.kind !== 'codex-limit' ? h('span', { class: 'muted small' }, ` · ${e.detail}`) : null), h('time', { class: 'muted small', title: new Date(e.at).toLocaleString() }, ago(e.at))))));
}
const overview = (d) => [h('div', { class: 'twocol' }, codexCard(d), freeCard(d)), nowCard(d), workedCard(d), changesCard(d)].filter(Boolean);

// ---- who does what
function policyTab(d, rerender) {
  const p = d.policy; const set = (body, msg) => act(async () => { await post('/agents/policy', body); }, msg, rerender);
  const rows = Object.entries(p.roles).map(([role, r]) => { const u = d.acc?.byRole.find((x) => x.role === role); const cur = r.source === 'you' ? r.route : 'default';
    const seg = h('div', { class: 'segctl small', role: 'group', 'aria-label': `Who does ${ROLE[role]?.[0] ?? role}` }, [['default', 'Default'], ['codex', 'Codex'], ['openrouter', 'Free'], ['auto', 'Free, then Codex']].map(([v, l]) => h('button', { type: 'button', class: cur === v ? 'on' : '', 'aria-pressed': String(cur === v), title: v === 'default' ? `Use the default for this agent: ${({ codex: 'Codex', openrouter: 'free models', auto: 'free models first, then Codex' })[r.default]}` : v === 'auto' ? 'Free models first. Codex when the job is big, is a retry, or the free models cannot answer.' : `Always ${v === 'codex' ? 'Codex' : 'free models'}`, onclick: set({ routes: { [role]: v } }, `${ROLE[role]?.[0] ?? role}: saved`) }, l)));
    return h('tr', {}, h('td', {}, h('b', {}, ROLE[role]?.[0] ?? role), h('div', { class: 'muted small' }, ROLE[role]?.[1] ?? '')), h('td', {}, seg, h('div', { class: 'muted small' }, r.source === 'you' ? 'Your choice' : (r.defaultWhy ?? ''))),
      h('td', {}, chip(r.first === 'openrouter' ? 'ok' : r.first === 'none' ? 'warn' : 'off', PROV[r.first] ?? r.first), r.firstWhy && r.firstWhy !== r.defaultWhy ? h('div', { class: 'muted small' }, r.firstWhy) : null), h('td', { class: 'splitcell' }, u ? splitBar([{ label: 'Codex', value: u.codex.weighted, cls: 'codex' }, { label: 'Free', value: u.openrouter.weighted, cls: 'free' }], { empty: 'Not used this week' }) : h('span', { class: 'muted small' }, 'Not used this week'))); });
  return [card(h('div', { class: 'card-h' }, h('h2', {}, icon('spark', 17), 'Which provider does the work')),
      h('div', { class: 'modegrid' }, p.modes.map((m) => h('button', { type: 'button', class: `modebtn ${p.mode === m ? 'on' : ''}`, 'aria-pressed': String(p.mode === m), onclick: set({ mode: m }, `${MODES[m][0]}: saved`) }, h('b', {}, MODES[m][0], p.mode === m ? h('em', {}, 'In use') : null, m === 'mix' ? h('em', { class: 'rec' }, 'Recommended') : null), h('span', {}, MODES[m][1])))),
      p.mode !== 'codex' && !p.openrouterReady ? h('div', { class: 'note info' }, icon('plug', 14), h('div', {}, 'The free models are not set up yet, so everything uses Codex for now. ', h('a', { href: '#/agents/free' }, 'Set them up'))) : null),
    card(h('div', { class: 'card-h' }, h('h2', {}, 'Choose for each agent'), h('span', { class: 'muted small' }, p.mode === 'mix' ? 'Anything you pick here beats the default' : 'These apply when you choose "Both"')),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Agent', 'Who does it', 'First choice right now', 'This week'].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows))),
      h('p', { class: 'muted small' }, 'When Codex runs out, the free models take over automatically, except for an agent you set to Codex. When a free model cannot give a usable answer, Codex does that job.'))];
}

// ---- free models
function keyCard(d, rerender) {
  const k = d.or.key; const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-or-v1-…', 'aria-label': 'OpenRouter API key' });
  const save = act(async () => { const r = await post('/openrouter/key', { key: input.value.trim() }); input.value = ''; if (r.error) throw new Error(r.error); }, 'Key saved', rerender);
  return card(h('div', { class: 'card-h' }, h('h2', {}, icon('plug', 17), 'OpenRouter account'), chip(k.set && !k.authFailed ? 'ok' : 'warn', k.set ? (k.authFailed ? 'Key refused' : 'Connected') : 'Not connected')),
    h('p', { class: 'muted small' }, k.set ? (k.authFailed ? 'OpenRouter did not accept the key. Paste a new one below.' : `${k.info?.freeTier === false ? 'Account with credit.' : 'Free account.'} ${d.or.credits ? `Credit left: ${money(d.or.credits.remaining)}.` : ''}`) : 'Create a key at openrouter.ai/keys and paste it here. It is stored privately and never shown again.'),
    h('div', { class: 'row nowrap' }, input, h('button', { class: 'btn primary', onclick: save }, k.set ? 'Replace key' : 'Connect')), k.set ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn small', onclick: act(async () => { await post('/openrouter/refresh'); }, 'Model list updated', rerender) }, icon('refresh', 12), 'Refresh the model list')) : null);
}
function switchRow(id, checked, label, help) { const c = h('input', { type: 'checkbox', id }); c.checked = checked; return [c, h('label', { class: 'switch', for: id }, c, h('span', { class: 'slider', 'aria-hidden': 'true' }), h('span', {}, h('b', {}, label), help ? h('small', {}, help) : null))]; }
function settingsCard(d, rerender) {
  const c = d.or.config; const [on, onRow] = switchRow('fm-on', c.enabled, 'Use free models', 'Switch them on or off without losing your key.'); const [fb, fbRow] = switchRow('fm-fb', c.fallback.enabled, 'Carry on when Codex runs out', 'The free models take over so work does not stop.'); const [paid, paidRow] = switchRow('fm-paid', c.allowPaid, 'Allow paid models', 'Off means nothing here can spend your OpenRouter credit.');
  return card(h('div', { class: 'card-h' }, h('h2', {}, 'Settings')), onRow, fbRow, paidRow, h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: act(async () => { await post('/openrouter/config', { enabled: on.checked, fallback: { enabled: fb.checked, roles: 'all' }, allowPaid: paid.checked }); }, 'Saved', rerender) }, icon('check', 13), 'Save'),
    h('span', { class: 'muted small' }, 'Which agent uses free models is chosen under "Who does what".')));
}
const STATE = { ready: ['ok', 'Ready'], resting: ['warn', 'Resting'], 'free allowance used': ['warn', 'Daily allowance used'], banned: ['bad', 'Banned by you'], 'not allowed': ['off', 'Paid (not allowed)'], 'no tool calling': ['off', 'Cannot use tools'] };
function modelsTab(d, rerender) {
  const list = d.or.models; const rank = new Map(list.filter((m) => m.state === 'ready').map((m, i) => [m.id, i + 1]));
  const rows = list.map((m) => { const [tone, label] = STATE[m.state] ?? ['off', m.state]; const rel = m.calls ? m.ok / m.calls : null;
    return h('tr', { class: m.state === 'ready' ? '' : 'dim' }, h('td', {}, h('div', { class: 'row nowrap' }, h('i', { class: `sdot ${tone}`, 'aria-hidden': 'true' }), h('div', {}, h('b', {}, short(m.id)), h('div', { class: 'muted small' }, `${org(m.id)} · ${compact(m.context)} memory${m.modalities.includes('image') ? ' · sees images' : ''}${m.reasoning ? ' · thinks step by step' : ''}`)))),
      h('td', {}, h('span', { class: `pill2 ${tone === 'ok' ? 'solid' : tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : ''}` }, label), m.backAt ? h('div', { class: 'muted small' }, `Back in ${dur(Math.max(0, m.backAt - Date.now()))}${m.learnedRestMs ? ` · usually rests ${dur(m.learnedRestMs)}` : ''}`) : null),
      h('td', {}, rel === null ? h('span', { class: 'muted small' }, 'Not used yet') : h('div', {}, meter(m.ok, m.calls, rel > 0.9 ? 'ok' : rel > 0.6 ? 'warn' : 'bad', `${m.ok} of ${m.calls} calls worked`), h('div', { class: 'muted small' }, `${percent(rel)} of ${m.calls}`))),
      h('td', { class: 'tnum' }, m.avgMs ? `${(m.avgMs / 1000).toFixed(1)}s` : '–'), h('td', { class: 'tnum' }, m.tokensIn || m.tokensOut ? compact(m.tokensIn + m.tokensOut) : '–'), h('td', { class: 'tnum' }, rank.get(m.id) ?? '–'),
      h('td', {}, h('div', { class: 'row nowrap' }, h('button', { class: 'btn small', title: 'Send one tiny request to check this model works', onclick: act(async () => { const r = await post('/openrouter/test', { model: m.id }); if (!r.ok) throw new Error(r.message ?? r.kind); }, `${short(m.id)} answered`, rerender) }, 'Test'),
        m.state === 'resting' || m.state === 'free allowance used' ? h('button', { class: 'btn small ghost', onclick: act(async () => { await post('/openrouter/reset', { model: m.id }); }, 'Back in rotation', rerender) }, 'Wake') : null,
        h('button', { class: 'btn small ghost', onclick: act(async () => { const b = new Set(d.or.config.banned); b.has(m.id) ? b.delete(m.id) : b.add(m.id); await post('/openrouter/config', { banned: [...b] }); }, m.banned ? 'Allowed again' : 'Banned', rerender) }, m.banned ? 'Allow' : 'Ban')))); });
  return [keyCard(d, rerender), d.or.key.set ? settingsCard(d, rerender) : null,
    d.or.key.set ? card(h('div', { class: 'card-h' }, h('h2', {}, 'The models'), d.or.resting ? h('button', { class: 'btn small', onclick: act(async () => { await post('/openrouter/reset'); }, 'All back in rotation', rerender) }, 'Wake all') : null),
      list.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, [h('th', {}, 'Model'), h('th', {}, 'Right now'), h('th', {}, 'Reliability', tip('How often a call to this model worked.')), h('th', {}, 'Speed', tip('Average time for a reply.')), h('th', {}, 'Used', tip('Tokens it has read and written for you.')), h('th', {}, 'Rank', tip('The order the factory tries ready models in. It starts from the model\'s size and memory, then adjusts for how well it has actually done.')), h('th', {}, '')])), h('tbody', {}, ...rows)))
        : h('p', { class: 'muted' }, 'No models loaded yet. Use "Refresh the model list".'), h('p', { class: 'muted small' }, 'A model that hits its limit rests, then returns by itself. The page shows how long that model usually takes.')) : null].filter(Boolean);
}

// ---- codex
function codexTab(d, rerender) {
  const ctx = { rerender }; const s = d.settings; if (!s) return [h('div', { class: 'note bad' }, icon('alert', 14), 'Could not load the Codex settings.')];
  return [setupCard(d.setups, ctx), agentCard(s, ctx), rolesCard(d.roles, s, ctx), limitCard(s, ctx), historyCard(s)].filter(Boolean);
}

export const agentsPage = {
  async load(arg) {
    const tab = TABS.some(([k]) => k === arg) ? arg : 'overview';
    const [policy, or, settings, status, acc, activity, roles, setups] = await Promise.all([api('/agents/policy'), api('/openrouter'), api('/settings').catch(() => null), api('/status').catch(() => null), tab === 'overview' || tab === 'policy' ? api('/accounts?days=7&calls=1').catch(() => null) : null, tab === 'overview' ? api('/activity').catch(() => null) : null, tab === 'codex' ? api('/roles').catch(() => null) : null, tab === 'codex' ? api('/setups').catch(() => null) : null]);
    const lim = status?.limit ?? null; return { tab, policy, or, settings, status, acc, agents: activity?.agents ?? [], roles, setups, codex: { limited: lim, backIn: lim ? dur(Math.max(0, lim.until - Date.now())) : null } };
  },
  draw(d, ctx) {
    d.openrouterReady = d.policy.openrouterReady; const body = d.tab === 'policy' ? policyTab(d, ctx.rerender) : d.tab === 'free' ? modelsTab(d, ctx.rerender) : d.tab === 'codex' ? codexTab(d, ctx.rerender) : overview(d);
    return [head('Agents', 'Who does the work, on what, and how each is doing.'), tabs(d.tab), ...body];
  },
};
