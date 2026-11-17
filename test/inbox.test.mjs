import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';
import { githubTickets } from '../src/adapters/tickets-github.mjs';
import { jiraTickets } from '../src/adapters/tickets-jira.mjs';
import { createServer, hostsFor } from '../src/server.mjs';

const res = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function setup(tickets) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-')); const tp = path.join(root, 't.json'); fs.writeFileSync(tp, JSON.stringify(tickets));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [{ id: 'app', repo: 'me/app', base: 'main', tickets: { kind: 'file', path: tp } }] });
  const e = new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: { tickets: (p) => fileTickets(p.tickets.path), hostAdapter: () => ({ pr: { listAgentPrs: async () => [{ number: 9, branch: 'agent/3-add-it', sha: 's', title: 'Add it' }] }, prUrl: (_r, n) => `https://example.test/pr/${n}`, gitEnv: () => ({}), cloneUrl: () => 'x' }) } });
  return { e, tp, read: () => JSON.parse(fs.readFileSync(tp, 'utf8')) };
}
const vague = { id: 1, title: 'Make it better', body: 'Improve it', labels: ['agent-needs-info'], comments: ['agent-factory did not start work: it is very short'] };
const failed = { id: 2, title: 'Add a retry helper', body: 'Add `retry(fn, n)` to util.js that retries fn up to n times and rethrows the last error; test it.', labels: ['agent-failed'], comments: ['agent-factory gave up: verify-failed after 2 attempt(s).'] };
const review = { id: 3, title: 'Add it', body: 'Add `it()` to it.js returning 1, and it should have a test.', labels: ['agent-review'], comments: [] };
const other = { id: 4, title: 'unrelated', body: 'x', labels: [] };

test('inbox gathers decisions (with reason + run) before reviews (with the PR), ignores everything else', async () => {
  const { e } = setup([vague, failed, review, other, { ...failed, id: 5, labels: ['agent-failed'], closed: true }]);
  fs.mkdirSync(e.cfg.stateDir, { recursive: true });
  fs.writeFileSync(path.join(e.cfg.stateDir, 'runs.jsonl'), JSON.stringify({ id: 'abcd1234', project: 'app', ticket: 2, status: 'verify-failed', error: 'tests failed', finished: new Date().toISOString() }) + '\n');
  const inbox = await e.inbox();
  assert.deepEqual(inbox.counts, { decisions: 2, reviews: 1 });
  assert.deepEqual(inbox.items.map((i) => i.kind), ['decision', 'decision', 'review']); assert.deepEqual(inbox.items.map((i) => i.id).sort(), [1, 2, 3]); // decisions first
  const f = inbox.items.find((i) => i.id === 2); assert.equal(f.run.status, 'verify-failed'); assert.match(f.comments.at(-1).body, /gave up/); assert.ok(f.body);
  assert.equal(inbox.items.find((i) => i.id === 3).pr.number, 9); assert.equal((await e.inboxCount()).count, 3);
});

