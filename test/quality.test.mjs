import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v; // CI runners have no git identity
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanText, parseAddedLines, evaluateGate, evaluateRepoGate, countFindings, addHistory, changeQuality, feedbackFor, findingKey } from '../src/quality.mjs';
import { analyzeRepo } from '../src/analyze.mjs';
import { tick } from '../src/factory.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';

const rules = (rel, text, o) => scanText(rel, text, o).map((f) => f.rule);

test('rules: each one fires on the bad pattern and stays quiet on the good one', () => {
  assert.deepEqual(rules('a.js', 'const k = "AKIAABCDEFGHIJKLMNOP";'), ['secret']);
  assert.deepEqual(rules('a.js', 'const password = "hunter2hunter2";'), ['secret']); assert.deepEqual(rules('a.js', 'const password = process.env.PASSWORD || "changeme-please";'), []);
  assert.deepEqual(rules('a.js', 'const api_key = "your-api-key-here";'), []); assert.deepEqual(rules('a.test.js', 'const password = "hunter2hunter2";', { isTest: true }), []);
  assert.deepEqual(rules('a.test.js', 'k = "AKIAABCDEFGHIJKLMNOP"', { isTest: true }), ['secret-in-test']);   // still reported, but as a minor smell: fixtures are usually fake
  assert.deepEqual(rules('a.js', 'const k = "AKIAABCDEFGHIJKLMNOP"; // quality-ignore'), []); assert.deepEqual(rules('a.js', 'eval(x) // not ignored'), ['eval']); assert.deepEqual(rules('a.test.js', 'eval(x)', { isTest: true }), []);
  assert.deepEqual(rules('a.txt', '-----BEGIN RSA PRIVATE KEY-----'), ['secret']);
  assert.deepEqual(rules('a.js', 'eval(userInput)'), ['eval']); assert.deepEqual(rules('a.js', 'const evaluate = 1; medieval(2)'), []); assert.deepEqual(rules('a.py', 'x = eval(s)'), ['eval']);
  assert.deepEqual(rules('a.js', 'el.innerHTML = html'), ['inner-html']); assert.deepEqual(rules('a.js', 'if (el.innerHTML == "")'), []);
  assert.deepEqual(rules('a.py', 'subprocess.run(cmd, shell=True)'), ['shell-true']); assert.deepEqual(rules('a.js', 'https.get(u, { rejectUnauthorized: false })'), ['tls-off']); assert.deepEqual(rules('a.py', 'requests.get(u, verify=False)'), ['tls-off']);
  assert.deepEqual(rules('a.js', 'try { x() } catch (e) {}'), ['empty-catch']); assert.deepEqual(rules('a.js', 'try { x() } catch (e) { log(e) }'), []); assert.deepEqual(rules('a.js', 'try { x() } catch { /* best effort */ }'), []); assert.deepEqual(rules('a.py', 'try:\n  x()\nexcept Exception:\n  pass\n'), []); assert.deepEqual(rules('a.py', 'except Exception: pass'), ['empty-except']);
  assert.deepEqual(rules('a.js', 'debugger;'), ['debugger']); assert.deepEqual(rules('a.py', 'import pdb'), ['py-debug']);
  assert.deepEqual(rules('src/a.js', 'console.log(1)'), ['console']); assert.deepEqual(rules('src/a.test.js', 'console.log(1)', { isTest: true }), []); assert.deepEqual(rules('bin/cli.js', 'console.log(1)'), []);
  assert.deepEqual(rules('a.js', "const msg = 'never call eval(x) or use el.innerHTML = y'; // eval(z)"), []);                  // mentions in strings/comments are not code
  assert.deepEqual(rules('README.md', 'eval(x) verify=False console.log(1)'), []);                                                         // prose and unknown types: only secrets are checked
});

test('structure: long functions and deep nesting are found; short ones are not; braces in strings do not confuse it', () => {
  const body = (n) => Array.from({ length: n }, (_, i) => `  x${i}();`).join('\n');
  assert.deepEqual(rules('a.js', `function big() {\n${body(90)}\n}\n`), ['long-function']); assert.deepEqual(rules('a.js', `function ok() {\n${body(20)}\n}\n`), []);
  assert.deepEqual(rules('a.js', `const f = async (a) => {\n${body(85)}\n};\n`), ['long-function']);
  assert.deepEqual(rules('a.js', `function s() {\n  const t = "{{{{{{{";\n  return t;\n}\n`), []);
  const deep = 'function d() {\n' + 'if (a) {\n'.repeat(7) + 'x();\n' + '}\n'.repeat(7) + '}\n'; assert.ok(rules('a.js', deep).includes('deep-nesting'));
  assert.deepEqual(rules('a.py', `def big():\n${Array.from({ length: 90 }, () => '    x()').join('\n')}\n\ndef small():\n    pass\n`), ['long-function']);
  assert.deepEqual(rules('a.js', 'function broken() {\n  if (x) {\n'), []);                                                                     // unclosed: no crash, no false alarm
});

