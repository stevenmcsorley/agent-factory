import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { tick } from '../src/factory.mjs';
import { initForge, localHost, forgeDir } from '../src/adapters/host-local.mjs';
import { validateScenario, startRun, advance } from '../src/scenarios.mjs';
import { createServer, hostsFor } from '../src/server.mjs';

const tmp = (p = 'fg-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
const bare = (repo, ...a) => execFileSync('git', ['--git-dir', repo, ...a], { stdio: 'pipe' }).toString().trim();
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };

function world() {
  const root = tmp(); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} });
  return { e, root, repo: () => path.join(forgeDir(e.cfg.stateDir, 'app'), 'repo.git') };
}
async function mkProject(w, host = { kind: 'local' }) { return w.e.addProject({ repo: 'app', id: 'app', host }); }
// One real factory run on the project: the agent (scripted) writes `files`; everything else (clone, commit, push, PR) is the real code.
async function build(w, title, files) {
  const p = w.e.project('app'); const d = w.e.deps(p); d.config.verify = false; d.config.maxAttempts = 1;
  d.sandbox = { create: async ({ cloneUrl, branch, base }) => { const dir = fs.mkdtempSync(path.join(w.root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); git(dir, 'checkout', '-qb', branch); return { dir, cloneUrl, destroy() {} }; }, exec: async () => ({ code: 0, out: '' }) };
  d.agent = { run: async (_sb, ws) => { for (const [f, c] of Object.entries(files)) write(path.join(ws.dir, f), c); return { out: 'done', costUsd: 0 }; } };
  await w.e.createTicket('app', { title, body: `${title}. Write it in a.js with a test that checks it works.` }); const [rec] = await tick(d); return rec;
}

test('initForge: an empty repo has one commit, the right branch and NO hooks; importing works from a folder; hostile or vague import sources are refused', async () => {
  const dir = tmp(); await initForge({ dir, base: 'trunk' }); const repo = path.join(dir, 'repo.git');
  assert.equal(bare(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'trunk'); assert.equal(bare(repo, 'rev-list', '--count', 'trunk'), '1'); assert.deepEqual(fs.existsSync(path.join(repo, 'hooks')) ? fs.readdirSync(path.join(repo, 'hooks')) : [], [], 'no sample hooks to run');
  await assert.rejects(initForge({ dir, base: 'trunk' }), /already has a local repository/); await assert.rejects(initForge({ dir: tmp(), base: 'bad branch!' }), /not a usable branch/);
  const src = tmp('src-'); execFileSync('git', ['init', '-q', '-b', 'main', src]); write(path.join(src, 'x.txt'), 'hello\n'); git(src, 'add', '-A'); git(src, 'commit', '-qm', 'one'); write(path.join(src, '.git/hooks/post-checkout'), '#!/bin/sh\ntouch /tmp/should-never-exist-af\n');
  const d2 = tmp(); await initForge({ dir: d2, base: 'main', importFrom: src }); const r2 = path.join(d2, 'repo.git'); assert.equal(bare(r2, 'show', 'main:x.txt'), 'hello'); assert.ok(!fs.existsSync(path.join(r2, 'hooks/post-checkout')), 'hooks are not imported'); assert.doesNotMatch(fs.readFileSync(path.join(r2, 'config'), 'utf8'), /remote/, 'the source URL is not kept in the repo');
  await assert.rejects(initForge({ dir: tmp(), importFrom: src, base: 'nope' }), /no "nope" branch \(it has "main"\)/);
  for (const bad of ['ext::sh -c touch /tmp/x', '--upload-pack=evil', 'relative/path', 'http://insecure.example/x.git']) await assert.rejects(initForge({ dir: tmp(), importFrom: bad }), /does not look like|Import from/, bad);
});

test('a local project end to end: created without any account, the factory builds into it, you see the diff, comment, and merge by fast-forward', async () => {
  const w = world(); const p = await mkProject(w); assert.deepEqual([p.repo, p.host, p.tickets, p.feedbackAuthors], ['local/app', { kind: 'local' }, { kind: 'local' }, ['you']]); assert.ok(fs.existsSync(w.repo()));
  const rec = await build(w, 'Add the a module', { 'a.js': 'export const a = 1;\n', 'a.test.js': "import test from 'node:test';\ntest('a', () => {});\n" }); assert.equal(rec.status, 'ok'); assert.equal(rec.pr, 'local-pr:app/pull/1'); assert.match(rec.commit, /^[0-9a-f]{40}$/);
  const prs = await w.e.listPrs('app'); assert.deepEqual(prs.map((x) => [x.number, x.branch, x.url]), [[1, 'agent/1-add-the-a-module', 'local-pr:app/pull/1']]);
  assert.match((await w.e.ticketDetail('app', 1)).comments.at(-1).body, /^Opened local-pr:app\/pull\/1 after 1 attempt/); assert.ok((await w.e.ticketDetail('app', 1)).labels.includes('agent-review'));
  const det = await w.e.prDetail('app', 1); assert.deepEqual(det.files.map((f) => [f.path, f.added]), [['a.js', 1], ['a.test.js', 2]]); assert.match(det.diff, /\+export const a = 1;/); assert.equal(det.pr.stale, false); assert.equal(det.pr.verifiedHead, rec.commit); assert.match(det.pr.body, /Draft/);
  await w.e.prAction('app', 1, 'comment', { text: 'Looks fine, merge it' }); const host = localHost({ project: 'app', dir: forgeDir(w.e.cfg.stateDir, 'app') }); assert.deepEqual((await host.pr.getFeedback({ number: 1 })).comments.map((c) => [c.author, c.body]), [['you', 'Looks fine, merge it']], 'human comments feed the factory feedback loop');
  const m = await w.e.prAction('app', 1, 'merge'); assert.equal(m.how, 'fast-forward'); assert.equal(bare(w.repo(), 'show', 'main:a.js'), 'export const a = 1;'); assert.equal(bare(w.repo(), 'rev-parse', 'main'), rec.commit); assert.equal(bare(w.repo(), 'branch', '--list', 'agent/*'), '', 'the merged branch is removed');
  assert.deepEqual(await w.e.listPrs('app'), []); assert.equal(host.get(1).state, 'merged'); await assert.rejects(w.e.prAction('app', 1, 'merge'), /already merged/); assert.match((await w.e.prDetail('app', 1)).diff, /\+export const a = 1;/, 'a merged PR still shows its diff');
  await assert.rejects(w.e.prDetail('app', 99), /No such pull request/); await assert.rejects(w.e.prAction('app', '1', 'explode'), /Unknown action/);
});

test('creating a local project: a test command is kept as the project verify, the brief is seeded, and no GitHub call is made', async () => {
  const w = world(); w.e.gh = new Proxy({}, { get: () => () => { throw new Error('GitHub must not be called'); } });
  const r = await w.e.createProject({ id: 'fresh', name: 'Fresh App', host: 'local', verify: 'npm test', spec: 'Build a tiny thing in thing.js that returns 1, with a test that checks it' });
  assert.deepEqual([r.project.repo, r.project.host, r.project.tickets, r.project.config], ['local/fresh-app', { kind: 'local' }, { kind: 'local' }, { verify: 'npm test' }]); assert.equal(r.url, null); assert.equal((await w.e.listTickets('fresh')).length, 1);
});

test('several branches from the same base: the first fast-forwards, the next get a merge commit, and a real conflict is refused with nothing changed', async () => {
  const w = world(); await mkProject(w);
  await build(w, 'Add file one', { 'one.js': 'export const one = 1;\n' }); await build(w, 'Add file two', { 'two.js': 'export const two = 2;\n' }); await build(w, 'Edit shared first', { 'shared.js': 'export const s = "first";\n' }); await build(w, 'Edit shared second', { 'shared.js': 'export const s = "second";\n' });
  assert.equal((await w.e.prAction('app', 1, 'merge')).how, 'fast-forward'); const m2 = await w.e.prAction('app', 2, 'merge'); assert.equal(m2.how, 'merge commit'); assert.equal(bare(w.repo(), 'rev-list', '--parents', '-n1', 'main').split(' ').length, 3, 'two parents');
  assert.deepEqual(bare(w.repo(), 'ls-tree', '--name-only', 'main').split('\n').sort(), ['one.js', 'two.js']);
  await w.e.prAction('app', 3, 'merge'); const before = bare(w.repo(), 'rev-parse', 'main'); await assert.rejects(w.e.prAction('app', 4, 'merge'), (e) => e.status === 409 && /conflicts with main/.test(e.message)); assert.equal(bare(w.repo(), 'rev-parse', 'main'), before, 'a refused merge changes nothing'); assert.equal((await w.e.prDetail('app', 4)).pr.state, 'open');
  await w.e.prAction('app', 4, 'close'); assert.equal((await w.e.prDetail('app', 4)).pr.state, 'closed'); await assert.rejects(w.e.prAction('app', 4, 'close'), /already closed/);
});

test('merge safety: a protected-file change is refused at merge time, a branch changed after verification is refused, and a planted hook never runs', async () => {
  const w = world(); await mkProject(w);
  // protected: the factory's own check is bypassed on purpose (as if the branch was edited after review) by pushing straight into the repo
  await build(w, 'Add a harmless module', { 'ok.js': 'export const ok = 1;\n' }); const clone = tmp(); execFileSync('git', ['clone', '-q', `file://${w.repo()}`, clone]); git(clone, 'checkout', '-q', 'agent/1-add-a-harmless-module');
  write(path.join(clone, '.github/workflows/ci.yml'), 'name: x\n'); git(clone, 'add', '-A'); git(clone, 'commit', '-qm', 'sneaky'); git(clone, 'push', '-q', 'origin', 'HEAD');
  await assert.rejects(w.e.prAction('app', 1, 'merge'), (e) => /changed since it was verified/.test(e.message) && e.status === 409, 'an unverified head is refused first');
  const host = localHost({ project: 'app', dir: forgeDir(w.e.cfg.stateDir, 'app') }); await host.pr.comment({ number: 1 }, 'agent-factory: pushed a verified round');           // the factory adopting the new head as verified
  await assert.rejects(w.e.prAction('app', 1, 'merge'), (e) => e.status === 403 && /protected files \(\.github\/workflows\/ci\.yml\)/.test(e.message)); assert.equal(bare(w.repo(), 'ls-tree', '--name-only', 'main'), '', 'main is untouched');
  // a repo that lists its own protected paths
  const w2 = world(); await mkProject(w2); const c2 = tmp(); execFileSync('git', ['clone', '-q', `file://${w2.repo()}`, c2]); write(path.join(c2, '.agent-factory.json'), JSON.stringify({ protectedPaths: ['golden/'] })); git(c2, 'add', '-A'); git(c2, 'commit', '-qm', 'rules'); git(c2, 'push', '-q', 'origin', 'HEAD:main');
  await build(w2, 'Touch a golden file', { 'golden/expected.txt': 'x\n' }); assert.deepEqual(await w2.e.listPrs('app'), [], 'the factory itself already refuses an agent edit to a protected file, so no PR exists');
  await build(w2, 'Add a harmless file', { 'fine.js': 'export const f = 1;\n' }); const c3 = tmp(); execFileSync('git', ['clone', '-q', `file://${w2.repo()}`, c3]); git(c3, 'checkout', '-q', 'agent/2-add-a-harmless-file'); write(path.join(c3, 'golden/expected.txt'), 'x\n'); git(c3, 'add', '-A'); git(c3, 'commit', '-qm', 'edit golden'); git(c3, 'push', '-q', 'origin', 'HEAD');
  await localHost({ project: 'app', dir: forgeDir(w2.e.cfg.stateDir, 'app') }).pr.comment({ number: 1 }, 'agent-factory: adopt'); await assert.rejects(w2.e.prAction('app', 1, 'merge'), /protected files \(golden\/expected\.txt\)/);
  // a hook planted in the repo must not run during merge, diff or publish
  const w3 = world(); await mkProject(w3); const marker = path.join(w3.root, 'PWNED'); fs.mkdirSync(path.join(w3.repo(), 'hooks'), { recursive: true }); for (const h of ['update', 'reference-transaction', 'post-update', 'pre-receive']) { fs.writeFileSync(path.join(w3.repo(), 'hooks', h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 }); }
  await build(w3, 'Add something small', { 'x.js': 'export const x = 1;\n' }); await w3.e.prDetail('app', 1); await w3.e.prAction('app', 1, 'merge'); assert.ok(!fs.existsSync(marker), 'hooks are switched off for every command the factory runs in the forge'); assert.equal(bare(w3.repo(), 'show', 'main:x.js'), 'export const x = 1;');
});

test('publish: a target is validated, the base branch is pushed (never forced), up-to-date is a no-op, a diverged remote refuses, and switching host needs the new commenters', async () => {
  const w = world(); await mkProject(w); await build(w, 'Add the shipped module', { 's.js': 'export const s = 1;\n' }); await w.e.prAction('app', 1, 'merge'); const p = w.e.project('app');
  await assert.rejects(w.e.publish('app'), /Set a publish target first/); await assert.rejects(w.e.setPublishTarget('app', { kind: 'svn', repo: 'o/r' }), /Publish to github/); await assert.rejects(w.e.setPublishTarget('app', { kind: 'git', repo: 'o/r', fields: { remoteTemplate: 'https://x.example/no-placeholder.git' } }), /\{repo\}/);
  const remoteRoot = tmp('rem-'); const remote = path.join(remoteRoot, 'o/r.git'); fs.mkdirSync(path.dirname(remote), { recursive: true }); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  p.publish = { kind: 'git', repo: 'o/r', remoteTemplate: `file://${remoteRoot}/{repo}.git` };                       // (file:// is test-only: real targets are https or ssh)
  assert.deepEqual(await w.e.publishStatus('app'), { target: { kind: 'git', repo: 'o/r' }, local: bare(w.repo(), 'rev-parse', 'main'), remote: null, upToDate: false, open: 0 });
  const r = await w.e.publish('app'); assert.equal(r.pushed, true); assert.equal(bare(remote, 'rev-parse', 'main'), bare(w.repo(), 'rev-parse', 'main')); assert.deepEqual(await w.e.publish('app'), { pushed: false, upToDate: true, sha: r.sha });
  // the remote moves on without us: refuse, never force
  const other = tmp(); execFileSync('git', ['clone', '-q', `file://${remote}`, other]); write(path.join(other, 'theirs.txt'), 'x\n'); git(other, 'add', '-A'); git(other, 'commit', '-qm', 'theirs'); git(other, 'push', '-q', 'origin', 'HEAD:main'); const theirs = bare(remote, 'rev-parse', 'main');
  await build(w, 'Add another module', { 't.js': 'export const t = 1;\n' }); await w.e.prAction('app', 2, 'merge'); await assert.rejects(w.e.publish('app'), (e) => e.status === 409 && /remote has commits this repository does not have/.test(e.message)); assert.equal(bare(remote, 'rev-parse', 'main'), theirs, 'nothing was pushed');
  git(other, 'checkout', '-q', '-B', 'x'); fs.rmSync(remote, { recursive: true }); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await assert.rejects(w.e.publish('app', { switchHost: true }), /feedbackAuthors/); assert.ok(p.publish, 'a refused switch changes nothing');
  const s = await w.e.publish('app', { switchHost: true, feedbackAuthors: ['alice'] }); assert.equal(s.switched, true); assert.deepEqual([p.host, p.repo, p.feedbackAuthors, p.publish], [{ kind: 'git', remoteTemplate: `file://${remoteRoot}/{repo}.git` }, 'o/r', ['alice'], undefined]); assert.equal(bare(remote, 'rev-parse', 'main'), bare(w.repo(), 'rev-parse', 'main'));
  assert.throws(() => w.e.prDetail('app', 1), /does not use the local forge/, 'after switching, the project no longer uses the forge');
});

test('the publish scenario step may only follow a human approval, and a dry run pushes nothing', async () => {
  assert.throws(() => validateScenario({ id: 'x', name: 'X', steps: [{ id: 'go', type: 'publish' }] }), /must come after an approve step/);
  assert.throws(() => validateScenario({ id: 'x', name: 'X', steps: [{ id: 'a', type: 'approve' }, { id: 'go', type: 'publish', requires: [] }] }), /must come after an approve step/);
  const def = validateScenario({ id: 'x', name: 'X', steps: [{ id: 'a', type: 'approve', message: 'ok?' }, { id: 'mid', type: 'note', text: 'n' }, { id: 'go', type: 'publish' }] });
  const w = world(); await mkProject(w); const run = startRun(w.e, { scenario: def, project: 'app', dryRun: true }); const r = await advance(w.e, 'app', run.id, { scenarios: [def] }); assert.equal(r.steps.a.status, 'done', 'dry run does not wait for approval'); assert.equal(r.steps.go.output.dryRun, true);
  let pushed = 0; w.e.publish = async () => { pushed++; return { pushed: true, sha: 'abc1234567' }; }; const live = startRun(w.e, { scenario: def, project: 'app', dryRun: false }); let l = await advance(w.e, 'app', live.id, { scenarios: [def] }); assert.equal(l.steps.a.status, 'waiting-approval'); assert.equal(pushed, 0, 'nothing is published before a human approves');
});

test('the pull request file: corruption stops the forge and keeps a copy; bad branch names and numbers are rejected before they reach git', async () => {
  const w = world(); await mkProject(w); const dir = forgeDir(w.e.cfg.stateDir, 'app'); const host = localHost({ project: 'app', dir });
  await assert.rejects(host.openPr({ branch: '../../etc/passwd', title: 't' }), /Invalid branch|not in the local repository/); await assert.rejects(host.openPr({ branch: 'agent/missing', title: 't' }), /not in the local repository/);
  for (const n of ['0', '-1', '1.5', 'abc', '1; rm -rf']) assert.throws(() => host.get(n), /Invalid pull request number/);
  await build(w, 'Add a safe module', { 'k.js': 'export const k = 1;\n' }); fs.writeFileSync(path.join(dir, 'prs.json'), '{"prs": [ {broken'); await assert.rejects(w.e.listPrs('app'), /corrupt \(a copy was kept/); assert.equal(fs.readFileSync(path.join(dir, 'prs.json'), 'utf8'), '{"prs": [ {broken'); assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('prs.json.corrupt-')));
});

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
test('the API: PR detail, comment, merge and publish status need the token; the catalog offers "On this machine"; no agent operation can merge or publish', async () => {
  const w = world(); await mkProject(w); await build(w, 'Add an api module', { 'api.js': 'export const api = 1;\n' }); const port = await freePort(); const token = 'T'.repeat(32);
  const server = createServer(w.e, { token, allowedHosts: hostsFor('127.0.0.1', port) }); await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const call = (method, p, body, auth = true) => new Promise((res) => { const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(b || 'null') })); }); req.end(body ? JSON.stringify(body) : undefined); });
  try {
    assert.equal((await call('GET', '/api/projects/app/prs/1', null, false)).status, 401); const d = await call('GET', '/api/projects/app/prs/1'); assert.equal(d.status, 200); assert.equal(d.json.files[0].path, 'api.js');
    assert.equal((await call('POST', '/api/projects/app/prs/1/comment', { text: 'hello there' })).status, 200); assert.equal((await call('GET', '/api/projects/app/prs/1')).json.pr.comments.at(-1).body, 'hello there');
    assert.equal((await call('GET', '/api/projects/app/publish')).json.target, null); assert.equal((await call('POST', '/api/projects/app/prs/1/merge', {})).json.how, 'fast-forward'); assert.equal((await call('GET', '/api/projects/app/prs/9')).status, 404);
    assert.ok((await call('GET', '/api/catalog')).json.hosts.some((h) => h.kind === 'local' && h.fields.length === 0));
    const { OPS } = await import('../src/ops.mjs'); assert.ok(!OPS.some((o) => /merge/.test(o.name) || ['publish', 'publish_project', 'publish_code'].includes(o.name)), 'merging and publishing are human actions, not agent operations');
  } finally { await new Promise((r) => server.close(r)); }
});
