import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { failingWorkflows, prNumberOf, fetchBaseRuns } from '../src/deploywatch.mjs';

let n = 0;
const run = (o) => ({ id: ++n, workflow_id: 1, name: 'Deploy to Pi', status: 'completed', conclusion: 'success', head_sha: 'abcdef1234567', created_at: new Date(Date.UTC(2026, 10, 20, 12, n)).toISOString(),
  updated_at: new Date(Date.UTC(2026, 10, 20, 12, n, 30)).toISOString(), html_url: `https://github.com/me/app/actions/runs/${n}`, head_commit: { message: 'Merge pull request #7 from me/agent/1-x\n\nTitle' }, ...o });

test('PR numbers are read from merge and squash commit messages', () => {
  assert.equal(prNumberOf('Merge pull request #12 from me/agent/3-x\n\nBoard'), 12);
  assert.equal(prNumberOf('Add a thing (#45)\n\nbody'), 45);
  assert.equal(prNumberOf('Fix typo'), null); assert.equal(prNumberOf(undefined), null);
});

test('a workflow whose latest finished run failed is reported, newest first, with the PR and link', () => {
  const older = run({ conclusion: 'success' }); const newer = run({ conclusion: 'failure', head_commit: { message: 'Merge pull request #39 from me/x\n\nfix' } });
  const runs = [older, newer];   // deliberately oldest first: the verdict must come from the timestamps, not the order the API returned them in
  const f = failingWorkflows(runs);
  assert.equal(f.length, 1); assert.equal(f[0].workflow, 'Deploy to Pi'); assert.equal(f[0].pr, 39); assert.equal(f[0].conclusion, 'failure'); assert.equal(f[0].sha, 'abcdef1');
  assert.match(f[0].url, /^https:\/\/github\.com\//); assert.match(f[0].headline, /Merge pull request #39/);
});

test('a later green run of the same workflow clears the failure by itself', () => {
  const failed = run({ conclusion: 'failure' }); const fixed = run({ conclusion: 'success' });
  assert.deepEqual(failingWorkflows([fixed, failed]), []);
  assert.equal(failingWorkflows([failed, fixed]).length, 0);
});

test('cancelled, skipped and in-progress runs are neutral: they neither raise nor clear a failure', () => {
  const failed = run({ conclusion: 'failure' });
  assert.equal(failingWorkflows([run({ conclusion: 'cancelled' }), failed]).length, 1);                 // a newer push cancelling a run does not hide the red one
  assert.equal(failingWorkflows([run({ status: 'in_progress', conclusion: null }), failed]).length, 1);
  assert.equal(failingWorkflows([run({ conclusion: 'skipped' }), failed]).length, 1);
  assert.equal(failingWorkflows([run({ conclusion: 'cancelled' })]).length, 0);
  assert.equal(failingWorkflows([]).length, 0); assert.equal(failingWorkflows(undefined).length, 0);
});

test('workflows are judged separately, and timeouts count as failures', () => {
  const a = run({ workflow_id: 1, name: 'Deploy', conclusion: 'failure' }); const b = run({ workflow_id: 2, name: 'CI', conclusion: 'success' }); const c = run({ workflow_id: 3, name: 'Nightly', conclusion: 'timed_out' });
  assert.deepEqual(failingWorkflows([a, b, c]).map((x) => x.workflow).sort(), ['Deploy', 'Nightly']);
});

test('a link that is not a github.com URL is never passed on', () => {
  const f = failingWorkflows([run({ conclusion: 'failure', html_url: 'javascript:alert(1)' })]); assert.equal(f[0].url, null);
  assert.equal(failingWorkflows([run({ conclusion: 'failure', html_url: 'https://evil.example/runs/1' })])[0].url, null);
});

test('fetchBaseRuns asks the right API for the base branch and surfaces gh errors', async () => {
  let seen; const ok = await fetchBaseRuns('me/app', 'feature/x y', async (cmd, args) => { seen = { cmd, args }; return { code: 0, out: JSON.stringify({ workflow_runs: [run({})] }) }; });
  assert.equal(ok.length, 1); assert.equal(seen.cmd, 'gh'); assert.match(seen.args[1], /^repos\/me\/app\/actions\/runs\?branch=feature%2Fx%20y&event=push/);
  await assert.rejects(fetchBaseRuns('me/app', 'main', async () => ({ code: 1, out: 'HTTP 404: Not Found' })), /404/);
});

// ---- through the engine: the Inbox and its badge
function engine(projects, baseRuns, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-')); fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects });
  const tp = path.join(root, 't.json'); fs.writeFileSync(tp, '[]');
  for (const p of cfg.projects) p.tickets = { kind: 'file', path: tp };
  return new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: { baseRuns, tickets: () => ({ listAgentTickets: async () => [] }), host: () => ({ listAgentPrs: async () => [] }), ...extra } });
}

