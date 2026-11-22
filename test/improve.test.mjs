// The improvement loop: how a job is scored, how problems are grouped into fixes, how a fix is applied, and how its effect is measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFinding, scoreRun, scoreRuns, buildImprovements, TAGS } from '../src/improve.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { recordRun } from '../src/budget.mjs';
import { recordUsage } from '../src/usage.mjs';
import { callOp } from '../src/ops.mjs';
import * as sk from '../src/skills.mjs';

const NOW = Date.parse('2026-11-22T12:00:00Z'); const ago = (d) => new Date(NOW - d * 86_400_000).toISOString();
let n = 0; const run = (o = {}) => ({ id: `r${++n}`, project: 'shop', ticket: n, title: `Ticket ${n}`, started: ago(1), status: 'ok', attempts: 1, tokens: { input: 100_000, output: 800, cached: 80_000 }, review: { verdict: 'approve', findings: [] }, quality: { passed: true, blockers: [] }, visual: { status: 'pass' }, ...o });
const changes = (...issues) => ({ review: { verdict: 'changes', summary: 'needs work', findings: issues.map((issue) => ({ severity: 'major', issue })) } });

test('findings are sorted into plain problems; minor chatter is not a problem', () => {
  assert.equal(classifyFinding({ issue: 'Removing the responsive rules breaks the Home page, outside the ticket\'s scope', severity: 'major' }), 'finding-scope');
  assert.equal(classifyFinding({ issue: 'The new image has no alt text', severity: 'minor' }), 'finding-a11y'); assert.equal(classifyFinding({ issue: 'It deletes a failing test instead of fixing it', severity: 'major' }), 'finding-tests');
  assert.equal(classifyFinding({ issue: 'The form posts the secret in the URL', severity: 'major' }), 'finding-security'); assert.equal(classifyFinding({ issue: 'Does not implement the second point of the ticket', severity: 'major' }), 'finding-requirement');
  assert.equal(classifyFinding({ issue: 'Off by one when the list is empty', severity: 'major' }), 'finding-bug'); assert.equal(classifyFinding({ issue: 'Consider a nicer variable name', severity: 'minor' }), null);
});
test('a job is scored from what was recorded: clean is 100, each problem costs, and a job stopped by a limit is not scored at all', () => {
  assert.deepEqual([scoreRun(run()).score, scoreRun(run()).outcome, scoreRun(run()).tags], [100, 'ok', []]);
  const r = scoreRun(run({ attempts: 3, ...changes('Changes shared styles outside the ticket scope', 'No test for the new behaviour') })); assert.deepEqual(r.tags.map((t) => t.id).sort(), ['finding-scope', 'finding-tests', 'retry', 'review-changes'].sort()); assert.equal(r.score, 100 - 20 - 12 - 5 - 5);
  const v = scoreRun(run({ status: 'verify-failed', verifyTail: 'not ok 3 - totals' })); assert.deepEqual([v.outcome, v.score], ['failed', 70]); assert.match(v.tags[0].detail, /not ok 3/);
  assert.deepEqual(scoreRun(run({ status: 'rate-limited' })), { score: null, outcome: 'stopped', tags: [] }); assert.equal(scoreRun(run({ status: 'error' })).outcome, 'stopped', 'a factory error is not the agent\'s fault');
  assert.equal(scoreRun(run({ visual: { status: 'fail', summary: 'header overlaps' } })).score, 85); assert.equal(scoreRun(run({ quality: { passed: false, blockers: ['secret in code'] } })).score, 80); assert.ok(TAGS.retry.label && TAGS['fix-round'].label);
  assert.equal(scoreRun(run({ tokens: { input: 1_000_000, output: 1000 } }), { medianWeighted: 50_000 }).tags[0].id, 'expensive');
});
test('a retry is explained by what came right before it: failed tests, the reviewer, or the screenshots; only failed tests lead to the "run the checks" fix', () => {
  const ph = (...names) => names.map((name) => ({ name })); const a = scoreRun(run({ attempts: 2, phases: ph('claim', 'agent', 'verify', 'agent', 'verify', 'review', 'push') })); assert.deepEqual(a.tags.map((t) => t.id), ['retry', 'retry-verify']); assert.match(a.tags[0].detail, /2 attempts: its tests failed/);
  const b = scoreRun(run({ attempts: 2, phases: ph('agent', 'verify', 'review', 'agent', 'verify', 'review') })); assert.deepEqual(b.tags.map((t) => t.id), ['retry']); assert.match(b.tags[0].detail, /the reviewer asked for changes/);
  assert.deepEqual(scoreRun(run({ attempts: 2, phases: ph('sandbox', 'review', 'agent', 'verify') })).tags.map((t) => t.detail), ['2 attempts'], 'a fix round that starts with a review is not a retry cause');
  const rs = Array.from({ length: 5 }, () => run({ attempts: 2, phases: ph('agent', 'verify', 'review', 'agent') })); assert.equal(buildImprovements({ scored: scoreRuns(rs.concat(many(5)), [], { now: NOW }), now: NOW }).ideas.length, 0, 'reviewer-driven retries get no "run the checks" advice');
  const rv = Array.from({ length: 5 }, () => run({ attempts: 2, phases: ph('agent', 'verify', 'agent', 'verify') })); assert.equal(buildImprovements({ scored: scoreRuns(rv.concat(many(5)), [], { now: NOW }), now: NOW }).ideas[0].change.skill.name, 'run-the-checks-first');
});
test('scoring a window: fix runs are not scored but mark their job, the provider comes from the usage log, old jobs are left out', () => {
  const a = run({ id: 'a', project: 'shop', ticket: 1 }); const fix = run({ id: 'a2', project: 'shop', ticket: 1, fixRound: 1, prNumber: 9 }); const b = run({ id: 'b', ticket: 2 }); const old = run({ id: 'old', started: ago(40) });
  const usage = [{ run: 'b', role: 'builder', via: 'openrouter' }, { run: 'b', role: 'reviewer', via: 'local' }, { run: 'a', role: 'builder', via: null }]; const s = scoreRuns([a, fix, b, old], usage, { now: NOW, days: 14 });
  assert.deepEqual(s.map((x) => x.id).sort(), ['a', 'b']); assert.deepEqual(s.find((x) => x.id === 'a').tags.map((t) => t.id), ['fix-round']); assert.equal(s.find((x) => x.id === 'b').provider, 'openrouter'); assert.equal(s.find((x) => x.id === 'a').provider, 'codex');
});

