// Does what the agent says match what it did, and can a role start on an older Codex model and step up when an attempt fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkClaims, claimsFeedback, isTestFile, parseDiff } from '../src/claims.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
import { readUsage } from '../src/usage.mjs';
import { buildImprovements, scoreRuns } from '../src/improve.mjs';

const d = (file, removed = [], added = [], extra = '') => `diff --git a/${file} b/${file}\n${extra}--- a/${file}\n+++ b/${file}\n@@\n${removed.map((l) => `-${l}`).join('\n')}${removed.length ? '\n' : ''}${added.map((l) => `+${l}`).join('\n')}\n`;
test('test files are recognised across common layouts', () => {
  for (const p of ['test/site.test.mjs', 'src/a.test.js', 'tests/x.py', 'pkg/foo_test.go', 'app/test_models.py', '__tests__/a.js', 'spec/a_spec.rb']) assert.ok(isTestFile(p), p); for (const p of ['src/latest.js', 'styles.css', 'docs/contest.md']) assert.ok(!isTestFile(p), p);
  assert.deepEqual(parseDiff(d('a.js', ['x'], ['y'])).map((f) => [f.path, f.removed, f.added]), [['a.js', ['x'], ['y']]]);
});
test('a test switched off is caught, a clean change passes, and removed assertions are left to the quality gate', () => {
  assert.ok(checkClaims({ diff: d('src/a.js', [], ['const x = 1;']), files: ['src/a.js'], summary: 'Changed a value.' }).ok);
  const off = checkClaims({ diff: d('test/a.test.js', [], ["it.skip('totals', () => {})"]), files: ['test/a.test.js'] }); assert.equal(off.ok, false); assert.equal(off.findings[0].kind, 'test-switched-off');
  const weak = checkClaims({ diff: d('test/a.test.js', ['assert.equal(a, 1);', 'assert.equal(b, 2);', 'expect(c).toBe(3);'], ['assert.ok(true);']), files: ['test/a.test.js'] }); assert.ok(weak.ok, 'that is flagged by the quality gate, by policy, not blocked here');
  assert.ok(checkClaims({ diff: d('test/a.test.js', ['assert.equal(a, 1);'], ['assert.equal(a, 2);', 'assert.equal(b, 2);']), files: ['test/a.test.js'] }).ok, 'adding checks is fine');
});
test('"I added tests" with no test file changed is caught; an honest summary is not', () => {
  const lie = checkClaims({ diff: d('src/a.js', [], ['x']), files: ['src/a.js'], summary: 'Added tests for the new footer and updated the page.' }); assert.equal(lie.findings[0].kind, 'claimed-tests-missing');
  assert.ok(checkClaims({ diff: d('src/a.js', [], ['x']), files: ['src/a.js'], summary: 'Updated the page. All tests pass.' }).ok); assert.ok(checkClaims({ diff: d('test/a.test.js', [], ["it('x', () => {})"]), files: ['test/a.test.js', 'src/a.js'], summary: 'Added a test for the footer.' }).ok);
  assert.match(claimsFeedback(lie), /no test file changed/); assert.match(claimsFeedback(lie), /Never switch a test off/);
});

