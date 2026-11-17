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