test('the Inbox lists a failing pipeline first, counts it, and drops it once the next run is green', async () => {
  let runs = [run({ conclusion: 'failure', head_commit: { message: 'Merge pull request #5 from me/agent/9-x' } })];
  const e = engine([{ id: 'app', repo: 'me/app', base: 'main' }], async (repo, base) => { assert.equal(repo, 'me/app'); assert.equal(base, 'main'); return runs; });
  e.gh = {}; const inbox1 = await e.inbox();
  assert.equal(inbox1.items[0].kind, 'deploy'); assert.equal(inbox1.items[0].project, 'app'); assert.equal(inbox1.items[0].pr, 5); assert.equal(inbox1.items[0].title, 'Deploy to Pi is failing on main'); assert.equal(inbox1.counts.deploys, 1);
  assert.equal((await e.inboxCount()).count >= 1, true);
  runs = [run({ conclusion: 'success' }), ...runs]; e._deploy.at = 0; await e.deployFailures(); await e._deployScan;   // older than two minutes: refreshes in the background
  const inbox2 = await e.inbox(); assert.equal(inbox2.items.filter((i) => i.kind === 'deploy').length, 0); assert.equal(inbox2.counts.deploys, 0);
});

test('projects can opt out, non-GitHub hosts are skipped, and a GitHub error is not an Inbox item', async () => {
  const calls = []; const f = async (repo) => { calls.push(repo); return [run({ conclusion: 'failure' })]; };
  const e = engine([{ id: 'quiet', repo: 'me/quiet', base: 'main', deployWatch: false }, { id: 'local', repo: 'me/local', base: 'main', host: { kind: 'local' } }, { id: 'live', repo: 'me/live', base: 'trunk' }], f);
  const items = (await e.inbox()).items.filter((i) => i.kind === 'deploy'); assert.deepEqual(calls, ['me/live']); assert.equal(items.length, 1); assert.equal(items[0].base, 'trunk');
  const broken = engine([{ id: 'app', repo: 'me/app', base: 'main' }], async () => { throw new Error('gh: not logged in'); });
  const inbox = await broken.inbox(); assert.equal(inbox.items.length, 0); assert.deepEqual(inbox.errors, []);
});

test('demo mode never calls GitHub', async () => {
  let called = 0; const e = engine([{ id: 'app', repo: 'me/app', base: 'main' }], async () => { called++; return []; }); e.demo = true;
  assert.deepEqual(await e.deployFailures(), []); assert.equal(called, 0);
});

// ---- coverage: which changed files the project's test command does not exercise
import { verifyScopes, coverageGap } from '../src/coverage.mjs';
import { agents } from '../src/adapters/agents.mjs';
import { sandbox } from '../src/adapters/sandbox.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';
import { tick } from '../src/factory.mjs';
import { execFileSync } from 'node:child_process';

test('verifyScopes reads the folders a test command runs in', () => {
  assert.deepEqual(verifyScopes('cd frontend && npm ci --legacy-peer-deps && npx tsc -b && npm test && npx vite build'), ['frontend']);
  assert.deepEqual(verifyScopes('npm --prefix web test'), ['web']); assert.deepEqual(verifyScopes('make -C api test'), ['api']);
  assert.deepEqual(verifyScopes('cd api && npm test; cd ../web && npm test').sort(), ['api']);                 // a parent-relative folder is not a scope we can name
  assert.deepEqual(verifyScopes('npm test'), []); assert.deepEqual(verifyScopes(''), []); assert.deepEqual(verifyScopes(undefined), []);
  assert.deepEqual(verifyScopes('cd $HOME && npm test'), []); assert.deepEqual(verifyScopes('cd /abs/path && x'), []);
});

