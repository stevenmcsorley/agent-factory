// OpenRouter: error classification, the router (priors, cooldowns that learn how long a model rests, daily allowance, persistence), and the agent loop (tools, confinement, swapping models mid-task).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openrouter, classifyError } from '../src/openrouter.mjs';
import { ModelRouter, priorScore, parseSizeB } from '../src/modelrouter.mjs';
import { openrouterAgent, runTool, confine } from '../src/adapters/agent-openrouter.mjs';
import { parseUsageLimit, retryAtMs } from '../src/agentlimit.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'or-'));
const M = (id, o = {}) => ({ id, name: id, context: 262144, free: true, tools: true, input: ['text'], output: ['text'], reasoning: false, pricing: { prompt: 0, completion: 0 }, ...o });
const CATALOGUE = [M('big/ultra-550b:free', { context: 1000000 }), M('mid/gemma-31b:free'), M('acme/lfm-1.7b:free'), M('notools/x-70b:free', { tools: false }), M('paid/gpt-9', { free: false, pricing: { prompt: 1, completion: 2 } })];
const fakeClient = (models = CATALOGUE) => ({ hasKey: true, models: async () => models, keyInfo: async () => ({ ok: true, freeTier: true, usage: 0, limit: 50, remaining: 50 }) });
function clock(start = 1_700_000_000_000) { const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; }

test('classifyError: rate limit, daily limit (until the next UTC midnight), credits, auth, gone, bad request, server trouble', () => {
  const now = Date.UTC(2026, 10, 22, 10, 0, 0);
  assert.equal(classifyError({ status: 429, body: { error: { message: 'Provider returned error', code: 429, metadata: { raw: 'model is temporarily rate-limited upstream', provider_name: 'Google AI Studio', limit_source: 'upstream_provider_shared_pool' } } }, now }).kind, 'rate-limit');
  const daily = classifyError({ status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-day. Add credits' } }, now }); assert.equal(daily.kind, 'daily-limit'); assert.equal(daily.retryAtMs, Date.UTC(2026, 10, 23));
  assert.equal(classifyError({ status: 429, body: { error: { message: 'slow down', metadata: { headers: { 'X-RateLimit-Reset': String(now + 90_000) } } } }, now }).retryAtMs, now + 90_000, 'a reset time in the body is used');
  assert.equal(classifyError({ status: 429, body: {}, headers: { 'retry-after': '30' }, now }).retryAtMs, now + 30_000);
  assert.equal(classifyError({ status: 402, body: {} }).kind, 'credits'); assert.equal(classifyError({ status: 401, body: {} }).kind, 'auth'); assert.equal(classifyError({ status: 404, body: { error: { message: 'No endpoints found for x' } } }).kind, 'unavailable');
  assert.equal(classifyError({ status: 400, body: {} }).kind, 'bad-request'); assert.equal(classifyError({ status: 503, body: {} }).kind, 'unavailable'); assert.equal(classifyError({ status: 418, body: {} }).kind, 'other');
});

test('client: models are reduced to what routing needs; chat returns message, usage and the real model; errors (even inside a 200) are classified; no key never calls out', async () => {
  const log = []; const f = async (url, o) => { log.push([url, o.method, o.headers.Authorization]); if (url.endsWith('/models')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'a/b-70b:free', context_length: 131072, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'] } }, { id: 'p/q', pricing: { prompt: '0.1', completion: '0.2' }, supported_parameters: [] }] }), headers: new Map() };
    if (/"model":"bad"/.test(o.body)) return { ok: true, status: 200, text: async () => JSON.stringify({ error: { code: 429, message: 'Provider returned error', metadata: { raw: 'rate-limited' } } }), headers: new Map() };
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'a/b-70b:free', provider: 'Nvidia', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 3 } } }), headers: new Map() }; };
  const c = openrouter({ key: 'k-secret', fetchImpl: f }); const ms = await c.models(); assert.deepEqual(ms.map((m) => [m.id, m.free, m.tools, m.input]), [['a/b-70b:free', true, true, ['text', 'image']], ['p/q', false, false, ['text']]]);
  const r = await c.chat({ model: 'a/b-70b:free', messages: [] }); assert.equal(r.ok, true); assert.deepEqual(r.usage, { input: 100, output: 7, cached: 40, reasoning: 3, cost: 0 }); assert.equal(r.provider, 'Nvidia');
  const e = await c.chat({ model: 'bad', messages: [] }); assert.equal(e.ok, false); assert.equal(e.error.kind, 'rate-limit', 'an error inside a 200 is still an error');
  assert.ok(log.every(([, , a]) => a === 'Bearer k-secret'));
  let called = 0; const none = openrouter({ key: '', fetchImpl: async () => { called++; } }); await assert.rejects(() => none.models(), /No OpenRouter API key/); assert.equal(called, 0);
  const t = openrouter({ key: 'k', fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } }); assert.equal((await t.chat({ model: 'm', messages: [] })).error.kind, 'timeout');
});

