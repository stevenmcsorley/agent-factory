import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { localTickets } from '../src/adapters/tickets-local.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { tick } from '../src/factory.mjs';
import { createServer, hostsFor } from '../src/server.mjs';
import * as pk from '../src/pack.mjs';
import * as sc from '../src/scenarios.mjs';
import { buildTickets } from '../src/sources.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lt-'));

test('adapter: sequential ids, ready/working queues, labels, comments with authorship, closing and reopening, and everything survives a restart', async () => {
  const dir = tmp(); const t = localTickets({ dir, project: 'app' });
  const a = await t.create({ title: 'First ticket here', body: 'Do it in a.js' }); const b = await t.create({ title: 'Second ticket here', body: 'x', repo: 'o/other' }); assert.deepEqual([a.id, b.id, a.url], [1, 2, 'local:app/1']);
  assert.deepEqual((await t.poll()).map((x) => x.id), [1, 2]); assert.ok((await t.get(2)).labels.includes('repo:o/other'));
  await t.label(1, ['agent-working'], ['agent-ready']); assert.deepEqual((await t.poll()).map((x) => x.id), [2]); assert.deepEqual((await t.listWorking()).map((x) => x.id), [1]);
  await t.comment(1, 'Opened https://x/pr/1 after 1 attempt(s).'); await t.comment(1, 'Looks good, merge it'); await t.comment(1, '   '); const g = await t.get(1);
  assert.deepEqual(g.comments.map((c) => [c.author, c.factory]), [['agent-factory', true], ['you', false]]); assert.equal(g.state, 'OPEN');
  await t.close(1); assert.equal((await t.get(1)).state, 'CLOSED'); assert.equal((await t.listAgentTickets()).find((x) => x.id === 1).state, 'CLOSED'); await t.reopen(1); assert.equal((await t.get(1)).state, 'OPEN');
  await t.update(2, { title: 'Renamed ticket title', body: 'new' }); assert.equal((await t.get(2)).title, 'Renamed ticket title');
  const again = localTickets({ dir, project: 'app' }); assert.equal((await again.get(2)).body, 'new'); assert.equal((await again.create({ title: 'Third ticket here' })).id, 3, 'ids continue after a restart');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'writes are atomic');
  await assert.rejects(t.get(99), /No such ticket/); await assert.rejects(t.create({ title: '   ' }), /needs a title/); await assert.rejects(t.update(1, { title: '' }), /needs a title/); await assert.rejects(t.create({ title: 'x y z', epic: 1 }), /No such epic/);
});

test('epics: not work (never queued), children link to them, and an epic closes itself when its last child closes and reopens with a child', async () => {
  const t = localTickets({ dir: tmp(), project: 'app' }); const e = await t.createEpic({ title: 'Core API', body: 'goal' }); assert.equal(e.url, 'local:app/1');
  assert.deepEqual(await t.poll(), []); assert.deepEqual(await t.listAgentTickets(), [], 'an epic is not a work ticket');
  const c1 = await t.create({ title: 'Child one here', epic: e.id }); const c2 = await t.create({ title: 'Child two here', epic: e.id }); assert.deepEqual((await t.poll()).map((x) => x.id), [2, 3]);
  const g = await t.get(e.id); assert.deepEqual(g.children.map((x) => x.id), [2, 3]); assert.equal((await t.get(c1.id)).epicInfo.title, 'Core API'); assert.equal(g.state, 'OPEN');
  await t.close(c1.id); assert.equal((await t.get(e.id)).state, 'OPEN'); await t.close(c2.id); assert.equal((await t.get(e.id)).state, 'CLOSED'); await t.reopen(c2.id); assert.equal((await t.get(e.id)).state, 'OPEN');
  assert.deepEqual(await t.overview(), { epics: [{ ...(await t.get(e.id)), children: undefined, comments: undefined, total: 2, done: 1 }].map(({ children, comments, epicInfo, ...r }) => r), tickets: 2 });
});

