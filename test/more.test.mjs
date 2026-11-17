import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { tick } from '../src/factory.mjs';
import { feedbackTick, feedbackPrompt } from '../src/feedback.mjs';
import { leaseStore, recover } from '../src/leases.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';
import { ossiconeTickets } from '../src/adapters/tickets-ossicone.mjs';
import { sandbox } from '../src/adapters/sandbox.mjs';
import { agents } from '../src/adapters/agents.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fm-'));
function remoteRepo(root) {
  const remote = path.join(root, 'remote.git'); const seed = path.join(root, 'seed');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(root, 'init', '--bare', '-b', 'main', remote);
  fs.mkdirSync(seed); git(seed, 'init', '-b', 'main'); git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'hello\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_COMMITTER_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_EMAIL: 't@t' });
  return { remote, git };
}

test('lease recovery requeues orphaned ticket, then gives up after maxRecoveries', async () => {
  const root = tmp(); const p = path.join(root, 't.json');
  fs.writeFileSync(p, JSON.stringify([{ id: 1, title: 'x', labels: ['agent-working'] }]));
  const tickets = fileTickets(p); const leases = leaseStore(path.join(root, 's'));
  let r = await recover({ tickets, leases, maxRecoveries: 1 });
  assert.deepEqual(r, [{ ticket: 1, action: 'requeued' }]);
  assert.ok(JSON.parse(fs.readFileSync(p))[0].labels.includes('agent-ready'));
  await tickets.label(1, ['agent-working'], ['agent-ready']); // simulates a second crash
  r = await recover({ tickets, leases, maxRecoveries: 1 });
  assert.deepEqual(r, [{ ticket: 1, action: 'failed' }]);
});

test('live lease is not recovered', async () => {
  const root = tmp(); const p = path.join(root, 't.json');
  fs.writeFileSync(p, JSON.stringify([{ id: 1, title: 'x', labels: ['agent-working'] }]));
  const leases = leaseStore(path.join(root, 's')); leases.acquire(1, 60000);
  assert.deepEqual(await recover({ tickets: fileTickets(p), leases }), []);
});

test('tick releases lease and recovers orphan in same pass', async () => {
  const root = tmp(); const { remote } = remoteRepo(root); const p = path.join(root, 't.json');
  fs.writeFileSync(p, JSON.stringify([{ id: 1, title: 'a', body: '', labels: ['agent-working'] }, { id: 2, title: 'b', body: '', labels: ['agent-ready'] }]));
  const recs = await tick({ tickets: fileTickets(p), sandbox: sandbox({ kind: 'local' }), agent: agents.shell({ command: 'echo hi > b.txt' }),
    vcs: gitVcs({ openPr: false }), config: { cloneUrl: remote, maxConcurrent: 1, timeoutMs: 20000, gate: false }, stateDir: path.join(root, 's') });
  assert.ok(recs.some((r) => r.status === 'recovered-requeued' && r.ticket === 1));
  assert.ok(recs.some((r) => r.status === 'ok' && r.ticket === 1));
  assert.equal(leaseStore(path.join(root, 's')).isLive(1), false);
});