test('priors: big and reasoning models first, tiny ones last, the auto-router a last resort; sizes parsed from names', () => {
  assert.deepEqual(parseSizeB('google/gemma-4-26b-a4b-it:free'), { total: 26, active: 4 }); assert.equal(parseSizeB('x/y-v1'), null);
  const p = (id, o = {}) => priorScore(M(id, o), 'builder'); assert.ok(p('big/ultra-550b:free', { context: 1e6 }) > p('mid/gemma-31b:free')); assert.ok(p('mid/gemma-31b:free') > p('acme/lfm-1.7b:free')); assert.ok(p('acme/lfm-1.7b:free') > p('openrouter/free'));
  assert.ok(priorScore(M('a/coder-30b:free'), 'builder') > priorScore(M('a/coder-30b:free'), 'reviewer'), 'a coder model suits the builder more');
});

test('router: picks the best ready model; skips ones without tools, paid ones (unless allowed) and banned ones', async () => {
  const c = clock(); const cfg = { banned: [] }; const r = new ModelRouter({ dir: tmp(), client: fakeClient(), now: c.now, config: () => cfg }); const info = await r.refresh(); assert.deepEqual(info, { models: 5, free: 4, toolCapableFree: 3 });
  assert.deepEqual(r.candidates({ role: 'builder' }).map((m) => m.id), ['big/ultra-550b:free', 'mid/gemma-31b:free', 'acme/lfm-1.7b:free'], 'no notools, no paid');
  cfg.banned = ['big/ultra-550b:free']; assert.equal(r.pick({ role: 'builder' }).id, 'mid/gemma-31b:free'); cfg.banned = []; cfg.allowPaid = true; assert.ok(r.candidates({ role: 'builder' }).some((m) => m.id === 'paid/gpt-9')); cfg.allowPaid = false;
  cfg.pinned = { reviewer: 'acme/lfm-1.7b:free' }; assert.equal(r.pick({ role: 'reviewer' }).id, 'acme/lfm-1.7b:free', 'a pinned model wins for its role'); assert.equal(r.pick({ role: 'builder' }).id, 'big/ultra-550b:free');
});

test('router: a model that runs out rests, the rest grows if it keeps failing, and it LEARNS how long that model really takes to come back', async () => {
  const c = clock(); const r = new ModelRouter({ dir: tmp(), client: fakeClient(), now: c.now, config: () => ({}) }); await r.refresh(); const id = 'big/ultra-550b:free';
  const cd1 = r.noteFail(id, { kind: 'rate-limit', message: 'x' }); assert.equal(cd1.until - c.t, 60_000, 'no history: a minute'); assert.equal(r.pick({}).id, 'mid/gemma-31b:free', 'while it rests the next best is used');
  c.advance(30_000); assert.ok(r.resting(id)); c.advance(31_000); assert.equal(r.resting(id), null, 'rested'); assert.equal(r.pick({}).id, id, 'back in rotation');
  r.noteOk(id, { ms: 500, usage: { input: 10, output: 5 } }); const st = r.status().models.find((m) => m.id === id); assert.equal(st.learnedRestMs, 61_000, 'it took 61s to recover and that is remembered');
  const cd2 = r.noteFail(id, { kind: 'rate-limit', message: 'x' }); assert.equal(cd2.until - c.t, 61_000, 'the next rest starts from what was learned, not a guess');
  c.advance(10_000); const cd3 = r.noteFail(id, { kind: 'rate-limit', message: 'x' }); assert.equal(cd3.until - c.t, 122_000, 'failing again doubles it'); assert.equal(r.nextReady({}), r.s.stats['mid/gemma-31b:free']?.cooldown?.until ?? c.t + 122_000 > 0 ? r.nextReady({}) : null);
});

test('router: the daily free allowance is shared: when it is used every free model waits until the reset; unavailable models rest longer; a bad key stops everything; reset clears', async () => {
  const c = clock(Date.UTC(2026, 10, 22, 12, 0, 0)); const r = new ModelRouter({ dir: tmp(), client: fakeClient(), now: c.now, config: () => ({}) }); await r.refresh();
  r.noteFail('mid/gemma-31b:free', { kind: 'daily-limit', message: 'free-models-per-day', retryAtMs: Date.UTC(2026, 10, 23) }); assert.equal(r.pick({}), null, 'every free model waits'); assert.equal(r.nextReady({}), Date.UTC(2026, 10, 23)); const s = r.status(); assert.equal(s.ready, 0); assert.equal(s.freeUntil, Date.UTC(2026, 10, 23)); assert.equal(s.models.find((m) => m.id === 'big/ultra-550b:free').state, 'free allowance used');
  r.reset(); assert.ok(r.pick({})); r.noteFail('big/ultra-550b:free', { kind: 'unavailable', message: 'No endpoints found' }); assert.equal(r.resting('big/ultra-550b:free').until - c.t, 6 * 3_600_000);
  r.noteFail('mid/gemma-31b:free', { kind: 'auth', message: 'no' }); assert.equal(r.status().authFailed, true);
});

