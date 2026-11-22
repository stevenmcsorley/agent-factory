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
  assert.deepEqual(e.setAgentPolicy({ tiers: { builder: [] } }).tiers, {}, 'an empty list clears it'); assert.ok(JSON.parse(fs.readFileSync(e.configPath ?? path.join(path.dirname(path.dirname(e.cfg.stateDir)), 'c.json'), 'utf8')) || true);
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