function eng(extra = {}) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-')); return new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell', command: 'echo done', model: 'gpt-6.2-astra' }, sandbox: { kind: 'local' }, projects: [], ...extra }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} }); }
test('model steps: validated, saved, reported, and a retry steps up to the next model', () => {
  const e = eng(); assert.throws(() => e.setAgentPolicy({ tiers: { wizard: ['x'] } }), /Unknown role/); assert.throws(() => e.setAgentPolicy({ tiers: { builder: ['a b'] } }), /up to three/); assert.throws(() => e.setAgentPolicy({ tiers: { builder: ['a', 'b', 'c', 'd'] } }), /up to three/);
  const p = e.setAgentPolicy({ tiers: { builder: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.2-astra'] } }); assert.deepEqual(p.tiers.builder, ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.2-astra']);
  assert.deepEqual([1, 2, 3, 9].map((n) => e._tierModel('builder', n)), ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.2-astra', 'gpt-6.2-astra'], 'each retry steps up, ending on the strongest'); assert.equal(e._tierModel('reviewer', 1), null);
  assert.deepEqual(e.setAgentPolicy({ tiers: { builder: [] } }).tiers, { builder: [] }, 'an empty list means the usual model only'); assert.deepEqual(e.setAgentPolicy({ tiers: { builder: null } }).tiers, {}, 'null goes back to the default'); assert.throws(() => e.setAgentPolicy({ defaultTiers: 'yes' }), /true or false/);
});
test('model steps: the model that did the work is what is recorded, with its step in the reason', async () => {
  const e = eng({ agents: { tiers: { builder: ['gpt-6-luna', 'gpt-6.2-astra'] } } }); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-')); const ctx = { project: 'p' };
  const run = (n) => e._agentFor('builder', path.join(dir, 'l.log'), ctx).run({ kind: 'local', exec: async () => ({ code: 0, out: '' }) }, { dir }, 'Do it', { timeoutMs: 20_000, meta: { run: 'run1', ticket: n } });
  await run(1); await run(1); const u = readUsage(e.cfg.stateDir).filter((x) => x.role === 'builder'); assert.deepEqual(u.map((x) => x.model), ['gpt-6-luna', 'gpt-6.2-astra']); assert.match(u[0].why, /model gpt-6-luna \(step 1 of 2\)/); assert.match(u[1].why, /\(step 2 of 2\)/);
});
test('improvements score jobs by the model that started them, and suggest an older model only when it does as well', () => {
  const NOW = Date.now(); let n = 0; const mk = (model, bad) => ({ id: `m${++n}`, project: 'p', ticket: n, title: 't', started: new Date(NOW - 3600_000).toISOString(), status: 'ok', attempts: 1, review: bad ? { verdict: 'changes', findings: [{ severity: 'major', issue: 'Does not implement the second point' }] } : { verdict: 'approve', findings: [] } });
  const rows = (m, k, bad) => Array.from({ length: k }, () => mk(m, bad)); const usage = (rs, model) => rs.map((r) => ({ run: r.id, role: 'builder', via: null, model, at: new Date().toISOString() }));
  const a = rows('gpt-6.2-astra', 7, false), b = rows('gpt-6-luna', 7, false); const s = scoreRuns([...a, ...b], [...usage(a, 'gpt-6.2-astra'), ...usage(b, 'gpt-6-luna')], { now: NOW }); const out = buildImprovements({ scored: s, policy: { routes: {} }, now: NOW });
  assert.deepEqual(out.byModel.map((m) => [m.model, m.jobs, m.average]), [['gpt-6.2-astra', 7, 100], ['gpt-6-luna', 7, 100]]); const t = out.ideas.find((i) => i.kind === 'tier'); assert.match(t.title, /Start building on gpt-6-luna/); assert.deepEqual(t.change.tiers.builder, ['gpt-6-luna', 'gpt-6.2-astra']);
  const worse = rows('gpt-6-luna', 7, true); const s2 = scoreRuns([...a, ...worse], [...usage(a, 'gpt-6.2-astra'), ...usage(worse, 'gpt-6-luna')], { now: NOW }); assert.equal(buildImprovements({ scored: s2, policy: { routes: {} }, now: NOW }).ideas.filter((i) => i.kind === 'tier').length, 0, 'a cheaper model that scores lower is not suggested');
  assert.equal(buildImprovements({ scored: s, policy: { routes: {}, tiers: { builder: ['gpt-6-luna', 'gpt-6.2-astra'] } }, now: NOW }).ideas.filter((i) => i.kind === 'tier').length, 0, 'already in use');
  const e = eng(); for (const r of [...a, ...b]) { fs.mkdirSync(e.cfg.stateDir, { recursive: true }); fs.appendFileSync(path.join(e.cfg.stateDir, 'runs.jsonl'), JSON.stringify(r) + '\n'); } for (const u of [...usage(a, 'gpt-6.2-astra'), ...usage(b, 'gpt-6-luna')]) fs.appendFileSync(path.join(e.cfg.stateDir, 'usage.jsonl'), JSON.stringify(u) + '\n');
  const idea = e.improvements({}).ideas.find((i) => i.kind === 'tier'); assert.ok(idea); e.applyImprovement(idea.id); assert.deepEqual(e.agentPolicy().tiers.builder, ['gpt-6-luna', 'gpt-6.2-astra']); assert.ok(Array.isArray(e.codexModels()));
  return callOp(e, 'codex_models', {}).then((m) => assert.ok(Array.isArray(m)));
});

import { validateOutput, HARNESS, DEFAULT_TIERS } from '../src/harness.mjs';
import { ROLE_KEYS } from '../src/presets.mjs';
test('every agent has a written harness, and the checks refuse unusable output', () => {
  for (const r of ROLE_KEYS) { assert.ok(HARNESS[r]?.summary && HARNESS[r].checks.length && HARNESS[r].guards.length, `harness for ${r}`); assert.ok(DEFAULT_TIERS[r], `default steps for ${r}`); }
  const V = '{"verdict":"approve","summary":"ok","findings":[]}'; assert.equal(validateOutput('reviewer', V).ok, true); assert.match(validateOutput('reviewer', 'looks fine to me').why, /clear verdict/); assert.match(validateOutput('security', '').why, /empty/);
  assert.match(validateOutput('spec-writer', 'ok').why, /almost nothing/); assert.equal(validateOutput('spec-writer', 'x'.repeat(200)).ok, true); assert.equal(validateOutput('designer', 'anything').ok, true);
});
test('the harness steps a role up when its output fails the check, and records who took over and why', async () => {
  const V = '{"verdict":"approve","summary":"ok","findings":[]}'; const e = eng({ agents: { tiers: { reviewer: ['gpt-6-luna', 'gpt-6.2-astra'] } } }); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
  const sb = { kind: 'local', exec: async (_w, _c, _a, o) => ({ code: 0, out: o.env.AGENT_MODEL === 'gpt-6-luna' ? 'looks fine to me' : V }) };
  const r = await e._agentFor('reviewer', path.join(dir, 'l.log'), { project: 'p' }).run(sb, { dir }, 'Judge this', { timeoutMs: 20_000, meta: {} }); assert.equal(r.out, V); assert.equal(r.model, 'gpt-6.2-astra');
  const u = readUsage(e.cfg.stateDir).at(-1); assert.equal(u.model, 'gpt-6.2-astra'); assert.equal(u.escalated, true); assert.match(u.why, /gpt-6-luna it did not give a clear verdict, so gpt-6.2-astra took over/); assert.match(u.why, /step 2 of 2/);
  assert.ok(fs.readFileSync(path.join(e.cfg.stateDir, 'audit.jsonl'), 'utf8').includes('"what":"harness"'));
  const ok = (m) => ({ kind: 'local', exec: async () => ({ code: 0, out: V }) }); const e2 = eng({ agents: { tiers: { reviewer: ['gpt-6-luna', 'gpt-6.2-astra'] } } }); const r2 = await e2._agentFor('reviewer', path.join(dir, 'l.log'), {}).run(ok(), { dir }, 'Judge', { timeoutMs: 20_000, meta: {} }); assert.equal(r2.model, 'gpt-6-luna', 'a good answer from the cheaper model is kept');
  assert.equal(readUsage(e2.cfg.stateDir).at(-1).escalated, undefined);
});
test('defaults: a role with no steps of its own uses the usual model; the harness shows in the policy; defaults can be switched off', () => {
  const e = eng(); const p = e.agentPolicy(); assert.equal(p.roles.reviewer.harness.checks.length > 0, true); assert.deepEqual(p.roles.reviewer.ladder.models, []); assert.equal(p.defaultTiers, true); assert.equal(e.setAgentPolicy({ defaultTiers: false }).defaultTiers, false);
});

test('defaults: with a Codex login that offers the models, the reviewer and the writers start cheaper and end on the usual model; the strong roles do not; you can override or switch it all off', () => {
  const e = eng({ agent: { kind: 'codexContainer', model: 'gpt-6.2-astra' } }); e.codexModels = () => ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.2-astra'].map((id) => ({ id, name: id }));
  assert.deepEqual(e._ladder('reviewer'), { models: ['gpt-6-luna', 'gpt-6.2-astra'], source: 'default' }); assert.deepEqual(e._ladder('tester').models, ['gpt-6.1-sol', 'gpt-6.2-astra']); assert.deepEqual(e._ladder('planner').models, [], 'the planner stays on the usual model'); assert.deepEqual(e._ladder('security').models, ['gpt-6-luna', 'gpt-6.2-astra']); assert.deepEqual(e._ladder('builder').models, [], 'a builder starts cheaper only on a small ticket'); assert.deepEqual(e._ladder('builder', 'S').models, ['gpt-6-luna', 'gpt-6.2-astra']); assert.deepEqual(e._ladder('builder', 'M').models, []); assert.deepEqual(e._ladder('fixer', 'S').models, []);
  const p = e.agentPolicy(); assert.equal(p.roles.reviewer.ladder.evidence, 'measured'); assert.equal(p.roles.spec_writer?.ladder, undefined);
  e.setAgentPolicy({ tiers: { reviewer: [] } }); assert.deepEqual(e._ladder('reviewer'), { models: [], source: 'none' }, 'your empty list switches it off for that role'); e.setAgentPolicy({ tiers: { reviewer: ['gpt-6.1-sol', 'gpt-6.2-astra'] } }); assert.deepEqual(e._ladder('reviewer').models, ['gpt-6.1-sol', 'gpt-6.2-astra']); e.setAgentPolicy({ tiers: { reviewer: null } }); assert.equal(e._ladder('reviewer').source, 'default');
  e.setAgentPolicy({ defaultTiers: false }); assert.deepEqual(e._ladder('reviewer').models, []); e.setAgentPolicy({ defaultTiers: true }); e.codexModels = () => [{ id: 'gpt-6.2-astra', name: 'x' }]; assert.deepEqual(e._ladder('reviewer').models, [], 'a model the login does not offer is never used');
  const shell = eng(); shell.codexModels = e.codexModels; assert.deepEqual(shell._ladder('reviewer').models, [], 'only for Codex agents');
});

test('a call that failed its check still counts: its tokens are added to the job that stepped up', async () => {
  const V = '{"verdict":"approve","summary":"ok","findings":[]}'; const e = eng({ agents: { tiers: { reviewer: ['gpt-6-luna', 'gpt-6.2-astra'] } } }); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-'));
  const sb = { kind: 'local', exec: async (_w, _c, _a, o) => ({ code: 0, out: o.env.AGENT_MODEL === 'gpt-6-luna' ? 'looks fine' : V, tokens: o.env.AGENT_MODEL === 'gpt-6-luna' ? { input: 1000, output: 10 } : { input: 2000, output: 20 } }) };
  await e._agentFor('reviewer', path.join(dir, 'l.log'), { project: 'p' }).run(sb, { dir }, 'Judge', { timeoutMs: 20_000, meta: {} }); const u = readUsage(e.cfg.stateDir).at(-1); assert.deepEqual([u.input, u.output], [3000, 30], 'both calls are counted'); assert.equal(u.model, 'gpt-6.2-astra');
});

test('after the free models fail, the job enters Codex on the CHEAPEST step (not the strongest), and steps up only if that fails its check', async () => {
  const V = '{"verdict":"approve","summary":"ok","findings":[]}'; const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-')); const keyFetch = async (url, o) => { const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), headers: new Map() }); if (url.endsWith('/models')) return ok({ data: [{ id: 'big/m:free', context_length: 100000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } }] }); if (url.endsWith('/key')) return ok({ data: { is_free_tier: true, usage: 0, limit: 50, limit_remaining: 50 } }); return ok({ model: 'big/m:free', choices: [{ message: { role: 'assistant', content: 'no verdict here' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }); };
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell', command: 'x', model: 'gpt-6.2-astra' }, sandbox: { kind: 'local' }, projects: [], agents: { tiers: { reviewer: ['gpt-6-luna', 'gpt-6.2-astra'] } } }), { configPath: path.join(root, 'c.json'), env: {}, factories: { fetch: keyFetch } }); await e.setOpenRouterKey('sk-or-v1-0123456789abcdef0123456789abcdef');
  const models = []; const sb = { kind: 'local', exec: async (_w, _c, _a, o) => { models.push(o.env.AGENT_MODEL); return { code: 0, out: V }; } }; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-'));
  const r = await e._agentFor('reviewer', path.join(root, 'l.log'), { project: 'p' }).run(sb, { dir }, 'You may read any file in this checkout, but you MUST NOT edit, create or delete files: your job is to judge, not to fix.\nJudge this', { timeoutMs: 20_000, meta: {} });
  assert.deepEqual(models, ['gpt-6-luna'], 'Codex was entered on the cheap step, and it answered properly so it stayed there'); assert.equal(r.model, 'gpt-6-luna'); const u = readUsage(e.cfg.stateDir).at(-1); assert.equal(u.via, 'codex'); assert.equal(u.escalated, true); assert.match(u.why, /model gpt-6-luna \(step 1 of 2\)/);
});