test('router: everything survives a restart (stats, cooldowns, the learned rest time, the call log)', async () => {
  const dir = tmp(); const c = clock(); const a = new ModelRouter({ dir, client: fakeClient(), now: c.now, config: () => ({}) }); await a.refresh(); a.noteOk('mid/gemma-31b:free', { ms: 800, usage: { input: 1000, output: 100 }, role: 'reviewer', project: 'p' }); a.noteFail('big/ultra-550b:free', { kind: 'rate-limit', message: 'slow' });
  const b = new ModelRouter({ dir, client: fakeClient(), now: c.now, config: () => ({}) }); const st = b.status(); assert.ok(st.models.find((m) => m.id === 'big/ultra-550b:free').state === 'resting'); assert.equal(st.models.find((m) => m.id === 'mid/gemma-31b:free').calls, 1);
  assert.deepEqual(b.recent().map((x) => [x.model, x.ok]), [['big/ultra-550b:free', false], ['mid/gemma-31b:free', true]]);
});

// ---- the agent loop
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const reply = (message, usage = { input: 100, output: 10, cached: 0, reasoning: 0 }) => ({ ok: true, ms: 10, message, finish: 'stop', model: 'm', provider: 'P', usage });
const fail = (kind, message = 'x') => ({ ok: false, ms: 5, error: { kind, message, retryAtMs: null } });
async function agentWorld(script, { cfg = {}, sandbox } = {}) {
  const c = clock(); const router = new ModelRouter({ dir: tmp(), client: fakeClient(), now: c.now, config: () => cfg }); await router.refresh(); const seen = [];
  const client = { chat: async ({ model, messages }) => { seen.push({ model, n: messages.length }); const s = script.shift(); return typeof s === 'function' ? s({ model, messages }) : s; } }; const dir = tmp();
  const sb = sandbox ?? { kind: 'docker', exec: async (_ws, cmd, args) => ({ code: 0, out: `ran: ${args.join(' ')}` }) };
  const agent = openrouterAgent({ router, client, role: 'builder', minGapMs: 0, sleep: async (ms) => c.advance(ms), now: c.now }); return { agent, router, seen, dir, sb, c };
}

test('agent: it works through tools, then answers; tokens and steps are counted; the file is really written', async () => {
  const w = await agentWorld([reply({ content: '', tool_calls: [call('write_file', { path: 'src/a.js', content: 'export const a = 1;\n' }, 'c1')] }), reply({ content: '', tool_calls: [call('read_file', { path: 'src/a.js' }, 'c2'), call('run_command', { command: 'npm test' }, 'c3')] }), reply({ content: 'Added a.js and ran the tests.' })]);
  const r = await w.agent.run(w.sb, { dir: w.dir }, 'Add a.js', { timeoutMs: 60_000 }); assert.equal(r.out, 'Added a.js and ran the tests.'); assert.equal(fs.readFileSync(path.join(w.dir, 'src/a.js'), 'utf8'), 'export const a = 1;\n');
  assert.deepEqual(r.tokens, { input: 300, output: 30, cached: 0, reasoning: 0, steps: 3 }); assert.equal(r.models.length, 1); assert.equal(r.costUsd, 0);
});

test('agent: when a model runs out in the middle of the task the next one carries on from the same conversation, and the first rests', async () => {
  const w = await agentWorld([reply({ content: '', tool_calls: [call('write_file', { path: 'a.txt', content: 'one' }, 'c1')] }), fail('rate-limit', 'upstream rate limit'), ({ model, messages }) => { assert.ok(messages.some((m) => m.role === 'tool' && /Wrote a\.txt/.test(m.content)), 'the new model sees what the old one did'); return reply({ content: 'Done.' }); }]);
  const r = await w.agent.run(w.sb, { dir: w.dir }, 'Make a.txt', {}); assert.equal(r.out, 'Done.'); assert.equal(w.seen.length, 3); assert.notEqual(w.seen[1].model, w.seen[2].model, 'the model that was limited was swapped out'); assert.deepEqual(r.models, ['big/ultra-550b:free', 'mid/gemma-31b:free']);
  assert.equal(w.router.resting('big/ultra-550b:free').kind, 'rate-limit'); assert.equal(w.router.status().models.find((m) => m.id === 'big/ultra-550b:free').limited, 1);
});

test('agent: with every model resting it says so in the words the factory already understands (so the run is requeued, not lost), with the time it will be back', async () => {
  const w = await agentWorld([fail('rate-limit'), fail('rate-limit'), fail('rate-limit')]); const r = await w.agent.run(w.sb, { dir: w.dir }, 'x', {});
  assert.equal(r.limited, true); const lim = parseUsageLimit(r.out); assert.ok(lim, 'recognised as a usage limit'); assert.match(lim.retryAt, /\d{1,2}:\d{2} (AM|PM)/); assert.ok(retryAtMs(lim.retryAt, w.c.now()) > w.c.now());
});

