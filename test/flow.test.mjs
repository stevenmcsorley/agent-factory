import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;   // the real loop commits: CI has no git identity
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cycles, flowMetrics, ENOUGH } from '../src/flow.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { tick } from '../src/factory.mjs';
import { execFileSync } from 'node:child_process';

const T0 = Date.parse('2026-11-10T09:00:00Z'); const at = (min) => new Date(T0 + min * 60_000).toISOString(); const ev = (min, event, ticket = '1', project = 'p') => ({ at: at(min), project, ticket, event });
const NOW = T0 + 10 * 86_400_000;

test('a ticket\'s cycle: queue wait, build time, review wait, ready-to-merged, and decision wait are measured from the right events', () => {
  const [c] = cycles([ev(0, 'ready'), ev(10, 'claimed'), ev(25, 'pr-opened'), ev(205, 'closed')]); assert.deepEqual([c.closedAt - c.readyAt, c.claimedAt - c.readyAt, c.prAt - c.claimedAt, c.closedAt - c.prAt, c.decisionMs], [205 * 60_000, 10 * 60_000, 15 * 60_000, 180 * 60_000, 0]);
  const [d] = cycles([ev(0, 'ready'), ev(5, 'claimed'), ev(6, 'parked'), ev(66, 'ready'), ev(70, 'claimed'), ev(80, 'pr-opened'), ev(100, 'closed')]); assert.equal(d.decisionMs, 60 * 60_000, 'parked at 6, ready again at 66'); assert.equal(d.claims, 2); assert.equal(d.readyAt, T0, 'the cycle starts at the FIRST ready, not the requeue');
  assert.deepEqual(cycles([ev(0, 'ready'), ev(5, 'claimed')]), [], 'an open ticket is not a completed cycle'); assert.equal(cycles([ev(0, 'ready'), ev(5, 'claimed'), ev(20, 'pr-opened'), ev(30, 'closed'), ev(40, 'ready'), ev(45, 'claimed'), ev(60, 'pr-opened'), ev(90, 'closed')]).length, 2, 'a reopened ticket is a second cycle');
  assert.deepEqual(cycles([{ at: 'garbage', event: 'ready' }, ev(5, 'claimed'), ev(9, 'closed')]).length, 1, 'a bad timestamp is skipped, not fatal'); assert.deepEqual(cycles([ev(30, 'closed')]), [], 'closed with nothing before it was not ours');
});

test('flowMetrics over several tickets: medians, p90, rates and cost per accepted change, hand-checked', () => {
  const events = []; const spans = [[0, 5, 15, 75], [0, 10, 30, 150], [0, 2, 10, 70], [0, 3, 20, 380], [0, 4, 14, 44]];   // ready, claimed, pr, closed (minutes) for tickets 1..5
  spans.forEach(([r, c, p, d], i) => events.push(ev(r + i * 1000, 'ready', String(i + 1)), ev(c + i * 1000, 'claimed', String(i + 1)), ev(p + i * 1000, 'pr-opened', String(i + 1)), ev(d + i * 1000, 'closed', String(i + 1))));
  const run = (ticket, attempts, costUsd, extra = {}) => ({ project: 'p', ticket, status: 'ok', attempts, costUsd, finished: at(9000), started: at(8999), ...extra });
  const runs = [run('1', 1, 0.5, { verifyCmd: 'npm test', commit: 'a' }), run('2', 2, 1.5, { verifyCmd: 'npm test', commit: 'b' }), run('3', 1, 0.5, { commit: 'c' }), run('4', 1, 1, { verifyCmd: 'npm test', commit: 'd' }), run('5', 1, 0.5, { verifyCmd: 'npm test', commit: 'e' }), { project: 'p', ticket: '2', status: 'ok', round: 1, finished: at(9000), costUsd: 99 }];
  const m = flowMetrics({ runs, events, now: NOW, days: 30 }); assert.equal(m.accepted, 5);
  assert.deepEqual([m.readyToMergedMs.median, m.readyToMergedMs.p90], [75 * 60_000, 380 * 60_000]); assert.equal(m.readyToMergedMs.n, 5); assert.equal(m.queueWaitMs.median, 4 * 60_000); assert.equal(m.buildMs.median, 10 * 60_000, '10,20,10,17,10 -> median 10'); assert.equal(m.reviewWaitMs.median, 60 * 60_000, '60,120,60,360,30 -> median 60');
  assert.deepEqual(m.firstPassRate, { n: 5, value: 0.8 }); assert.deepEqual(m.verifiedShare, { n: 5, value: 0.8 }, 'ticket 3 had a commit but no verify command: unverified'); assert.deepEqual(m.perAccepted, { n: 5, costUsd: 0.8, attempts: 1.2 }, 'feedback rounds are not counted as extra attempts or cost per ticket (their cost is in the 99, excluded here)');
  assert.equal(m.feedbackRounds, 1); assert.equal(m.enough, true); assert.equal(m.note, null); assert.equal(m.reworkRate.value, 0);
});

