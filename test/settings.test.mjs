import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.mjs';
import { DEFAULTS, withDefaults, validateConfig } from '../src/config.mjs';
import { createServer, hostsFor } from '../src/server.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';
import { sandbox } from '../src/adapters/sandbox.mjs';
import { agents, codexExecArgs } from '../src/adapters/agents.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';
import { tick } from '../src/factory.mjs';
import { LIMIT_DEFAULTS, LIMIT_FIELDS, EFFORTS, readCodexModels, validateAgentPatch, validateLimitsPatch, parseCodexHeader } from '../src/settings.mjs';

const TOKEN = 'test-token-0123456789-abcdefghij';
const MODELS = { models: [
  { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', description: 'Fast', default_reasoning_level: 'low', visibility: 'list',
    supported_reasoning_levels: [{ effort: 'low', description: 'Light' }, { effort: 'medium', description: 'Balanced' }, { effort: 'high', description: 'Deep' }] },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Cheap', default_reasoning_level: 'medium', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium', description: 'Only this' }] },
  { slug: 'codex-auto-review', display_name: 'Auto review', description: 'internal', visibility: 'hide', supported_reasoning_levels: [] },
  { slug: '-bad', display_name: 'Bad id', supported_reasoning_levels: [] },
] };
const HEADER = 'Reading additional input from stdin...\nOpenAI Codex v0.169.0\n--------\nworkdir: /work\nmodel: gpt-6.2-sol\nprovider: openai\napproval: never\nsandbox: read-only\nreasoning effort: none\nreasoning summaries: none\n--------\nuser\nReply\ncodex\nok\n';

function codexHome({ withModels = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-')); fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
  if (withModels) fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify(MODELS));
  return dir;
}

test('readCodexModels lists the usable models, hides internal and malformed ones, and survives a missing cache', () => {
  const list = readCodexModels(codexHome());
  assert.deepEqual(list.map((m) => m.slug), ['gpt-6.2-sol', 'gpt-6-luna']);
  assert.equal(list[0].name, 'GPT-6.2-Sol'); assert.equal(list[0].defaultEffort, 'low');
  assert.deepEqual(list[0].efforts.map((x) => x.effort), ['low', 'medium', 'high']);
  assert.deepEqual(readCodexModels(codexHome({ withModels: false })), []);
  assert.deepEqual(readCodexModels('/no/such/dir'), []);
});

test('agent patch: valid, clearing, and rejected values', () => {
  const models = readCodexModels(codexHome()); const kind = 'codexContainer';
  assert.deepEqual(validateAgentPatch({ model: 'gpt-6.2-sol', reasoningEffort: 'medium' }, { kind, models }), { value: { model: 'gpt-6.2-sol', reasoningEffort: 'medium' }, errors: [] });
  assert.deepEqual(validateAgentPatch({ model: '', reasoningEffort: null }, { kind, models }).value, { model: null, reasoningEffort: null });
  assert.deepEqual(validateAgentPatch({ model: 'brand-new-model' }, { kind, models }).errors, []);                          // an unlisted (new) model is allowed
  for (const bad of ['-x', '--help', 'a b', 'a;b', '$(id)', 'x'.repeat(65), '../etc']) assert.ok(validateAgentPatch({ model: bad }, { kind, models }).errors.length, `rejects ${bad}`);
  assert.ok(validateAgentPatch({ reasoningEffort: 'extreme' }, { kind, models }).errors[0].includes('reasoningEffort'));
  assert.ok(validateAgentPatch({ model: 42 }, { kind, models }).errors.length);
  assert.match(validateAgentPatch({ model: 'gpt-6-luna', reasoningEffort: 'high' }, { kind, models }).errors[0], /supports reasoning effort medium/);
  assert.match(validateAgentPatch({ reasoningEffort: 'high' }, { kind, models, current: { model: 'gpt-6-luna' } }).errors[0], /supports/);   // effort-only change checks the model already set
  assert.deepEqual(validateAgentPatch({ reasoningEffort: 'high' }, { kind, models, current: { model: null } }).errors, []);
  assert.match(validateAgentPatch({ kind: 'shell' }, { kind, models }).errors[0], /agent\.kind cannot be changed/);
  assert.match(validateAgentPatch({ codexHome: '/x' }, { kind, models }).errors[0], /cannot be changed/);
  assert.ok(validateAgentPatch('nope', { kind }).errors.length);
  assert.match(validateAgentPatch({ model: 'x1' }, { kind: 'shell' }).errors[0], /does not take a model/);
  assert.match(validateAgentPatch({ reasoningEffort: 'low' }, { kind: 'claudeContainer' }).errors[0], /does not take a reasoning effort/);
  assert.deepEqual(validateAgentPatch({ model: 'claude-sonnet-5-5' }, { kind: 'claudeContainer' }).errors, []);
});

