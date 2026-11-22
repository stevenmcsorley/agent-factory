import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryAtMs } from '../src/agentlimit.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { recordRun } from '../src/budget.mjs';
import { callOp } from '../src/ops.mjs';

const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
test('reading when the limit lifts: a clock time means the next time it comes round, a full date is taken as written, and nonsense is null', () => {
  const now = at(2026, 11, 21, 22, 5); const min = 60_000;
  assert.equal(retryAtMs('10:26 PM', now), at(2026, 11, 21, 22, 26) + 2 * min); assert.equal(retryAtMs('4:12 AM', now), at(2026, 11, 22, 4, 12) + 2 * min, 'already past today, so tomorrow');
  assert.equal(retryAtMs('Nov 22nd, 2026 3:28 AM', now), at(2026, 11, 22, 3, 28) + 2 * min); assert.equal(retryAtMs('Dec 1st, 2026 12:05 PM', now), at(2026, 12, 1, 12, 5) + 2 * min); assert.equal(retryAtMs('12:30 AM', at(2026, 11, 21, 23, 0)), at(2026, 11, 22, 0, 30) + 2 * min);
  assert.equal(retryAtMs('in 45 minutes', now), now + 45 * min + 2 * min); assert.equal(retryAtMs('in 2 hours', now), now + 120 * min + 2 * min); assert.equal(retryAtMs('soon', now), null); assert.equal(retryAtMs(null, now), null);
});

function boot(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')); const tp = path.join(root, 't.json'); fs.writeFileSync(tp, JSON.stringify([{ id: 1, title: 'Failed by the limit', body: 'x', labels: ['agent-failed'] }, { id: 2, title: 'Failed for real', body: 'x', labels: ['agent-failed'] }, { id: 3, title: 'Waiting', body: 'make it do the thing properly', labels: ['agent-ready'] }]));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, ...over, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: tp } }, { id: 'b', repo: 'me/b', base: 'main', tickets: { kind: 'file', path: tp } }] });
  return { e: new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: {} }), tp };
}

test('the first sign of the limit, from any agent, pauses every project until it lifts, and says why', async () => {
  const { e } = boot(); assert.equal(e.planLimit(), null); assert.equal(e._dueProjects().length, 2);
  e._noteLimit({ message: 'You have hit your usage limit', retryAt: '3:28 AM' }, at(2026, 11, 21, 22, 0));
  const l = e.planLimit(); assert.ok(l, 'recorded'); assert.equal(l.autoResume, true); assert.deepEqual(e._dueProjects(), []); assert.equal((await callOp(e, 'why_waiting', { project: 'a' })).reasons.find((r) => r.code === 'plan-limit').code, 'plan-limit');
  assert.match(e.status().limit.message, /usage limit/); assert.throws(() => e.startDesign('a', { title: 'x', request: 'a design that cannot start now' }), /usage limit is reached/); assert.throws(() => e.startPlanning('a'), /usage limit is reached/);
  assert.equal((await callOp(e, 'agent_plan_status', {})).autoResume, true);
});

test('it survives a restart: the limit is read back from disk, and from the last rate-limited run if nothing was saved', () => {
  const { e } = boot(); const soon = Date.now() + 3_600_000; e._limit = { until: soon, message: 'hit', at: new Date().toISOString() }; e._saveLimit();
  const again = new Engine(e.cfg, { configPath: e.configPath, factories: {} }); assert.equal(again.planLimit().until, soon);
  const { e: e2 } = boot(); const t = new Date(Date.now() - 60_000); const future = new Date(Date.now() + 2 * 3_600_000); const hh = future.getHours() % 12 || 12; const clock = `${hh}:${String(future.getMinutes()).padStart(2, '0')} ${future.getHours() >= 12 ? 'PM' : 'AM'}`;
  recordRun(e2.cfg.stateDir, { project: 'a', ticket: 1, status: 'rate-limited', error: 'You have hit your usage limit', retryAt: clock, finished: t.toISOString() });
  const l = new Engine(e2.cfg, { configPath: e2.configPath, factories: {} }).planLimit(); assert.ok(l?.derived, 'derived from the run record'); assert.ok(l.until > Date.now());
});

test('when it lifts, work resumes by itself and ONLY tickets the limit failed are put back; with auto-resume off nothing is requeued', async () => {
  for (const auto of [true, false]) {
    const { e, tp } = boot({ autoResume: auto }); recordRun(e.cfg.stateDir, { project: 'a', ticket: 1, status: 'rate-limited', finished: new Date().toISOString() }); recordRun(e.cfg.stateDir, { project: 'a', ticket: 2, status: 'verify-failed', finished: new Date().toISOString() });
    e._limit = { until: Date.now() - 1000, message: 'hit', at: new Date().toISOString() };   // the time has passed
    assert.equal(e.planLimit(), null, 'expired'); assert.equal(e._dueProjects().length, 2, 'agents are due again'); await new Promise((r) => setTimeout(r, 150));
    const labels = Object.fromEntries(JSON.parse(fs.readFileSync(tp, 'utf8')).map((t) => [t.id, t.labels]));
    if (auto) { assert.ok(labels[1].includes('agent-ready') && !labels[1].includes('agent-failed'), 'the limit-failed ticket is back in the queue'); assert.ok(labels[2].includes('agent-failed'), 'a real failure is left for a human'); } else assert.ok(labels[1].includes('agent-failed'), 'auto-resume off: left alone');
  }
});

test('Resume anyway clears the pause now; the switch is stored', async () => {
  const { e } = boot(); e._noteLimit({ message: 'hit', retryAt: null }); assert.ok(e.planLimit(), 'no readable time: a short fallback pause'); assert.ok(e.planLimit().until - Date.now() <= 31 * 60_000);
  assert.deepEqual(e.clearPlanLimit(), { cleared: true }); assert.equal(e.planLimit(), null); assert.deepEqual(e.clearPlanLimit(), { cleared: false });
  e.setSettings({ autoResume: false }); assert.equal(e.autoResume(), false); assert.equal(e.cfg.autoResume, false); assert.throws(() => e.setSettings({ autoResume: 'yes' }), /true or false/);
});

test('any role reporting the limit (here the reviewer) pauses every agent', async () => {
  const { e } = boot(); e.f.agent = { name: 'fake', run: async () => ({ out: "You've hit your usage limit. Try again at 3:28 AM.", code: 0 }) };
  assert.equal(e.planLimit(), null); await e._agentFor('reviewer').run({}, {}, 'prompt', {}); assert.ok(e.planLimit(), 'the limit is now recorded'); assert.deepEqual(e._dueProjects(), []);
  const ok = boot().e; ok.f.agent = { name: 'fake', run: async () => ({ out: 'all good', code: 0 }) }; await ok._agentFor('builder').run({}, {}, 'p', {}); assert.equal(ok.planLimit(), null, 'ordinary output does not trip it');
});