test('requeue: vague tickets are refused with advice; adding detail fixes and requeues; labels and overlay are reset', async () => {
  const { e, read } = setup([vague]);
  await assert.rejects(e.ticketAction('app', 1, 'requeue', {}), /Still too vague/);
  assert.deepEqual(read()[0].labels, ['agent-needs-info']);                                                    // untouched on refusal
  await assert.rejects(e.ticketAction('app', 1, 'requeue', { details: 'more please' }), /Still too vague/);
  const r = await e.ticketAction('app', 1, 'requeue', { details: 'Add an exported `improve(list)` function to math.js that returns a sorted copy of list, without mutating the input, and add tests for it.' });
  assert.equal(r.requeued, true); const t = read()[0];
  assert.deepEqual(t.labels, ['agent-ready']); assert.match(t.body, /Improve it\n\n---\nAdditional detail:\nAdd an exported `improve/); assert.match(t.comments.at(-1), /requeued by you with extra detail/);
  e.outcomes.set('app#1', { status: 'needs-info', at: Date.now() }); await e.ticketAction('app', 1, 'requeue', {}); assert.equal(e.outcomes.has('app#1'), false);
});

test('requeue of an already-clear failed ticket needs no new detail and clears the failure label', async () => {
  const { e, read } = setup([failed]);
  assert.equal((await e.ticketAction('app', 2, 'requeue', {})).requeued, true); assert.deepEqual(read()[0].labels, ['agent-ready']);
});

test('comment, update and close act on the tracker; inputs are validated', async () => {
  const { e, read } = setup([failed]);
  await e.ticketAction('app', 2, 'comment', { text: 'Use exponential backoff.' }); assert.equal(read()[0].comments.at(-1), 'Use exponential backoff.');
  await e.ticketAction('app', 2, 'update', { title: 'Add retry with backoff' }); assert.equal(read()[0].title, 'Add retry with backoff');
  await assert.rejects(e.ticketAction('app', 2, 'comment', { text: '   ' }), /Text is required/); await assert.rejects(e.ticketAction('app', 2, 'update', {}), /Nothing to update/);
  await assert.rejects(e.ticketAction('app', '../x', 'close'), /Invalid ticket id/); await assert.rejects(e.ticketAction('app', 2, 'explode'), /Unknown action/); await assert.rejects(e.ticketAction('nope', 2, 'close'), /No such project/);
  await e.ticketAction('app', 2, 'close'); assert.equal(read()[0].closed, true); assert.equal((await e.inbox()).items.length, 0);
});

test('API: inbox, count and ticket actions are authenticated and routed', async () => {
  const { e } = setup([vague, review]); const TOKEN = 'inbox-token-0123456789-abcdefghij';
  const a = createServer(e, { token: TOKEN, allowedHosts: [] }); await new Promise((r) => a.listen(0, '127.0.0.1', r)); const port = a.address().port; a.close();
  const srv = createServer(e, { token: TOKEN, allowedHosts: hostsFor('127.0.0.1', port) }); await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const call = (p, body, token = TOKEN) => fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call('/api/inbox', null, null)).status, 401);
  assert.equal((await (await call('/api/inbox')).json()).counts.decisions, 1); assert.equal((await (await call('/api/inbox/count')).json()).count, 2);
  const bad = await call('/api/projects/app/tickets/1/requeue', {}); assert.equal(bad.status, 400); assert.match((await bad.json()).error, /Still too vague/);
  assert.equal((await call('/api/projects/app/tickets/1/comment', { text: 'hi' })).status, 200);
  assert.equal((await call('/api/projects/app/tickets/1/explode', {})).status, 404);
  srv.closeAllConnections(); srv.close();
});

test('GitHub get/update/close: trusted authors only, comment thread with factory comments flagged', async () => {
  const calls = []; const issue = { number: 5, title: 'T', body: 'B', labels: [{ name: 'agent-needs-info' }], user: { login: 'me' }, html_url: 'https://github.com/o/r/issues/5', state: 'open', updated_at: 'U' };
  const exec = async (_c, args) => { calls.push(args.join(' ')); if (/issues\/5\/comments/.test(args[1] ?? '')) return { code: 0, out: JSON.stringify([{ user: { login: 'me' }, body: 'agent-factory did not start work', created_at: 'a' }, { user: { login: 'me' }, body: 'my note', created_at: 'b' }]) }; if (/issues\/6/.test(args.join(' '))) return { code: 0, out: JSON.stringify({ ...issue, number: 6, user: { login: 'stranger' } }) }; return { code: 0, out: JSON.stringify(issue) }; };
  const t = githubTickets({ repo: 'o/r', allowedAuthors: ['me'], exec });
  const g = await t.get(5); assert.deepEqual(g.comments.map((c) => c.factory), [true, false]); assert.equal(g.body, 'B');
  await t.update(5, { body: 'new' }); assert.ok(calls.some((c) => /-X PATCH repos\/o\/r\/issues\/5 -f body=new/.test(c)));
  await t.close(5); assert.ok(calls.some((c) => /-f state=closed/.test(c)));
  await assert.rejects(t.get(6), /not created by an allowed author/); await assert.rejects(t.update(6, { body: 'x' }), /not created by an allowed author/);
});

test('Jira get returns the comment thread; close is honestly unsupported', async () => {
  const f = async (url, init) => res(200, { key: 'PRJ-1', fields: { summary: 'S', description: 'D', labels: ['agent-failed'], reporter: { accountId: 'a1' }, status: { statusCategory: { key: 'new' } }, updated: 'U', comment: { comments: [{ author: { displayName: 'Bot' }, body: 'agent-factory gave up', created: 'c' }] } } });
  const t = jiraTickets({ baseUrl: 'https://x.atlassian.net', projectKey: 'PRJ', email: 'e', token: 't', allowedReporters: ['a1'], fetchImpl: f });
  const g = await t.get('PRJ-1'); assert.equal(g.comments[0].factory, true); assert.equal(g.body, 'D'); await assert.rejects(t.close('PRJ-1'), /not supported for Jira/);
  await assert.rejects(jiraTickets({ baseUrl: 'https://x.atlassian.net', projectKey: 'PRJ', email: 'e', token: 't', allowedReporters: ['someone'], fetchImpl: f }).get('PRJ-1'), /not created by an allowed reporter/);
});
