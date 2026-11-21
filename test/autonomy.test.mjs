import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
import { recordRun } from '../src/budget.mjs';
import { mergeVerdict, normalizeAutonomy, fixTicket } from '../src/autonomy.mjs';
import { assessTicket } from '../src/gate.mjs';

const GOOD = { status: 'ok', pr: 'https://github.com/me/a/pull/7', ticket: 3, verifyCmd: 'npm test', quality: { passed: true }, review: { verdict: 'approve' } };
const base = (over = {}) => ({ global: { allow: true }, auto: { mode: 'merge' }, run: GOOD, feedback: { failedChecks: [], pending: false, comments: [] }, ...over });

test('merge verdict: every condition is required and each one says why it blocks', () => {
  assert.deepEqual(mergeVerdict(base()), { ok: true, blockers: [] });
  const why = (over) => mergeVerdict(base(over)).blockers.join(' | ');
  assert.match(why({ global: { allow: false } }), /whole factory/);
  assert.match(why({ auto: { mode: 'off' } }), /not in autonomous mode/);
  assert.match(why({ run: undefined }), /did not open/);
  assert.match(why({ run: { ...GOOD, verifyCmd: undefined } }), /no test command/);
  assert.match(why({ run: { ...GOOD, review: undefined } }), /no reviewer agent/);
  assert.match(why({ run: { ...GOOD, review: { verdict: 'changes' } } }), /asked for changes/);
  assert.match(why({ run: { ...GOOD, quality: { passed: false } } }), /quality gate/);
  assert.match(why({ run: { ...GOOD, coverage: { uncovered: ['backend/a.js'], total: 1 } } }), /does not cover backend\/a\.js/);
  assert.match(why({ feedback: { failedChecks: [{ name: 'ci' }], pending: false, comments: [] } }), /checks failed: ci/);
  assert.match(why({ feedback: { failedChecks: [], pending: true, comments: [] } }), /still running/);
  assert.match(why({ feedback: { failedChecks: [], pending: false, comments: [{ id: 'c1' }] } }), /1 review comment/);
  assert.match(why({ mergedToday: 5 }), /limit of 5/);
  assert.equal(mergeVerdict(base({ feedback: { failedChecks: [], pending: false, comments: [{ id: 'c1' }] }, seenComments: ['c1'] })).ok, true);
  assert.equal(mergeVerdict(base({ auto: { mode: 'merge', requireReviewer: false }, run: { ...GOOD, review: undefined } })).ok, true);
});

test('autonomy settings are validated, and a fix ticket passes the clarity gate', () => {
  assert.throws(() => normalizeAutonomy({ mode: 'yolo' }), /mode/); assert.throws(() => normalizeAutonomy({ nope: 1 }), /not an autonomy setting/); assert.throws(() => normalizeAutonomy({ maxMergesPerDay: 0 }), /maxMergesPerDay/);
  const t = fixTicket({ workflow: 'Deploy', pr: 7, sha: 'abc1234', url: 'https://github.com/me/a/actions/runs/9', headline: 'Add thing' }, { verify: 'npm test' });
  assert.equal(assessTicket(t).ok, true, JSON.stringify(assessTicket(t)));
});

function boot({ prs, feedback, merged = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-')); const closed = []; const comments = [];
  const host = { listAgentPrs: async () => prs, getFeedback: async () => feedback, comment: async () => {}, label: async () => {}, merge: async (pr) => { merged.push(pr.number); return { merged: true }; } };
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [{ id: 'a', repo: 'me/a', base: 'main', config: { verify: 'npm test' }, tickets: { kind: 'file', path: path.join(root, 't.json') } }] });
  const e = new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: { host: () => host, hostAdapter: () => ({ pr: host, cloneUrl: () => 'x', gitEnv: () => ({}), prUrl: (_r, n) => `https://github.com/me/a/pull/${n}` }),
    tickets: () => ({ comment: async (id, t) => comments.push([id, t]), close: async (id) => closed.push(id), listAgentTickets: async () => [], label: async () => {} }) } });
  return { e, closed, comments, root, merged };
}
const addRun = (e, over = {}) => recordRun(e.cfg.stateDir, { project: 'a', ...GOOD, finished: new Date().toISOString(), ...over });

test('autonomous mode cannot be switched on without the factory-wide switch, a reviewer and a test command', async () => {
  const { e } = boot({ prs: [], feedback: {} });
  await assert.rejects(() => callOp(e, 'set_autonomy', { project: 'a', settings: { mode: 'merge' } }), /switched off for the whole factory/);
  await callOp(e, 'set_autonomy_allowed', { allow: true });
  await assert.rejects(() => callOp(e, 'set_autonomy', { project: 'a', settings: { mode: 'merge' } }), /reviewer agent on/);
  await callOp(e, 'set_project_roles', { project: 'a', roles: { reviewer: { enabled: true } } });
  e.project('a').config = {}; await assert.rejects(() => callOp(e, 'set_autonomy', { project: 'a', settings: { mode: 'merge' } }), /test command/);
  e.project('a').config = { verify: 'npm test' };
  assert.equal((await callOp(e, 'set_autonomy', { project: 'a', settings: { mode: 'merge' } })).active, true);
});

