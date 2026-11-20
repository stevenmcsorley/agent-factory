import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { buildDemo } from '../src/demo.mjs';
import { createServer, hostsFor } from '../src/server.mjs';
import { ensureToken } from '../src/init.mjs';

test('the demo builds with no Docker and no agent: real projects, a launched plan, real PRs (one merge-ready, one blocked), tickets in every state, and history for the Flow card', async () => {
  const d = await buildDemo(); const e = d.engine;
  try {
    assert.deepEqual(e.cfg.projects.map((p) => p.id), ['booking-app', 'status-page']); assert.equal(e.cfg.sandbox.kind, 'local'); assert.equal(e.cfg.agent.kind, 'shell'); assert.equal(e.demo, true); assert.equal(e.status().demo, true);
    const t = await e.listTickets('booking-app'); const states = Object.fromEntries(t.map((x) => [x.title, x.labels.find((l) => l.startsWith('agent-')) + (x.state === 'CLOSED' ? '+closed' : '')]));
    assert.equal(states['Validate bookings before storing them'], 'agent-review+closed'); assert.equal(states['Reject overlapping bookings for the same room'], 'agent-review'); assert.equal(states['Make bookings nicer'], 'agent-needs-info'); assert.equal(states['Send SMS reminders the day before'], 'agent-failed'); assert.equal(states['Show the week as a calendar grid'], 'agent-ready');
    assert.ok(!t.some((x) => x.title.startsWith('Email a confirmation')), 'the dependent plan ticket is still waiting for its dependency');
    const prs = await e.listPrs('booking-app'); assert.equal(prs.length, 2); const ok = await e.prDetail('booking-app', prs[0].number), blocked = await e.prDetail('booking-app', prs[1].number);
    assert.deepEqual([ok.pr.stale, blocked.pr.stale], [false, true]); assert.ok(blocked.files.some((f) => f.path === 'src/extra.js'), 'the blocked PR has a commit added after verification'); assert.match(ok.diff, /overlaps/);
    const f = e.flow({ days: 30 }); assert.ok(f.accepted >= 5 && f.enough, 'enough history that the Flow card is not just a warning'); assert.equal(f.verifiedShare.value, 1);
    const pf = await e.portfolio(); assert.equal(pf.find((r) => r.id === 'status-page').verification, 'none'); assert.equal(pf.find((r) => r.id === 'booking-app').plan.total, 4); assert.ok(e.cfg.projects.every((p) => p.profile), 'the sample code was really analysed');
    // the interesting guardrail, live: merge-ready merges by fast-forward, the stale one is refused
    assert.equal((await e.prAction('booking-app', prs[0].number, 'merge')).how, 'fast-forward'); await assert.rejects(e.prAction('booking-app', prs[1].number, 'merge'), (x) => x.status === 409 && /changed since it was verified/.test(x.message));
    const log = fs.readFileSync(`${d.stateDir}/runs.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); assert.ok(log.length >= 10 && log.every((r) => r.project && r.started && r.finished), 'sample run history is well-formed');
  } finally { fs.rmSync(d.dir, { recursive: true, force: true }); }
});

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
test('the demo serves the UI and API on loopback only, with the token, and says it is a demo', async () => {
  const d = await buildDemo(); const port = await freePort(); const token = await ensureToken(d.stateDir); const server = createServer(d.engine, { token, allowedHosts: hostsFor('127.0.0.1', port) }); await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const get = (p, auth) => new Promise((res) => { http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}`, ...(auth ? { Authorization: `Bearer ${token}` } : {}) } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }); });
    assert.equal((await get('/api/status', false)).status, 401); const s = await get('/api/status', true); assert.equal(s.status, 200); assert.equal(JSON.parse(s.body).demo, true); assert.equal((await get('/', false)).status, 200);
  } finally { await new Promise((r) => server.close(r)); fs.rmSync(d.dir, { recursive: true, force: true }); }
});

test('`agent-factory demo` starts from a clean checkout with no config, prints the UI link, and cleans up its folder when stopped', async () => {
  const port = await freePort(); const child = spawn(process.execPath, ['src/cli.mjs', 'demo', `--port=${port}`, '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() }); let out = '';
  child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
  for (let i = 0; i < 100 && !/UI:\s+http/.test(out); i++) await new Promise((r) => setTimeout(r, 200)); assert.match(out, /Agent Factory demo is running \(no Docker, no agent, nothing will run\)/); const root = /Everything is in (\S+) and is deleted on exit/.exec(out)?.[1]; assert.ok(root && fs.existsSync(root));
  child.kill('SIGINT'); await new Promise((r) => child.once('exit', r)); await new Promise((r) => setTimeout(r, 300)); assert.ok(!fs.existsSync(root), 'the throwaway folder is deleted on exit');
});
