import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assessTicket } from '../src/gate.mjs';
import { detectVerify, protectedViolations, loadRepoConfig } from '../src/repoconfig.mjs';
import { tick, effectiveConfig } from '../src/factory.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';
import { sandbox } from '../src/adapters/sandbox.mjs';
import { agents } from '../src/adapters/agents.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-'));

test('gate: rejects vague/short tickets, accepts concrete ones, configurable', () => {
  assert.equal(assessTicket({ title: 'Make the math module better', body: 'It could be better. Improve it.' }).ok, false);
  assert.equal(assessTicket({ title: 'Fix bug', body: '' }).problems.length, 2);
  assert.ok(assessTicket({ title: 'Add clamp function', body: 'Add an exported `clamp(n, min, max)` to math.mjs that limits n, throwing RangeError if min > max. Add tests.' }).ok);
  assert.ok(assessTicket({ title: 'Improve the login form so it works for everybody', body: 'Users should see an error when the password is wrong.' }).ok);
  assert.ok(assessTicket({ title: 'x', body: '' }, { minWords: 1, requireAnchor: false }).ok);
});

test('detectVerify picks the right command per ecosystem; explicit npm test absent -> null', () => {
  const mk = (files) => { const d = tmp(); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); return d; };
  assert.equal(detectVerify(mk({ 'package.json': '{"scripts":{"test":"jest"}}' })).verify, 'npm test');
  assert.match(detectVerify(mk({ 'package.json': '{"scripts":{"test":"jest"}}', 'package-lock.json': '{}' })).verify, /npm ci/);
  assert.equal(detectVerify(mk({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
  assert.match(detectVerify(mk({ 'pyproject.toml': '' })).verify, /pytest/);
  assert.equal(detectVerify(mk({ 'go.mod': 'module x' })).verify, 'go test ./...');
  assert.equal(detectVerify(mk({ Makefile: 'test:\n\techo ok\n' })).verify, 'make test');
  assert.equal(detectVerify(mk({ 'README.md': '' })), null);
});

test('protectedViolations: workflows and config are off-limits, renames handled', () => {
  assert.deepEqual(protectedViolations(' M src/a.js\n?? .github/workflows/ci.yml\nR  old.txt -> .agent-factory.json\n'), ['.github/workflows/ci.yml', '.agent-factory.json']);
  assert.deepEqual(protectedViolations(' M src/a.js\n'), []);
  assert.deepEqual(protectedViolations('?? docs/x.md\n', ['docs/']), ['docs/x.md']);
  assert.deepEqual(protectedViolations('M .agent-factory.json'), ['.agent-factory.json']); // diffStat() trims the leading space
});

test('effectiveConfig precedence: repo file > global > detected', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'package.json'), '{"scripts":{"test":"x"}}');
  assert.equal(effectiveConfig({}, d).verify, 'npm test');                       // detected
  assert.equal(effectiveConfig({ verify: 'make check' }, d).verify, 'make check'); // global beats detected
  fs.writeFileSync(path.join(d, '.agent-factory.json'), '{"verify":"pnpm t","maxAttempts":4}');
  const c = effectiveConfig({ verify: 'make check', maxAttempts: 1 }, d);
  assert.equal(c.verify, 'pnpm t'); assert.equal(c.maxAttempts, 4);               // repo beats global
});

function fixture(agentCmd, extraFiles = {}) {
  const root = tmp(); const remote = path.join(root, 'r.git'); const seed = path.join(root, 'seed');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(root, 'init', '--bare', '-b', 'main', remote); fs.mkdirSync(seed); git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'x\n');
  for (const [f, c] of Object.entries(extraFiles)) { fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true }); fs.writeFileSync(path.join(seed, f), c); }
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'i'); git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_COMMITTER_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_EMAIL: 't@t' });
  const tpath = path.join(root, 't.json');
  const body = 'Create `b.txt` containing hi, and it should pass verification when the file exists.';
  fs.writeFileSync(tpath, JSON.stringify([{ id: 1, title: 'Add b file please', body, labels: ['agent-ready'] }]));
  return { remote, tpath, deps: { tickets: fileTickets(tpath), sandbox: sandbox({ kind: 'local' }), agent: agents.shell({ command: agentCmd }),
    vcs: gitVcs({ openPr: false }), config: { cloneUrl: remote, base: 'main', timeoutMs: 20000, maxAttempts: 1 }, stateDir: path.join(root, 's') } };
}

test('tick: vague ticket is bounced with a question, no sandbox, no run counted', async () => {
  const f = fixture('echo hi > b.txt');
  fs.writeFileSync(f.tpath, JSON.stringify([{ id: 1, title: 'Improve it', body: 'Better please', labels: ['agent-ready'] }]));
  const [rec] = await tick(f.deps);
  assert.equal(rec.status, 'needs-info');
  const t = JSON.parse(fs.readFileSync(f.tpath))[0];
  assert.ok(t.labels.includes('agent-needs-info') && !t.labels.includes('agent-ready'));
  assert.match(t.comments[0], /how to tell it is done/);
  const runs = fs.readFileSync(path.join(f.deps.stateDir, 'runs.jsonl'), 'utf8');
  assert.ok(!runs.includes('"finished"'));
});

