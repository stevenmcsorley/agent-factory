// The accounting: every figure on the Usage page, checked against logs I wrote by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAccounts, accountsCsv } from '../src/accounts.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { recordUsage } from '../src/usage.mjs';
import { createServer, hostsFor } from '../src/server.mjs';
import { callOp } from '../src/ops.mjs';

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0); const iso = (d, h = 10) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const U = (o) => ({ at: iso(22), role: 'builder', project: 'p', model: 'gpt-6.2-astra', via: null, input: 1000, cached: 800, output: 100, steps: 4, ms: 5000, ...o });
const usage = [U({ at: iso(20), role: 'reviewer', input: 90_000, cached: 80_000, output: 500, steps: 6 }), U({ at: iso(21), via: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', role: 'reviewer', input: 1200, cached: 0, output: 80, steps: 0, ms: 4000 }),
  U({ at: iso(21, 11), via: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', role: 'builder', project: 'q', input: 5400, cached: 0, output: 300, steps: 5, ms: 38_000, escalated: true }), U({ at: iso(22), via: 'none', role: 'builder', input: 0, cached: 0, output: 0, steps: 0, limited: true, why: 'Codex only, and Codex is not available' }), U({ at: iso(22, 11), limited: true })];
const audit = [{ at: iso(21, 8), what: 'plan-limit', until: iso(21, 9) }, { at: iso(21, 9), what: 'plan-limit-cleared' }, { at: iso(22, 8), what: 'plan-limit', until: iso(22, 10) }, { at: iso(22, 7), what: 'openrouter', action: 'fallback', role: 'builder', project: 'p' }, { at: iso(21, 12), what: 'openrouter', action: 'back-to-plan', role: 'reviewer', why: 'no usable answer' }, { at: iso(19), what: 'agent-policy', from: { mode: 'codex' }, to: { mode: 'mix' } }];
const orCalls = [{ at: Date.parse(iso(22, 6)), model: 'google/gemma-4-31b-it:free', ok: false, kind: 'rate-limit', err: 'upstream' }, { at: Date.parse(iso(22, 9)), model: 'x/y:free', ok: false, kind: 'daily-limit', err: 'free-models-per-day' }, { at: Date.parse(iso(21, 7)), model: 'nvidia/nemotron-3-ultra-550b-a55b:free', ok: false, kind: 'bad-tool-call' }, { at: Date.parse(iso(21, 7)), model: 'a/b:free', ok: true }];
const A = () => buildAccounts({ usage, orCalls, audit, now: NOW, days: 7, planLimit: null, budget: { cap: 1000, used: 40, remaining: 960 }, credits: { total: 10.2, used: 0.15, remaining: 10.05 }, keyInfo: { freeTier: false } });

test('totals and the split between Codex and the free models (weighted: cached input counts a tenth, output six times)', () => {
  const a = A(); assert.equal(a.totals.calls, 5, 'every call in the range'); assert.deepEqual([a.byProvider.codex.calls, a.byProvider.openrouter.calls, a.byProvider.none.calls], [2, 2, 1]);
  assert.equal(a.byProvider.openrouter.input, 6600); assert.equal(a.byProvider.openrouter.output, 380); const w = (i, c, o) => (i - c) + c * 0.1 + o * 6; assert.equal(a.byProvider.openrouter.weighted, w(1200, 0, 80) + w(5400, 0, 300)); assert.equal(a.byProvider.codex.weighted, w(90_000, 80_000, 500) + w(1000, 800, 100));
  assert.ok(Math.abs(a.totals.freeShare - a.byProvider.openrouter.weighted / a.totals.weighted) < 1e-9); assert.equal(a.totals.limited, 2); assert.equal(a.totals.escalated, 1);
});

test('days: every day in the range is there (a quiet day is a visible gap) with its own split', () => {
  const a = A(); assert.deepEqual(a.byDay.map((d) => d.day), ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']); const d21 = a.byDay.find((d) => d.day === '2026-11-21'); assert.equal(d21.openrouter.calls, 2); assert.equal(d21.codex.calls, 0); assert.equal(a.byDay.find((d) => d.day === '2026-11-18').codex.calls, 0);
});

test('models: calls, tokens, speed and the tool-call numbers (steps per call, tokens per step, bad tool calls)', () => {
  const a = A(); const free = a.byModel.find((m) => m.model.startsWith('nvidia/')); assert.equal(free.provider, 'openrouter'); assert.equal(free.calls, 2); assert.equal(free.steps, 5); assert.equal(free.avgSteps, 2.5); assert.equal(free.tokensPerStep, 1320); assert.equal(free.avgMs, 21_000); assert.equal(free.toolFailures, 1);
  const codex = a.byModel.find((m) => m.model === 'gpt-6.2-astra'); assert.equal(codex.provider, 'codex'); assert.equal(codex.calls, 2);
});

test('roles and projects: who used what', () => {
  const a = A(); const rev = a.byRole.find((r) => r.role === 'reviewer'); assert.equal(rev.codex.calls, 1); assert.equal(rev.openrouter.calls, 1); assert.equal(a.byProject.find((p) => p.project === 'q').calls, 1); assert.equal(a.byProject.find((p) => p.project === 'p').calls, 4);
});

test('events: limits, rests, resets, fallbacks and policy changes, newest first, in plain words', () => {
  const a = A(); const kinds = a.events.map((e) => e.kind); for (const k of ['codex-limit', 'codex-resume', 'fallback', 'escalation', 'policy', 'free-rest', 'free-daily']) assert.ok(kinds.includes(k), k);
  assert.deepEqual(a.events.map((e) => e.at), [...a.events.map((e) => e.at)].sort((x, y) => Date.parse(y) - Date.parse(x))); assert.match(a.events.find((e) => e.kind === 'free-rest').title, /gemma-4-31b-it:free rate limited/); assert.match(a.events.find((e) => e.kind === 'policy').detail, /codex → mix/);
});

test('Codex limit history: when each limit hit, when it was expected back, when work actually resumed and how long that took', () => {
  const h = A().limits.codex.history; assert.equal(h.length, 2); const second = h[0]; assert.equal(second.at, iso(22, 8)); assert.equal(second.resumedAt, iso(22, 10), 'no "cleared" entry, but the stated time has passed: it lifted by itself then'); assert.equal(second.durationMs, 2 * 3_600_000);
  const first = h[1]; assert.equal(first.resumedAt, iso(21, 9)); assert.equal(first.durationMs, 3_600_000);
  const open = buildAccounts({ usage: [], audit: [{ at: iso(22, 11), what: 'plan-limit', until: iso(22, 15) }], now: NOW, days: 7 }).limits.codex.history[0]; assert.equal(open.resumedAt, null); assert.equal(open.durationMs, null, 'still limited: no end yet');
});

test('calls: newest first with the outcome in words; the range is respected; CSV is quoted properly', () => {
  const a = A(); assert.equal(a.calls[0].at, iso(22, 11)); assert.deepEqual(a.calls.map((c) => c.outcome), ['limited', 'not run', 'escalated', 'ok', 'ok']); assert.equal(a.calls.find((c) => c.outcome === 'not run').why, 'Codex only, and Codex is not available');
  assert.equal(buildAccounts({ usage, now: NOW, days: 1 }).totals.calls, 2, 'one day back: only the 22nd'); const csv = accountsCsv({ calls: [{ at: iso(22), provider: 'codex', model: 'm', role: 'builder', project: 'a,b', ticket: 1, run: 'r', input: 1, cached: 0, output: 2, steps: 3, ms: 4, outcome: 'ok', why: 'say "hi"' }] });
  assert.match(csv.split('\n')[0], /^time,provider,model,agent,project/); assert.match(csv.split('\n')[1], /"a,b"/); assert.match(csv.split('\n')[1], /"say ""hi"""/);
});

test('limits: the free allowance, the credit position and the reset time are passed through', () => {
  const a = A(); assert.deepEqual(a.limits.free.budget, { cap: 1000, used: 40, remaining: 960 }); assert.equal(a.limits.free.credits.total, 10.2); assert.equal(a.limits.free.freeTier, false);
});

test('through the engine: usage written by the factory and the audit trail come back as accounts, over REST (with the token), as CSV, and as an MCP operation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} });
  recordUsage(e.cfg.stateDir, { role: 'builder', project: 'p', model: 'm1', via: null, input: 100, cached: 0, output: 10, steps: 2, ms: 900 }); recordUsage(e.cfg.stateDir, { role: 'reviewer', project: 'p', model: 'free/x:free', via: 'openrouter', input: 50, cached: 0, output: 5, steps: 0, ms: 300 }); e._audit({ what: 'plan-limit', until: new Date(Date.now() + 3_600_000).toISOString() });
  const a = await e.accounts({ days: 1 }); assert.equal(a.totals.calls, 2); assert.equal(a.byProvider.openrouter.calls, 1); assert.equal(a.events.some((x) => x.kind === 'codex-limit'), true);
  assert.equal((await callOp(e, 'usage_accounts', { days: 3 })).range.days, 3); const TOKEN = 'test-token-0123456789-abcdefghij'; const tmp = createServer(e, { token: TOKEN, allowedHosts: [] }); await new Promise((r) => tmp.listen(0, '127.0.0.1', r)); const port = tmp.address().port; tmp.close();
  const srv = createServer(e, { token: TOKEN, allowedHosts: hostsFor('127.0.0.1', port) }); await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  try { const get = (p, token = TOKEN) => fetch(`http://127.0.0.1:${port}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); assert.equal((await get('/api/accounts?days=1', null)).status, 401); const j = await (await get('/api/accounts?days=1')).json(); assert.equal(j.totals.calls, 2);
    const csv = await get('/api/accounts.csv?days=1'); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(await csv.text(), /tokens_in/); assert.equal((await get('/api/accounts.csv', null)).status, 401); } finally { srv.closeAllConnections(); srv.close(); }
});

test('a limit that is re-noted and a clear that is re-checked many times is ONE hit and ONE resume (the audit trail repeats itself; the accounting must not)', () => {
  const a = buildAccounts({ usage: [], now: NOW, days: 7, audit: [{ at: iso(21, 8), what: 'plan-limit', until: iso(21, 12) }, { at: iso(21, 8, ), what: 'plan-limit', until: iso(21, 12) }, { at: iso(21, 9), what: 'plan-limit', until: iso(21, 13) }, { at: iso(21, 14), what: 'plan-limit-cleared' }, { at: iso(21, 14), what: 'plan-limit-cleared' }, { at: iso(21, 15), what: 'plan-limit-cleared' }] });
  assert.deepEqual(a.events.map((e) => e.kind).sort(), ['codex-limit', 'codex-resume']); assert.equal(a.limits.codex.history.length, 1); assert.equal(a.limits.codex.history[0].expected, iso(21, 13), 'the latest expected time'); assert.equal(a.limits.codex.history[0].resumedAt, iso(21, 14)); assert.equal(a.limits.codex.history[0].durationMs, 6 * 3_600_000);
  assert.equal(buildAccounts({ usage: [], now: NOW, days: 7, audit: [{ at: iso(21, 9), what: 'plan-limit-cleared' }] }).events.length, 0, 'a clear with no limit before it is not an event');
});