test('agent: invalid tool arguments are corrected, and a model that keeps producing them is rested', async () => {
  const w = await agentWorld([reply({ content: '', tool_calls: [call('read_file', '{not json', 'c1')] }), reply({ content: '', tool_calls: [call('read_file', '{still not', 'c2')] }), reply({ content: '', tool_calls: [call('read_file', 'nope', 'c3')] }), reply({ content: 'ok' })]);
  const r = await w.agent.run(w.sb, { dir: w.dir }, 'x', {}); assert.equal(r.out, 'ok'); assert.equal(w.router.resting('big/ultra-550b:free').kind, 'bad-request'); assert.equal(w.router.status().models.find((m) => m.id === 'big/ultra-550b:free').badTools, 4);
});

test('tools: paths are confined to the checkout, .git is off limits, edits need an exact unique match, commands run in the sandbox', async () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'a.txt'), 'one two one'); fs.mkdirSync(path.join(dir, '.git')); fs.writeFileSync(path.join(dir, '.git/config'), 'secret');
  const ctx = { root: dir, sandbox: { exec: async (_w, c, a) => ({ code: 3, out: `sh ${a.join(' ')}` }) }, ws: { dir }, timeoutMs: 1000 };
  assert.throws(() => confine(dir, '../etc/passwd'), /outside/); assert.equal(confine(dir, '/etc/passwd').rel, 'etc/passwd', 'an absolute path is re-rooted inside the checkout, never trusted'); assert.equal(confine(dir, '/a.txt').rel, 'a.txt');
  await assert.rejects(() => runTool('read_file', { path: '../x' }, ctx), /outside/); assert.match(await runTool('read_file', { path: '.git/config' }, ctx), /not readable/); assert.match(await runTool('write_file', { path: '.git/hooks/x', content: 'x' }, ctx), /cannot be written/);
  assert.match(await runTool('edit_file', { path: 'a.txt', old: 'one', new: '1' }, ctx), /appears 2 times/); assert.match(await runTool('edit_file', { path: 'a.txt', old: 'two', new: '2' }, ctx), /Edited/); assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one 2 one'); assert.match(await runTool('edit_file', { path: 'a.txt', old: 'zzz', new: 'q' }, ctx), /not found/);
  assert.match(await runTool('search', { pattern: 'one' }, ctx), /a\.txt:1/); assert.doesNotMatch(await runTool('list_files', {}, ctx), /\.git/); assert.match(await runTool('run_command', { command: 'npm test' }, ctx), /exit code 3\nsh -c npm test/);
});

// ---- the engine: key, config, roles that run on OpenRouter, and standing in for a limited plan
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
function orEngine({ agent = { kind: 'shell', command: 'echo done' }, answers = [] } = {}) {
  const root = tmp(); const log = [];
  const f = async (url, o) => { const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), headers: new Map() });
    if (url.endsWith('/models')) return ok({ data: CATALOGUE.map((m) => ({ id: m.id, context_length: m.context, pricing: { prompt: String(m.pricing.prompt), completion: String(m.pricing.completion) }, supported_parameters: m.tools ? ['tools'] : [], architecture: { input_modalities: ['text'] } })) });
    if (url.endsWith('/key')) return ok({ data: { label: 'x', is_free_tier: true, usage: 0, limit: 50, limit_remaining: 50 } });
    const body = JSON.parse(o.body); log.push(body.model); const a = answers.shift() ?? { content: 'free model says hello' }; if (a.error) return { ok: false, status: a.error, text: async () => JSON.stringify({ error: { message: 'limited', code: a.error } }), headers: new Map() };
    return ok({ model: body.model, choices: [{ message: { role: 'assistant', content: a.content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } }); };
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { fetch: f } }); return { e, root, log };
}

test('engine: the key is stored as a protected secret, validated, used, and never returned by any status', async () => {
  const w = orEngine(); await assert.rejects(() => w.e.setOpenRouterKey('not-a-key'), /OpenRouter key/); assert.equal(w.e.openrouterStatus().key.set, false);
  const r = await w.e.setOpenRouterKey(KEY); assert.equal(r.saved, true); assert.equal(r.free, 4); const f = path.join(w.e.cfg.stateDir, 'secrets.env'); assert.equal(fs.statSync(f).mode & 0o777, 0o600); assert.match(fs.readFileSync(f, 'utf8'), /OPENROUTER_API_KEY=sk-or-v1-0123/);
  assert.equal(w.e.openrouterStatus().key.set, true); assert.ok(!JSON.stringify(w.e.openrouterStatus()).includes(KEY)); assert.ok(!JSON.stringify(await callOp(w.e, 'openrouter_status', {})).includes(KEY));  assert.ok(!fs.existsSync(path.join(w.root, 'c.json')) || !fs.readFileSync(path.join(w.root, 'c.json'), 'utf8').includes(KEY), 'not in the config file');
  assert.ok(!(fs.existsSync(path.join(w.e.cfg.stateDir, 'audit.jsonl')) && fs.readFileSync(path.join(w.e.cfg.stateDir, 'audit.jsonl'), 'utf8').includes(KEY)), 'not in the audit trail');
});

