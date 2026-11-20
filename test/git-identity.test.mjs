import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitVcs } from '../src/adapters/vcs.mjs';

// A fresh machine: no ~/.gitconfig, no system config, no identity in the environment. (This is exactly what a clean-machine install test hit.)
const CLEAN = () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-home-')); return { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'none') }; };
const IDENT = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
async function withEnv(extra, fn) { const saved = { ...process.env }; for (const k of IDENT) delete process.env[k]; Object.assign(process.env, extra); try { return await fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); } }
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env } }).toString().trim();
function remoteAndWorkspace() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-')); const remote = path.join(root, 'r.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(root, 'seed'); execFileSync('git', ['init', '-q', '-b', 'main', seed]); fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n'); execFileSync('git', ['-c', 'user.name=s', '-c', 'user.email=s@s', 'add', '-A'], { cwd: seed }); execFileSync('git', ['-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '-qm', 'seed'], { cwd: seed }); execFileSync('git', ['push', '-q', remote, 'main'], { cwd: seed });
  const dir = path.join(root, 'ws'); execFileSync('git', ['clone', '-q', remote, dir]); execFileSync('git', ['checkout', '-qb', 'agent/1-x'], { cwd: dir }); fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n'); return { remote, dir }; }

test('a machine with no git identity can still commit and push: the agent commit gets a fallback author instead of failing', async () => {
  const { remote, dir } = remoteAndWorkspace();
  await withEnv(CLEAN(), async () => { await gitVcs({}).commitAndPush({ dir, cloneUrl: remote }, { branch: 'agent/1-x', message: 'Add b' }); });
  assert.equal(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%an <%ae>', 'agent/1-x']).toString().trim(), 'Agent Factory <agent-factory@localhost>');
});

test('an identity you have is never overridden: configured name and email are used, and only the missing half is filled in', async () => {
  const a = remoteAndWorkspace(); const cleanA = CLEAN(); fs.writeFileSync(cleanA.GIT_CONFIG_GLOBAL, '[user]\n\tname = Jo Dev\n\temail = jo@example.com\n');
  await withEnv(cleanA, async () => { await gitVcs({}).commitAndPush({ dir: a.dir, cloneUrl: a.remote }, { branch: 'agent/1-x', message: 'Add b' }); });
  assert.equal(execFileSync('git', ['--git-dir', a.remote, 'log', '-1', '--format=%an <%ae>', 'agent/1-x']).toString().trim(), 'Jo Dev <jo@example.com>');
  const b = remoteAndWorkspace(); const cleanB = CLEAN(); fs.writeFileSync(cleanB.GIT_CONFIG_GLOBAL, '[user]\n\tname = Only Name\n');
  await withEnv(cleanB, async () => { await gitVcs({}).commitAndPush({ dir: b.dir, cloneUrl: b.remote }, { branch: 'agent/1-x', message: 'Add b' }); });
  assert.equal(execFileSync('git', ['--git-dir', b.remote, 'log', '-1', '--format=%an <%ae>', 'agent/1-x']).toString().trim(), 'Only Name <agent-factory@localhost>', 'a configured name is kept; only the missing email is filled in');
  const c = remoteAndWorkspace(); await withEnv({ ...CLEAN(), GIT_AUTHOR_NAME: 'Env Dev', GIT_AUTHOR_EMAIL: 'env@example.com', GIT_COMMITTER_NAME: 'Env Dev', GIT_COMMITTER_EMAIL: 'env@example.com' }, async () => { await gitVcs({}).commitAndPush({ dir: c.dir, cloneUrl: c.remote }, { branch: 'agent/1-x', message: 'Add b' }); });
  assert.equal(execFileSync('git', ['--git-dir', c.remote, 'log', '-1', '--format=%an <%ae>', 'agent/1-x']).toString().trim(), 'Env Dev <env@example.com>', 'an identity from the environment counts too');
  void sh;
});
