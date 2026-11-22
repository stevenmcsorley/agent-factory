import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { split, weighted, recordUsage, readUsage, summarize, WEIGHTS } from '../src/usage.mjs';
import { parseCodexJsonl, parseClaudeJson } from '../src/adapters/agents.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
import { recordRun } from '../src/budget.mjs';

test('fresh, cached and output: input INCLUDES the cached part, unless a source reports more cached than input', () => {
  assert.deepEqual(split({ input: 1000, cached: 900, output: 10 }), { fresh: 100, cached: 900, output: 10 });
  assert.deepEqual(split({ input: 100, cached: 900, output: 5 }), { fresh: 100, cached: 900, output: 5 }, 'counted separately: nothing is subtracted');
  assert.deepEqual(split({}), { fresh: 0, cached: 0, output: 0 }); assert.deepEqual(split({ input: -5, cached: 'x' }), { fresh: 0, cached: 0, output: 0 });
  assert.equal(weighted({ fresh: 100, cached: 900, output: 10 }), Math.round(100 + 900 * WEIGHTS.cached + 10 * WEIGHTS.output));
});

test('the agent adapters read cached tokens: Codex turn.completed, and Claude (cache reads are folded into input)', () => {
  const c = parseCodexJsonl({ out: [JSON.stringify({ type: 'thread.started' }), JSON.stringify({ type: 'item.completed', item: { text: 'done' } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4200, output_tokens: 80, reasoning_output_tokens: 20 } })].join('\n') });
  assert.deepEqual(c.tokens, { input: 5000, output: 80, cached: 4200, reasoning: 20, steps: 0 }); assert.equal(c.out, 'done');
  const k = parseClaudeJson({ out: JSON.stringify({ result: 'ok', total_cost_usd: 0.1, usage: { input_tokens: 10, cache_read_input_tokens: 700, cache_creation_input_tokens: 90, output_tokens: 30 } }) });
  assert.deepEqual(k.tokens, { input: 800, cached: 700, output: 30 });
});

test('summary: by role, project and day, cached share, costliest runs, and older runs counted as builder-only estimates', () => {
  const now = Date.parse('2026-11-22T10:00:00Z'); const e = (o) => ({ at: '2026-11-22T09:00:00.000Z', project: 'a', input: 0, cached: 0, output: 0, ms: 1000, ...o });
  const entries = [e({ role: 'builder', run: 'r1', ticket: 1, input: 500_000, cached: 450_000, output: 3000 }), e({ role: 'reviewer', run: 'r1', ticket: 1, input: 60_000, cached: 40_000, output: 800 }), e({ role: 'tester', run: 'r1', input: 90_000, cached: 70_000, output: 1500 }), e({ role: 'designer', project: 'b', ref: 'design x', input: 20_000, cached: 0, output: 9000 }), e({ at: '2026-10-01T00:00:00Z', role: 'builder', input: 9e9 })];
  const legacy = [{ id: 'old1', project: 'a', ticket: 9, finished: '2026-11-20T10:00:00Z', tokens: { input: 300_000, output: 2000 } }, { id: 'r1', project: 'a', finished: '2026-11-22T09:30:00Z', tokens: { input: 1, output: 1 } }];
  const s = summarize({ entries, runs: legacy, days: 14, now });
  assert.equal(s.totals.calls, 5, 'the old entry is outside the window; r1 is in the log so its legacy copy is not double counted'); assert.equal(s.legacyRuns, 1);
  assert.deepEqual(s.byRole.map((r) => r.role).sort(), ['builder', 'designer', 'reviewer', 'tester']); const b = s.byRole.find((r) => r.role === 'builder'); assert.equal(b.calls, 2); assert.equal(b.cached, 450_000);
  assert.ok(s.totals.cachedShare > 0.5 && s.totals.cachedShare < 1); assert.equal(s.topRuns[0].run, 'old1', 'an older run has no cached split, so it counts as all fresh: an over-estimate, and it is flagged'); assert.equal(s.topRuns.find((r) => r.run === 'r1').calls, 3);
  assert.equal(s.byProject.length, 2); assert.equal(s.byDay.at(-1).day, '2026-11-22'); assert.ok(Math.abs(s.byRole.reduce((a, r) => a + r.share, 0) - 1) < 1e-9);
  assert.equal(summarize({ entries, runs: legacy, days: 14, project: 'b', now }).totals.calls, 1, 'filtered to a project');
});

test('every agent call, whatever the role, is logged with its project and run; the usage report and the run record show it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-'));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } }] });
  const e = new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: { agent: { name: 'fake', run: async () => ({ out: 'ok', code: 0, tokens: { input: 1000, cached: 800, output: 50 } }) } } });
  await e._agentFor('reviewer', undefined, { project: 'a' }).run({}, {}, 'p', { meta: { run: 'abc12345', ticket: 4 } }); await e._agentFor('builder', undefined, { project: 'a' }).run({}, {}, 'p', { meta: { run: 'abc12345', ticket: 4 } }); await e._agentFor('designer', undefined, { project: 'a' }).run({}, {}, 'p', { meta: { ref: 'design zz' } });
  const rows = readUsage(cfg.stateDir); assert.equal(rows.length, 3); assert.deepEqual(rows.map((r) => r.role), ['reviewer', 'builder', 'designer']); assert.equal(rows[0].run, 'abc12345'); assert.equal(rows[2].ref, 'design zz'); assert.equal(rows[0].cached, 800);
  const rep = await callOp(e, 'usage_report', { days: 7 }); assert.equal(rep.totals.calls, 3); assert.equal(rep.totals.fresh, 600); assert.equal(rep.totals.cached, 2400);
  recordRun(cfg.stateDir, { id: 'abc12345', project: 'a', ticket: 4, status: 'ok', finished: new Date().toISOString() }); const run = e.getRun('abc12345'); assert.deepEqual(run.usage.map((u) => u.role).sort(), ['builder', 'reviewer']); assert.equal(run.usage[0].cached, 800);
});

test('steps: commands, edits and searches are counted (messages and reasoning are not), so context per step can be worked out', () => {
  const ev = (type, item) => JSON.stringify({ type, item });
  const out = [ev('item.completed', { type: 'reasoning', text: 'hm' }), ev('item.completed', { type: 'command_execution', command: 'ls' }), ev('item.completed', { type: 'file_change', changes: [] }), ev('item.completed', { type: 'command_execution', command: 'npm test' }), ev('item.completed', { type: 'agent_message', text: 'done' }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 300000, cached_input_tokens: 270000, output_tokens: 900 } })].join('\n');
  const r = parseCodexJsonl({ out }); assert.equal(r.tokens.steps, 3); assert.equal(r.out, 'done');
  const s = summarize({ entries: [{ at: new Date().toISOString(), role: 'builder', project: 'a', input: 300000, cached: 270000, output: 900, steps: 3 }], days: 7 }); assert.equal(s.totals.avgStepsPerCall, 3); assert.equal(s.totals.avgInputPerStep, 100000);
});