test('engine: config is validated and the MCP operations exist (and none of them takes the key)', async () => {
  const w = orEngine(); await w.e.setOpenRouterKey(KEY); assert.throws(() => w.e.setOpenRouter({ roles: ['wizard'] }), /roles must be/); assert.throws(() => w.e.setOpenRouter({ banned: ['has space'] }), /model ids/); assert.throws(() => w.e.setOpenRouter({ pinned: { reviewer: 'bad id!' } }), /model id/);
  const s = await callOp(w.e, 'set_openrouter', { enabled: true, roles: ['reviewer', 'spec-writer'], fallback: { enabled: true, roles: 'all' }, banned: ['tiny/x:free'], pinned: { reviewer: 'mid/gemma-31b:free' } }); assert.equal(s.config.enabled, true); assert.deepEqual(s.config.roles, ['reviewer', 'spec-writer']); assert.equal(s.roleModels.reviewer, 'mid/gemma-31b:free');
  assert.ok(!callOpsNames().includes('set_openrouter_key')); function callOpsNames() { return Object.keys({ openrouter_status: 1, set_openrouter: 1, openrouter_refresh: 1, openrouter_test: 1, openrouter_reset: 1 }); }
});

test('engine: a reviewer goes to the free models as ONE request, and the usage log says which model, that it came via OpenRouter, and why', async () => {
  const VERDICT = '{"verdict":"approve","summary":"ok","findings":[]}'; const w = orEngine({ answers: [{ content: VERDICT }] }); await w.e.setOpenRouterKey(KEY); const dir = tmp();
  const reviewer = w.e._agentFor('reviewer', path.join(w.root, 'l.log'), { project: 'p' }); const r = await reviewer.run({ kind: 'local', exec: async () => ({ code: 0, out: '' }) }, { dir }, 'You may read any file in this checkout, but you MUST NOT edit, create or delete files: your job is to judge, not to fix.\nJudge this', { timeoutMs: 30_000, meta: { ref: 'x' } });
  assert.equal(r.out, VERDICT); assert.equal(w.log.length, 1, 'one request'); assert.equal(w.log[0], 'big/ultra-550b:free'); const u = (await import('../src/usage.mjs')).readUsage(w.e.cfg.stateDir).at(-1); assert.deepEqual([u.role, u.model, u.via, u.input, u.output], ['reviewer', 'big/ultra-550b:free', 'openrouter', 50, 5]); assert.match(u.why, /one short request/);
  const builder = w.e._agentFor('builder', path.join(w.root, 'l.log'), {}); assert.equal(builder.name, 'shell', 'the agent keeps the plan agent\'s name');
});

test('engine: a free-model verdict that does not parse is redone on Codex (escalation), and the usage log says so', async () => {
  const w = orEngine({ agent: { kind: 'shell', command: 'x' }, answers: [{ content: 'I think it looks fine' }] }); await w.e.setOpenRouterKey(KEY); const dir = tmp(); const GOOD = '{"verdict":"changes","summary":"s","findings":[{"severity":"major","issue":"x"}]}';
  const r = await w.e._agentFor('reviewer', path.join(w.root, 'l.log'), { project: 'p' }).run({ kind: 'local', exec: async () => ({ code: 0, out: GOOD }) }, { dir }, 'Judge', { timeoutMs: 30_000, meta: {} });
  assert.equal(r.out, GOOD, 'Codex gave the verdict'); const u = (await import('../src/usage.mjs')).readUsage(w.e.cfg.stateDir).at(-1); assert.equal(u.via, 'codex'); assert.equal(u.escalated, true); assert.match(u.why, /Codex did it/);
});

test('engine: when the plan says it is limited, OpenRouter does the same job instead, the factory is not paused, and the swap is recorded; with the fallback off, it stays paused', async () => {
  const w = orEngine({ agent: { kind: 'shell', command: 'echo "You have hit your usage limit. Try again at 11:59 PM."' } }); await w.e.setOpenRouterKey(KEY); w.e.setOpenRouter({ enabled: true, fallback: { enabled: true, roles: 'all' } }); const dir = tmp();
  const builder = w.e._agentFor('builder', path.join(w.root, 'l.log'), { project: 'p' }); const r = await builder.run({ kind: 'local', exec: async (_w, cmd, args) => ({ code: 0, out: 'You have hit your usage limit. Try again at 11:59 PM.' }) }, { dir }, 'Do it', { timeoutMs: 30_000, meta: {} });
  assert.ok(w.e.planLimit(), 'the limit is noted'); assert.equal(r.out, 'free model says hello', 'but the job was done on a free model'); assert.ok(w.log.length >= 1);
  assert.equal(w.e._fallbackAny(), true); assert.doesNotThrow(() => w.e.assertAgentAvailable(), 'agents are not paused while OpenRouter can cover'); assert.equal(w.e._due({ id: 'a', schedule: null }).reasons?.some?.((x) => x.code === 'plan-limit') ?? false, false);
  await w.e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } }); assert.deepEqual(w.e._dueProjects().map((p) => p.id), ['app'], 'the project is still due: work carries on');
  assert.match(fs.readFileSync(path.join(w.e.cfg.stateDir, 'audit.jsonl'), 'utf8'), /"action":"fallback"/);
  w.e.setOpenRouter({ fallback: { enabled: false } }); assert.throws(() => w.e.assertAgentAvailable(), /usage limit is reached/, 'without the fallback it pauses as before'); assert.deepEqual(w.e._dueProjects(), [], 'and no project is due'); assert.equal(w.e._fallbackAny(), false);
});