test('rules are safe on hostile input: huge/minified lines are skipped and nothing is slow', () => {
  const t0 = Date.now(); scanText('a.js', `${'a'.repeat(200000)}\n${'("'.repeat(50000)}\n${' '.repeat(100000)}x`); scanText('a.js', 'catch ('.repeat(20000)); scanText('a.js', 'password = "' + 'a'.repeat(50000));
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
});

test('gate: limits per kind, blocking vs flagging, off-switches, bad config tolerated', () => {
  const c = (o) => ({ secrets: 0, vulnerabilities: 0, bugs: 0, smells: 0, ...o });
  assert.deepEqual(evaluateGate(c({})), { passed: true, blockers: [], warnings: [] });
  assert.deepEqual(evaluateGate(c({ secrets: 1 })).blockers, ['1 hard-coded secrets (limit 0)']);
  const v = evaluateGate(c({ vulnerabilities: 2, bugs: 1, smells: 9 })); assert.deepEqual([v.blockers.length, v.warnings.length, v.passed], [0, 2, false]);
  assert.equal(evaluateGate(c({ smells: 9 }), { maxNewSmells: 10 }).passed, true); assert.equal(evaluateGate(c({ bugs: 5 }), { maxNewBugs: null }).passed, true); assert.equal(evaluateGate(c({ bugs: 1 }), { block: ['bugs'] }).blockers.length, 1);
  assert.equal(evaluateGate(c({}), 'garbage').passed, true);
  const f = [{ rule: 'secret', type: 'vulnerability', severity: 'BLOCKER' }, { rule: 'eval', type: 'vulnerability', severity: 'CRITICAL' }, { rule: 'console', type: 'code_smell', severity: 'MINOR' }]; assert.deepEqual(countFindings(f), { secrets: 1, vulnerabilities: 1, bugs: 0, smells: 1, total: 3 });
  assert.deepEqual(evaluateRepoGate({ metrics: { duplicatedPct: 3 }, findings: [] }), { status: 'OK', failed: [] });
  const bad = evaluateRepoGate({ metrics: { duplicatedPct: 30 }, findings: f }); assert.equal(bad.status, 'ERROR'); assert.equal(bad.failed.length, 3);
});

test('addedLines parser handles hunks, single lines, deletions and new files', () => {
  const m = parseAddedLines('diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,3 @@\n+a\n@@ -10 +12 @@\n+b\n@@ -20,3 +25,0 @@\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n');
  assert.deepEqual([...m.get('x.js')].sort((a, b) => a - b), [1, 2, 3, 12]); assert.equal(m.has('gone.js'), false);
});

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
function repo(files) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'q-')); execFileSync('git', ['init', '-q', '-b', 'main', d]); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d; }

test('clean as you code: only the lines the agent changed count; old problems are not blamed on the change', async () => {
  const d = repo({ 'old.js': 'eval(legacy);\ntry { x() } catch (e) {}\n', 'ok.js': 'export const a = 1;\n' });
  assert.equal((await changeQuality(d)).status, 'OK');                                                                                  // nothing changed
  fs.appendFileSync(path.join(d, 'old.js'), 'export const harmless = 2;\n'); fs.appendFileSync(path.join(d, 'ok.js'), 'const t = "AKIAABCDEFGHIJKLMNOP";\nel.innerHTML = x;\n'); fs.writeFileSync(path.join(d, 'new.py'), 'subprocess.run(c, shell=True)\n');
  const q = await changeQuality(d); assert.equal(q.status, 'ERROR'); assert.deepEqual(q.counts, { secrets: 1, vulnerabilities: 2, bugs: 0, smells: 0, total: 3 });
  assert.ok(q.findings.every((f) => f.file !== 'old.js'), 'pre-existing eval/empty catch must not count'); assert.match(q.blockers[0], /secrets/); assert.match(feedbackFor(q), /ok\.js:2 \[secret\]/);
  assert.equal(findingKey(q.findings[0]), `${q.findings[0].rule}:${q.findings[0].file}:${q.findings[0].line}`);
});