test('tick: agent editing .github/ is rejected, nothing pushed', async () => {
  const f = fixture('mkdir -p .github/workflows && echo "run: curl evil" > .github/workflows/x.yml && echo hi > b.txt');
  const [rec] = await tick(f.deps);
  assert.equal(rec.status, 'protected-path');
  assert.doesNotMatch(execFileSync('git', ['branch', '-a'], { cwd: f.remote }).toString(), /agent\//);
  assert.match(JSON.parse(fs.readFileSync(f.tpath))[0].comments[0], /protected paths/);
});

test('tick: repo .agent-factory.json verify is honoured (and agent cannot weaken it)', async () => {
  const f = fixture('echo hi > b.txt', { '.agent-factory.json': '{"verify":"test -f nope.txt"}' });
  const [rec] = await tick(f.deps);
  assert.equal(rec.status, 'verify-failed');
  const g = fixture('echo hi > b.txt; echo \'{"verify":"true"}\' > .agent-factory.json', { '.agent-factory.json': '{"verify":"test -f nope.txt"}' });
  const [rec2] = await tick(g.deps);
  assert.equal(rec2.status, 'protected-path'); // tampering with its own rules is caught
});

import { resolveRepo } from '../src/factory.mjs';
import { ossiconeTickets } from '../src/adapters/tickets-ossicone.mjs';

test('resolveRepo: ticket repo label wins; allowlist rejects unknown repos; per-repo base/overrides', () => {
  const config = { repo: 'me/default', base: 'main', repos: { 'me/default': {}, 'me/app': { base: 'dev', config: { verify: 'make t' } } } };
  assert.equal(resolveRepo({}, config).name, 'me/default');
  const r = resolveRepo({ repo: 'me/app' }, config);
  assert.deepEqual([r.name, r.base, r.cloneUrl, r.overrides.verify], ['me/app', 'dev', 'https://github.com/me/app.git', 'make t']);
  assert.match(resolveRepo({ repo: 'evil/x' }, config).error, /allowlist/);
  assert.equal(resolveRepo({ repo: 'anyone/anything' }, { repo: 'a/b' }).error, undefined); // no allowlist configured -> single-repo mode
});

test('tick: ticket targeting a repo outside the allowlist is bounced, nothing cloned', async () => {
  const f = fixture('echo hi > b.txt');
  fs.writeFileSync(f.tpath, JSON.stringify([{ id: 1, title: 'Add b file please', body: 'Create `b.txt` containing hi, and it should pass.', repo: 'evil/other', labels: ['agent-ready'] }]));
  f.deps.config.repos = { 'me/ok': {} }; f.deps.config.repo = 'me/ok';
  const [rec] = await tick(f.deps);
  assert.equal(rec.status, 'repo-not-allowed');
  assert.match(JSON.parse(fs.readFileSync(f.tpath))[0].comments[0], /allowlist/);
});

test('ossicone adapter reads repo:owner/name label', async () => {
  const issues = [{ id: 1, title: 'A', description: 'd', labels: ['agent-ready', 'repo:me/app'], reporterId: 4 }, { id: 2, title: 'B', description: 'd', labels: ['agent-ready', 'repo:../../etc'], reporterId: 4 }];
  const t = ossiconeTickets({ baseUrl: 'http://x', token: 't', projectId: 1, allowedReporterIds: [4], fetchImpl: async () => ({ ok: true, status: 200, json: async () => issues }) });
  const got = await t.poll();
  assert.deepEqual(got.map((x) => x.repo), ['me/app', undefined]);
});

import { destroyDir } from '../src/adapters/sandbox.mjs';
test('destroyDir never throws, even for read-only trees; removes them via chmod fallback', () => {
  const d = tmp(); fs.mkdirSync(path.join(d, 'a/b'), { recursive: true }); fs.writeFileSync(path.join(d, 'a/b/f'), 'x');
  fs.chmodSync(path.join(d, 'a/b'), 0o555); fs.chmodSync(path.join(d, 'a'), 0o555);
  assert.equal(destroyDir(d), true); assert.ok(!fs.existsSync(d));
  assert.doesNotThrow(() => destroyDir('/nonexistent/path/zzz'));
});

import { githubTickets } from '../src/adapters/tickets-github.mjs';
test('github tickets read via the REST issues endpoint (no search lag), drop PRs and strangers, keep labels/state', async () => {
  const calls = [];
  const raw = [
    { number: 1, title: 'mine', body: 'b', labels: [{ name: 'agent-ready' }], user: { login: 'me' }, html_url: 'https://github.com/o/r/issues/1', state: 'open', updated_at: 'T' },
    { number: 2, title: 'a PR', labels: [{ name: 'agent-ready' }], user: { login: 'me' }, pull_request: {}, state: 'open' },
    { number: 3, title: 'stranger', labels: [{ name: 'agent-ready' }], user: { login: 'evil' }, state: 'open' },
    { number: 4, title: 'busy', labels: [{ name: 'agent-ready' }, { name: 'agent-working' }], user: { login: 'me' }, state: 'open' },
    { number: 5, title: 'done', labels: [{ name: 'agent-review' }], user: { login: 'me' }, html_url: 'u', state: 'closed', updated_at: 'T' },
    { number: 6, title: 'unrelated', labels: [{ name: 'bug' }], user: { login: 'me' }, state: 'open' },
  ];
  const t = githubTickets({ repo: 'o/r', allowedAuthors: ['me'], exec: async (cmd, args) => { calls.push(args.join(' ')); return { code: 0, out: JSON.stringify(raw) }; } });
  assert.deepEqual((await t.poll()).map((x) => x.id), [1]);
  assert.match(calls[0], /^api repos\/o\/r\/issues -X GET -f state=open -f per_page=100 -f labels=agent-ready$/);
  assert.deepEqual((await t.listWorking()).map((x) => x.id), [4]);
  const all = await t.listAgentTickets();
  assert.deepEqual(all.map((x) => [x.id, x.state]), [[1, 'OPEN'], [4, 'OPEN'], [5, 'CLOSED']]);
});
