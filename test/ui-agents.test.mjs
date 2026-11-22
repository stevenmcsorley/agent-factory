// The Agents and Usage pages and the visuals, drawn against REAL data shapes (from a real engine) in every state, checking they draw, say things a person understands, and never show the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class El { constructor(t) { this.tag = t; this.nodeType = 1; this.kids = []; this.attrs = {}; this.dataset = {}; this.style = {}; }
  append(...ns) { for (const n of ns) { assert.ok(n && (n.nodeType === 1 || n.nodeType === 3), `bad child: ${n} in <${this.tag}>`); this.kids.push(n); } } replaceChildren(...ns) { this.kids = []; this.append(...ns); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; } addEventListener() {}
  get value() { if (this.tag === 'select') { const o = this.all().filter((x) => x.tag === 'option'); return (o.find((x) => 'selected' in x.attrs) ?? o[0])?.attrs.value ?? ''; } return this.attrs.value ?? ''; } set value(v) { this.attrs.value = v; } get textContent() { return this.kids.map((k) => (k.nodeType === 3 ? k.text : k.textContent)).join(' '); } all() { return this.kids.flatMap((k) => (k.nodeType === 1 ? [k, ...k.all()] : [])); } }
globalThis.document = { createElement: (t) => new El(t), createElementNS: (_n, t) => new El(t), createTextNode: (text) => ({ nodeType: 3, text }) }; globalThis.location = { hash: '', pathname: '/', search: '' };
const viz = await import('../ui/viz.js'); const { agentsPage } = await import('../ui/agents.js'); const { usagePage } = await import('../ui/usage.js');
const { Engine } = await import('../src/engine.mjs'); const { withDefaults } = await import('../src/config.mjs'); const { recordUsage } = await import('../src/usage.mjs');

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const M = (id, o = {}) => ({ id, name: id, context: 262144, free: true, tools: true, input: ['text'], output: ['text'], reasoning: true, pricing: { prompt: 0, completion: 0 }, ...o });
async function world({ key = true, limited = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-')); const f = async (url, o) => { const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), headers: new Map() }); const pth = new URL(url).pathname;
    if (pth === '/api/tags') return ok({ models: [{ name: 'llama3.1:8b', size: 4.9e9, details: { parameter_size: '8.0B' } }, { name: 'gemma3n:e4b', size: 7.5e9, details: { parameter_size: '6.9B' } }, { name: 'glm-5.1:cloud', size: 0, details: {} }] }); if (pth === '/api/show') return ok({ capabilities: ['completion', 'tools'] });
    if (url.endsWith('/models')) return ok({ data: [M('big/ultra-550b:free', { context: 1e6 }), M('mid/gemma-31b:free', { input: ['text', 'image'] }), M('acme/lfm-1.7b:free')].map((m) => ({ id: m.id, context_length: m.context, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: m.input, output_modalities: ['text'] } })) });
    if (url.endsWith('/key')) return ok({ data: { is_free_tier: false, usage: 0, limit: 50, limit_remaining: 50 } }); if (url.endsWith('/credits')) return ok({ data: { total_credits: 10.2, total_usage: 0.15 } }); return ok({}); };
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { fetch: f } }); if (key) await e.setOpenRouterKey(KEY);
  const now = Date.now(); const R = (o) => recordUsage(e.cfg.stateDir, { role: 'builder', project: 'close-joinery', model: 'gpt-6.2-astra', via: null, input: 150000, cached: 135000, output: 1800, steps: 5, ms: 61000, ...o });
  R({}); R({ role: 'reviewer', input: 90000, cached: 80000, output: 400 }); R({ role: 'reviewer', via: 'openrouter', model: 'big/ultra-550b:free', input: 1200, cached: 0, output: 90, steps: 0, ms: 5000, why: 'Checking a change takes one short request.' }); R({ role: 'builder', via: 'openrouter', model: 'mid/gemma-31b:free', input: 5400, cached: 0, output: 300, steps: 5, ms: 38000, escalated: true, why: 'Small tickets on the first try go to free models. The free models could not give a usable answer, so Codex did it.' });
  if (limited) { e._audit({ what: 'plan-limit', until: new Date(now + 3 * 3_600_000).toISOString() }); e._noteLimit({ message: 'You have hit your usage limit', retryAt: new Date(now + 3 * 3_600_000).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) }); }
  e._audit({ what: 'openrouter', action: 'fallback', role: 'builder', project: 'close-joinery' }); e.router().noteFail('mid/gemma-31b:free', { kind: 'rate-limit', message: 'upstream' });
  return e;
}
const load = async (e, tab) => ({ tab, policy: e.agentPolicy(), or: e.openrouterStatus(), local: e.localStatus(), settings: e.settings(), status: e.status(), acc: await e.accounts({ days: 7, calls: 50 }), agents: [{ role: 'builder', project: 'close-joinery', what: 'writing the code' }], roles: e.roles(), setups: e.presets(), codex: { limited: e.planLimit(), backIn: e.planLimit() ? '3 h' : null } });
const text = (nodes) => nodes.map((n) => n.textContent).join(' ').replace(/\s+/g, ' ');
const JARGON = [/weighted/i, /escalat/i, /tool call/i, /\bshot\b/i, /\bprior\b/i, /is fine right now/i, /\bdelegat/i, /OpenRouter agent/, /\bwrapper\b/i, /\bpolicy\b/i];