test('limits patch enforces ranges, integers and the whitelist', () => {
  assert.deepEqual(validateLimitsPatch({ maxRunsPerDay: 100, maxAttempts: '3', dailyBudgetUsd: '' }), { value: { maxRunsPerDay: 100, maxAttempts: 3, dailyBudgetUsd: null }, errors: [] });
  assert.ok(validateLimitsPatch({ maxRunsPerDay: 0 }).errors[0].includes('between'));
  assert.ok(validateLimitsPatch({ maxRunsPerDay: 1001 }).errors.length);
  assert.ok(validateLimitsPatch({ maxAttempts: 1.5 }).errors[0].includes('whole number'));
  assert.ok(validateLimitsPatch({ maxAttempts: 'many' }).errors[0].includes('number'));
  assert.ok(validateLimitsPatch({ timeoutMs: 10 }).errors.length);
  assert.ok(validateLimitsPatch({ maxRunsPerDay: '' }).errors[0].includes('required'));
  assert.ok(validateLimitsPatch({ dailyBudgetUsd: -1 }).errors.length);
  for (const k of ['maxConcurrent', 'gate', 'qualityRepoGate', 'requireVerify', 'analysis', '__proto__x']) assert.ok(validateLimitsPatch({ [k]: 1 }).errors[0].includes('cannot be changed'), k);
  assert.deepEqual(validateLimitsPatch({}).errors, []);
});

test('the default limits shown in the UI match the real defaults', () => {
  for (const [k, v] of Object.entries(LIMIT_DEFAULTS)) if (k in DEFAULTS.limits) assert.equal(v, DEFAULTS.limits[k], k);
  assert.deepEqual(Object.keys(LIMIT_FIELDS).sort(), ['dailyBudgetUsd', 'maxAttempts', 'maxRunsPerDay', 'parallelProjects', 'timeoutMs']);
});

test('parseCodexHeader reads the model, effort and version a real run prints', () => {
  assert.deepEqual(parseCodexHeader(HEADER), { model: 'gpt-6.2-sol', reasoningEffort: 'none', codexVersion: '0.169.0' });
  assert.deepEqual(parseCodexHeader('garbage'), { model: null, reasoningEffort: null, codexVersion: null });
});

test('codexExecArgs: unchanged without settings, adds -m and effort when set, probe mode, and refuses bad values', () => {
  const base = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  assert.deepEqual(codexExecArgs({ prompt: 'p' }), [...base, 'p']);
  assert.deepEqual(codexExecArgs({ model: 'gpt-6.2-sol', reasoningEffort: 'high', prompt: 'p' }), [...base, '-m', 'gpt-6.2-sol', '-c', 'model_reasoning_effort="high"', 'p']);
  assert.deepEqual(codexExecArgs({ model: 'gpt-6.2-sol', prompt: 'p', probe: true }), ['exec', '--ephemeral', '--skip-git-repo-check', '-m', 'gpt-6.2-sol', 'p']);
  assert.throws(() => codexExecArgs({ model: '--evil', prompt: 'p' }), /not a valid model/);
  assert.throws(() => codexExecArgs({ reasoningEffort: 'x"; rm', prompt: 'p' }), /must be one of/);
  assert.ok(EFFORTS.includes('medium'));
});

test('the codex agent hands the pinned model to the container and exposes it for the run record', async () => {
  const calls = []; const sb = { kind: 'docker', exec: async (ws, cmd, args) => { calls.push({ cmd, args }); return { code: 0, out: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n' }; } };
  const home = codexHome(); const a = agents.codexContainer({ codexHome: home, model: 'gpt-6.2-sol', reasoningEffort: 'medium' });
  assert.deepEqual(a.info, { model: 'gpt-6.2-sol', reasoningEffort: 'medium' });
  await a.run(sb, { dir: '/tmp' }, 'do it', { timeoutMs: 1000 });
  assert.equal(calls[0].cmd, 'codex'); assert.deepEqual(calls[0].args.slice(5, 9), ['-m', 'gpt-6.2-sol', '-c', 'model_reasoning_effort="medium"']); assert.equal(calls[0].args.at(-1), 'do it');
  assert.deepEqual(agents.codexContainer({ codexHome: home }).info, { model: null, reasoningEffort: null });
});

test('config validation rejects a hand-edited bad model or effort', () => {
  const base = withDefaults({ agent: { kind: 'codexContainer', codexHome: '/x' }, projects: [] });
  assert.deepEqual(validateConfig(base), []);
  assert.ok(validateConfig({ ...base, agent: { ...base.agent, model: '--bad' } }).some((m) => m.includes('agent.model')));
  assert.ok(validateConfig({ ...base, agent: { ...base.agent, reasoningEffort: 'turbo' } }).some((m) => m.includes('reasoningEffort')));
  assert.deepEqual(validateConfig({ ...base, agent: { ...base.agent, model: 'gpt-6.2-sol', reasoningEffort: 'low' } }), []);
});

// ---- through the engine and the real HTTP server
async function boot({ kind = 'codexContainer', sandboxFake } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')); const home = codexHome();
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind, codexHome: home }, sandbox: { kind: 'docker' }, projects: [] });
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const configPath = path.join(root, 'agent-factory.json');
  const e = new Engine(cfg, { configPath, factories: sandboxFake ? { sandbox: sandboxFake } : {} });
  e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  const srv = createServer(e, { token: TOKEN, allowedHosts: [] }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; srv.close();
  const s2 = createServer(e, { token: TOKEN, allowedHosts: hostsFor('127.0.0.1', port) }); await new Promise((r) => s2.listen(port, '127.0.0.1', r));
  const call = (p, { method = 'GET', body, token = TOKEN } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: `http://127.0.0.1:${port}` }, body: body ? JSON.stringify(body) : undefined });
  return { call, e, configPath, home, close: () => { s2.closeAllConnections(); s2.close(); } };
}