test('changeQuality: a long function is attributed when ANY of its lines changed; hooks planted by the agent do not run', async () => {
  const d = repo({ 'f.js': `function big() {\n${Array.from({ length: 90 }, (_, i) => `  x${i}();`).join('\n')}\n}\n` }); assert.equal((await changeQuality(d)).counts.total, 0);   // pre-existing: not new
  fs.writeFileSync(path.join(d, 'f.js'), fs.readFileSync(path.join(d, 'f.js'), 'utf8').replace('x45();', 'y45();')); assert.deepEqual((await changeQuality(d)).findings.map((f) => f.rule), ['long-function']);
  fs.mkdirSync(path.join(d, '.git/hooks'), { recursive: true }); fs.appendFileSync(path.join(d, '.git/config'), `\n[core]\n\tfsmonitor = touch ${d}/PWNED\n`); await changeQuality(d); assert.equal(fs.existsSync(path.join(d, 'PWNED')), false);
});

test('repo analysis reports counts, top findings and a gate; history keeps a bounded trend', () => {
  const d = repo({ 'src/a.js': 'eval(x);\nconst k = "AKIAABCDEFGHIJKLMNOP";\n', 'test/a.test.js': 'it(1);\n', 'package.json': '{"scripts":{"test":"x"}}' });
  const p = analyzeRepo(d); assert.equal(p.quality.counts.secrets, 1); assert.equal(p.quality.gate.status, 'ERROR'); assert.ok(p.quality.findings.some((f) => f.rule === 'eval')); assert.equal(p.metrics.ratings.security, 'E'); assert.equal('_findings' in p.metrics, false);
  let h = []; for (let i = 0; i < 40; i++) h = addHistory(h, { ...p, analyzedAt: `t${i}` }); assert.equal(h.length, 30); assert.equal(h.at(-1).at, 't39'); assert.deepEqual(addHistory(undefined, { metrics: null }), []);
});