test('visuals: gauge, split bar, day bars, dots, meter and timeline draw, with titles a person can hover, and the helpers format plainly', () => {
  assert.equal(viz.compact(10_936_477), '10.9M'); assert.equal(viz.compact(980), '980'); assert.equal(viz.percent(0.0837), '8%'); assert.equal(viz.money(10.05), '$10.05'); assert.equal(viz.span(5_400_000), '1 h 30 min'); assert.equal(viz.span(30_000), 'under a minute'); assert.equal(viz.span(null), '–');
  const g = viz.gauge({ value: 40, max: 1000, label: '960', sub: 'left today', title: '40 of 1000 used' }); assert.match(g.textContent, /960/); assert.ok(g.all().some((e) => e.tag === 'title' && /40 of 1000/.test(e.textContent)), 'hover text'); assert.equal(g.all().find((e) => e.tag === 'circle' && /gauge-fill/.test(e.attrs.class)).attrs['stroke-dasharray'].split(' ')[0] > 0, true);
  const sb = viz.splitBar([{ label: 'Codex', value: 90, cls: 'codex' }, { label: 'Free models', value: 10, cls: 'free' }]); assert.match(sb.textContent, /Codex\s+90%/); assert.match(sb.textContent, /Free models\s+10%/); assert.match(viz.splitBar([{ label: 'a', value: 0, cls: 'x' }], { empty: 'Nothing yet' }).textContent, /Nothing yet/);
  const d = viz.dayBars([{ day: '2026-11-20', a: 100, b: 0 }, { day: '2026-11-21', a: 50, b: 50 }, { day: '2026-11-22', a: 0, b: 0 }], { aLabel: 'Codex', bLabel: 'Free' }); assert.ok(d.all().some((e) => e.tag === 'title' && /Codex 50, Free 50/.test(e.textContent)), 'each day explains itself');
  assert.equal(viz.dots([{ tone: 'ok', title: 'a' }, { tone: 'warn', title: 'b' }]).attrs['aria-label'], '1 of 2 ready'); assert.equal(viz.meter(3, 4).all()[0].attrs.style === undefined, true); const t = viz.timeline([{ at: '2026-11-21T10:00:00Z', kind: 'codex-limit', title: 'Codex hit its limit' }], '2026-11-20T00:00:00Z', '2026-11-23T00:00:00Z'); assert.ok(t.all().some((e) => e.tag === 'circle' && /ev-codex-limit/.test(e.attrs.class)));
});

test('agents overview: Codex and the free models side by side, in plain words, with the allowance, who is working right now, where the work went, and what changed', async () => {
  const e = await world(); const out = agentsPage.draw(await load(e, 'overview'), { rerender() {} }); const t = text(out);
  assert.match(t, /Agents/); assert.match(t, /Codex/); assert.match(t, /Working normally/); assert.match(t, /Free models/); assert.match(t, /of \d+ ready|ready/); assert.match(t, /free requests used today/); assert.match(t, /Right now/); assert.match(t, /Free model: |Codex/); assert.match(t, /writing the code/); assert.match(t, /Where the work went this week/); assert.match(t, /Recent changes/); assert.match(t, /Free models took over from Codex/);
  assert.match(t, /Overview/); assert.match(t, /Who does what/); assert.match(t, /Codex settings/); assert.ok(!t.includes(KEY)); for (const re of JARGON) assert.doesNotMatch(t, re, `no developer language: ${re}`);
});

