import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedule, scheduleState, usedToday } from '../src/schedule.mjs';

const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();   // local time, the way the schedule reads it

test('no schedule means always allowed; bad input is refused with a reason', () => {
  assert.equal(scheduleState(null).allowed, true);
  assert.equal(normalizeSchedule(null), null);
  assert.throws(() => normalizeSchedule({ hoursPerDay: 30 }), /hoursPerDay/);
  assert.throws(() => normalizeSchedule({ windows: [{ from: '25:00', to: '06:00' }] }), /HH:MM/);
  assert.throws(() => normalizeSchedule({ windows: [{ from: '10:00', to: '10:00' }] }), /same time/);
  assert.throws(() => normalizeSchedule({ priority: 12 }), /priority/);
  assert.throws(() => normalizeSchedule({ startAt: 'soon' }), /startAt/);
});

test('startAt holds a project back until then, a bare date meaning local midnight', () => {
  const s = normalizeSchedule({ startAt: '2026-12-01' });
  const before = scheduleState(s, at(2026, 11, 30, 23, 59)); assert.equal(before.allowed, false); assert.equal(before.code, 'not-started');
  assert.equal(scheduleState(s, at(2026, 12, 1, 0, 1)).allowed, true);
});

test('a window that crosses midnight covers both sides of it, and belongs to the day it started on', () => {
  const s = normalizeSchedule({ windows: [{ days: [5], from: '22:00', to: '06:00' }] });   // Fridays 22:00 to Saturday 06:00
  assert.equal(scheduleState(s, at(2026, 11, 27, 23, 0)).allowed, true);    // Friday night
  assert.equal(scheduleState(s, at(2026, 11, 28, 3, 0)).allowed, true);     // Saturday small hours
  assert.equal(scheduleState(s, at(2026, 11, 28, 23, 0)).allowed, false);   // Saturday night is not Friday
  assert.equal(scheduleState(s, at(2026, 11, 27, 12, 0)).allowed, false);
  assert.ok(scheduleState(s, at(2026, 11, 27, 12, 0)).nextAt, 'says when the next window opens');
});

test('hours per day counts finished run time since local midnight and stops at the budget', () => {
  const now = at(2026, 11, 21, 15, 0);
  const runs = [
    { project: 'a', started: new Date(at(2026, 11, 21, 9, 0)).toISOString(), finished: new Date(at(2026, 11, 21, 12, 0)).toISOString() },   // 3 h
    { project: 'a', started: new Date(at(2026, 11, 20, 22, 0)).toISOString(), finished: new Date(at(2026, 11, 21, 1, 0)).toISOString() },   // 1 h counts after midnight
    { project: 'b', started: new Date(at(2026, 11, 21, 9, 0)).toISOString(), finished: new Date(at(2026, 11, 21, 14, 0)).toISOString() },
    { project: 'a', started: new Date(at(2026, 11, 19, 9, 0)).toISOString(), finished: new Date(at(2026, 11, 19, 14, 0)).toISOString() },   // yesterday
  ];
  assert.equal(usedToday(runs, 'a', now), 4 * 3_600_000);
  const s = normalizeSchedule({ hoursPerDay: 4 });
  assert.equal(scheduleState(s, now, usedToday(runs, 'a', now)).code, 'hours-used');
  assert.equal(scheduleState(normalizeSchedule({ hoursPerDay: 5 }), now, usedToday(runs, 'a', now)).allowed, true);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';

function boot(projects) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-'));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: projects.map((p) => ({ repo: `me/${p.id}`, base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') }, ...p })) });
  return new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: {} });
}

test('engine: unpaused projects inside their schedule are due, in priority order; held ones say why', async () => {
  const e = boot([{ id: 'late' }, { id: 'urgent' }, { id: 'future' }, { id: 'off', paused: true }]);
  await callOp(e, 'set_schedule', { project: 'late', schedule: { priority: 8 } });
  await callOp(e, 'set_schedule', { project: 'urgent', schedule: { priority: 1 } });
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const w = await callOp(e, 'set_schedule', { project: 'future', schedule: { startAt: soon } });
  assert.equal(w.waiting, true); assert.equal(w.reasons[0].code, 'not-started');
  assert.deepEqual(e._dueProjects().map((p) => p.id), ['urgent', 'late']);
  assert.equal((await callOp(e, 'why_waiting', { project: 'off' })).reasons[0].code, 'project-paused');
  const cleared = await callOp(e, 'set_schedule', { project: 'future', schedule: null }); assert.equal(cleared.waiting, false);
  await assert.rejects(() => callOp(e, 'set_schedule', { project: 'late', schedule: { hoursPerDay: 99 } }), /hoursPerDay/);
});

test('engine: the daily cap shows up as a reason on every project', async () => {
  const e = boot([{ id: 'a' }]); e.cfg.limits.maxRunsPerDay = 0;
  const w = await callOp(e, 'why_waiting', { project: 'a' }); assert.ok(w.reasons.some((r) => r.code === 'daily-cap'));
});