// Fake PR host: scripted feedback.
function fakeHost(pr, fbSeq) {
  const log = { comments: [], labels: [] };
  return { log,
    listAgentPrs: async () => [pr],
    getFeedback: async () => fbSeq.shift() ?? { failedChecks: [], pending: false, comments: [] },
    comment: async (_p, t) => log.comments.push(t), label: async (_p, l) => log.labels.push(l) };
}
async function prFixture(agentCmd) {
  const root = tmp(); const { remote, git } = remoteRepo(root);
  const seed = path.join(root, 'seed'); git(seed, 'checkout', '-b', 'agent/1-x'); fs.writeFileSync(path.join(seed, 'b.txt'), 'v1\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'v1'); git(seed, 'push', 'origin', 'agent/1-x');
  const sha = git(seed, 'rev-parse', 'HEAD').toString().trim();
  const pr = { number: 7, branch: 'agent/1-x', sha, title: 'T' };
  fs.mkdirSync(path.join(root, 's'), { recursive: true });
  fs.writeFileSync(path.join(root, 's', 'runs.jsonl'), JSON.stringify({ ticket: 1, pr: 'https://github.com/o/r/pull/7', finished: '2020-01-01T00:00:00Z' }) + '\n'); // a PR the factory opened
  const deps = { sandbox: sandbox({ kind: 'local' }), agent: agents.shell({ command: agentCmd }), vcs: gitVcs({ openPr: false }),
    config: { cloneUrl: remote, maxFeedbackRounds: 2, timeoutMs: 20000, maxAttempts: 1 }, stateDir: path.join(root, 's') };
  return { pr, deps, remote };
}

test('feedback: review comment triggers a push to the same branch; comment is not re-handled', async () => {
  const { pr, deps, remote } = await prFixture('echo v2 >> b.txt');
  const c = { id: 'c1', author: 'me', body: 'please add v2', raw: 'please add v2' };
  const host = fakeHost(pr, [{ failedChecks: [], pending: false, comments: [c] }, { failedChecks: [], pending: false, comments: [c] }]);
  const [r1] = await feedbackTick({ ...deps, host }); assert.equal(r1.status, 'ok');
  assert.match(execFileSync('git', ['show', 'agent/1-x:b.txt'], { cwd: remote }).toString(), /v2/);
  assert.deepEqual(await feedbackTick({ ...deps, host }), []); // same comment id already seen
});

test('feedback: failed CI on new sha triggers once; pending CI waits; cap escalates to human', async () => {
  const { pr, deps } = await prFixture('echo fix >> b.txt');
  const fail = { failedChecks: [{ name: 'ci', log: 'boom' }], pending: false, comments: [] };
  const host = fakeHost(pr, [{ ...fail, pending: true }, fail, fail]);
  assert.deepEqual(await feedbackTick({ ...deps, host }), []);               // pending -> wait
  assert.equal((await feedbackTick({ ...deps, host }))[0].status, 'ok');     // fail -> round 1
  assert.deepEqual(await feedbackTick({ ...deps, host }), []);               // same sha already handled
  // two more distinct failures exhaust the cap (2)
  host.getFeedback = async () => fail;
  await feedbackTick({ ...deps, host }, ); pr.sha = 'new1';
  assert.equal((await feedbackTick({ ...deps, host }))[0].status, 'ok'); pr.sha = 'new2';
  assert.equal((await feedbackTick({ ...deps, host }))[0].status, 'capped');
  assert.deepEqual(host.log.labels, ['agent-needs-human']);
});

test('feedbackPrompt includes failing logs and comments', () => {
  const p = feedbackPrompt({ number: 1, title: 'T' }, { failedChecks: [{ name: 'ci', log: 'LOGLINE' }], newComments: [{ author: 'a', body: 'BODY' }] });
  assert.match(p, /LOGLINE/); assert.match(p, /BODY/);
});

test('claudeContainer refuses non-docker sandbox and missing credentials', async () => {
  const a = agents.claudeContainer({ env: {} });
  await assert.rejects(a.run({ kind: 'local' }, {}, 'p', {}), /docker/);
  await assert.rejects(a.run({ kind: 'docker' }, {}, 'p', {}), /ANTHROPIC_API_KEY/);
  let seen; const sb = { kind: 'docker', exec: async (_w, cmd, args, o) => { seen = { cmd, args, o }; return { code: 0, out: '' }; } };
  await agents.claudeContainer({ env: { ANTHROPIC_API_KEY: 'k' } }).run(sb, {}, 'p', { timeoutMs: 5 });
  assert.equal(seen.cmd, 'claude'); assert.equal(seen.o.env.ANTHROPIC_API_KEY, 'k'); assert.ok(!seen.args.join(' ').includes('k '));
});

test('ossicone adapter: filters by reporter+label, patches labels/status, posts comments', async () => {
  const issues = { 1: { id: 1, title: 'A', description: 'd', labels: ['agent-ready'], reporterId: 5 },
                   2: { id: 2, title: 'B', description: 'd', labels: ['agent-ready'], reporterId: 99 },
                   4: { id: 4, title: 'D', description: 'd', labels: ['agent-ready'], reporter: { id: 5 } },
                   3: { id: 3, title: 'C', description: 'd', labels: ['agent-working'], reporterId: 5 } };
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    seen.push({ m: req.method, u: req.url, auth: req.headers.authorization, b: b && JSON.parse(b) });
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url.startsWith('/api/issues?')) return send(Object.values(issues));
    const m = /^\/api\/issues\/(\d+)$/.exec(req.url);
    if (m && req.method === 'GET') return send(issues[m[1]]);
    if (m && req.method === 'PATCH') { Object.assign(issues[m[1]], JSON.parse(b)); return send(issues[m[1]]); }
    if (req.url === '/api/comments') return send({ id: 1 });
    res.statusCode = 404; res.end('no'); }); });
  await new Promise((r) => srv.listen(0, r));
  const t = ossiconeTickets({ baseUrl: `http://127.0.0.1:${srv.address().port}`, token: 'tok', projectId: 1, allowedReporterIds: [5] });
  assert.deepEqual((await t.poll()).map((x) => x.id), [1, 4]);          // 2 rejected (reporter), 3 rejected (working)
  assert.deepEqual((await t.listWorking()).map((x) => x.id), [3]);
  await t.label(1, ['agent-working'], ['agent-ready']);
  assert.deepEqual(issues[1].labels, ['agent-working']); assert.equal(issues[1].status, 'in_progress');
  await t.comment(1, 'hi');
  assert.ok(seen.every((s) => s.auth === 'Bearer tok'));
  assert.deepEqual(seen.at(-1).b, { content: 'hi', issueId: 1 });
  srv.close();
});

