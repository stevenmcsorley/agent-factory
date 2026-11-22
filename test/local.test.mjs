// Local models: the Ollama protocol (tool calls both ways), which installed models are eligible, how the delegation rules use them, and the whole path through the engine against a fake Ollama.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localClient, LocalRouter, paramsOf, classifyLocalError } from '../src/localmodels.mjs';
import { decide, MODES, ROUTES } from '../src/delegation.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
import { readUsage } from '../src/usage.mjs';
import { buildAccounts } from '../src/accounts.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'local-'));
const TAGS = { models: [
  { name: 'llama3.1:8b', size: 4.9e9, details: { parameter_size: '8.0B', quantization_level: 'Q4_K_M', family: 'llama' } },
  { name: 'qwen2.5:3b', size: 1.9e9, details: { parameter_size: '3.1B', quantization_level: 'Q4_K_M' } },
  { name: 'gemma3n:e4b', size: 7.5e9, details: { parameter_size: '6.9B' } },
  { name: 'glm-5.1:cloud', size: 0, details: {} },
  { name: 'nomic-embed-text:v1.5', size: 0.3e9, details: { parameter_size: '137M' } },
  { name: 'old:7b', size: 4e9, details: { parameter_size: '7B' } },
] };
const SHOW = { 'llama3.1:8b': { capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 131072 } }, 'qwen2.5:3b': { capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32768 } }, 'gemma3n:e4b': { capabilities: ['completion'] }, 'glm-5.1:cloud': { capabilities: ['completion', 'tools'] }, 'nomic-embed-text:v1.5': { capabilities: ['embedding'] }, 'old:7b': { capabilities: ['completion'] } };
const J = (b, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(b), headers: new Map() });
// a fake Ollama: records every chat request and answers from a queue
function fakeOllama({ answers = [] } = {}) {
  const chats = []; const f = async (url, o) => { const u = new URL(url); if (u.pathname === '/api/tags') return J(TAGS); if (u.pathname === '/api/show') return J(SHOW[JSON.parse(o.body).model] ?? { capabilities: [] });
    if (u.pathname === '/api/chat') { const body = JSON.parse(o.body); chats.push(body); const a = answers.shift() ?? { content: 'local says hello' }; if (a.status) return J({ error: a.error ?? 'boom' }, a.status); if (a.throw) throw new Error('ECONNREFUSED');
      return J({ model: body.model, message: { role: 'assistant', content: a.content ?? '', ...(a.tool ? { tool_calls: [{ function: { name: a.tool.name, arguments: a.tool.args } }] } : {}) }, done_reason: 'stop', prompt_eval_count: 40, eval_count: 8, eval_duration: 2e9 }); }
    return J({ error: 'no' }, 404); }; return { f, chats };
}

test('the client reads what Ollama has: sizes, tool support, cloud-hosted models flagged, embedding models left out', async () => {
  const c = localClient({ fetchImpl: fakeOllama().f }); const m = await c.models(); const by = Object.fromEntries(m.map((x) => [x.id, x]));
  assert.equal(c.kind, 'ollama'); assert.ok(!by['nomic-embed-text:v1.5'], 'embedding models cannot work as agents'); assert.equal(by['llama3.1:8b'].tools, true); assert.equal(by['llama3.1:8b'].sizeGb, 4.9); assert.equal(by['llama3.1:8b'].params, 8); assert.equal(by['llama3.1:8b'].context, 131072);
  assert.equal(by['gemma3n:e4b'].tools, false); assert.equal(by['glm-5.1:cloud'].remote, true, 'Ollama cloud models run on its servers, not here'); assert.equal(by['qwen2.5:3b'].remote, false);
  assert.equal(paramsOf({ details: { parameter_size: '137M' } }), 0.137); assert.equal(paramsOf({ name: 'foo-14b-instruct' }), 14);
});