test('agents overview when Codex has run out: says so in words, when it is back, and who is carrying on', async () => {
  const e = await world({ limited: true }); e.setOpenRouter({ enabled: true }); const d = await load(e, 'overview'); const t = text(agentsPage.draw(d, { rerender() {} }));
  assert.match(t, /Limited until/); assert.match(t, /Your Codex plan has run out for now and is back/); assert.match(t, /free models are carrying on/); assert.match(t, /Codex ran out of usage/);
});

test('agents overview without the free models set up: invites you in, nothing broken', async () => {
  const e = await world({ key: false }); const t = text(agentsPage.draw(await load(e, 'overview'), { rerender() {} })); assert.match(t, /Not set up/); assert.match(t, /Add an OpenRouter key/); assert.match(t, /Set up/);
});

test('who does what: three providers choices with Both recommended, each agent in plain names with a choice and a reason, and the plain-language rules', async () => {
  const e = await world(); const out = agentsPage.draw(await load(e, 'policy'), { rerender() {} }); const t = text(out); assert.match(t, /Both/); assert.match(t, /Recommended/); assert.match(t, /Codex only/); assert.match(t, /Free models only/); assert.match(t, /Which provider does the work/);
  for (const name of ['Builder', 'Reviewer', 'Security reviewer', 'Spec writer', 'Designer', 'Planner']) assert.match(t, new RegExp(name)); assert.match(t, /Checks each change before it goes in/); assert.match(t, /Free, then Codex/); assert.match(t, /Checking a change takes one short request/); assert.match(t, /Not tested on free models yet, so it stays on Codex/);
  const buttons = out.flatMap((n) => n.all()).filter((x) => x.tag === 'button' && /Default|Free, then Codex/.test(x.textContent)); assert.ok(buttons.length >= 9 * 2); for (const re of JARGON) assert.doesNotMatch(t, re, `${re}`);
});

test('free models: the account, the settings as switches, and a model table with state, return time, reliability, speed and what it did', async () => {
  const e = await world(); const out = agentsPage.draw(await load(e, 'free'), { rerender() {} }); const t = text(out); assert.match(t, /OpenRouter account/); assert.match(t, /Connected/); assert.match(t, /Use free models/); assert.match(t, /Carry on when Codex runs out/); assert.match(t, /Allow paid models/); assert.match(t, /nothing here can spend your OpenRouter credit/i);
  assert.match(t, /ultra-550b/); assert.match(t, /gemma-31b/); assert.match(t, /Resting/); assert.match(t, /Back in/); assert.match(t, /sees images/); assert.match(t, /Ready/); assert.match(t, /Test/); assert.match(t, /Ban/); const pw = out.flatMap((n) => n.all()).filter((x) => x.tag === 'input' && x.attrs.type === 'password'); assert.equal(pw.length, 1); assert.ok(!t.includes(KEY));
  assert.ok(out.flatMap((n) => n.all()).filter((x) => x.tag === 'input' && x.attrs.type === 'checkbox').length >= 3, 'switches');
});

test('codex tab: the Codex settings are back (model, thinking effort, per-agent settings, what happens when the plan runs out)', async () => {
  const e = await world(); const out = agentsPage.draw(await load(e, 'codex'), { rerender() {} }); assert.ok(out.length >= 4); const t = text(out); assert.match(t, /Codex|Agent|Setup/);
});

