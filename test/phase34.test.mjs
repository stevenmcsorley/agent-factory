import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { createServer, hostsFor } from '../src/server.mjs';
import { callOp, OPS } from '../src/ops.mjs';

const tmp = (p = 'p34-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
const MONEY = `export function formatMoney(amount, currency = 'USD') {\n  const n = Number(amount);\n  if (!Number.isFinite(n)) throw new Error('amount must be a number');\n  const abs = Math.abs(n).toFixed(2);\n  const [whole, cents] = abs.split('.');\n  const grouped = whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');\n  return (n < 0 ? '-' : '') + ({ USD: '$', EUR: '€' }[currency] ?? '') + grouped + '.' + cents;\n}\n`;
function remoteWith(files, root) { const bare = path.join(root, `r-${Math.random().toString(36).slice(2, 8)}.git`); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]); const seed = tmp('seed-'); execFileSync('git', ['init', '-q', '-b', 'main', seed]); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true }); fs.writeFileSync(path.join(seed, f), c); } git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'i'); git(seed, 'push', '-q', bare, 'main'); return bare; }
async function world(files) {
  const root = tmp('w-'); const remotes = { app: remoteWith(files ?? { 'src/money.js': MONEY, 'src/loop.js': 'export function spin() {\n  while (true) {}\n}\nexport const add = (a, b) => a + b;\n', 'src/dep.js': "import fs from 'node:fs';\nexport const read = (f) => fs.readFileSync(f, 'utf8');\n" }, root) };
  const sandbox = { kind: 'local', create: async ({ cloneUrl, branch, base, newBranch = true }) => { const dir = fs.mkdtempSync(path.join(root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); if (newBranch) execFileSync('git', ['checkout', '-qb', branch], { cwd: dir }); return { dir, cloneUrl, destroy() {} }; }, exec: async () => ({ code: 0, out: '' }) };
  const store = []; const tk = { create: async ({ title, body }) => { store.push({ id: store.length + 1, title, body }); return { url: `https://x/${store.length}` }; }, listAgentTickets: async () => [], poll: async () => [] };
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { sandbox, tickets: () => tk, hostAdapter: () => ({ cloneUrl: () => remotes.app, gitEnv: () => ({}), prUrl: () => '', openPr: async () => '' }) } });
  e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  await e.addProject({ repo: 'o/app', id: 'app' }); const bare = path.join(root, 'lib.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]); await e.libraryConnect({ remote: bare });
  return { e, store, root };
}

test('try it: a part function runs in the sandbox and returns a value; errors, bad input and infinite loops are contained', async () => {
  const w = await world(); await w.e.promotePart({ project: 'app', files: ['src/money.js'], name: 'Money Format', summary: 'Format money', direct: true }); await w.e.promotePart({ project: 'app', files: ['src/loop.js'], name: 'Loop Helpers', summary: 'Loops and adding', direct: true }); await w.e.promotePart({ project: 'app', files: ['src/dep.js'], name: 'File Reader', summary: 'Read files', direct: true });
  assert.deepEqual((({ ok, result }) => ({ ok, result }))(await w.e.tryPart({ part: 'money-format', fn: 'formatMoney', args: [1234.5] })), { ok: true, result: '$1,234.50' }); assert.equal((await w.e.tryPart({ part: 'money-format', fn: 'formatMoney', args: [-9, 'EUR'] })).result, '-€9.00');
  const bad = await w.e.tryPart({ part: 'money-format', fn: 'formatMoney', args: ['nope'] }); assert.equal(bad.ok, false); assert.match(bad.error, /amount must be a number/);
  assert.equal((await w.e.tryPart({ part: 'loop-helpers', fn: 'add', args: [2, 3] })).result, 5);
  const t0 = Date.now(); const spin = await w.e.tryPart({ part: 'loop-helpers', fn: 'spin', args: [] }); assert.equal(spin.ok, false); assert.ok(Date.now() - t0 < 8000, 'the infinite loop was interrupted');
  await assert.rejects(w.e.tryPart({ part: 'money-format', fn: 'nope' }), /not an exported function/); await assert.rejects(w.e.tryPart({ part: 'money-format', fn: 'formatMoney', args: 'x' }), /JSON array/); await assert.rejects(w.e.tryPart({ part: 'file-reader', fn: 'read', args: ['/etc/passwd'] }), /imports other modules/); await assert.rejects(w.e.tryPart({ part: 'missing', fn: 'x' }), /No such part/);
  assert.equal((await callOp(w.e, 'library_try', { part: 'money-format', fn: 'formatMoney', args: [5] })).result, '$5.00');
});

