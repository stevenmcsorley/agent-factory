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
  for (const f of ['app.js', 'lib.js', 'views.js', 'charts.js']) { const js = await call(`/${f}`, { token: null }); assert.equal(js.status, 200, f); assert.match(js.headers.get('content-type'), /javascript/); assert.match(await js.text(), /import|export/); }
  assert.match((await call('/favicon.svg', { token: null })).headers.get('content-type'), /svg/);
  const font = await call('/fonts/archivo-var.woff2', { token: null }); assert.equal(font.status, 200); assert.equal(font.headers.get('content-type'), 'font/woff2'); assert.ok((await font.arrayBuffer()).byteLength > 50000);
  assert.equal((await call('/fonts/../package.json', { token: null })).status, 404); assert.equal((await call('/fonts/nope.woff2', { token: null })).status, 404); assert.match(ui.headers.get('content-security-policy'), /font-src 'self'/); assert.match((await (await call('/', { token: null })).text()), /type="module"/);
  assert.match(ui.headers.get('content-security-policy'), /default-src 'none'/); assert.equal(ui.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('/../package.json', { token: null })).status, 404);
  assert.equal((await call('/secrets.env', { token: null })).status, 404);
  close();
});

test('/healthz answers without a token for uptime monitors, exposes nothing else, and still checks the Host header', async () => {
  const { call, close, port } = await boot();
  const r = await call('/healthz', { token: null }); assert.equal(r.status, 200); assert.deepEqual(Object.keys(await r.json()).sort(), ['ok', 'paused']);
  const hostile = await new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port, path: '/healthz', headers: { Host: 'evil.test' } }, (x) => { x.resume(); resolve(x.statusCode); }); q.end(); }); assert.equal(hostile, 421);
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

const rpc = (call, path, method, params, id = 1) => call(path, { method: 'POST', body: { jsonrpc: '2.0', id, method, params } }).then((r) => r.json());

test('MCP /mcp: auth, handshake, tools, calls, errors-as-results, notifications, batch', async () => {
  const { call, close } = await boot();
  assert.equal((await call('/mcp', { token: null, method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401);
  assert.equal((await call('/mcp')).status, 405);
  const init = await rpc(call, '/mcp', 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26'); assert.equal(init.result.serverInfo.name, 'agent-factory'); assert.ok(init.result.capabilities.tools);
  assert.equal((await rpc(call, '/mcp', 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18'); // unknown version -> our latest
  const list = await rpc(call, '/mcp', 'tools/list');
  const names = list.result.tools.map((t) => t.name); assert.ok(names.includes('create_ticket') && names.includes('status') && !names.includes('remove_project'));
  assert.ok(list.result.tools.every((t) => t.inputSchema.type === 'object' && t.annotations));
  const projects = await rpc(call, '/mcp', 'tools/call', { name: 'list_projects', arguments: {} });
  assert.deepEqual(JSON.parse(projects.result.content[0].text).map((p) => p.id), ['app']);
  const bad = await rpc(call, '/mcp', 'tools/call', { name: 'create_ticket', arguments: { project: 'app', title: 'x', body: 'y', evil: 1 } });
  assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /unknown argument/);
  const vague = JSON.parse((await rpc(call, '/mcp', 'tools/call', { name: 'create_ticket', arguments: { project: 'app', title: 'Improve it', body: 'better' } })).result.content[0].text);
  assert.equal(vague.queued, false); assert.ok(vague.problems.length && vague.hint);
  const good = JSON.parse((await rpc(call, '/mcp', 'tools/call', { name: 'create_ticket', arguments: { project: 'app', title: 'Add thing function', body: 'Add an exported `thing()` function to index.js that returns 1, and it should be covered by a test.' } })).result.content[0].text);
  assert.equal(good.queued, true);
  assert.equal((await rpc(call, '/mcp', 'nope')).error.code, -32601);
  assert.equal((await call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
  const batch = await (await call('/mcp', { method: 'POST', body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }] })).json();
  assert.equal(batch.length, 2);
  close();
});

test('MCP /mcp-code: two tools, cheap index, execute runs JS against the ops, errors are flagged', async () => {
  const { call, close } = await boot();
  const list = await rpc(call, '/mcp-code', 'tools/list'); assert.deepEqual(list.result.tools.map((t) => t.name), ['search', 'execute']);
  const idx = JSON.parse((await rpc(call, '/mcp-code', 'tools/call', { name: 'search', arguments: {} })).result.content[0].text);
  assert.ok(idx.tools.length >= 15 && idx.tools.every((t) => !t.inputSchema));
  const hit = JSON.parse((await rpc(call, '/mcp-code', 'tools/call', { name: 'search', arguments: { query: 'create_ticket', limit: 1 } })).result.content[0].text);
  assert.equal(hit.tools[0].method, 'factory.create_ticket'); assert.ok(hit.tools[0].inputSchema.properties.title);
  const run = async (code) => (await rpc(call, '/mcp-code', 'tools/call', { name: 'execute', arguments: { code } })).result;
  const r = await run('async () => { const ps = await factory.list_projects({}); const t = await factory.list_tickets({ project: ps[0].id }); return { n: ps.length, tickets: t.length } }');
  assert.deepEqual(JSON.parse(r.content[0].text).result, { n: 1, tickets: 1 }); assert.notEqual(r.isError, true);
  const e1 = await run('async () => await factory.create_ticket({ project: "nope", title: "Add thing function", body: "Add an exported `thing()` function to index.js that returns 1, and it should be tested." })'); assert.equal(e1.isError, true); assert.match(e1.content[0].text, /No such project/);
  const e2 = await run('async () => { while (true) {} }'.replace('while (true) {}', 'return typeof process + typeof fetch + typeof require')); assert.equal(JSON.parse(e2.content[0].text).result, 'undefinedundefinedundefined');
  close();
});

test('API: activity, metrics and run detail endpoints', async () => {
  const { call, close } = await boot(); const j = async (r) => r.json();
  assert.deepEqual(Object.keys(await j(await call('/api/activity'))).sort(), ['active', 'events']);
  const m = await j(await call('/api/metrics?days=7')); assert.equal(m.days.length, 7); assert.ok('totals' in m && 'projects' in m);
  assert.equal((await call('/api/runs/deadbeef')).status, 404); assert.equal((await call('/api/runs/not-hex!')).status, 404);
  close();
});