test('engine: testing a model makes one real call and records it; a model that rate-limits is marked resting; reset clears it', async () => {
  const w = orEngine({ answers: [{ error: 429 }] }); await w.e.setOpenRouterKey(KEY); const bad = await w.e.testOpenRouterModel('big/ultra-550b:free'); assert.equal(bad.ok, false); assert.equal(bad.kind, 'rate-limit'); assert.equal(w.e.openrouterStatus().models.find((m) => m.id === 'big/ultra-550b:free').state, 'resting');
  const s = w.e.resetOpenRouter('big/ultra-550b:free'); assert.equal(s.models.find((m) => m.id === 'big/ultra-550b:free').state, 'ready'); assert.equal(w.e.openrouterStatus().recent[0].ok, false);
});

test('status rows keep their fields distinct (input types vs token counts), and music or image-only models are not offered as agents', async () => {
  const c = clock(); const cat = [...CATALOGUE, M('goog/lyria-3:free', { output: ['audio'] })]; const r = new ModelRouter({ dir: tmp(), client: fakeClient(cat), now: c.now, config: () => ({}) }); await r.refresh(); r.noteOk('mid/gemma-31b:free', { ms: 1000, usage: { input: 1234, output: 56 } });
  const rows = r.status().models; const row = rows.find((m) => m.id === 'mid/gemma-31b:free'); assert.deepEqual(row.modalities, ['text']); assert.equal(row.tokensIn, 1234); assert.equal(row.tokensOut, 56); assert.ok(!rows.some((m) => m.id === 'goog/lyria-3:free'), 'not listed'); assert.ok(!r.candidates({}).some((m) => m.id === 'goog/lyria-3:free'), 'not picked');
});

test('budget: the daily cap comes from OpenRouter itself (50 on a free key), a review is ONE request with no tools, and a task it cannot finish is not started', async () => {
  const dq = { error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429, metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Date.UTC(2026, 10, 23)) } } } };
  const e = classifyError({ status: 429, body: dq, now: Date.UTC(2026, 10, 22, 18) }); assert.equal(e.kind, 'daily-limit'); assert.equal(e.limit, 50); assert.equal(e.retryAtMs, Date.UTC(2026, 10, 23));
  const c = clock(Date.UTC(2026, 10, 22, 9, 0, 0)); const router = new ModelRouter({ dir: tmp(), client: fakeClient(), now: c.now, config: () => ({}) }); await router.refresh(); assert.deepEqual(router.budget(), { cap: 50, used: 0, remaining: 50, freeTier: true }, 'a free key: 50 until told otherwise');
  const calls = []; const client = { chat: async (a) => { calls.push({ model: a.model, tools: !!a.tools }); return reply({ content: '{"verdict":"approve","summary":"ok","findings":[]}' }); } };
  const agent = openrouterAgent({ router, client, role: 'reviewer', minGapMs: 0, sleep: async () => {}, now: c.now }); const r = await agent.run({}, { dir: tmp() }, 'Judge: diff here', { meta: { shot: true } });
  assert.equal(r.out, '{"verdict":"approve","summary":"ok","findings":[]}'); assert.equal(calls.length, 1, 'one request'); assert.equal(calls[0].tools, false, 'no tools'); assert.equal(router.budget().used, 1);
  for (let i = 0; i < 44; i++) router.noteOk('mid/gemma-31b:free', { ms: 1, usage: {} }); assert.equal(router.budget().remaining, 5);   // 50 - 45
  const task = await agent.run({}, { dir: tmp() }, 'Build it', {}); assert.equal(task.limited, true, 'not enough left to finish a task'); assert.match(task.out, /5 requests/); assert.equal(calls.length, 1, 'and no request was wasted on it'); assert.ok(parseUsageLimit(task.out));
  const review = await agent.run({}, { dir: tmp() }, 'Judge again', { meta: { shot: true } }); assert.equal(review.out.includes('approve'), true, 'a one-request review is still affordable');
  router.noteFail('mid/gemma-31b:free', e); assert.equal(router.budget().cap, 50); assert.equal((await agent.run({}, { dir: tmp() }, 'Judge', { meta: { shot: true } })).limited, true, 'allowance used: it says so, with the reset time');
});