test('settings API: read, change model/effort/limits, persist to the config file, audit, and refuse bad input', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('/api/settings', { token: null })).status, 401);
    const first = await (await t.call('/api/settings')).json();
    assert.equal(first.agent.model, null); assert.equal(first.agent.kind, 'codexContainer'); assert.equal(first.agent.acceptsEffort, true);
    assert.deepEqual(first.models.map((m) => m.slug), ['gpt-6.2-sol', 'gpt-6-luna']);
    assert.equal(first.limits.maxRunsPerDay, 20); assert.equal(first.limits.parallelProjects, 1); assert.equal(first.limits.dailyBudgetUsd, null);

    const r = await t.call('/api/settings', { method: 'POST', body: { agent: { model: 'gpt-6.2-sol', reasoningEffort: 'medium' }, limits: { maxRunsPerDay: 100 } } });
    assert.equal(r.status, 200); const out = await r.json();
    assert.equal(out.changed, true); assert.equal(out.appliesTo, 'the next run'); assert.equal(out.agent.model, 'gpt-6.2-sol'); assert.equal(out.limits.maxRunsPerDay, 100);
    const onDisk = JSON.parse(fs.readFileSync(t.configPath, 'utf8'));
    assert.equal(onDisk.agent.model, 'gpt-6.2-sol'); assert.equal(onDisk.agent.reasoningEffort, 'medium'); assert.equal(onDisk.limits.maxRunsPerDay, 100); assert.equal(onDisk.agent.kind, 'codexContainer');
    assert.equal((fs.statSync(t.configPath).mode & 0o777), 0o600);
    assert.equal(t.e.deps({ id: 'p', repo: 'a/b', base: 'main', tickets: { kind: 'local' } }).agent.info.model, 'gpt-6.2-sol');    // the next run is built with it
    assert.equal(out.history[0].changes.agent.model.to, 'gpt-6.2-sol'); assert.equal(out.history[0].changes.limits.maxRunsPerDay.from, 20);

    const same = await (await t.call('/api/settings', { method: 'POST', body: { agent: { model: 'gpt-6.2-sol' } } })).json();
    assert.equal(same.changed, false); assert.equal(same.history.length, 1);                                                  // a no-op writes no history

    const cleared = await (await t.call('/api/settings', { method: 'POST', body: { agent: { model: null, reasoningEffort: '' } } })).json();
    assert.equal(cleared.agent.model, null); assert.equal(JSON.parse(fs.readFileSync(t.configPath, 'utf8')).agent.model, undefined);

    for (const body of [{ agent: { model: '--help' } }, { agent: { kind: 'shell' } }, { agent: { model: 'gpt-6-luna', reasoningEffort: 'high' } }, { limits: { maxRunsPerDay: -5 } }, { limits: { gate: 1 } }, { sandbox: {} }, { agent: { codexHome: '/etc' } }, [], 'x'])
      assert.equal((await t.call('/api/settings', { method: 'POST', body })).status, 400, JSON.stringify(body));
    assert.equal(t.e.cfg.agent.kind, 'codexContainer'); assert.equal(t.e.cfg.limits.maxRunsPerDay, 100);                       // nothing slipped through
    assert.equal((await t.call('/api/settings', { method: 'POST', body: { limits: { dailyBudgetUsd: 5 } } })).status, 200);
    assert.equal((await (await t.call('/api/settings', { method: 'POST', body: { limits: { dailyBudgetUsd: '' } } })).json()).limits.dailyBudgetUsd, null);
  } finally { t.close(); }
});

