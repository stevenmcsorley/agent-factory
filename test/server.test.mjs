import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { createServer, hostsFor } from '../src/server.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';

const TOKEN = 'test-token-0123456789-abcdefghij';
async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-')); const tp = path.join(root, 't.json');
  fs.writeFileSync(tp, JSON.stringify([{ id: 1, title: '<img src=x onerror=alert(1)>', body: 'b', labels: ['agent-review'] }]));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' },
    projects: [{ id: 'app', repo: 'me/app', base: 'main', tickets: { kind: 'file', path: tp } }] });
  const e = new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: { tickets: (p) => fileTickets(p.tickets.path), host: () => ({ listAgentPrs: async () => [{ number: 3, title: 'T', branch: 'agent/1-x', sha: 'a' }] }) } });
  e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  const srv = createServer(e, { token: TOKEN, allowedHosts: [] });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port; srv.close(); // recreate with the real allowed hosts now that we know the port
  const s2 = createServer(e, { token: TOKEN, allowedHosts: hostsFor('127.0.0.1', port) });
  await new Promise((r) => s2.listen(port, '127.0.0.1', r));
  const call = (p, { method = 'GET', body, token = TOKEN, headers = {} } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { call, port, close: () => { s2.closeAllConnections(); s2.close(); }, e, root };
}

test('server refuses to start without a strong token', () => assert.throws(() => createServer({}, { token: 'short', allowedHosts: [] }), /token/));

test('auth: every /api route needs the bearer token; static UI does not; wrong host refused', async () => {
  const { call, close, port } = await boot();
  assert.equal((await call('/api/status', { token: null })).status, 401);
  assert.equal((await call('/api/status', { token: 'x'.repeat(32) })).status, 401);
  assert.equal((await call('/api/status')).status, 200);
  const hostile = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: 'evil.test', Authorization: `Bearer ${TOKEN}` } }, (x) => { x.resume(); resolve(x.statusCode); }); r.end(); });
  assert.equal(hostile, 421); // DNS-rebinding style request with a foreign Host header
  const ui = await call('/', { token: null }); assert.equal(ui.status, 200);
  assert.match(await ui.clone().text(), /^<!doctype html>/i); assert.match(ui.headers.get('content-type'), /text\/html/);
  const js = await call('/app.js', { token: null }); assert.match(await js.text(), /Agent Factory UI/); assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(ui.headers.get('content-security-policy'), /default-src 'none'/); assert.equal(ui.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('/../package.json', { token: null })).status, 404);
  assert.equal((await call('/secrets.env', { token: null })).status, 404);
  close();
});

test('writes: JSON only, bounded, same-origin only', async () => {
  const { call, close, port } = await boot();
  const raw = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers }, body: init.body });
  assert.equal((await raw('/api/control/pause', { headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await raw('/api/check-ticket', { headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal((await raw('/api/check-ticket', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'x'.repeat(70000) }) })).status, 413);
  assert.equal((await call('/api/control/pause', { method: 'POST', body: {}, headers: { Origin: 'https://evil.test' } })).status, 403);
  close();
});

test('API: status, tickets (untrusted text is data), prs, ticket create, gate check, pause/resume, runs', async () => {
  const { call, close, e } = await boot();
  const j = async (r) => r.json();
  assert.equal((await j(await call('/api/status'))).projects[0].project, 'app');
  const tickets = await j(await call('/api/projects/app/tickets')); assert.equal(tickets[0].title, '<img src=x onerror=alert(1)>'); // returned verbatim as JSON; the UI renders with textContent
  assert.equal((await j(await call('/api/projects/app/prs')))[0].url, 'https://github.com/me/app/pull/3');
  assert.equal((await call('/api/projects/app/tickets', { method: 'POST', body: { title: 'Add thing', body: 'Add `thing()` that returns 1, and it should be tested.' } })).status, 200);
  assert.equal((await call('/api/projects/app/tickets', { method: 'POST', body: { title: '' } })).status, 400);
  assert.equal((await call('/api/projects/nope/tickets')).status, 404);
  assert.equal((await j(await call('/api/check-ticket', { method: 'POST', body: { title: 'Improve it', body: 'better' } }))).ok, false);
  assert.equal((await j(await call('/api/control/pause', { method: 'POST', body: {} }))).paused, true);
  assert.equal((await j(await call('/api/control/resume', { method: 'POST', body: {} }))).paused, false);
  assert.deepEqual(await j(await call('/api/runs')), []);
  assert.equal((await call('/api/nope')).status, 404);
  close();
});

test('API: add/remove project persists; control tick refuses when busy; templates listed', async () => {
  const { call, close, e } = await boot();
  const add = await call('/api/projects', { method: 'POST', body: { id: 'two', repo: 'me/two' } });
  assert.equal(add.status, 200); assert.equal((await (await call('/api/projects')).json()).length, 2);
  assert.equal((await call('/api/projects', { method: 'POST', body: { id: 'two', repo: 'me/two' } })).status, 400);
  assert.equal((await call('/api/projects/two', { method: 'DELETE' })).status, 200);
  assert.ok((await (await call('/api/templates')).json()).includes('node'));
  e.busy = true; assert.equal((await call('/api/control/tick', { method: 'POST', body: {} })).status, 409);
  close();
});