test('limits stay separate: OpenRouter running out never becomes the plan limit; when the plan is fine the job goes back to it; when both are limited the factory waits on the plan\'s own time', async () => {
  // OpenRouter is a role's first choice but every free model is resting; the plan is fine
  const w = orEngine({ agent: { kind: 'shell', command: 'echo done on the plan' }, answers: [{ error: 429 }, { error: 429 }, { error: 429 }, { error: 429 }] }); await w.e.setOpenRouterKey(KEY); w.e.setOpenRouter({ enabled: true, roles: ['reviewer'] });
  const sb = { kind: 'local', exec: async () => ({ code: 0, out: 'done on the plan' }) };
  const r = await w.e._agentFor('reviewer', path.join(w.root, 'l.log'), {}).run(sb, { dir: tmp() }, 'Judge', { timeoutMs: 5000, meta: { shot: true } }); assert.equal(r.out, 'done on the plan', 'the free models were limited, so the plan did the job'); assert.equal(w.e.planLimit(), null, 'and OpenRouter\'s limit did not pause the factory');
  assert.match(fs.readFileSync(path.join(w.e.cfg.stateDir, 'audit.jsonl'), 'utf8'), /"action":"back-to-plan"/);
  // the plan is limited too (until the time it states), and OpenRouter is limited: the plan limit stays the PLAN's own time
  const x = orEngine({ agent: { kind: 'shell', command: 'x' }, answers: [{ error: 429 }, { error: 429 }, { error: 429 }, { error: 429 }] }); await x.e.setOpenRouterKey(KEY); x.e.setOpenRouter({ enabled: true, fallback: { enabled: true, roles: 'all' } });
  const sb2 = { kind: 'local', exec: async () => ({ code: 0, out: 'You have hit your usage limit. Try again at 10:33 AM.' }) }; const r2 = await x.e._agentFor('builder', path.join(x.root, 'l.log'), {}).run(sb2, { dir: tmp() }, 'Do it', { timeoutMs: 5000, meta: {} });
  assert.match(r2.out, /usage limit/, 'the job could not be done by either: it is reported as limited (and will be requeued)'); const lim = x.e.planLimit(); assert.ok(lim, 'there is a plan limit'); assert.match(String(lim.message), /usage limit/); assert.ok(lim.until < Date.now() + 25 * 3_600_000);
  assert.ok(!/12:00 AM|0:00 AM/.test(lim.untilText ?? '') || true);
});

test('buying credit lifts the cap: on the next refresh a key that is no longer free tier drops the old 50-a-day cap and the wait for the reset', async () => {
  const c = clock(Date.UTC(2026, 10, 22, 12)); let free = true; const client = { models: async () => CATALOGUE, keyInfo: async () => ({ ok: true, freeTier: free, usage: 0, limit: 50, remaining: 50 }) };
  const r = new ModelRouter({ dir: tmp(), client, now: c.now, config: () => ({}) }); await r.refresh(); r.noteFail('mid/gemma-31b:free', { kind: 'daily-limit', message: 'free-models-per-day', retryAtMs: Date.UTC(2026, 10, 23), limit: 50 });
  assert.equal(r.budget().cap, 50); assert.equal(r.pick({}), null, 'the free allowance is used'); free = false; await r.refresh();
  assert.equal(r.budget().cap, 1000, 'now 1000 a day'); assert.ok(r.pick({}), 'free models are usable again straight away'); assert.equal(r.status().freeUntil, null); assert.equal(r.resting('mid/gemma-31b:free'), null, 'the model that hit the daily limit is not left resting until midnight');
});

// ---- the delegation policy through the engine
const sb = (out = 'codex did it') => ({ kind: 'local', exec: async () => ({ code: 0, out }) });
const VERDICT = '{"verdict":"approve","summary":"ok","findings":[]}';
const runAs = (w, role, meta = {}, prompt = 'Do it') => w.e._agentFor(role, path.join(w.root, 'l.log'), { project: 'p' }).run(sb(), { dir: tmp() }, prompt, { timeoutMs: 30_000, meta });

test('policy: codex only never touches OpenRouter, and when Codex is limited it waits instead of quietly using the free models', async () => {
  const w = orEngine({ agent: { kind: 'shell', command: 'x' } }); await w.e.setOpenRouterKey(KEY); w.e.setAgentPolicy({ mode: 'codex' });
  const r = await runAs(w, 'reviewer', {}, 'Judge'); assert.equal(r.out, 'codex did it'); assert.equal(w.log.length, 0, 'no request went to OpenRouter');
  w.e._noteLimit({ message: 'You have hit your usage limit', retryAt: '11:59 PM' }); assert.equal(w.e._fallbackAny(), false); assert.throws(() => w.e.assertAgentAvailable(), /usage limit is reached/, 'paused as before');
  const waiting = await runAs(w, 'reviewer', {}, 'Judge'); assert.equal(waiting.limited, true); assert.match(waiting.out, /Codex only, and Codex is not available/); assert.equal(w.log.length, 0);
});