test('the client speaks Ollama\'s tool protocol both ways: arguments become objects going out and JSON text coming back, tool results are matched by name, and the context size is set', async () => {
  const w = fakeOllama({ answers: [{ tool: { name: 'read_file', args: { path: 'a.txt' } } }] }); const c = localClient({ fetchImpl: w.f, numCtx: 8192 });
  const res = await c.chat({ model: 'llama3.1:8b', maxTokens: 300, tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }], messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'a.txt' }] });
  const sent = w.chats[0]; assert.equal(sent.options.num_ctx, 8192); assert.equal(sent.options.num_predict, 300); assert.equal(sent.stream, false); assert.deepEqual(sent.messages[2].tool_calls[0].function.arguments, { path: '.' }); assert.equal(sent.messages[3].tool_name, 'list_files');
  assert.ok(res.ok); assert.equal(res.message.tool_calls[0].function.name, 'read_file'); assert.equal(res.message.tool_calls[0].function.arguments, '{"path":"a.txt"}'); assert.deepEqual([res.usage.input, res.usage.output, res.usage.cost], [40, 8, 0]); assert.equal(res.speed, 4);
});

test('failures are named in plain terms: the server is down, the model is missing, it cannot call tools, there is not enough memory', () => {
  assert.equal(classifyLocalError({ thrown: 'network' }).kind, 'down'); assert.equal(classifyLocalError({ thrown: 'timeout' }).kind, 'timeout'); assert.equal(classifyLocalError({ status: 404, body: { error: 'model "x" not found, try pulling it first' } }).kind, 'unavailable');
  assert.equal(classifyLocalError({ status: 400, body: { error: 'registry.ollama.ai/library/gemma3n does not support tools' } }).kind, 'bad-request'); assert.equal(classifyLocalError({ status: 500, body: { error: 'model requires more system memory (9.1 GiB) than is available' } }).kind, 'memory');
});

test('the router: only what fits and can call tools, cloud models only when allowed, a pinned model wins, failures rest a model, speed is learned', async () => {
  let conf = { enabled: true, maxGb: 6, allowRemote: false, banned: [], pinned: {} }; const dir = tmp(); const t = { now: 1_000_000 };
  const r = new LocalRouter({ dir, client: localClient({ fetchImpl: fakeOllama().f }), config: () => conf, now: () => t.now }); await r.refresh();
  assert.equal(r.pick({ role: 'builder', need: { tools: true } }).id, 'llama3.1:8b', 'the biggest model that fits and calls tools'); assert.ok(!r.models.find((m) => m.id === 'gemma3n:e4b' && r.eligible(m, { tools: true })), 'too big and no tools');
  assert.equal(r.pick({ role: 'reviewer', need: { tools: false } }).id !== 'glm-5.1:cloud', true); conf = { ...conf, allowRemote: true }; assert.ok(r.eligible(r.models.find((m) => m.id === 'glm-5.1:cloud'), { tools: true }), 'allowed when you say so');
  conf = { ...conf, allowRemote: false, pinned: { reviewer: 'qwen2.5:3b' } }; assert.equal(r.pick({ role: 'reviewer' }).id, 'qwen2.5:3b'); assert.equal(r.pick({ role: 'builder' }).id, 'llama3.1:8b', 'a pin is for one role');
  conf = { ...conf, pinned: {} }; r.noteFail('llama3.1:8b', { kind: 'memory', message: 'out of memory' }); assert.equal(r.pick({ role: 'builder', need: { tools: true } }).id, 'qwen2.5:3b', 'the next one while the first rests'); assert.ok(r.nextReady({ need: { tools: true } }) > t.now);
  t.now += 11 * 60_000; assert.equal(r.pick({ role: 'builder', need: { tools: true } }).id, 'llama3.1:8b', 'it returns after resting'); r.noteOk('qwen2.5:3b', { ms: 2000, usage: { output: 10 } }); assert.equal(r.status().models.find((m) => m.id === 'qwen2.5:3b').tokensPerSecond, 5);
  assert.deepEqual(r.budget(), { remaining: null, cap: null }); const again = new LocalRouter({ dir, client: r.client, config: () => conf }); assert.equal(again.st('qwen2.5:3b').ok, 1, 'what was learned survives a restart'); conf = { ...conf, enabled: false }; assert.equal(r.pick({ role: 'builder' }), null);
});

