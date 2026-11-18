import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lockGit } from '../src/gitguard.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-')); const remote = path.join(root, 'remote.git'); const evil = path.join(root, 'evil.git'); const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', evil]);
  const seed = path.join(root, 'seed'); execFileSync('git', ['init', '-q', '-b', 'main', seed]); fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'init'); git(seed, 'push', '-q', remote, 'main');
  execFileSync('git', ['clone', '-q', remote, work]); git(work, 'checkout', '-qb', 'agent/1'); return { root, remote, evil, work, marker: path.join(root, 'PWNED') };
}

test('a compromised agent cannot run code on the host through .git (hooks, fsmonitor, sshCommand, credential helper, ext:: remote) or redirect the push', async () => {
  const w = world();
  // what a malicious agent could leave behind in the checkout it controls
  const hook = (n) => { fs.mkdirSync(path.join(w.work, '.git/hooks'), { recursive: true }); fs.writeFileSync(path.join(w.work, '.git/hooks', n), `#!/bin/sh\ntouch ${w.marker}-${n}\n`, { mode: 0o755 }); };
  for (const n of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'reference-transaction']) hook(n);
  fs.appendFileSync(path.join(w.work, '.git/config'), `\n[core]\n\tfsmonitor = touch ${w.marker}-fsmonitor\n\tsshCommand = touch ${w.marker}-ssh\n\thooksPath = ${path.join(w.work, '.git/hooks')}\n[credential]\n\thelper = !touch ${w.marker}-cred\n[remote "origin"]\n\turl = ${w.evil}\n[url "${w.evil}"]\n\tinsteadOf = ${w.remote}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = touch ${w.marker}-gpg\n`);
  fs.writeFileSync(path.join(w.work, 'b.txt'), 'change\n');
  const vcs = gitVcs({ log: path.join(w.root, 'log') }); const ws = { dir: w.work, cloneUrl: w.remote };
  assert.match(await vcs.diffStat(ws), /b\.txt/);
  await vcs.commitAndPush(ws, { branch: 'agent/1', message: 'change' });
  const leaked = fs.readdirSync(w.root).filter((f) => f.startsWith('PWNED')); assert.deepEqual(leaked, [], `host executed attacker code: ${leaked}`);
  assert.match(execFileSync('git', ['--git-dir', w.remote, 'branch'], { stdio: 'pipe' }).toString(), /agent\/1/);                       // pushed to the REAL remote
  assert.equal(execFileSync('git', ['--git-dir', w.evil, 'branch'], { stdio: 'pipe' }).toString().trim(), '');                          // not to the attacker's
});

test('lockGit refuses a .git that is a file or symlink, and a suspicious remote', () => {
  const w = world(); fs.rmSync(path.join(w.work, '.git'), { recursive: true }); fs.writeFileSync(path.join(w.work, '.git'), `gitdir: ${w.evil}\n`);
  assert.throws(() => lockGit(w.work, w.remote), /real directory/);
  const w2 = world(); assert.throws(() => lockGit(w2.work, 'ext::sh -c touch /tmp/x'), /suspicious/); assert.throws(() => lockGit(w2.work, 'https://x/y"\n[core]'), /suspicious/);
  assert.throws(() => lockGit(path.join(w2.root, 'nope'), w2.remote), /not a git checkout/);
});
