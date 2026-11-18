import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { testTampering, changeQuality } from '../src/quality.mjs';
import { leaseStore } from '../src/leases.mjs';
import { tick } from '../src/factory.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';
import { revision } from '../src/pack.mjs';

const tmp = (p = 'dc-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const TEST = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('adds', () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(0, 0), 0);\n  assert.equal(add(-1, 1), 0);\n});\n`;
const SRC = 'export const add = (a, b) => a + b;\n';
function repo() { const d = tmp(); execFileSync('git', ['init', '-q', '-b', 'main', d]); write(path.join(d, 'src/add.js'), SRC); write(path.join(d, 'test/add.test.js'), TEST); write(path.join(d, 'test/other.test.js'), TEST.replace('adds', 'other')); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'i'); return d; }

test('test tampering: lost assertions, deleted test files and switched-off tests are found; new tests, equal rewrites and non-test files are not', async () => {
  const d = repo();
  // 1. loosen: remove two assertions
  fs.writeFileSync(path.join(d, 'test/add.test.js'), TEST.replace("  assert.equal(add(0, 0), 0);\n  assert.equal(add(-1, 1), 0);\n", '')); let q = await changeQuality(d);
  assert.equal(q.status, 'WARN'); assert.deepEqual(q.findings.filter((f) => f.rule === 'test-weakened').map((f) => f.file), ['test/add.test.js']); assert.match(q.findings[0].message, /lost 2 assertions \(2 removed, 0 added\)/); assert.match(q.warnings.join(), /1 test change weakened existing checks/); assert.equal(q.blockers.length, 0);
  assert.equal((await changeQuality(d, { blockTestWeakening: true })).status, 'ERROR');                                     // you can choose to block instead
  assert.equal((await changeQuality(d, { maxTestWeakening: 1 })).passed, true);                                              // or tolerate some
  git(d, 'checkout', '--', '.');
  // 2. delete a whole test file; 3. skip a test
  fs.rmSync(path.join(d, 'test/other.test.js')); fs.writeFileSync(path.join(d, 'test/add.test.js'), TEST.replace("test('adds'", "test.skip('adds'")); q = await changeQuality(d);
  assert.deepEqual(q.findings.filter((f) => f.rule === 'test-weakened').map((f) => [f.file, /deleted|switched off/.exec(f.message)[0]]).sort(), [['test/add.test.js', 'switched off'], ['test/other.test.js', 'deleted']]);
  git(d, 'checkout', '--', '.');
  // 4. fine: add tests, rename, change the expectation of equal weight, edit non-test code, add a new test file
  fs.writeFileSync(path.join(d, 'test/add.test.js'), TEST.replace("assert.equal(add(0, 0), 0);", "assert.equal(add(0, 5), 5);") + "test('more', () => { assert.equal(add(2, 2), 4); });\n"); write(path.join(d, 'test/new.test.js'), TEST.replace('adds', 'new')); fs.writeFileSync(path.join(d, 'src/add.js'), SRC + '// comment\n');
  q = await changeQuality(d); assert.equal(q.findings.filter((f) => f.rule === 'test-weakened').length, 0); assert.equal(q.status, 'OK');
  const diff = "diff --git a/src/add.js b/src/add.js\n--- a/src/add.js\n+++ b/src/add.js\n@@ -1 +1 @@\n-assert.equal(1, 1)\n+nothing\n"; assert.deepEqual(testTampering(diff), [], 'removing assertion-like lines from non-test code is not tampering');
  const ig = { test: (r) => /legacy/.test(r) }; assert.deepEqual(testTampering(`diff --git a/test/legacy.test.js b/test/legacy.test.js\ndeleted file mode 100644\n--- a/test/legacy.test.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-assert.ok(1)\n`, { ignore: ig }), []);
});