const OK = { orUsable: true, orReady: true, orRemaining: 900, planLimited: false, codexUsable: true, localUsable: true, localReady: true };
test('delegation: local only is strict, and says why when it cannot run', () => {
  assert.deepEqual(MODES, ['mix', 'codex', 'openrouter', 'local']); assert.ok(ROUTES.includes('local'));
  for (const role of ['builder', 'reviewer', 'planner']) assert.equal(decide({ role, mode: 'local', ...OK }).provider, 'local', role);
  assert.equal(decide({ role: 'builder', mode: 'local', ...OK, localReady: false }).provider, 'none'); assert.match(decide({ role: 'builder', mode: 'local', ...OK, localReady: false }).why, /resting/); assert.match(decide({ role: 'builder', mode: 'local', ...OK, localUsable: false, localReady: false }).why, /not switched on/);
  assert.equal(decide({ role: 'builder', mode: 'codex', ...OK }).provider, 'codex', 'codex only never touches local models'); assert.equal(decide({ role: 'builder', mode: 'openrouter', ...OK }).provider, 'openrouter');
});
test('delegation: a role routed to local goes there first with the free models, then Codex, as the way out; otherwise nothing changes', () => {
  const d = decide({ role: 'reviewer', mode: 'mix', routes: { reviewer: 'local' }, ...OK }); assert.deepEqual([d.provider, d.shot, d.escalate, d.chain], ['local', true, true, ['openrouter', 'codex']]); assert.match(d.why, /you set this role to local/);
  assert.deepEqual(decide({ role: 'reviewer', mode: 'mix', routes: { reviewer: 'local' }, ...OK, orReady: false }).chain, ['codex']); assert.deepEqual(decide({ role: 'reviewer', mode: 'mix', routes: { reviewer: 'local' }, ...OK, orReady: false, codexUsable: false }).chain, []);
  const off = decide({ role: 'reviewer', mode: 'mix', routes: { reviewer: 'local' }, ...OK, localUsable: false, localReady: false }); assert.equal(off.provider, 'openrouter', 'local is off: it behaves as auto'); assert.match(off.why, /local models are not available/);
  assert.equal(decide({ role: 'reviewer', mode: 'mix', ...OK }).provider, 'openrouter', 'local is never used unless you route a role to it'); assert.equal(decide({ role: 'planner', mode: 'mix', ...OK }).provider, 'codex'); assert.deepEqual(decide({ role: 'planner', mode: 'mix', ...OK }).chain, []);
});
test('delegation: when Codex is limited and the free models are not available, local models stand in (but never for a role you pinned to Codex)', () => {
  const d = decide({ role: 'builder', mode: 'mix', ...OK, planLimited: true, codexUsable: false, orReady: false }); assert.equal(d.provider, 'local'); assert.match(d.why, /stand in/);
  assert.equal(decide({ role: 'builder', mode: 'mix', ...OK, planLimited: true, codexUsable: false }).provider, 'openrouter', 'the free models come first'); assert.equal(decide({ role: 'builder', mode: 'mix', routes: { builder: 'codex' }, ...OK, planLimited: true, codexUsable: false, orReady: false }).provider, 'none', 'a pin is a pin');
  assert.equal(decide({ role: 'builder', mode: 'mix', ...OK, planLimited: true, codexUsable: false, orReady: false, localReady: false }).provider, 'none');
});

