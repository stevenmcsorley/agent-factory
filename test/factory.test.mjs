import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tick } from '../src/factory.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';
import { sandbox } from '../src/adapters/sandbox.mjs';
import { agents } from '../src/adapters/agents.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';

// End-to-end with a local bare "remote", local sandbox, and a scripted shell agent. No network, no LLM.
function setup(agentCmd, verify) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(root, 'init', '--bare', '-b', 'main', remote);
  fs.mkdirSync(seed); git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'hello\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'init'); git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
  const tpath = path.join(root, 'tickets.json');
  fs.writeFileSync(tpath, JSON.stringify([{ id: 1, title: 'Add greeting', body: 'make b.txt', labels: ['agent-ready'] }]));
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
  const deps = {
    tickets: fileTickets(tpath),
    sandbox: sandbox({ kind: 'local' }),
    agent: agents.shell({ command: agentCmd }),
    vcs: gitVcs({ openPr: false }),
    config: { cloneUrl: remote, base: 'main', maxAttempts: 2, timeoutMs: 20000, verify, gate: false },
    stateDir: path.join(root, 'state'),
  };
  return { deps, remote, tpath };
}

test('happy path: agent edits, verify passes, branch pushed, ticket relabelled', async () => {
  const { deps, remote, tpath } = setup('echo hi > b.txt', 'test -f b.txt');
  const [rec] = await tick(deps);
  assert.equal(rec.status, 'ok');
  assert.match(execFileSync('git', ['branch', '-a'], { cwd: remote }).toString(), /agent\/1-add-greeting/);
  const t = JSON.parse(fs.readFileSync(tpath))[0];
  assert.ok(t.labels.includes('agent-review') && !t.labels.includes('agent-working'));
});