const many = (k, o = () => ({}), base = {}) => Array.from({ length: k }, (_, i) => run({ ...base, ...o(i) }));
test('suggestions: only for a problem seen often enough, never too early, and never for a fix that already exists', () => {
  const rs = [...many(4, () => changes('Also changes the header outside the ticket scope')), ...many(6)]; const out = buildImprovements({ scored: scoreRuns(rs, [], { now: NOW }), now: NOW });
  assert.equal(out.health.jobs, 10); assert.equal(out.problems[0].tag, 'review-changes'); const i = out.ideas.find((x) => x.tag === 'finding-scope'); assert.ok(i); assert.equal(i.kind, 'skill'); assert.equal(i.status, 'new'); assert.match(i.why, /seen in 4 of 10 jobs \(40%\)/); assert.equal(i.change.skill.name, 'stay-in-scope'); assert.ok(i.examples[0].run);
  assert.equal(buildImprovements({ scored: scoreRuns(rs.slice(0, 4), [], { now: NOW }), now: NOW }).ideas.length, 0, 'under five jobs there is not enough to say anything'); assert.equal(buildImprovements({ scored: scoreRuns(rs, [], { now: NOW }), skillNames: ['stay-in-scope'], now: NOW }).ideas.length, 0, 'it already exists');
  assert.equal(buildImprovements({ scored: scoreRuns([...many(2, () => changes('outside the ticket scope')), ...many(8)], [], { now: NOW }), now: NOW }).ideas.length, 0, 'two in ten is noise');
});
test('suggestions about who builds: only with enough jobs on both sides, and only when the gap is real', () => {
  const mk = (via, k, bad) => many(k, (i) => ({ id: `${via}${i}`, ...(bad ? changes('Does not implement the second point') : {}) })); const usage = (via, k) => Array.from({ length: k }, (_, i) => ({ run: `${via}${i}`, role: 'builder', via }));
  const rs = [...mk('codex', 7, false), ...mk('local', 7, true)]; const u = [...usage('codex', 7), ...usage('local', 7)]; const out = buildImprovements({ scored: scoreRuns(rs, u, { now: NOW }), policy: { routes: {} }, now: NOW });
  assert.equal(out.byProvider.codex.average, 100); assert.equal(out.byProvider.local.average, 83); const r = out.ideas.find((x) => x.kind === 'route'); assert.match(r.title, /Stop giving building jobs to the local models/); assert.deepEqual(r.change.routes, { builder: 'codex', fixer: 'codex' });
  assert.equal(buildImprovements({ scored: scoreRuns(rs, u, { now: NOW }), policy: { routes: { builder: 'codex' } }, now: NOW }).ideas.filter((x) => x.kind === 'route').length, 0, 'already pinned to Codex');
  const eq = buildImprovements({ scored: scoreRuns([...mk('codex', 7, false), ...mk('openrouter', 7, false)], [...usage('codex', 7), ...usage('openrouter', 7)], { now: NOW }), policy: { routes: { builder: 'codex' } }, now: NOW }); assert.match(eq.ideas.find((x) => x.kind === 'route').title, /Let the free models build too/);
  assert.equal(buildImprovements({ scored: scoreRuns([...mk('codex', 7, false), ...mk('local', 3, true)], [...usage('codex', 7), ...usage('local', 3)], { now: NOW }), policy: { routes: {} }, now: NOW }).ideas.filter((x) => x.kind === 'route').length, 0, 'three jobs prove nothing');
});
test('the effect of an applied fix is measured on the jobs after it, and a fix whose problem vanished stays visible', () => {
  const before = many(5, (i) => ({ started: ago(6 - i * 0.1), ...changes('outside the ticket scope') })); const after = many(6, (i) => ({ started: ago(2 - i * 0.1) })); const scored = scoreRuns([...before, ...after], [], { now: NOW });
  const first = buildImprovements({ scored, now: NOW }); const id = first.ideas.find((x) => x.tag === 'finding-scope').id;
  const out = buildImprovements({ scored, decisions: { [id]: { status: 'applied', at: ago(3), kind: 'skill', tag: 'finding-scope', title: 'Keep changes to what the ticket asks for', why: 'w', change: { skill: {} }, baseline: { count: 5, share: 0.5 } } }, now: NOW }); const i = out.ideas.find((x) => x.id === id);
  assert.deepEqual([i.status, i.effect.enough, i.effect.before, i.effect.after, i.effect.runsAfter], ['applied', true, 0.5, 0, 6]);
  const gone = buildImprovements({ scored: scoreRuns(many(8), [], { now: NOW }), decisions: { [id]: { status: 'applied', at: ago(3), kind: 'skill', tag: 'finding-scope', title: 'Keep changes to what the ticket asks for', change: { skill: {} }, baseline: { count: 5, share: 0.5 } } }, now: NOW }); assert.equal(gone.ideas[0].status, 'applied'); assert.equal(gone.ideas[0].effect.after, 0);
  assert.equal(buildImprovements({ scored: scoreRuns(many(8), [], { now: NOW }), decisions: { [id]: { status: 'applied', at: ago(0.1), kind: 'skill', tag: 'finding-scope', title: 't', change: {}, baseline: { count: 5, share: 0.5 } } }, now: NOW }).ideas[0].effect.enough, false, 'too few jobs since to say');
});

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell', command: 'x' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} });
  const rs = [...many(4, (i) => ({ started: ago(2), ...changes('Also changes the header outside the ticket scope') })), ...many(6, () => ({ started: ago(1) }))]; for (const r of rs) recordRun(e.cfg.stateDir, r); return { e, root };
}
test('engine: a suggestion is applied as a real skill (with your wording if you edit it), saved, logged, and cannot be applied twice', async () => {
  const { e } = world(); const cur = e.improvements({ days: 14 }); assert.equal(cur.enough, true); const idea = cur.ideas.find((x) => x.tag === 'finding-scope'); assert.ok(idea);
  const done = e.applyImprovement(idea.id, { text: 'Only change what the ticket names. Nothing else.' }); assert.equal(done.status, 'applied'); const s = sk.getSkill(e.cfg.stateDir, 'stay-in-scope'); assert.match(s.body, /Only change what the ticket names/); assert.match(String(s.roles), /builder/);
  assert.throws(() => e.applyImprovement(idea.id), /already applied/); assert.throws(() => e.applyImprovement('zzzzzzzzzz'), /not a suggestion id/); assert.throws(() => e.applyImprovement('0123456789'), /no longer there/);
  assert.ok(fs.readFileSync(path.join(e.cfg.stateDir, 'audit.jsonl'), 'utf8').includes('"what":"improvement"')); assert.equal(new Engine(e.cfg, { configPath: path.join(path.dirname(e.cfg.stateDir), 'c.json'), env: {}, factories: {} }).improvements({}).ideas.find((x) => x.id === idea.id).status, 'applied', 'the decision survives a restart');
});
test('engine: dismissing hides a suggestion until you reopen it; a route suggestion changes who builds; MCP can do all of it', async () => {
  const { e } = world(); const id = e.improvements({}).ideas[0].id; await callOp(e, 'improvement_dismiss', { id, note: 'not now' }); assert.equal(e.improvements({}).ideas.find((x) => x.id === id).status, 'dismissed'); await callOp(e, 'improvement_reopen', { id }); assert.equal(e.improvements({}).ideas.find((x) => x.id === id).status, 'new'); assert.throws(() => e.reopenImprovement(id), /Only a dismissed/);
  const sc = await callOp(e, 'run_scores', { days: 14 }); assert.equal(sc.length, 10); assert.ok(sc.find((x) => x.tags.length).tags[0].label); const out = await callOp(e, 'improvements', {}); assert.equal(out.health.jobs, 10);
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'imp2-')); const e2 = new Engine(withDefaults({ stateDir: path.join(root2, 's'), agent: { kind: 'shell', command: 'x' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root2, 'c.json'), env: {}, factories: {} });
  for (let i = 0; i < 7; i++) { recordRun(e2.cfg.stateDir, run({ id: `c${i}`, started: ago(2) })); recordUsage(e2.cfg.stateDir, { run: `c${i}`, role: 'builder', via: null, input: 1, output: 1 }); recordRun(e2.cfg.stateDir, run({ id: `l${i}`, started: ago(2), ...changes('Does not implement the second point') })); recordUsage(e2.cfg.stateDir, { run: `l${i}`, role: 'builder', via: 'local', input: 1, output: 1 }); }
  const r = e2.improvements({}).ideas.find((x) => x.kind === 'route'); assert.ok(r); e2.applyImprovement(r.id); assert.equal(e2.agentPolicy().roles.builder.route, 'codex'); assert.equal(e2.agentPolicy().roles.fixer.route, 'codex');
});