test('rework counts tickets that needed a second claim or failed once; decision wait counts only time parked; project filter and window apply', () => {
  const events = [ev(0, 'ready', 'a'), ev(1, 'claimed', 'a'), ev(2, 'failed', 'a'), ev(3, 'ready', 'a'), ev(4, 'claimed', 'a'), ev(10, 'pr-opened', 'a'), ev(20, 'closed', 'a'),
    ev(0, 'ready', 'b'), ev(1, 'claimed', 'b'), ev(5, 'pr-opened', 'b'), ev(15, 'closed', 'b'), ev(0, 'ready', 'x', 'other'), ev(1, 'claimed', 'x', 'other'), ev(2, 'parked', 'x', 'other'), ev(302, 'ready', 'x', 'other'), ev(303, 'claimed', 'x', 'other'), ev(310, 'pr-opened', 'x', 'other'), ev(320, 'closed', 'x', 'other')];
  const all = flowMetrics({ events, now: NOW }); assert.equal(all.accepted, 3); assert.deepEqual(all.reworkRate, { n: 3, value: 0.333 }); assert.deepEqual(all.decisionWaitMs, { n: 1, median: 300 * 60_000, p90: 300 * 60_000 });
  const p = flowMetrics({ events, now: NOW, project: 'p' }); assert.equal(p.accepted, 2); assert.equal(p.project, 'p'); assert.equal(p.decisionWaitMs.n, 0); assert.equal(p.decisionWaitMs.median, null);
  assert.equal(flowMetrics({ events, now: NOW + 40 * 86_400_000, days: 30 }).accepted, 0, 'everything closed more than 30 days ago is outside the window');
});

test('small samples say so; empty data is not an error; runs from before provenance cannot claim a verified share', () => {
  const none = flowMetrics({ now: NOW }); assert.equal(none.accepted, 0); assert.equal(none.readyToMergedMs.median, null); assert.equal(none.firstPassRate.value, null); assert.equal(none.perAccepted.costUsd, null); assert.match(none.note, /Only 0 accepted changes/); assert.equal(none.since, null);
  const one = flowMetrics({ events: [ev(0, 'ready'), ev(2, 'claimed'), ev(9, 'pr-opened'), ev(20, 'closed')], now: NOW }); assert.match(one.note, new RegExp(`Only 1 accepted change so far.*${ENOUGH}`)); assert.equal(one.enough, false); assert.equal(one.since, at(0));
  const old = flowMetrics({ runs: [{ project: 'p', ticket: '1', status: 'ok', attempts: 1, finished: at(100) }], now: NOW }); assert.equal(old.verifiedShare.value, null, 'no provenance fields: unknown, not 0%'); assert.equal(old.firstPassRate.value, 1);
});

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
const world = async () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} }); await e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } }); return { e, root }; };

test('engine events: written once per state change (not every poll), survive a restart, and a followed ticket that closes is recorded as closed', async () => {
  const { e } = await world(); assert.equal(e.recordEvent('app', 1, 'ready'), true); assert.equal(e.recordEvent('app', 1, 'ready'), false, 'a ticket waiting in the queue is ready once'); assert.equal(e.recordEvent('app', 1, 'claimed'), true); assert.equal(e.lifecycleEvents().length, 2);
  e._observeClosed('app', [{ id: 1, state: 'CLOSED' }, { id: 2, state: 'CLOSED' }, { id: 3, state: 'OPEN' }]); assert.deepEqual(e.lifecycleEvents().map((x) => `${x.ticket}:${x.event}`), ['1:ready', '1:claimed', '1:closed'], 'ticket 2 was never followed, so its close is not ours to count');
  e._observeClosed('app', [{ id: 1, state: 'CLOSED' }]); assert.equal(e.lifecycleEvents().length, 3, 'observed once'); e._evIdx = null; assert.equal(e.recordEvent('app', 1, 'closed'), false, 'the index is rebuilt from the file after a restart');
  fs.appendFileSync(path.join(e.cfg.stateDir, 'events.jsonl'), 'not json\n'); assert.equal(e.lifecycleEvents().length, 3, 'a corrupt line is skipped');
});

test('the real loop writes the lifecycle: ready, claimed, pr-opened; parked and failed on the way; and the metrics come out of it', async () => {
  const { e, root } = await world(); const p = e.cfg.projects[0]; const make = async (title, body) => (await e.createTicket('app', { title, body })).id;
  const good = await make('Add the thing to a.js', 'Add the thing in a.js that returns one, with a test that checks it works'); const d = e.deps(p); d.config.verify = false;
  d.sandbox = { create: async ({ cloneUrl, branch, base }) => { const dir = fs.mkdtempSync(path.join(root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); git(dir, 'checkout', '-qb', branch); return { dir, cloneUrl, destroy() {} }; }, exec: async () => ({ code: 0, out: '' }) };
  d.agent = { run: async (_sb, ws) => { fs.writeFileSync(path.join(ws.dir, 'a.js'), 'export const a = 1;\n'); return { out: 'done', costUsd: 0.25 }; } }; const [r] = await tick(d); assert.equal(r.status, 'ok');
  const seq = e.lifecycleEvents().filter((x) => x.ticket === String(good)).map((x) => x.event); assert.deepEqual(seq, ['ready', 'claimed', 'pr-opened']);
  await e.ticketAction('app', good, 'close', {}); await e.listTickets('app'); e._cache?.clear?.(); await e.listTickets('app'); assert.equal(e.lifecycleEvents().at(-1).event, 'closed'); const m = e.flow({ days: 30, project: 'app' }); assert.equal(m.accepted, 1); assert.ok(m.readyToMergedMs.median >= 0); assert.equal(m.perAccepted.costUsd, 0.25); assert.equal(m.firstPassRate.value, 1); assert.match(m.note, /Only 1 accepted change/);
  const vague = await make('Improve', ''); const [g] = await tick(e.deps(p)); void g; assert.ok(e.lifecycleEvents().some((x) => x.ticket === String(vague) && x.event === 'parked'), 'a ticket the gate parks is recorded as parked');
});
