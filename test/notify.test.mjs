import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeNotify, makeNotifier, payload } from '../src/notify.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';

test('notification address: https only (or this machine), no credentials, known events', () => {
  assert.equal(normalizeNotify(null), null);
  assert.equal(normalizeNotify({ url: 'https://ntfy.sh/my-topic' }).events.length, 9);
  assert.equal(normalizeNotify({ url: 'http://127.0.0.1:9000/x', events: ['merged'] }).events[0], 'merged');
  assert.throws(() => normalizeNotify({ url: 'http://example.com/x' }), /https/); assert.throws(() => normalizeNotify({ url: 'https://u:p@example.com/x' }), /credentials/);
  assert.throws(() => normalizeNotify({ url: 'nonsense' }), /web address/); assert.throws(() => normalizeNotify({ url: 'https://x.test/', events: ['boom'] }), /Unknown event/); assert.throws(() => normalizeNotify({ url: 'https://x.test/', nope: 1 }), /not a notify setting/);
});

test('notifier: sends subscribed events as JSON, skips the rest, drops duplicates and floods, and never throws', async () => {
  const sent = []; let fail = false; const f = async (url, o) => { if (fail) throw new Error('down'); sent.push({ url, body: JSON.parse(o.body), headers: o.headers }); return { ok: true, status: 200 }; };
  let t = 1_000_000; const cfg = { url: 'https://x.test/h', events: ['pr-ready', 'failed'], enabled: true }; const n = makeNotifier(() => cfg, { fetchImpl: f, now: () => t });
  assert.equal((await n({ event: 'pr-ready', project: 'a', title: 'Add x', url: 'https://github.com/o/r/pull/1' })).sent, true);
  assert.equal(sent[0].body.text, '[a] Add x https://github.com/o/r/pull/1'); assert.equal(sent[0].body.event, 'pr-ready'); assert.equal(sent[0].headers.Title, 'Add x');
  assert.equal((await n({ event: 'merged', project: 'a', title: 'y' })).why, 'not subscribed');
  assert.equal((await n({ event: 'pr-ready', project: 'a', title: 'Add x' })).why, 'duplicate'); t += 61_000; assert.equal((await n({ event: 'pr-ready', project: 'a', title: 'Add x' })).sent, true);
  for (let i = 0; i < 40; i++) await n({ event: 'failed', project: 'a', title: `t${i}` }); assert.ok(sent.length <= 31, 'at most 30 a minute');
  fail = true; t += 120_000; assert.deepEqual(await n({ event: 'failed', project: 'a', title: 'later' }), { sent: false, why: 'down' });
  cfg.enabled = false; assert.equal((await n({ event: 'failed', title: 'z' })).why, 'not subscribed');
  assert.match(payload({ event: 'failed', title: 'T' }).text, /^T$/);
});

function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-')); const tp = path.join(root, 't.json'); fs.writeFileSync(tp, JSON.stringify([{ id: 1, title: 'Add thing', body: 'x', labels: ['agent-ready'] }, { id: 2, title: 'Other', body: 'y', labels: ['agent-review'] }]));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: tp } }] });
  return new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: {} });
}

test('engine: lifecycle events notify once per transition, and the daily cap once per day', async () => {
  const e = boot(); const got = []; await callOp(e, 'set_notifications', { notify: { url: 'https://x.test/h' } });
  const real = globalThis.fetch; globalThis.fetch = async (_u, o) => { got.push(JSON.parse(o.body)); return { ok: true, status: 200 }; };
  try {
    const cfg = e.deps(e.project('a')).config;
    cfg.recordEvent({ ticket: 1, title: 'Add thing', event: 'pr-opened', url: 'https://github.com/me/a/pull/5' }); cfg.recordEvent({ ticket: 1, title: 'Add thing', event: 'pr-opened', url: 'https://github.com/me/a/pull/5' });
    cfg.recordEvent({ ticket: 3, title: 'Broken', event: 'failed' }); cfg.recordEvent({ ticket: 4, title: 'Claim', event: 'claimed' });
    await new Promise((r) => setTimeout(r, 30)); assert.deepEqual(got.map((x) => x.event), ['pr-ready', 'failed']); assert.equal(got[0].url, 'https://github.com/me/a/pull/5');
    e.cfg.limits.maxRunsPerDay = 0; await e.notifyScan(); await e.notifyScan(); await new Promise((r) => setTimeout(r, 30)); assert.equal(got.filter((x) => x.event === 'cap-reached').length, 1);
    e.deployFailures = async () => [{ project: 'a', workflow: 'Deploy', runId: 7, pr: 5, url: 'https://github.com/me/a/actions/runs/7' }]; await e.notifyScan(); await e.notifyScan(); await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.filter((x) => x.event === 'deploy-failing').length, 1); assert.match(got.at(-1).title, /Deploy is failing after a merge/);
    const t = await callOp(e, 'test_notification', {}); assert.equal(t.sent, true);
  } finally { globalThis.fetch = real; }
  await callOp(e, 'set_notifications', { notify: null }); assert.equal((await callOp(e, 'get_notifications', {})).notify, null);
});

test('engine: a ready ticket says why it is waiting; held ones say what they wait for; tickets in other states say nothing', async () => {
  const e = boot(); const tickets = await e.listTickets('a');
  assert.equal(tickets.find((t) => t.id === 1).waiting, undefined, 'nothing holds it');
  e.project('a').paused = true; e.cache.clear(); let l = await e.listTickets('a'); assert.match(l.find((t) => t.id === 1).waiting, /paused/); assert.equal(l.find((t) => t.id === 2).waiting, undefined);
  e.project('a').paused = false; e.holds = new Map([['a', [{ ticket: 1, reason: 'waiting for PR #9, which changes the same files (b.txt)' }]]]); e.cache.clear(); l = await e.listTickets('a'); assert.match(l.find((t) => t.id === 1).waiting, /PR #9/);
  e.holds = new Map(); await callOp(e, 'set_schedule', { project: 'a', schedule: { startAt: '2999-01-01' } }); e.cache.clear(); l = await e.listTickets('a'); assert.match(l.find((t) => t.id === 1).waiting, /starts .*resumes/);
});