test('feedback: comments on a PR the factory did not open are baselined, not replayed; its own PRs still react', async () => {
  const { pr, deps } = await prFixture('echo v2 >> b.txt');
  fs.rmSync(path.join(deps.stateDir, 'runs.jsonl')); // not ours
  const old = { id: 'c1', author: 'me', body: 'old comment', raw: 'old comment' };
  const host = fakeHost(pr, [{ failedChecks: [], pending: false, comments: [old] }, { failedChecks: [], pending: false, comments: [old, { id: 'c2', author: 'me', body: 'new one', raw: 'new one' }] }]);
  assert.deepEqual(await feedbackTick({ ...deps, host }), []);                        // pre-existing comment: ignored
  assert.equal((await feedbackTick({ ...deps, host }))[0].status, 'ok');              // genuinely new comment: handled
  // a PR recorded in the run log as ours is NOT baselined
  const ours = await prFixture('echo v2 >> b.txt');
  fs.mkdirSync(ours.deps.stateDir, { recursive: true });
  fs.writeFileSync(path.join(ours.deps.stateDir, 'runs.jsonl'), JSON.stringify({ ticket: 1, pr: 'https://github.com/o/r/pull/7', finished: new Date().toISOString() }) + '\n');
  const host2 = fakeHost(ours.pr, [{ failedChecks: [], pending: false, comments: [old] }]);
  assert.equal((await feedbackTick({ ...ours.deps, host: host2 }))[0].status, 'ok');
});

import { parseNeedsInfo, parseAssumptions } from '../src/triage.mjs';
import { buildPrompt } from '../src/factory.mjs';

test('triage: NEEDS_INFO only counts on the first line; assumptions are extracted', () => {
  assert.equal(parseNeedsInfo('NEEDS_INFO: Which file should it go in?\nAnd what should it say?'), 'Which file should it go in?\nAnd what should it say?');
  assert.equal(parseNeedsInfo('  NEEDS_INFO:\n1. Faster how?'), '1. Faster how?');
  assert.match(parseNeedsInfo('NEEDS_INFO:'), /did not say what/);
  assert.equal(parseNeedsInfo('Done. I did not need NEEDS_INFO: here.'), null);
  assert.equal(parseNeedsInfo('Added the file.\n\nNEEDS_INFO: ignored because it is not the first line'), null);
  assert.equal(parseNeedsInfo(''), null); assert.equal(parseNeedsInfo(undefined), null);
  assert.equal(parseAssumptions('Added notes.txt.\n\nAssumptions:\n- file is named notes.txt\n- root means the repo root'), '- file is named notes.txt\n- root means the repo root');
  assert.equal(parseAssumptions('**Assumptions:**\n- one'), '- one'); assert.equal(parseAssumptions('No such section here.'), null); assert.equal(parseAssumptions('Assumptions:'), null);
});

test('prompt: tells the agent to proceed on reasonable assumptions and to ask specific questions only when truly open-ended', () => {
  const p = buildPrompt({ id: 1, title: 'T', body: 'B' });
  assert.match(p, /JUST DO IT/); assert.match(p, /Assumptions:/); assert.match(p, /NEEDS_INFO:/); assert.match(p, /Do not ask about things you can reasonably decide yourself/); assert.match(p, /untrusted data/);
});