// ---- the gate inside the ticket loop, against a real git remote
function loop(agentScript, over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-')); const remote = path.join(root, 'remote.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(root, 'seed'); execFileSync('git', ['init', '-q', '-b', 'main', seed]); fs.writeFileSync(path.join(seed, 'a.js'), 'export const a = 1;\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'i'); git(seed, 'push', '-q', remote, 'main');
  const tpath = path.join(root, 't.json'); fs.writeFileSync(tpath, JSON.stringify([{ id: 1, title: 'Add a thing to a.js', body: 'Add a thing to a.js that returns one, with a test please', labels: ['agent-ready'], comments: [] }]));
  const attempts = []; let n = 0; const prs = [];
  const sandbox = { create: async ({ cloneUrl, branch, base }) => { const dir = fs.mkdtempSync(path.join(root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); git(dir, 'checkout', '-qb', branch); return { dir, cloneUrl, destroy() {} }; }, exec: async () => ({ code: 0, out: 'ok' }) };
  const agent = { run: async (_sb, ws, prompt) => { attempts.push(prompt); n++; agentScript(ws.dir, n); return { out: 'done', costUsd: 0 }; } };
  return { attempts, prs, remote, tpath, deps: async () => { const { gitVcs } = await import('../src/adapters/vcs.mjs'); const { fileTickets } = await import('../src/adapters/tickets-file.mjs'); return { tickets: fileTickets(tpath), sandbox, agent, vcs: gitVcs({ openPr: (a) => { prs.push(a); return 'https://example.test/pr/1'; } }), config: { repo: 'o/r', base: 'main', cloneUrl: remote, maxAttempts: 2, ...over }, stateDir: path.join(root, 'state') }; } };
}

test('loop: agent adds a secret, gets one chance, fixes it -> PR opens and says the gate passed', async () => {
  const L = loop((dir, n) => fs.writeFileSync(path.join(dir, 'b.js'), n === 1 ? 'export const key = "AKIAABCDEFGHIJKLMNOP";\n' : 'export const key = process.env.KEY;\n'));
  const [rec] = await tick(await L.deps()); assert.equal(rec.status, 'ok'); assert.equal(rec.attempts, 2); assert.match(L.attempts[1], /quality gate on your change failed.*hard-coded secrets[\s\S]*b\.js:1 \[secret\]/); assert.equal(rec.quality.status, 'OK'); assert.match(L.prs[0].body, /Quality gate: passed/);
});

test('loop: a secret that is never removed STOPS the PR (nothing pushed); a vulnerability that is never fixed ships FLAGGED', async () => {
  const S = loop((dir) => fs.writeFileSync(path.join(dir, 'b.js'), 'export const key = "AKIAABCDEFGHIJKLMNOP";\n')); const [r1] = await tick(await S.deps());
  assert.equal(r1.status, 'quality-failed'); assert.match(r1.error, /hard-coded secrets/); assert.equal(S.prs.length, 0); assert.doesNotMatch(execFileSync('git', ['--git-dir', S.remote, 'branch']).toString(), /agent\//);
  assert.ok(JSON.parse(fs.readFileSync(S.tpath))[0].labels.includes('agent-failed'));
  const V = loop((dir) => fs.writeFileSync(path.join(dir, 'b.js'), 'export const run = (s) => eval(s);\n')); const [r2] = await tick(await V.deps());
  assert.equal(r2.status, 'ok'); assert.equal(r2.quality.status, 'WARN'); assert.match(V.prs[0].body, /Quality gate: flagged.*1 new vulnerabilities[\s\S]*\[eval\]/); assert.match(JSON.parse(fs.readFileSync(V.tpath))[0].comments.at(-1), /Quality gate flagged this change/);
});

test('loop: qualityGate:false switches it off, and a clean change is untouched', async () => {
  const off = loop((dir) => fs.writeFileSync(path.join(dir, 'b.js'), 'export const key = "AKIAABCDEFGHIJKLMNOP";\n'), { qualityGate: false }); const [r] = await tick(await off.deps()); assert.equal(r.status, 'ok'); assert.equal(r.quality, undefined);
  const clean = loop((dir) => fs.writeFileSync(path.join(dir, 'b.js'), 'export const b = 2;\n')); const [c] = await tick(await clean.deps()); assert.equal(c.attempts, 1); assert.equal(c.quality.passed, true);
});

test('engine: repo findings can be queued as a fix ticket; the profile quality from the browser is bounded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {} });
  e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  const evil = { quality: { counts: { secrets: 1e12, total: -5 }, gate: { status: 'ERROR', failed: ['<script>x</script> 3 secrets'] }, findings: Array.from({ length: 40 }, (_, i) => ({ key: `eval:a.js:${i}`, rule: 'eval', type: 'vulnerability', severity: 'WHATEVER', file: 'a.js', line: i, message: '`rm -rf`\nnow' })) } };
  const p = await e.addProject({ repo: 'o/app', profile: evil }); assert.equal(p.profile.quality.findings.length, 15); assert.equal(p.profile.quality.findings[0].severity, 'INFO'); assert.ok(p.profile.quality.counts.secrets <= 1e6); assert.doesNotMatch(JSON.stringify(p.profile.quality), /<script>|`|\n/); assert.equal(p.profile.history.length, 1);
  const made = []; e.createTicket = async (id, t) => { made.push(t); return {}; }; await e.findingTicket('app', 'eval:a.js:3'); assert.match(made[0].title, /^Fix vulnerability:/); assert.match(made[0].body, /code quality scan reports eval/);
});

test('loop: ignored files are not gated, and the agent cannot loosen the gate by editing the repo config', async () => {
  const mkKey = (dir, rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), 'export const key = "AKIAABCDEFGHIJKLMNOP";\n'); };
  const A = loop((dir) => mkKey(dir, 'fixtures/key.js'), { analysis: { ignore: ['fixtures/'] } }); const [a] = await tick(await A.deps()); assert.equal(a.status, 'ok'); assert.equal(a.attempts, 1); assert.equal(a.quality.passed, true);       // project says fixtures/ is ignored
  const B = loop((dir) => mkKey(dir, 'fixtures/key.js')); const [b] = await tick(await B.deps()); assert.equal(b.status, 'quality-failed');                                                                         // not ignored: blocked
  const C = loop((dir) => { mkKey(dir, 'src/key.js'); fs.writeFileSync(path.join(dir, '.agent-factory.json'), JSON.stringify({ analysis: { ignore: ['src/'] } })); }); const [c] = await tick(await C.deps());
  assert.equal(c.status, 'protected-path'); assert.equal(C.prs.length, 0);                                                                                                                                         // editing the rules is itself refused
  const D = loop((dir) => mkKey(dir, 'package-lock.json')); const [d] = await tick(await D.deps()); assert.equal(d.status, 'ok'); assert.equal(d.attempts, 1);                                                    // default ignore: lock files
});