test('a corrupt tracker file is never silently replaced by an empty one: it stops, keeps a copy, and nothing else is written', async () => {
  const dir = tmp(); const t = localTickets({ dir, project: 'app' }); await t.create({ title: 'Precious ticket one' }); fs.writeFileSync(path.join(dir, 'tracker.json'), '{"next": 5, "issues": [ {broken');
  await assert.rejects(t.create({ title: 'Another ticket here' }), /corrupt \(a copy was kept/); await assert.rejects(t.poll(), /corrupt/); assert.equal(fs.readFileSync(path.join(dir, 'tracker.json'), 'utf8'), '{"next": 5, "issues": [ {broken', 'the file was left as it was');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('tracker.json.corrupt-')));
});

function world() {
  const root = tmp(); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { hostAdapter: () => ({ cloneUrl: () => 'x', gitEnv: () => ({}), prUrl: () => '' }) } });
  e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} }; return { e, root };
}

test('a project on the built-in tracker needs no account or token and works with the whole factory: tickets, the inbox actions, scenarios waiting on a ticket, webhooks and the factory loop', async () => {
  const w = world(); const p = await w.e.addProject({ repo: 'o/app', id: 'app', source: { kind: 'local' } }); assert.deepEqual(p.tickets, { kind: 'local' }); assert.deepEqual(w.e.cfg.projects[0].feedbackAuthors, ['me']);
  const made = await w.e.createTicket('app', { title: 'Add a thing to a.js', body: 'Add a thing in a.js that returns one, with a test' }); assert.equal(made.url, 'local:app/1'); assert.deepEqual((await w.e.listTickets('app')).map((x) => [x.id, x.state, x.url]), [[1, 'OPEN', 'local:app/1']]);
  assert.equal((await w.e.ticketDetail('app', 1)).title, 'Add a thing to a.js'); await assert.rejects(w.e.ticketDetail('app', '../x'), /Invalid ticket id/); await assert.rejects(w.e.ticketDetail('app', 99), /No such ticket/);
  await w.e.ticketAction('app', 1, 'comment', { text: 'Please also handle empty input' }); assert.equal((await w.e.ticketDetail('app', 1)).comments.at(-1).author, 'you'); await w.e.ticketAction('app', 1, 'close', {}); assert.equal((await w.e.ticketDetail('app', 1)).state, 'CLOSED');
  assert.deepEqual(await w.e.ticketAction('app', 1, 'reopen', {}), { reopened: true }); assert.equal((await w.e.ticketDetail('app', 1)).state, 'OPEN');
  // the real factory loop on top of it: ready -> working -> review, with a comment pointing at the PR
  const d = w.e.deps(w.e.cfg.projects[0]); const prs = []; d.config.verify = false; d.sandbox = { create: async () => ({ dir: tmp(), destroy() {} }), exec: async () => ({ code: 0, out: '' }) }; d.agent = { run: async (_sb, ws) => { fs.writeFileSync(path.join(ws.dir, 'a.js'), 'export const a = 1;\n'); return { out: 'done', costUsd: 0 }; } };
  d.vcs = { diffStat: async () => '?? a.js', commitAndPush: async () => {}, openPr: async (_ws, a) => { prs.push(a); return 'https://example.test/pr/1'; }, head: async () => 'abc1234567' }; const [rec] = await tick(d);
  assert.equal(rec.status, 'ok'); const after = await w.e.ticketDetail('app', 1); assert.ok(after.labels.includes('agent-review') && !after.labels.includes('agent-working') && !after.labels.includes('agent-ready')); assert.match(after.comments.at(-1).body, /^Opened https:\/\/example\.test\/pr\/1 after 1 attempt/); assert.equal(after.comments.at(-1).factory, true);
  const hook = await w.e.inboundTicket('app', w.e._hook('app').token, { title: 'Checkout returns 500 for an empty cart', body: 'seen 3 times', source: 'monitor', key: 'k1' }); assert.equal(hook.created, true); assert.match(hook.ticket, /^local:app\/2$/);
  // a scenario step can queue a ticket here and wait for it to close
  const def = sc.validateScenario({ id: 'x', name: 'X', steps: [{ id: 'mk', type: 'ticket', title: 'Write the release notes in the changelog', body: 'Add release notes.\n\nAcceptance criteria:\n- written', waitFor: 'closed' }] }); const run = sc.startRun(w.e, { scenario: def, project: 'app', dryRun: false });
  let r = await sc.advance(w.e, 'app', run.id, { scenarios: [def] }); assert.equal(r.steps.mk.status, 'waiting'); await w.e.ticketAction('app', r.steps.mk.output.ticketId, 'close', {}); r = await sc.advance(w.e, 'app', run.id, { scenarios: [def] }); assert.equal(r.status, 'done');
});