test('settings can be changed over MCP, validated and audited, but the security boundaries are never settings', async () => {
  const { callOp, OPS } = await import('../src/ops.mjs'); assert.ok(OPS.some((o) => o.name === 'set_settings') && OPS.some((o) => o.name === 'get_settings'));
  const t = await boot(); try {
    const r = await callOp(t.e, 'set_settings', { limits: { maxRunsPerDay: 33 }, autoResume: false }); assert.equal(r.limits.maxRunsPerDay, 33); assert.equal(r.autoResume, false); assert.equal(t.e.cfg.limits.maxRunsPerDay, 33);
    assert.equal((await callOp(t.e, 'get_settings', {})).limits.maxRunsPerDay, 33);
    assert.ok(fs.readFileSync(path.join(t.e.cfg.stateDir, 'audit.jsonl'), 'utf8').includes('"what":"settings"'), 'recorded in the audit log');
    for (const bad of [{ sandbox: { kind: 'local' } }, { ui: { host: '0.0.0.0' } }, { projects: [] }, { agent: { kind: 'shell' } }, { limits: { maxRunsPerDay: 99999 } }]) await assert.rejects(() => callOp(t.e, 'set_settings', bad), /cannot be changed|must be|unknown|not an agent/i, `${JSON.stringify(bad)} must be refused`);
  } finally { t.close(); }
});

test('probe asks the container what Codex will use and remembers the answer', async () => {
  const seen = [];
  const t = await boot({ sandboxFake: { kind: 'docker', exec: async (ws, cmd, args, opts) => { seen.push({ cmd, args, opts, dirExists: fs.existsSync(ws.dir) }); return { code: 0, out: HEADER }; } } });
  try {
    const r = await t.call('/api/settings/probe', { method: 'POST', body: {} }); assert.equal(r.status, 200); const out = await r.json();
    assert.deepEqual([out.ok, out.model, out.reasoningEffort, out.codexVersion, out.configuredModel], [true, 'gpt-6.2-sol', 'none', '0.169.0', null]);
    assert.equal(seen[0].cmd, 'codex'); assert.ok(!seen[0].args.includes('--dangerously-bypass-approvals-and-sandbox')); assert.equal(seen[0].args.at(-1), 'Reply with the single word ok and nothing else.');
    assert.equal(seen[0].dirExists, true); assert.ok(seen[0].opts.mounts[0].endsWith(':/home/node/.codex'));
    assert.equal((await (await t.call('/api/settings')).json()).probe.model, 'gpt-6.2-sol');
    await t.call('/api/settings', { method: 'POST', body: { agent: { model: 'gpt-6-luna' } } });
    await t.call('/api/settings/probe', { method: 'POST', body: {} }); assert.ok(seen[1].args.includes('-m') && seen[1].args.includes('gpt-6-luna'));   // the check uses the pending setting
    assert.equal((await t.call('/api/settings/probe', { method: 'POST', body: {}, token: null })).status, 401);
  } finally { t.close(); }
});

test('probe reports a failed check without throwing, and is only for the Codex agent', async () => {
  const t = await boot({ sandboxFake: { kind: 'docker', exec: async () => ({ code: 1, out: 'unauthorized: please log in again' }) } });
  try { const out = await (await t.call('/api/settings/probe', { method: 'POST', body: {} })).json(); assert.equal(out.ok, false); assert.match(out.error, /unauthorized/); } finally { t.close(); }
  const s = await boot({ kind: 'shell' });
  try { assert.equal((await s.call('/api/settings/probe', { method: 'POST', body: {} })).status, 400); const st = await (await s.call('/api/settings')).json(); assert.equal(st.agent.acceptsModel, false); assert.deepEqual(st.models, []); } finally { s.close(); }
});

test('every run records which agent and model it was asked to use', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')); const remote = path.join(root, 'remote.git'); const seed = path.join(root, 'seed');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(root, 'init', '--bare', '-b', 'main', remote); fs.mkdirSync(seed); git(seed, 'init', '-b', 'main'); git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'hi\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'init'); git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
  const tpath = path.join(root, 't.json'); fs.writeFileSync(tpath, JSON.stringify([{ id: 1, title: 'Add greeting', body: 'make b.txt', labels: ['agent-ready'] }]));
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't'; process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
  const inner = agents.shell({ command: 'echo hi > b.txt' }); const agent = { ...inner, name: 'codex-container', info: { model: 'gpt-6.2-sol', reasoningEffort: 'medium' } };
  await tick({ tickets: fileTickets(tpath), sandbox: sandbox({ kind: 'local' }), agent, vcs: gitVcs({ openPr: false }),
    config: { cloneUrl: remote, base: 'main', maxAttempts: 1, timeoutMs: 20000, verify: 'test -f b.txt', gate: false }, stateDir: path.join(root, 'state') });
  const runs = fs.readFileSync(path.join(root, 'state', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(runs.at(-1).agent, { name: 'codex-container', model: 'gpt-6.2-sol', reasoningEffort: 'medium' });
});
