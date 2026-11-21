import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseUsageLimit } from '../src/agentlimit.mjs';
import { tick } from '../src/factory.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';
import { sandbox } from '../src/adapters/sandbox.mjs';
import { agents } from '../src/adapters/agents.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';

test('the real usage-limit message is recognised and the reset time is read from it', () => {
  const out = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 4:12 AM.';
  const l = parseUsageLimit(out);
  assert.equal(l.retryAt, '4:12 AM');
  assert.ok(!l.message.includes('http'), 'links are stripped from the message that is shown');
  assert.ok(parseUsageLimit("You've hit your limit. Try again in 3 hours.")?.retryAt === '3 hours');
  assert.ok(parseUsageLimit('Usage limit reached'));
});

test('an agent merely talking about rate limiting in the code it wrote is not a usage limit', () => {
  assert.equal(parseUsageLimit('Added a rate limit: the endpoint returns 429 and Retry-After when the limit is exceeded; try again later is shown to users.'), null);
  assert.equal(parseUsageLimit('The user hit the limit of 100 events per minute, so the limiter rejects the request.'), null);
  assert.equal(parseUsageLimit(''), null);
  assert.equal(parseUsageLimit(undefined), null);
});

test('a run whose agent hit the limit opens no PR, pushes nothing, and parks the ticket with a clear comment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-')); const remote = path.join(root, 'remote.git'); const seed = path.join(root, 'seed');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(root, 'init', '--bare', '-b', 'main', remote); fs.mkdirSync(seed); git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't'); fs.writeFileSync(path.join(seed, 'a.txt'), 'hello\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'init'); git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
  const tpath = path.join(root, 'tickets.json'); fs.writeFileSync(tpath, JSON.stringify([{ id: 1, title: 'Add greeting', body: 'make b.txt', labels: ['agent-ready'] }]));
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't'; process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
  // The agent makes a small, valid-looking change (so verify would pass) and then reports the limit, exactly like the real incident.
  const cmd = "echo partial > b.txt; echo 'You have hit your usage limit. Try again at 4:12 AM.'";
  const [rec] = await tick({ tickets: fileTickets(tpath), sandbox: sandbox({ kind: 'local' }), agent: agents.shell({ command: cmd }), vcs: gitVcs({ openPr: false }),
    config: { cloneUrl: remote, base: 'main', maxAttempts: 2, timeoutMs: 20000, verify: 'test -f b.txt', gate: false }, stateDir: path.join(root, 'state') });
  assert.equal(rec.status, 'rate-limited'); assert.equal(rec.attempts, 1, 'no second attempt is wasted on a plan that is already exhausted');
  assert.equal(rec.retryAt, '4:12 AM'); assert.equal(rec.pr, undefined);
  assert.doesNotMatch(execFileSync('git', ['branch', '-a'], { cwd: remote }).toString(), /agent\//, 'nothing was pushed');
  const t = JSON.parse(fs.readFileSync(tpath))[0];
  assert.ok(t.labels.includes('agent-failed') && !t.labels.includes('agent-working') && !t.labels.includes('agent-review'));
  assert.match(JSON.stringify(t), /usage limit/);
});