test('autopilot merges a PR that meets every condition, comments and closes the ticket, and logs it', async () => {
  const { e, closed, comments, merged } = boot({ prs: [{ number: 7, branch: 'agent/3-x', title: 'Add x' }], feedback: { failedChecks: [], pending: false, comments: [] } });
  await callOp(e, 'set_autonomy_allowed', { allow: true }); await callOp(e, 'set_project_roles', { project: 'a', roles: { reviewer: { enabled: true } } }); await callOp(e, 'set_autonomy', { project: 'a', settings: { mode: 'merge' } });
  addRun(e);
  const r = await callOp(e, 'autopilot_now', {}); assert.deepEqual(r.results.map((x) => x.status), ['merged']);
  assert.deepEqual(merged, [7]); assert.deepEqual(closed, [3]); assert.match(comments[0][1], /merged .* automatically/);
  assert.equal((await callOp(e, 'autonomy_status', { project: 'a' })).recent[0].pr, 7);
  assert.ok(fs.readFileSync(path.join(e.cfg.stateDir, 'audit.jsonl'), 'utf8').includes('"what":"merge"'));
});

test('autopilot holds a PR whose CI is red and says why; the kill switch stops everything at once', async () => {
  const { e, merged } = boot({ prs: [{ number: 7, branch: 'agent/3-x', title: 'Add x' }], feedback: { failedChecks: [{ name: 'ci', log: '' }], pending: false, comments: [] } });
  await callOp(e, 'set_autonomy_allowed', { allow: true }); await callOp(e, 'set_project_roles', { project: 'a', roles: { reviewer: { enabled: true } } }); await callOp(e, 'set_autonomy', { project: 'a', settings: { mode: 'merge' } });
  addRun(e);
  assert.equal((await callOp(e, 'autopilot_now', {})).results[0].status, 'held'); assert.deepEqual(merged, []);
  assert.match((await callOp(e, 'autonomy_status', { project: 'a' })).held[0].blockers[0], /checks failed: ci/);
  e.setAutonomyAllowed({ allow: false }); assert.deepEqual((await callOp(e, 'autopilot_now', {})).results, []);
});

test('the daily merge limit holds the next PR', async () => {
  const { e, merged } = boot({ prs: [{ number: 7, title: 'a' }, { number: 8, title: 'b' }], feedback: { failedChecks: [], pending: false, comments: [] } });
  await callOp(e, 'set_autonomy_allowed', { allow: true }); await callOp(e, 'set_project_roles', { project: 'a', roles: { reviewer: { enabled: true } } }); await callOp(e, 'set_autonomy', { project: 'a', settings: { mode: 'merge', maxMergesPerDay: 1 } });
  addRun(e); addRun(e, { pr: 'https://github.com/me/a/pull/8', ticket: 4 });
  const r = (await callOp(e, 'autopilot_now', {})).results.map((x) => x.status); assert.deepEqual(r, ['merged', 'held']); assert.deepEqual(merged, [7]);
});

test('a broken pipeline after a merge becomes ONE fix ticket per failing run, capped per workflow, and resets when green', async () => {
  const { e } = boot({ prs: [], feedback: {} }); const made = [];
  await callOp(e, 'set_autonomy_allowed', { allow: true }); await callOp(e, 'set_project_roles', { project: 'a', roles: { reviewer: { enabled: true } } }); await callOp(e, 'set_autonomy', { project: 'a', settings: { mode: 'merge', fixAttemptsPerWorkflow: 2 } });
  e.createTicket = async (_id, t) => { made.push(t.title); return { id: made.length }; };
  let failing = [{ project: 'a', workflow: 'Deploy', runId: 1, pr: 7, sha: 'abc', url: 'https://github.com/me/a/actions/runs/1', headline: 'x' }]; e.deployFailures = async () => failing;
  await e.autopilotFixes(); await e.autopilotFixes(); assert.equal(made.length, 1, 'same failing run: one ticket');
  failing = [{ ...failing[0], runId: 2 }]; await e.autopilotFixes(); failing = [{ ...failing[0], runId: 3 }]; await e.autopilotFixes(); assert.equal(made.length, 2, 'capped at 2 attempts');
  failing = []; await e.autopilotFixes(); failing = [{ project: 'a', workflow: 'Deploy', runId: 4 }]; await e.autopilotFixes(); assert.equal(made.length, 3, 'green again resets the count');
});

test('the factory-wide merge cap applies across projects', async () => {
  const { e, merged } = boot({ prs: [{ number: 7, title: 'a' }, { number: 8, title: 'b' }], feedback: { failedChecks: [], pending: false, comments: [] } });
  await callOp(e, 'set_autonomy_allowed', { allow: true, maxMergesPerDay: 1 }); await callOp(e, 'set_project_roles', { project: 'a', roles: { reviewer: { enabled: true } } }); await callOp(e, 'set_autonomy', { project: 'a', settings: { mode: 'merge', maxMergesPerDay: 5 } });
  addRun(e); addRun(e, { pr: 'https://github.com/me/a/pull/8', ticket: 4 });
  assert.deepEqual((await callOp(e, 'autopilot_now', {})).results.map((x) => x.status), ['merged', 'held']); assert.deepEqual(merged, [7]);
});