test('verify failure exhausts attempts and marks ticket failed, nothing pushed', async () => {
  const { deps, remote, tpath } = setup('echo hi > b.txt', 'false');
  const [rec] = await tick(deps);
  assert.equal(rec.status, 'verify-failed');
  assert.equal(rec.attempts, 2); // maxAttempts, not maxAttempts+1
  assert.doesNotMatch(execFileSync('git', ['branch', '-a'], { cwd: remote }).toString(), /agent\//);
  assert.ok(JSON.parse(fs.readFileSync(tpath))[0].labels.includes('agent-failed'));
});

test('no-change agent is not delivered', async () => {
  const { deps } = setup('true', undefined);
  const [rec] = await tick(deps);
  assert.equal(rec.status, 'no-change');
});

test('STOP file halts the factory', async () => {
  const { deps } = setup('echo hi > b.txt', undefined);
  fs.mkdirSync(deps.stateDir, { recursive: true });
  fs.writeFileSync(path.join(deps.stateDir, 'STOP'), '');
  const [rec] = await tick(deps);
  assert.equal(rec.status, 'stopped');
});

import { gitVcs as gitVcs2 } from '../src/adapters/vcs.mjs';
test('agent answers NEEDS_INFO: no changes pushed, the specific question lands on the ticket, state is needs-info', async () => {
  const { deps, remote, tpath } = setup('echo "NEEDS_INFO: Faster how? Which operation is slow, and what is the target time?"', undefined);
  deps.config.gate = false; const [rec] = await tick(deps);
  assert.equal(rec.status, 'needs-info'); assert.match(rec.question, /Which operation is slow/);
  const t = JSON.parse(fs.readFileSync(tpath))[0];
  assert.ok(t.labels.includes('agent-needs-info') && !t.labels.includes('agent-working')); assert.match(t.comments.at(-1), /needs a little more information[\s\S]*Which operation is slow[\s\S]*inbox/);
  assert.doesNotMatch(execFileSync('git', ['branch', '-a'], { cwd: remote }).toString(), /agent\//);
});

test('agent proceeds on reasonable assumptions: they are put in the PR body and on the ticket', async () => {
  let pr; const { deps, tpath } = setup("echo hi > b.txt; printf 'Created b.txt.\\n\\nAssumptions:\\n- the file is named b.txt\\n- it lives in the repo root\\n'", 'test -f b.txt');
  deps.vcs = gitVcs2({ openPr: (a) => { pr = a; return 'https://example.test/pr/1'; } }); deps.config.gate = false;
  const [rec] = await tick(deps);
  assert.equal(rec.status, 'ok'); assert.match(rec.assumptions, /named b\.txt/); assert.match(pr.body, /### Assumptions the agent made\n- the file is named b\.txt/);
  assert.match(JSON.parse(fs.readFileSync(tpath))[0].comments.at(-1), /Assumptions the agent made \(please check\):\n- the file is named b\.txt/);
});

test('a normal summary that merely mentions NEEDS_INFO is not a request for information', async () => {
  const { deps } = setup("echo hi > b.txt; echo 'Done. (Did not need NEEDS_INFO: this time.)'", 'test -f b.txt'); deps.config.gate = false;
  assert.equal((await tick(deps))[0].status, 'ok');
});

test('reviewer: blocking findings send the change back to the builder once, then it ships with the verdict recorded', async () => {
  const { deps } = setup('echo hi >> b.txt', 'test -f b.txt'); const seen = [];
  deps.config.review = async ({ ticket }) => { seen.push(ticket.id); return seen.length === 1 ? { verdict: 'changes', summary: 'No input check', findings: [{ severity: 'major', file: 'b.txt', issue: 'unchecked' }] } : { verdict: 'approve', summary: 'Fine', findings: [] }; };
  const [rec] = await tick(deps);
  assert.equal(rec.status, 'ok'); assert.equal(rec.attempts, 2); assert.equal(rec.review.verdict, 'approve'); assert.equal(seen.length, 2);
  assert.ok(rec.phases.some((p) => p.name === 'review'));
});

test('reviewer: still asking for changes on the last attempt means the PR opens flagged, never silently approved', async () => {
  const { deps } = setup('echo hi >> b.txt', 'test -f b.txt');
  deps.config.review = async () => ({ verdict: 'changes', summary: 'Wrong approach', findings: [{ severity: 'blocker', file: 'b.txt', issue: 'bad' }] });
  const [rec] = await tick(deps);
  assert.equal(rec.status, 'ok'); assert.equal(rec.review.verdict, 'changes');
});

test('reviewer: a crashing reviewer is "error", not an approval, and does not block the PR', async () => {
  const { deps } = setup('echo hi > b.txt', 'test -f b.txt');
  deps.config.review = async () => { throw new Error('reviewer exploded'); };
  const [rec] = await tick(deps);
  assert.equal(rec.status, 'ok'); assert.equal(rec.review.verdict, 'error'); assert.match(rec.review.summary, /exploded/);
});

test('without a reviewer the loop is exactly as before: no review phase, no review field', async () => {
  const { deps } = setup('echo hi > b.txt', 'test -f b.txt');
  const [rec] = await tick(deps); assert.equal(rec.review, undefined); assert.ok(!rec.phases.some((p) => p.name === 'review'));
});

const withBody = (tpath, body) => fs.writeFileSync(tpath, JSON.stringify([{ id: 1, title: 'Add greeting', body, labels: ['agent-ready'] }]));
test('allowed-files: a change outside the ticket\'s list is refused, nothing is pushed, and the agent is told what to put back', async () => {
  const { deps, remote, tpath } = setup('echo hi > b.txt; echo no > c.txt', 'test -f b.txt');
  withBody(tpath, 'Make b.txt say hi.\n\n```allowed-files\nb.txt\n```\n');
  const [rec] = await tick(deps);
  assert.equal(rec.status, 'outside-allowlist'); assert.match(rec.error, /c\.txt/); assert.equal(rec.attempts, 2);
  assert.doesNotMatch(execFileSync('git', ['branch', '-a'], { cwd: remote }).toString(), /agent\//);
});
test('allowed-files: globs allow what they name, and a ticket without the block is unrestricted', async () => {
  const a = setup('echo hi > b.txt', 'test -f b.txt'); withBody(a.tpath, 'Make b.txt say hi.\n\n```allowed-files\n*.txt\n```\n');
  assert.equal((await tick(a.deps))[0].status, 'ok');
  const b = setup('echo hi > b.txt; echo x > c.txt', 'test -f b.txt'); assert.equal((await tick(b.deps))[0].status, 'ok');
});
import { parseAllowedFiles, outsideAllowlist } from '../src/allowlist.mjs';
test('allowed-files parsing: comments, junk and path escapes are dropped', () => {
  assert.equal(parseAllowedFiles('no block here'), null);
  assert.deepEqual(parseAllowedFiles('x\n```allowed-files\n# why\nsrc/**\n../etc/passwd\n/abs.js\n\n```'), ['src/**', 'abs.js']);
  assert.deepEqual(outsideAllowlist(['src/a/b.js', 'docs/x.md', 'abs.js'], ['src/**', 'abs.js']), ['docs/x.md']);
  assert.deepEqual(outsideAllowlist(['lib/x.js', 'libs/y.js'], ['lib/']), ['libs/y.js']);
});

test('overlap: a ticket that declares files waits for an open PR touching them, and goes when that PR is gone', async () => {
  const { deps, tpath } = setup('echo hi > b.txt', 'test -f b.txt'); withBody(tpath, 'Make b.txt say hi.\n\n```allowed-files\nb.txt\n```\n');
  let open = [{ pr: 9, files: ['b.txt'] }]; let holds = [];
  deps.config.openChanges = async () => open; deps.config.setHolds = (h) => { holds = h; };
  assert.deepEqual(await tick(deps), []); assert.match(holds[0].reason, /waiting for PR #9.*b\.txt/); assert.equal(JSON.parse(fs.readFileSync(tpath))[0].labels[0], 'agent-ready');
  open = [{ pr: 9, files: ['docs/x.md'] }]; assert.equal((await tick(deps))[0].status, 'ok'); assert.deepEqual(holds, []);
});
test('overlap: tickets without a declared file list are never held', async () => {
  const { deps } = setup('echo hi > b.txt', 'test -f b.txt'); let asked = false; deps.config.openChanges = async () => { asked = true; return [{ pr: 9, files: ['b.txt'] }]; };
  assert.equal((await tick(deps))[0].status, 'ok'); assert.equal(asked, false, 'no look-up when nothing declares files');
});

test('visual: new problems go back to the builder once; a check that cannot run is recorded and never blocks', async () => {
  const a = setup('echo hi >> b.txt', 'test -f b.txt'); let n = 0;
  a.deps.config.visual = async ({ runId }) => { n++; assert.match(runId, /^[a-f0-9]{8}$/); return n === 1 ? { status: 'fail', summary: '1 new problem', findings: [{ severity: 'fail', route: '/', widths: [360], detail: 'Scrolls sideways' }], counts: { fail: 1, warn: 0, existing: 0 } } : { status: 'pass', summary: 'No new visual problems', findings: [], counts: { fail: 0, warn: 0, existing: 0 } }; };
  const [rec] = await tick(a.deps); assert.equal(rec.status, 'ok'); assert.equal(rec.attempts, 2); assert.equal(rec.visual.status, 'pass'); assert.ok(rec.phases.some((p) => p.name === 'visual'));
  const b = setup('echo hi > b.txt', 'test -f b.txt'); b.deps.config.visual = async () => { throw new Error('no browser image'); };
  const [r2] = await tick(b.deps); assert.equal(r2.status, 'ok'); assert.equal(r2.visual.status, 'error'); assert.match(r2.visual.summary, /no browser image/);
  const c = setup('echo hi > b.txt', 'test -f b.txt'); c.deps.config.visual = async () => ({ status: 'fail', summary: 'still broken', findings: [{ severity: 'fail', route: '/', widths: [360], detail: 'Scrolls sideways' }], counts: { fail: 1, warn: 0, existing: 0 } });
  const [r3] = await tick(c.deps); assert.equal(r3.status, 'ok', 'opens the PR on the last attempt, flagged'); assert.equal(r3.visual.status, 'fail');
});