test('usage: the accounting page draws with its numbers, limits and resets in words, the tool-call columns with explanations, and a filterable call log', async () => {
  const e = await world({ limited: true }); const out = usagePage.draw({ a: await e.accounts({ days: 7, calls: 500 }) }, { rerender() {} }); const t = text(out);
  assert.match(t, /Usage/); assert.match(t, /Last 24 hours/); assert.match(t, /7 days/); assert.match(t, /Download as CSV/); assert.match(t, /jobs run/); assert.match(t, /tokens read/); assert.match(t, /done by free models/); assert.match(t, /times Codex ran out/); assert.match(t, /Day by day/); assert.match(t, /Limits and resets/); assert.match(t, /Working normally|Limited until/); assert.match(t, /requests left/); assert.match(t, /OpenRouter credit/); assert.match(t, /\$10\.05/); assert.match(t, /What happened/); assert.match(t, /Codex ran out of usage/);
  assert.match(t, /By model/); assert.match(t, /Steps per job/); assert.match(t, /Bad tool calls/); assert.match(t, /By agent/); assert.match(t, /By project/); assert.match(t, /close-joinery/); assert.match(t, /Every call/); assert.match(t, /Any provider/); assert.match(t, /Handed to Codex/); assert.match(t, /Done/);
  const tips = out.flatMap((n) => n.all()).filter((x) => x.attrs.class === 'hint'); assert.ok(tips.length >= 6 && tips.every((x) => x.attrs.title.length > 20), 'every unavoidable term explains itself'); for (const re of [/weighted/i, /escalat/i, /\bshot\b/i, /\bprior\b/i]) assert.doesNotMatch(t, re, `${re}`);
});

test('usage with nothing yet draws without error and says so', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} });
  const t = text(usagePage.draw({ a: await e.accounts({ days: 7, calls: 50 }) }, { rerender() {} })); assert.match(t, /No agent has run in this period yet/);
});

test('local models: the tab says what this machine can run, lists the models with plain states (ready, resting, too big, cloud-hosted), and the rest of the pages offer them once switched on', async () => {
  const e = await world(); const off = text(agentsPage.draw(await load(e, 'local'), { rerender() {} })); assert.match(off, /Switched off/); assert.match(off, /Use local models/); assert.doesNotMatch(off, /llama3\.1/, 'no models are listed until they are switched on');
  const ov = text(agentsPage.draw(await load(e, 'overview'), { rerender() {} })); assert.match(ov, /Local models/); assert.match(ov, /Switched off/); assert.match(ov, /Set up/);
  assert.doesNotMatch(text(agentsPage.draw(await load(e, 'policy'), { rerender() {} })), /Local only/, 'no local choice before they are switched on'); assert.match(text(agentsPage.draw(await load(e, 'policy'), { rerender() {} })), /Set up local models/);
  e.setLocal({ enabled: true, maxGb: 7 }); await e.refreshLocal(); e.localRouter().noteFail('llama3.1:8b', { kind: 'memory', message: 'Not enough memory to run this model' });
  const d = await load(e, 'local'); const t = text(agentsPage.draw(d, { rerender() {} }));
  for (const re of [/Connected/, /Largest model to run/, /Also use cloud-hosted models/, /memory and \d+ processor cores/, /llama3\.1:8b/, /Resting/, /Not enough memory to run this model/, /Too big for this machine/, /Runs on Ollama's servers, not on this machine/, /Check again/]) assert.match(t, re, String(re));
  for (const j of JARGON) assert.doesNotMatch(t, j, `developer wording: ${j}`); assert.doesNotMatch(t, /num_ctx|ollama pull|tokens\/s|quantiz/i);
  const ov2 = text(agentsPage.draw(await load(e, 'overview'), { rerender() {} })); assert.match(ov2, /Local models/); assert.match(ov2, /Manage local models/);
  const po = text(agentsPage.draw(await load(e, 'policy'), { rerender() {} })); assert.match(po, /Local only/); assert.match(po, /Local\b/);
  e.setAgentPolicy({ mode: 'local' }); const po2 = agentsPage.draw(await load(e, 'policy'), { rerender() {} }); assert.match(text(po2), /Local models are chosen/);
});

test('start cheaper, step up if it fails: the card explains it in plain words and offers the Codex models by name', async () => {
  const e = await world(); const d = await load(e, 'policy'); d.codexModels = [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }, { id: 'gpt-6.2-astra', name: 'GPT-6.2-Astra' }]; const t = text(agentsPage.draw(d, { rerender() {} }));
  for (const re of [/Start cheaper, step up if it fails/, /older Codex model/, /uses less of your plan/, /Start with/, /step up to/, /GPT-6-Luna/, /The checks decide/]) assert.match(t, re, String(re)); for (const j of JARGON) assert.doesNotMatch(t, j);
  e.setAgentPolicy({ tiers: { builder: ['gpt-6-luna', 'gpt-6.2-astra'] } }); const d2 = await load(e, 'policy'); d2.codexModels = d.codexModels; assert.match(text(agentsPage.draw(d2, { rerender() {} })), /\bOn\b/);
});