test('coverageGap names changed code outside the folders the command runs in, and ignores docs', () => {
  const cmd = 'cd frontend && npm test';
  assert.equal(coverageGap(cmd, ['frontend/src/a.tsx', 'frontend/test/a.test.cjs']), null);
  assert.deepEqual(coverageGap(cmd, ['frontend/src/a.tsx', 'backend/src/auth/x.ts', 'mcp/tools.js']), { scopes: ['frontend'], uncovered: ['backend/src/auth/x.ts', 'mcp/tools.js'], total: 2 });
  assert.equal(coverageGap(cmd, ['README.md', 'docs/guide.md', '.github/workflows/deploy.yml', 'LICENSE', '.gitignore']), null);
  assert.equal(coverageGap('npm test', ['backend/x.ts']), null);                                              // runs from the root: covers everything we can tell
  assert.equal(coverageGap(cmd, undefined), null);
  assert.equal(coverageGap('cd front && npm test', ['frontend/x.ts']).uncovered[0], 'frontend/x.ts');          // a folder with the same prefix is not the same folder
  assert.equal(coverageGap(cmd, Array.from({ length: 30 }, (_, i) => `backend/f${i}.ts`)).uncovered.length, 20);
  assert.equal(coverageGap(cmd, Array.from({ length: 30 }, (_, i) => `backend/f${i}.ts`)).total, 30);
});

test('the PR says which changed files the test command did not cover, and the run records it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-')); const remote = path.join(root, 'remote.git'); const seed = path.join(root, 'seed');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(root, 'init', '--bare', '-b', 'main', remote); fs.mkdirSync(seed); git(seed, 'init', '-b', 'main'); git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(seed, 'frontend')); fs.writeFileSync(path.join(seed, 'frontend', 'ok.txt'), 'x\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'init'); git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
  const tpath = path.join(root, 't.json'); fs.writeFileSync(tpath, JSON.stringify([{ id: 1, title: 'Touch both', body: 'b', labels: ['agent-ready'] }]));
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't'; process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
  const opened = [];
  await tick({ tickets: fileTickets(tpath), sandbox: sandbox({ kind: 'local' }), agent: agents.shell({ command: 'echo a > frontend/new.txt; mkdir -p backend; echo b > backend/api.txt; echo c > README.md' }),
    vcs: gitVcs({ openPr: async (a) => { opened.push(a); return { url: 'https://example.test/pr/1', number: 1 }; } }),
    config: { cloneUrl: remote, base: 'main', maxAttempts: 1, timeoutMs: 20000, verify: 'cd frontend && test -f new.txt', gate: false }, stateDir: path.join(root, 'state') });
  const rec = fs.readFileSync(path.join(root, 'state', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).at(-1);
  assert.equal(rec.status, 'ok'); assert.deepEqual(rec.coverage, { scopes: ['frontend'], uncovered: ['backend/'], total: 1 });          // git lists a brand-new folder as one entry; README.md is not code
  assert.match(opened[0]?.body ?? '', /Not covered by that command:\*\* `backend\/` \(it only runs in `frontend\/`\)/);
});

test('the UI never waits on GitHub: a stale answer is served at once and refreshed in the background', async () => {
  let release; const gate = new Promise((r) => { release = r; }); let calls = 0;
  const e = engine([{ id: 'app', repo: 'me/app', base: 'main' }], async () => { calls++; await gate; return [run({ conclusion: 'failure' })]; });
  const t0 = Date.now(); assert.deepEqual(await e.deployFailures(false), []);                          // first call with wait=false returns immediately, scan runs on its own
  assert.ok(Date.now() - t0 < 100); assert.equal(calls, 1);
  const first = e.deployFailures(true); release(); assert.equal((await first).length, 1);               // a caller that does wait gets the real answer once the scan ends
  e._deploy.at = 0; let release2; const gate2 = new Promise((r) => { release2 = r; });
  e.f.baseRuns = async () => { calls++; await gate2; return []; };
  const t1 = Date.now(); const stale = await e.deployFailures(true); assert.equal(stale.length, 1); assert.ok(Date.now() - t1 < 100);   // stale answer served instantly, even with wait=true
  assert.equal(calls, 2); await e.deployFailures(false); assert.equal(calls, 2);                           // and only one refresh runs at a time
  release2(); await e._deployScan; assert.equal((await e.deployFailures(false)).length, 0);              // the refresh lands: the failure is gone
});