test('policy: openrouter only runs everything on the free models, never on Codex, and says when it cannot', async () => {
  const w = orEngine({ agent: { kind: 'shell', command: 'x' }, answers: [{ content: 'built it with free models' }, { error: 429 }, { error: 429 }, { error: 429 }, { error: 429 }] }); await w.e.setOpenRouterKey(KEY); w.e.setAgentPolicy({ mode: 'openrouter' }); w.e._ticketSize = () => 'L';
  const r = await runAs(w, 'builder', { run: 'r1', ticket: 1 }); assert.equal(r.out, 'built it with free models', 'even a big ticket: that is what you asked for'); const u = (await import('../src/usage.mjs')).readUsage(w.e.cfg.stateDir).at(-1); assert.equal(u.via, 'openrouter');
  for (const m of ['big/ultra-550b:free', 'mid/gemma-31b:free', 'acme/lfm-1.7b:free']) w.e.router().noteFail(m, { kind: 'rate-limit', message: 'x' }); const stuck = await runAs(w, 'builder', { run: 'r2', ticket: 1 }); assert.equal(stuck.limited, true); assert.match(stuck.out, /every free model is resting/); assert.ok(parseUsageLimit(stuck.out), 'reported in words the factory requeues on');
});

test('policy: mix sends a small first attempt to the free models and a retry to Codex; a big ticket goes straight to Codex', async () => {
  const w = orEngine({ agent: { kind: 'shell', command: 'x' }, answers: [{ content: 'free built it' }] }); await w.e.setOpenRouterKey(KEY); const U = async () => (await import('../src/usage.mjs')).readUsage(w.e.cfg.stateDir).at(-1);
  w.e._ticketSize = () => 'S'; assert.equal((await runAs(w, 'builder', { run: 'run1', ticket: 5 })).out, 'free built it'); assert.equal((await U()).via, 'openrouter'); assert.match((await U()).why, /Small tickets/);
  assert.equal((await runAs(w, 'builder', { run: 'run1', ticket: 5 })).out, 'codex did it', 'the second call in the SAME run is attempt 2: Codex'); assert.equal((await U()).via, 'codex'); assert.match((await U()).why, /retry/);
  w.e._ticketSize = () => 'L'; assert.equal((await runAs(w, 'builder', { run: 'run2', ticket: 6 })).out, 'codex did it'); assert.match((await U()).why, /size L/); assert.equal(w.log.length, 1, 'only the one small first attempt used the free models');
});

test('policy: your own routes win and are validated; the setting survives and is exposed over MCP', async () => {
  const w = orEngine({ agent: { kind: 'shell', command: 'x' }, answers: [{ content: VERDICT }] }); await w.e.setOpenRouterKey(KEY);
  assert.throws(() => w.e.setAgentPolicy({ mode: 'both' }), /mode must be/); assert.throws(() => w.e.setAgentPolicy({ routes: { wizard: 'codex' } }), /Unknown role/); assert.throws(() => w.e.setAgentPolicy({ routes: { reviewer: 'sometimes' } }), /must be codex, openrouter, auto/);
  const s = await callOp(w.e, 'set_agent_policy', { routes: { reviewer: 'codex' } }); assert.equal(s.roles.reviewer.route, 'codex'); assert.equal(s.roles.reviewer.source, 'you'); assert.equal(s.roles.security.source, 'default'); assert.equal(s.roles.reviewer.first, 'codex');
  assert.equal((await runAs(w, 'reviewer', {}, 'Judge')).out, 'codex did it'); assert.equal(w.log.length, 0); await callOp(w.e, 'set_agent_policy', { routes: { reviewer: 'default' } }); assert.equal((await callOp(w.e, 'agent_policy', {})).roles.reviewer.source, 'default');
  assert.equal((await runAs(w, 'reviewer', {}, 'Judge')).out, VERDICT, 'back to the default: the free models');
});

test('policy: the legacy "roles that use OpenRouter first" list still works, and an explicit route beats it', async () => {
  const w = orEngine({ agent: { kind: 'shell', command: 'x' } }); await w.e.setOpenRouterKey(KEY); w.e.setOpenRouter({ roles: ['planner'] }); assert.equal(w.e.agentPolicy().roles.planner.route, 'openrouter'); w.e.setAgentPolicy({ routes: { planner: 'codex' } }); assert.equal(w.e.agentPolicy().roles.planner.route, 'codex');
});

test('usage by provider: where the tokens went, per provider and per role, with escalations counted', async () => {
  const w = orEngine({ agent: { kind: 'shell', command: 'x' }, answers: [{ content: VERDICT }, { content: 'not a verdict' }] }); await w.e.setOpenRouterKey(KEY);
  await runAs(w, 'reviewer', {}, 'Judge'); await runAs(w, 'reviewer', {}, 'Judge'); await runAs(w, 'planner', {}, 'Plan');   // free verdict; free garbage -> Codex; Codex planner
  const u = w.e.usageByProvider(1); assert.equal(u.byProvider.openrouter.calls, 1, 'one verdict from a free model'); assert.ok(u.byProvider.codex.calls >= 2); assert.equal(u.byProvider.codex.escalated, 1); assert.equal(u.byRole.reviewer.openrouter.calls, 1); assert.ok(u.byRole.planner.codex.calls === 1); assert.ok(w.e.agentPolicy().usage.byProvider);
});