// ---- a real ticket loop against a real git remote
function loop(agentFn, { tickets, over = {} } = {}) {
  const root = tmp('lp-'); const remote = path.join(root, 'remote.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]); const seed = path.join(root, 'seed'); execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  write(path.join(seed, 'src/add.js'), SRC); write(path.join(seed, 'test/add.test.js'), TEST); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'i'); git(seed, 'push', '-q', remote, 'main');
  const tpath = path.join(root, 't.json'); fs.writeFileSync(tpath, JSON.stringify(tickets ?? [{ id: 1, title: 'Make add handle strings', body: 'Make add() in src/add.js convert numeric strings, with a test that checks it', labels: ['agent-ready'], comments: [] }]));
  const prs = []; let n = 0; const calls = []; const stateDir = path.join(root, 'state'); const real = fileTickets(tpath); const tk = new Proxy(real, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { if (['label', 'comment'].includes(k)) calls.push([k, ...a]); return t[k](...a); } : t[k]) });
  const sandbox = { create: async ({ cloneUrl, branch, base }) => { const dir = fs.mkdtempSync(path.join(root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); git(dir, 'checkout', '-qb', branch); return { dir, cloneUrl, destroy() {} }; }, exec: async (ws, cmd, args) => { const r = (() => { try { return { code: 0, out: execFileSync(cmd, args, { cwd: ws.dir, stdio: 'pipe' }).toString() }; } catch (e) { return { code: 1, out: String(e.stdout ?? e.message) }; } })(); return r; } };
  const agent = { run: async (_sb, ws, prompt) => { n++; await agentFn(ws.dir, n, { prompt, stateDir }); return { out: 'done', costUsd: 0 }; } };
  return { prs, calls, remote, tpath, stateDir, attempts: () => n, deps: () => ({ tickets: tk, sandbox, agent, vcs: gitVcs({ openPr: (a) => { prs.push(a); return 'https://example.test/pr/1'; } }), config: { repo: 'o/r', base: 'main', cloneUrl: remote, maxAttempts: 2, verify: 'node --test', briefRev: () => 'abc12345', ...over }, stateDir }) };
}

test('loop: weakening a test earns one retry with a clear instruction, then ships FLAGGED (or is blocked if you ask); honest changes pass clean', async () => {
  const weaken = (dir) => { fs.writeFileSync(path.join(dir, 'test/add.test.js'), TEST.replace("  assert.equal(add(0, 0), 0);\n  assert.equal(add(-1, 1), 0);\n", '')); fs.writeFileSync(path.join(dir, 'src/add.js'), 'export const add = (a, b) => Number(a) + Number(b);\n'); };
  const L = loop(weaken); const [r] = await tick(L.deps()); assert.equal(r.attempts, 2); assert.equal(r.status, 'ok'); assert.equal(r.quality.status, 'WARN'); assert.match(r.quality.findings.find((f) => f.rule === 'test-weakened').message, /Do not loosen tests/);
  assert.match(L.prs[0].body, /Quality gate: flagged[\s\S]*weakened existing checks/); const prompts = []; const L2 = loop((dir, n, { prompt }) => { prompts.push(prompt); weaken(dir); }); await tick(L2.deps()); assert.match(prompts[1], /quality gate on your change failed[\s\S]*weakened[\s\S]*do not weaken or remove tests/);
  const B = loop(weaken, { over: { qualityGate: { blockTestWeakening: true } } }); const [b] = await tick(B.deps()); assert.equal(b.status, 'quality-failed'); assert.equal(B.prs.length, 0);
  const honest = loop((dir) => { fs.writeFileSync(path.join(dir, 'src/add.js'), 'export const add = (a, b) => Number(a) + Number(b);\n'); fs.appendFileSync(path.join(dir, 'test/add.test.js'), "test('strings', () => { assert.equal(add('1', '2'), 3); });\n"); }); const [h] = await tick(honest.deps()); assert.equal(h.attempts, 1); assert.equal(h.quality.status, 'OK'); assert.doesNotMatch(honest.prs[0].body, /weakened/);
});