test('extract: a tangled piece of code becomes a normal ticket with clear rules; a nameless request is refused', async () => {
  const w = await world(); const r = await w.e.extractPartTicket({ project: 'app', name: 'Money Format', files: ['src/money.js', '../../etc/passwd;rm'], description: 'format and parse money' });
  assert.match(r.url, /x\/1/); const t = w.store[0]; assert.equal(t.title, 'Extract Money Format into a standalone reusable module'); assert.match(t.body, /src\/lib\/money-format\.js/); assert.match(t.body, /must NOT import anything from this project's other modules/); assert.match(t.body, /Acceptance criteria:/); assert.doesNotMatch(t.body, /;rm/);
  await assert.rejects(w.e.extractPartTicket({ project: 'app', name: '' }), /name/); await assert.rejects(w.e.extractPartTicket({ project: 'nope', name: 'x' }), /No such project/);
});

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const post = (port, p, body, { host, type = 'application/json' } = {}) => new Promise((resolve) => { const data = typeof body === 'string' ? body : JSON.stringify(body); const q = http.request({ host: '127.0.0.1', port, path: p, method: body === undefined ? 'GET' : 'POST', headers: { Host: host ?? `127.0.0.1:${port}`, 'Content-Type': type, 'Content-Length': Buffer.byteLength(data ?? '') } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() })); }); q.end(body === undefined ? undefined : data); });

test('webhooks: alerts become tickets over HTTP with only the secret in the URL; wrong secret, method, type, size and host are all refused; duplicates and floods are handled; rotation kills the old URL', async () => {
  const w = await world(); const port = await freePort(); const ui = { host: '127.0.0.1', port }; const server = createServer(w.e, { token: 'T'.repeat(32), allowedHosts: hostsFor(ui.host, port) }); await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const info = w.e.webhookInfo('app'); assert.match(info.path, /^\/hook\/app\/[\w-]{20,}$/);
    const ok = await post(port, info.path, { title: 'Checkout returns 500 for an empty cart', body: 'Seen 14 times. TypeError in cart.total()', source: 'skylark', severity: 'High', url: 'https://example.com/issues/1', key: 'issue-1' });
    assert.equal(ok.status, 201); assert.equal(w.store.length, 1); assert.match(w.store[0].title, /^\[skylark\] Checkout returns 500/); assert.match(w.store[0].body, /severity: high/); assert.match(w.store[0].body, /Link: https:\/\/example\.com\/issues\/1/); assert.match(w.store[0].body, /Acceptance criteria:/);
    const dup = await post(port, info.path, { title: 'Checkout returns 500 for an empty cart', key: 'issue-1' }); assert.equal(dup.status, 200); assert.equal(dup.json.deduped, true); assert.equal(w.store.length, 1);
    assert.equal((await post(port, info.path, { body: 'no title' })).status, 422); assert.equal((await post(port, info.path.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), { title: 'x y z q r' })).status, 401); assert.equal((await post(port, info.path, undefined)).status, 405);
    assert.equal((await post(port, info.path, '{"title":"x"}', { type: 'text/plain' })).status, 415); assert.equal((await post(port, info.path, '{"title":"' + 'x'.repeat(70_000) + '"}')).status, 413); assert.equal((await post(port, info.path, '{nope')).status, 400);
    assert.equal((await post(port, info.path, { title: 'Evil host header test' }, { host: 'evil.test' })).status, 421, 'DNS-rebinding guard applies to hooks too');
    const before = w.store.length; assert.ok((await post(port, '/hook/app/short', { title: 'x y z' })).status >= 400 && w.store.length === before, 'a malformed hook path is not a hook');
    for (let i = 0; i < 40; i++) await post(port, info.path, { title: `Flood alert number ${i}`, key: `f${i}` }); assert.ok(w.store.length <= 31, `rate limited, got ${w.store.length}`); assert.equal((await post(port, info.path, { title: 'one more alert after flood' })).status, 429);
    const old = info.path; const fresh = w.e.webhookRotate('app'); assert.notEqual(fresh.path, old); assert.equal((await post(port, old, { title: 'old secret still works?' })).status, 401);
    w.e.setProjectPaused('app', true); assert.equal((await post(port, fresh.path, { title: 'paused project alert' })).status, 409);
    const api = await post(port, '/api/op/webhook_info', { project: 'app' }); assert.equal(api.status, 401, 'the UI/API still needs its own token');
  } finally { await new Promise((r) => server.close(r)); }
});

test('the new operations are in the catalogue (MCP, Code Mode, CLI)', async () => {
  const names = OPS.map((o) => o.name); for (const n of ['library_try', 'extract_part', 'webhook_info', 'webhook_rotate']) assert.ok(names.includes(n), n);
  const w = await world(); assert.match((await callOp(w.e, 'webhook_info', { project: 'app' })).path, /^\/hook\/app\//); assert.match((await callOp(w.e, 'extract_part', { project: 'app', name: 'Money Format' })).url, /x\/1/);
});
