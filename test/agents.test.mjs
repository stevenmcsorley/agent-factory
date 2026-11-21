import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { startRun } from '../src/trace.mjs';
import * as ds from '../src/designs.mjs';

function boot(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'codexContainer', codexHome: path.join(root, 'cx'), model: 'm-1', reasoningEffort: 'low' }, sandbox: { kind: 'local' }, ...extra, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } }] });
  return new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: {} });
}

test('a run in flight shows the agent working inside it: builder, tester, then the reviewer and the security reviewer, with plumbing hidden', () => {
  const e = boot({ roles: { security: { agent: { reasoningEffort: 'high' } } } }); const run = startRun({ ticket: 7, title: 'Add negate' }, { onEvent: (ev) => e._event(ev), project: 'a' });
  assert.deepEqual(e.agentsNow(), [], 'queued: no agent yet');
  run.phase('sandbox', 'cloning'); assert.deepEqual(e.agentsNow(), [], 'cloning is the factory\'s own plumbing');
  run.phase('agent', 'attempt 1'); let [a] = e.agentsNow(); assert.equal(a.role, 'builder'); assert.equal(a.project, 'a'); assert.equal(a.ticket, 7); assert.equal(a.detail, 'attempt 1'); assert.equal(a.model, 'm-1'); assert.equal(a.effort, 'low'); assert.equal(a.kind, 'agent');
  run.phase('verify', 'npm test'); [a] = e.agentsNow(); assert.equal(a.role, 'verify'); assert.equal(a.kind, 'check'); assert.equal(a.model, null, 'a check has no model');
  run.phase('tests', 'adds tests'); assert.equal(e.agentsNow()[0].role, 'tester');
  run.phase('review', 'a second agent reads the change'); assert.equal(e.agentsNow()[0].role, 'reviewer');
  run.role('security', 'checking for security problems'); [a] = e.agentsNow(); assert.equal(a.role, 'security'); assert.equal(a.effort, 'high', 'a role\'s own model and effort are shown'); assert.equal(a.what, 'checking for security problems');
  run.phase('push', 'branch'); assert.deepEqual(e.agentsNow(), [], 'a new phase clears the announced role');
  run.finish('ok'); assert.deepEqual(e.agentsNow(), []);
});

test('feedback rounds are the fixer, and a spec-writer announcement can be cleared', () => {
  const e = boot(); const run = startRun({ pr: 5, title: 'Feedback round 1 on #5: Add x', round: 1 }, { onEvent: (ev) => e._event(ev), project: 'a' });
  run.phase('agent', 'attempt 1'); assert.equal(e.agentsNow()[0].role, 'fixer'); run.finish('ok');
  const r2 = startRun({ ticket: 8, title: 'Vague' }, { onEvent: (ev) => e._event(ev), project: 'a' }); r2.role('spec-writer', 'drafting acceptance criteria'); assert.equal(e.agentsNow()[0].role, 'spec-writer'); r2.role(null); assert.deepEqual(e.agentsNow(), []);
});

test('background jobs that are not runs show up too: the designer, the planner, the skill writer and the visual check', () => {
  const e = boot(); const dir = e._designDir('a'); const d = ds.createDesign(dir, { title: 'Brand set', kind: 'assets', request: 'A logo and some icons for the app' });
  e.designJobs = new Map([[`a:${d.id}`, { startedAt: Date.now() - 5000 }]]); e.planJobs = new Map([['a', { state: 'running', phase: 'the agent is reading your brief', startedAt: Date.now() - 4000 }]]);
  e.skillJobs = new Map([['x', { state: 'running', name: 'safe-migrations', startedAt: Date.now() - 3000 }], ['y', { state: 'done', startedAt: 1 }]]); e.visualJobs = new Map([['a', { state: 'running', phase: 'starting the app', startedAt: Date.now() - 2000 }]]);
  const by = Object.fromEntries(e.agentsNow().map((x) => [x.role, x])); assert.deepEqual(Object.keys(by).sort(), ['designer', 'planner', 'skill-writer', 'visual']);
  assert.equal(by.designer.title, 'Brand set'); assert.equal(by.designer.what, 'drawing the artwork'); assert.equal(by.designer.project, 'a'); assert.equal(by.planner.what, 'the agent is reading your brief'); assert.equal(by['skill-writer'].title, 'safe-migrations'); assert.equal(by.visual.kind, 'check');
  assert.ok(Date.parse(by.designer.since) < Date.now(), 'since is a real timestamp the screen can count from');
});

test('the roster lists a role only when some project uses it, in pipeline order', () => {
  const e = boot(); let r = e.agentRoster(); assert.deepEqual(r.filter((x) => x.enabled).map((x) => x.role), ['builder', 'verify', 'designer', 'planner', 'fixer']);
  e.project('a').roles = { reviewer: { enabled: true }, tester: { enabled: true } }; e.project('a').preview = { command: 'x', port: 4000, routes: ['/'] };
  r = e.agentRoster(); assert.deepEqual(r.filter((x) => x.enabled).map((x) => x.role), ['builder', 'verify', 'tester', 'visual', 'reviewer', 'designer', 'planner', 'fixer']); assert.equal(r.find((x) => x.role === 'builder').model, 'm-1');
  assert.equal(r.find((x) => x.role === 'verify').kind, 'check');
});