test('fencing: lease tokens identify the current owner; a stale holder cannot release a newer lease; a run that was replaced mid-flight pushes nothing and touches nothing', async () => {
  const dir = tmp(); const ls = leaseStore(dir); const a = ls.acquire(7, 60_000); assert.ok(ls.valid(7, a)); assert.equal(ls.valid(7, 'nope'), false); assert.equal(ls.valid(8, a), false);
  const b = ls.acquire(7, 60_000); assert.notEqual(a, b); assert.equal(ls.valid(7, a), false, 'the replaced worker is no longer the owner'); assert.ok(ls.valid(7, b));
  assert.equal(ls.release(7, a), false); assert.ok(ls.valid(7, b), 'a late release must not delete the replacement lease'); assert.equal(ls.release(7, b), true); assert.equal(ls.valid(7, b), false);
  const e = ls.acquire(9, 1); await new Promise((r) => setTimeout(r, 15)); assert.equal(ls.valid(9, e), false, 'expired');
  // the whole loop: while the agent works, another run takes over the ticket
  let stolen; const L = loop((d2, n, { stateDir }) => { fs.writeFileSync(path.join(d2, 'src/add.js'), 'export const add = (a, b) => Number(a) + Number(b);\n'); stolen = leaseStore(stateDir).acquire(1, 600_000); });
  const [r] = await tick(L.deps()); assert.equal(r.status, 'lost-claim'); assert.match(r.error, /no longer holds the claim/); assert.equal(L.prs.length, 0);
  assert.doesNotMatch(execFileSync('git', ['--git-dir', L.remote, 'branch']).toString(), /agent\//, 'nothing was pushed');
  assert.deepEqual(L.calls.map((c) => [c[0], c[2]?.[0] ?? c[1]]).filter(([k, v]) => k === 'label' && v !== undefined), [['label', 'agent-working']], 'only the original claim label was written: no review/failed labels, no comments');
  assert.ok(!L.calls.some((c) => c[0] === 'comment')); assert.ok(leaseStore(L.stateDir).valid(1, stolen), 'the replacement keeps its lease');
});

test('review backlog: with maxOpenReviews set, no new work is claimed while that many PRs wait for a human; closed ones do not count; unset means unlimited', async () => {
  const T = (extra) => [{ id: 1, title: 'Ready ticket here', body: 'Do the thing in src/add.js with a test', labels: ['agent-ready'], comments: [] }, { id: 2, title: 'Old PR one', body: 'x', labels: ['agent-review'], comments: [] }, { id: 3, title: 'Old PR two', body: 'x', labels: ['agent-review'], comments: [], closed: !!extra }];
  let ran = 0; const agent = () => { ran++; };
  let L = loop(agent, { tickets: T(), over: { maxOpenReviews: 2, verify: false } }); let out = await tick(L.deps()); assert.deepEqual(out, [{ status: 'review-backlog', open: 2, cap: 2 }]); assert.equal(ran, 0);
  L = loop(agent, { tickets: T(true), over: { maxOpenReviews: 2, verify: false, maxAttempts: 1 } }); out = await tick(L.deps()); assert.equal(ran, 1, 'one is closed so the backlog is 1 < 2');
  ran = 0; L = loop(agent, { tickets: T(), over: { verify: false, maxAttempts: 1 } }); await tick(L.deps()); assert.equal(ran, 1, 'no cap configured');
});

test('provenance: the PR names the brief revision and the verified commit; revisions change only when the agreement changes; without a verify command the PR says it was not machine-checked', async () => {
  const L = loop((dir) => { fs.writeFileSync(path.join(dir, 'src/add.js'), 'export const add = (a, b) => Number(a) + Number(b);\n'); fs.appendFileSync(path.join(dir, 'test/add.test.js'), "test('strings', () => { assert.equal(add('1', '2'), 3); });\n"); });
  const [r] = await tick(L.deps()); assert.equal(r.status, 'ok'); const sha = execFileSync('git', ['--git-dir', L.remote, 'rev-parse', 'agent/1-make-add-handle-strings']).toString().trim(); assert.equal(r.commit, sha); assert.equal(r.briefRev, 'abc12345'); assert.equal(r.verifyCmd, 'node --test');
  assert.match(L.prs[0].body, new RegExp(`### Provenance\\n- Built from brief revision \`abc12345\`\\n- \`node --test\` passed on the working tree committed as \`${sha.slice(0, 10)}\`\\n- If this branch changes after this point, the result above no longer applies to it\\.`));
  const none = loop((dir) => fs.appendFileSync(path.join(dir, 'src/add.js'), '// tweak\n'), { over: { verify: false, briefRev: () => undefined } }); await tick(none.deps()); assert.match(none.prs[0].body, /No verify command was available: this change was not machine-checked/);
  const pack = { brief: { goal: 'A booking app' }, stack: 'JS', decisions: '', sources: [{ id: 'a', bytes: 10 }] }; const rev = revision(pack); assert.match(rev, /^[a-f0-9]{8}$/); assert.equal(revision(structuredClone(pack)), rev); assert.notEqual(revision({ ...pack, brief: { goal: 'A different app' } }), rev); assert.notEqual(revision({ ...pack, sources: [] }), rev);
});