test('plans live natively in the built-in tracker: launching creates real epics with the tickets linked to them, readable back with progress', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/app', id: 'app', source: { kind: 'local' } });
  const dir = pk.packDir(w.e.cfg.stateDir, 'app'); const pack = pk.loadPack(dir); pack.brief = { goal: 'A booking app for gyms', scope: 'classes API and a page' };
  pack.plan = pk.normalizePlan({ summary: 'Two steps', epics: [{ id: 'core', title: 'Core API', goal: 'The API', tickets: [{ id: 'schema', title: 'Add the schema', body: 'db/schema.sql.\n\nAcceptance criteria:\n- exists' }, { id: 'api', title: 'Add the endpoint', body: 'GET /classes.\n\nAcceptance criteria:\n- lists', dependsOn: ['schema'] }] }] }); pk.savePack(dir, pack);
  const r = await w.e.launchPlan('app'); const epic = r.plan.epics[0]; assert.match(epic.trackerUrl, /^local:app\//); const overview = await w.e.trackerOverview('app'); assert.equal(overview.epics.length, 1); assert.deepEqual([overview.epics[0].title, overview.epics[0].total, overview.epics[0].done], ['Core API', 1, 0]);
  assert.equal((await w.e.ticketDetail('app', epic.trackerId)).children.length, 1); assert.deepEqual((await w.e.listTickets('app')).map((x) => x.title), ['Add the schema'], 'the epic itself is not in the work queue');
  await w.e.ticketAction('app', 2, 'close', {}); await w.e.releasePlan('app'); assert.equal((await w.e.ticketDetail('app', epic.trackerId)).children.length, 2); assert.equal((await w.e.trackerOverview('app')).epics[0].done, 1);
  await assert.rejects(world().e.trackerOverview('nope'), /No such project/);
});

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
test('the API serves ticket detail for the UI (token required), and "local" appears in the tracker catalog and CLI-friendly create_project options', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/app', id: 'app', source: { kind: 'local' } }); await w.e.createTicket('app', { title: 'A ticket for the page', body: 'details' }); const port = await freePort(); const token = 'T'.repeat(32);
  const server = createServer(w.e, { token, allowedHosts: hostsFor('127.0.0.1', port) }); await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const get = (p, auth = true) => new Promise((res) => { http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}`, ...(auth ? { Authorization: `Bearer ${token}` } : {}) } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(b || 'null') })); }); });
  try { const ok = await get('/api/projects/app/tickets/1'); assert.equal(ok.status, 200); assert.equal(ok.json.title, 'A ticket for the page'); assert.equal((await get('/api/projects/app/tickets/1', false)).status, 401); assert.equal((await get('/api/projects/app/tickets/77')).status, 404); const cat = await get('/api/catalog'); assert.ok(cat.json.sources.some((s) => s.kind === 'local' && s.fields.length === 0)); assert.equal(buildTickets({ kind: 'local' }, { dir: tmp(), projectId: 'x' }).constructor, Object); }
  finally { await new Promise((r) => server.close(r)); }
});