function localEngine({ answers = [], routes = {}, mode = 'mix', codexAgent = { kind: 'shell', command: 'echo codex-did-it' } } = {}) {
  const root = tmp(); const o = fakeOllama({ answers }); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: codexAgent, sandbox: { kind: 'local' }, projects: [], agents: { mode, routes }, local: { enabled: true } }), { configPath: path.join(root, 'c.json'), env: {}, factories: { fetch: o.f } }); return { e, root, o };
}
const SHOT = 'You may read any file in this checkout, but you MUST NOT edit, create or delete files: your job is to judge, not to fix.\nJudge this';
const VERDICT = '{"verdict":"approve","summary":"ok","findings":[]}';
test('engine: a reviewer routed to local runs on the local model as one request, and the usage log says so', async () => {
  const w = localEngine({ routes: { reviewer: 'local' }, answers: [{ content: VERDICT }] }); const dir = tmp();
  const r = await w.e._agentFor('reviewer', path.join(w.root, 'l.log'), { project: 'p' }).run({ kind: 'local', exec: async () => ({ code: 0, out: '' }) }, { dir }, SHOT, { timeoutMs: 30_000, meta: { ref: 'x' } });
  assert.equal(r.out, VERDICT); assert.equal(w.o.chats.length, 1, 'one request'); assert.equal(w.o.chats[0].model, 'llama3.1:8b'); assert.equal(w.o.chats[0].tools, undefined, 'a verdict needs no tools');
  const u = readUsage(w.e.cfg.stateDir).at(-1); assert.deepEqual([u.role, u.model, u.via, u.input, u.output], ['reviewer', 'llama3.1:8b', 'local', 40, 8]); assert.match(u.why, /you set this role to local/);
  const a = buildAccounts({ usage: readUsage(w.e.cfg.stateDir) }); assert.equal(a.byProvider.local.calls, 1); assert.ok(a.totals.localShare > 0);
});
test('engine: when the local model gives no usable verdict the job goes on to the next provider in line, and the log says it was escalated', async () => {
  const w = localEngine({ routes: { reviewer: 'local' }, answers: [{ content: 'it looks fine to me' }], codexAgent: { kind: 'shell', command: `printf '%s' '${VERDICT}'` } }); const dir = tmp();
  const r = await w.e._agentFor('reviewer', path.join(w.root, 'l.log'), { project: 'p' }).run({ kind: 'local', exec: async () => ({ code: 0, out: '' }) }, { dir }, SHOT, { timeoutMs: 30_000, meta: {} });
  const u = readUsage(w.e.cfg.stateDir).at(-1); assert.equal(u.via, 'codex'); assert.equal(u.escalated, true); assert.match(u.why, /Codex took over/); assert.equal(w.o.chats.length, 1);
});
test('engine: if the local server is down, the job does not fail: it is done by the next provider and the model rests', async () => {
  const w = localEngine({ routes: { reviewer: 'local' }, answers: [{ throw: true }], codexAgent: { kind: 'shell', command: `printf '%s' '${VERDICT}'` } }); const dir = tmp();
  const r = await w.e._agentFor('reviewer', path.join(w.root, 'l.log'), { project: 'p' }).run({ kind: 'local', exec: async () => ({ code: 0, out: '' }) }, { dir }, SHOT, { timeoutMs: 30_000, meta: {} });
  assert.equal(readUsage(w.e.cfg.stateDir).at(-1).via, 'codex'); assert.ok(w.e.localStatus().models.find((m) => m.id === 'llama3.1:8b').resting, 'the model that failed rests'); assert.match(w.e.localStatus().models.find((m) => m.id === 'llama3.1:8b').resting.why, /not reachable/);
});
test('engine: local models are off until switched on, settings are validated, and the MCP operations exist', async () => {
  const root = tmp(); const o = fakeOllama(); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell', command: 'x' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { fetch: o.f } });
  assert.equal(e.localStatus().enabled, false); assert.equal(e._localState().usable, false, 'off means off, even with Ollama running');
  assert.throws(() => e.setLocal({ baseUrl: 'ftp://x' }), /address must look like/); assert.throws(() => e.setLocal({ numCtx: 10 }), /context size/); assert.throws(() => e.setLocal({ pinned: { wizard: 'x' } }), /Unknown role/); assert.throws(() => e.setLocal({ enabled: 'yes' }), /true or false/);
  e.setLocal({ enabled: true, maxGb: 6, pinned: { reviewer: 'qwen2.5:3b' } }); const st = await callOp(e, 'local_status', {}); assert.equal(st.enabled, true); assert.equal(st.reachable, true); assert.equal(st.models.find((m) => m.id === 'qwen2.5:3b').pinnedFor[0], 'reviewer'); assert.equal(st.models.find((m) => m.id === 'glm-5.1:cloud').usable, false);
  const t = await callOp(e, 'local_test', { model: 'llama3.1:8b' }); assert.equal(t.ok, true); assert.equal(t.tokensPerSecond, 4); await callOp(e, 'set_agent_policy', { routes: { reviewer: 'local' } }); assert.equal((await callOp(e, 'agent_policy', {})).roles.reviewer.first, 'local');
  assert.equal((await callOp(e, 'set_agent_policy', { mode: 'local' })).mode, 'local'); assert.ok(fs.readFileSync(path.join(root, 'c.json'), 'utf8').includes('"enabled": true'), 'saved to the config');
});