import { harnessVerdict, costByModel } from '../src/harness.mjs';
test('the harness verdict is honest: too early, holding up, not cheaper, or revert, from scores and tokens', () => {
  const sc = (a, b) => [{ model: 'astra', jobs: 20, average: a }, { model: 'luna', jobs: 8, average: b }]; const cost = (cu, cl) => [{ model: 'astra', medianTokens: cu, costJobs: 20 }, { model: 'luna', medianTokens: cl, costJobs: 8 }];
  assert.equal(harnessVerdict({ models: [{ model: 'astra', jobs: 20, average: 90 }, { model: 'luna', jobs: 2, average: 100 }], cost: [], usual: 'astra' }).state, 'early'); assert.match(harnessVerdict({ models: [], cost: [], usual: 'astra' }).text, /No cheaper model/);
  assert.equal(harnessVerdict({ models: sc(90, 89), cost: cost(40_000, 30_000), usual: 'astra' }).state, 'holding'); assert.match(harnessVerdict({ models: sc(90, 89), cost: cost(40_000, 30_000), usual: 'astra' }).text, /25% fewer tokens/);
  const mixed = harnessVerdict({ models: sc(90, 90), cost: cost(40_000, 57_000), usual: 'astra' }); assert.equal(mixed.state, 'mixed'); assert.match(mixed.text, /43% more tokens/); assert.match(mixed.text, /plan usage/);
  const bad = harnessVerdict({ models: sc(92, 80), cost: cost(40_000, 30_000), usual: 'astra' }); assert.equal(bad.state, 'revert'); assert.match(bad.text, /usual model/);
  assert.deepEqual(costByModel([{ role: 'builder', model: 'm', input: 1000, cached: 0, output: 10, at: 'x' }, { role: 'builder', via: 'openrouter', model: 'f', input: 1, output: 1, at: 'x' }, { role: 'reviewer', model: 'm', input: 9, output: 9, at: 'x' }]).map((c) => [c.model, c.costJobs, c.medianTokens]), [['m', 1, 1060]], 'only Codex builds count');
});
test('engine: the harness report brings it together and is available over MCP', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell', model: 'gpt-6.2-astra' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} });
  const now = Date.now(); recordRun(e.cfg.stateDir, { id: 'a1', project: 'p', ticket: 1, title: 't', started: new Date(now - 3600_000).toISOString(), status: 'ok', attempts: 1, claims: { ok: false, findings: [{ kind: 'test-switched-off', blocking: true, detail: 'a test was switched off' }] }, review: { verdict: 'approve', findings: [] } });
  e._audit({ what: 'harness', action: 'step-up', role: 'reviewer', from: 'gpt-6-luna', to: 'gpt-6.2-astra', why: 'it did not give a clear verdict', project: 'p' }); recordUsage(e.cfg.stateDir, { run: 'a1', role: 'builder', via: null, model: 'gpt-6.2-astra', input: 1000, output: 10, at: new Date(now).toISOString() });
  const r = await callOp(e, 'harness_report', { days: 7 }); assert.equal(r.claims.caught, 1); assert.match(r.claims.recent[0].findings[0], /switched off/); assert.equal(r.stepUps.count, 1); assert.equal(r.stepUps.byRole.reviewer, 1); assert.equal(r.verdict.state, 'early'); assert.ok(r.since && r.models.length >= 0);
});

test('a minor note is not counted as a problem with how the job was done (security and accessibility notes still are)', () => {
  const rec = (sev, issue) => run({ review: { verdict: 'approve', findings: [{ severity: sev, issue }] } });
  assert.deepEqual(scoreRun(rec('minor', 'Test file missing newline at end of file')).tags, [], 'a formatting nit is not weak tests'); assert.deepEqual(scoreRun(rec('minor', 'Changes shared styles outside the ticket scope')).tags, []);
  assert.deepEqual(scoreRun(rec('major', 'Test file would still pass if the heading were removed')).tags.map((t) => t.id), ['finding-tests']); assert.deepEqual(scoreRun(rec('minor', 'The new image has no alt text')).tags.map((t) => t.id), ['finding-a11y'], 'accessibility counts at any size');
  assert.deepEqual(scoreRun(rec('minor', 'The key is hard-coded: a secret in the source')).tags.map((t) => t.id), ['finding-security']);
});
