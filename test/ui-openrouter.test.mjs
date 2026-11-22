// The OpenRouter page draws without throwing for every state it can be in (no key, key + models, resting models, live runs, Codex limited), and never shows the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class El { constructor(t) { this.tag = t; this.nodeType = 1; this.kids = []; this.attrs = {}; this.dataset = {}; this.style = {}; }
  append(...ns) { for (const n of ns) { assert.ok(n && (n.nodeType === 1 || n.nodeType === 3), `bad child: ${n}`); this.kids.push(n); } } replaceChildren(...ns) { this.kids = []; this.append(...ns); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; } addEventListener() {} get textContent() { return this.kids.map((k) => (k.nodeType === 3 ? k.text : k.textContent)).join(' '); } all() { return this.kids.flatMap((k) => (k.nodeType === 1 ? [k, ...k.all()] : [])); } }
globalThis.document = { createElement: (t) => new El(t), createElementNS: (_n, t) => new El(t), createTextNode: (text) => ({ nodeType: 3, text }) }; globalThis.location = { hash: '', pathname: '/', search: '' };
const { openrouterPage } = await import('../ui/openrouter.js');
const policy = (o = {}) => ({ mode: 'mix', modes: ['mix', 'codex', 'openrouter'], routes: {}, openrouterReady: true, codexLimited: false, usage: { days: 7, byProvider: { codex: { calls: 4, input: 800000, cached: 700000, output: 9000, weighted: 200000, escalated: 1 }, openrouter: { calls: 30, input: 40000, cached: 0, output: 3000, weighted: 58000, escalated: 0 } }, byRole: { reviewer: { codex: { calls: 1, input: 90000 }, openrouter: { calls: 9, input: 12000 } } } }, roles: { reviewer: { route: 'openrouter', source: 'default', why: 'one request', default: 'openrouter', defaultWhy: 'a verdict on a diff is one request', judge: true, first: 'openrouter', firstWhy: 'a verdict on a diff is one request' }, builder: { route: 'codex', source: 'you', default: 'auto', defaultWhy: 'small tickets on the first attempt go to free models', judge: false, first: 'codex', firstWhy: 'you set this role to Codex' } }, ...o }); const { ModelRouter } = await import('../src/modelrouter.mjs');

const M = (id, o = {}) => ({ id, name: id, context: 262144, free: true, tools: true, input: ['text'], output: ['text'], reasoning: true, pricing: { prompt: 0, completion: 0 }, ...o });
async function data0({ key = true, rest = false, live = false, limited = false } = {}) {
  let clock = Date.now(); const t = clock; const r = new ModelRouter({ now: () => clock, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'uo-')), client: { models: async () => [M('big/ultra-550b:free', { context: 1e6 }), M('mid/gemma-31b:free', { input: ['text', 'image'] }), M('x/nope-9b:free', { tools: false })], keyInfo: async () => ({ ok: true, freeTier: true, usage: 0, limit: 50, remaining: 50 }) }, config: () => ({}) }); if (key) await r.refresh();
  r.noteOk('mid/gemma-31b:free', { ms: 2100, usage: { input: 5400, output: 300 }, role: 'builder', project: 'p' }); if (rest) { r.noteFail('big/ultra-550b:free', { kind: 'rate-limit', message: 'upstream limit' }); clock += 75_000; r.noteOk('big/ultra-550b:free', { ms: 900, usage: { input: 10, output: 1 } }); r.noteFail('big/ultra-550b:free', { kind: 'rate-limit', message: 'upstream limit' }); }
  const s = r.status(); s.budget = { cap: 50, used: 47, remaining: 3, freeTier: true }; return { d: { key: { set: key, authFailed: false, info: s.keyInfo }, config: { enabled: true, roles: ['reviewer'], fallback: { enabled: true, roles: 'all' }, allowPaid: false, banned: [], pinned: {} }, ...s, recent: r.recent(30), live: live ? [{ role: 'builder', project: 'tenement-life', model: 'mid/gemma-31b:free', since: t - 65_000, lastFail: 'big/ultra-550b:free: rate-limit' }] : [], codexLimit: limited ? { until: t + 3_600_000, untilText: 'Sun 10:33 AM' } : null, covering: limited, usable: key, roleModels: { builder: 'mid/gemma-31b:free', reviewer: null } } };
}
async function data(o = {}) { const x = await data0(o); return { ...x, p: policy() }; }
const text = (nodes) => nodes.map((n) => n.textContent).join(' ');

test('no key: the page asks for one and shows nothing else that needs it', async () => {
  const out = openrouterPage.draw(await data({ key: false }), { rerender() {} }); const t = text(out); assert.match(t, /not set/); assert.match(t, /Save key/); assert.doesNotMatch(t, /Recent calls/); assert.ok(out.every((n) => n && n.nodeType === 1), 'no null children');
});

test('with a key: models, states, return times, what runs now, what each agent would use, recent calls; Codex limited is stated with who is covering', async () => {
  const out = openrouterPage.draw(await data({ rest: true, live: true, limited: true }), { rerender() {} }); const t = text(out);
  assert.match(t, /big\/ultra-550b:free/); assert.match(t, /resting/); assert.match(t, /back in/); assert.match(t, /usually rests/, 'the learned rest time is shown'); assert.match(t, /ready/); assert.match(t, /no tool calling/); assert.match(t, /images/);
  assert.match(t, /tenement-life/); assert.match(t, /swapped away from big\/ultra-550b:free: rate-limit/); assert.match(t, /The Codex plan is limited until Sun 10:33 AM/); assert.match(t, /OpenRouter is carrying on, so nothing is paused/); assert.match(t, /of 50 requests left today/); assert.match(t, /Adding \$10 of credit/); assert.match(t, /Who does the work/); assert.match(t, /Codex only/); assert.match(t, /Free models only/); assert.match(t, /of the work \(weighted\) on free models/); assert.match(t, /you set this role to Codex/); assert.match(t, /your choice/); assert.match(t, /What each agent would use now/); assert.match(t, /Recent calls/); assert.match(t, /rate limited/);
  const inputs = out.flatMap((n) => n.all()).filter((e) => e.tag === 'input' && e.attrs.type === 'password'); assert.equal(inputs.length, 1, 'one password field for the key'); assert.ok(!t.includes('sk-or-v1-'), 'no key text anywhere');
});

test('a quiet, healthy state also draws: nothing live, Codex fine', async () => {
  const t = text(openrouterPage.draw(await data({}), { rerender() {} })); assert.match(t, /No OpenRouter run is active/); assert.match(t, /Codex plan is fine/);
});
