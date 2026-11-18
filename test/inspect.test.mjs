import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeRepo } from '../src/analyze.mjs';
import { inspectCode, importedNames } from '../src/inspect.mjs';
import { textReport } from '../src/report.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';

const mk = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'in-')); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } return d; };
const block = (tag, n = 8) => Array.from({ length: n }, (_, i) => `  const ${tag}${i} = compute(${i}, "same arguments here");`).join('\n');

test('repeated code: finds the same block in two files with real line numbers, merges it into one block, ignores trivial lines and self-overlap', () => {
  const p = analyzeRepo(mk({
    'src/a.js': `// header\nexport function one() {\n${block('x', 9)}\n}\nexport const unique = 1;\n`,
    'src/b.js': `import x from "y";\nexport const other = 2;\nexport function two() {\n${block('x', 9)}\n}\n`,
    'src/c.js': 'import { a } from "./a.js";\nimport { b } from "./b.js";\nimport { c } from "./c.js";\nimport { d } from "./d.js";\nimport { e } from "./e.js";\nimport { f } from "./f.js";\nimport { g } from "./g.js";\n',
    'src/table.js': Array.from({ length: 30 }, () => '  ["same", "row", "repeated", 1],').join('\n'),
  }));
  const blocks = p.duplicates.blocks; assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.equal(blocks[0].lines, 9); assert.deepEqual(blocks[0].a, { file: 'src/a.js', start: 3, end: 11 }); assert.deepEqual(blocks[0].b, { file: 'src/b.js', start: 4, end: 12 }); assert.match(blocks[0].key, /^dup:src\/b\.js:4$/);
  assert.ok(p.duplicates.pct > 0); assert.equal(p.metrics.ratings.duplication === 'A', false);
});

test('repeated code: tests are not counted, and a repo with no copies reports none', () => {
  const same = `function t() {\n${block('y', 9)}\n}\n`;
  assert.equal(analyzeRepo(mk({ 'src/a.js': same, 'test/a.test.js': same, 'test/b.test.js': same })).duplicates.blocks.length, 0);
  assert.deepEqual(analyzeRepo(mk({ 'src/a.js': 'export const a = 1;\n' })).duplicates.blocks, []);
});

test('layout and tests: lines per folder, and which source files have no test (by name or because a test imports them)', () => {
  const lines = (n, t) => Array.from({ length: n }, (_, i) => `export const ${t}${i} = ${i} + 12345;`).join('\n') + '\n';
  const p = analyzeRepo(mk({ 'src/gate.mjs': lines(30, 'g'), 'src/util.mjs': lines(25, 'u'), 'src/lonely.mjs': lines(40, 'l'), 'src/adapters/x.mjs': lines(20, 'x'), 'src/tiny.mjs': 'export const t = 1;\n', 'test/gate.test.mjs': lines(10, 't'), 'test/other.test.mjs': `import { u } from '../src/util.mjs';\n${lines(5, 'o')}`, 'package.json': '{"scripts":{"test":"x"}}' }));
  const s = p.structure; assert.deepEqual(s.dirs.map((d) => d.path), ['src', 'src/adapters', 'test']);                  // biggest first, two levels deep
  assert.equal(s.dirs.find((d) => d.path === 'src').lines, 96); assert.equal(s.dirs.find((d) => d.path === 'test').testLines, s.dirs.find((d) => d.path === 'test').lines);
  assert.deepEqual(s.untested.map((u) => u.file).sort(), ['src/adapters/x.mjs', 'src/lonely.mjs']); assert.equal(s.testedFiles, 2); assert.equal(s.sourceFiles, 4);          // tiny.mjs is under 15 lines: ignored
  assert.deepEqual([...importedNames("import a from '../src/Util.mjs'; const b = require('./thing.js'); import './side.css'")].sort(), ['side', 'thing', 'util']);
});

test('inspectCode is bounded on hostile input', () => {
  const norm = Array.from({ length: 50000 }, (_, i) => ({ t: `line number ${i % 7} of the same text`, n: i + 1 })); const t0 = Date.now();
  const r = inspectCode([{ rel: 'a.js', lang: 'JavaScript', isTest: false, lines: 50000, norm }, { rel: 'b.js', lang: 'JavaScript', isTest: false, lines: 50000, norm }], { maxWindows: 20000 });
  assert.ok(Date.now() - t0 < 3000); assert.ok(r.duplicates.blocks.length <= 12);
});

test('text report covers layout, copies, tests, gate and warnings; empty repo is handled', () => {
  const d = mk({ 'src/a.js': `export function one() {\n${block('x', 9)}\n}\nconst k = "AKIAABCDEFGHIJKLMNOP";\n`, 'src/b.js': `export function two() {\n${block('x', 9)}\n}\n`, 'package.json': '{}' });
  const r = textReport(analyzeRepo(d), 'demo'); for (const needle of ['Code inspection: demo', 'Where the code lives', 'Repeated code:', 'src/a.js:', '==', 'Tests:', 'Quality gate: FAILED', '1 secrets', 'UNVERIFIED', 'not a full static analyser']) assert.ok(r.includes(needle), `missing "${needle}" in\n${r}`);
  assert.match(textReport(analyzeRepo(mk({}))), /empty repository/);
});

test('CLI: `analyze <dir>` prints the report, --json prints the profile, a missing folder fails cleanly', () => {
  const d = mk({ 'src/a.js': `export function one() {\n${block('x', 9)}\n}\n`, 'src/b.js': `export function two() {\n${block('x', 9)}\n}\n` }); const cli = path.resolve('src/cli.mjs');
  const out = execFileSync('node', [cli, 'analyze', d], { cwd: os.tmpdir() }).toString(); assert.match(out, /Repeated code:[\s\S]*src\/a\.js:\d+-\d+\s+==\s+src\/b\.js:\d+-\d+/);
  assert.equal(JSON.parse(execFileSync('node', [cli, 'analyze', d, '--json'], { cwd: os.tmpdir() }).toString()).duplicates.blocks.length, 1);
  assert.throws(() => execFileSync('node', [cli, 'analyze', '/no/such/folder'], { stdio: 'pipe' }), /Not a folder/);
});

function eng() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-')); const repoDir = mk({ 'src/a.js': `export function one() {\n${block('x', 9)}\n}\n`, 'src/b.js': `export function two() {\n${block('x', 9)}\n}\n`, 'src/solo.js': Array.from({ length: 20 }, (_, i) => `export const s${i} = ${i} + 99999;`).join('\n') });
  const e = new Engine(withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {} });
  e.f.sandbox = { create: async () => ({ dir: repoDir, destroy() {} }) }; e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} }; return e;
}
const settle = async (e, id) => { for (let i = 0; i < 300 && e.analysisJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10)); return e.analysisJob(id); };

test('engine: re-analysis is a single-flight background job that stores the inspection and a bounded history', async () => {
  const e = eng(); await e.addProject({ repo: 'o/app' });
  const j = e.startAnalysis('app'); assert.equal(j.state, 'running'); assert.equal(e.startAnalysis('app'), j, 'no duplicate job'); assert.equal((await settle(e, 'app')).state, 'done');
  const pr = e.cfg.projects[0].profile; assert.equal(pr.duplicates.blocks.length, 1); assert.ok(pr.structure.untested.some((u) => u.file === 'src/solo.js')); assert.equal(pr.history.length, 1);
  for (let i = 0; i < 35; i++) { e.startAnalysis('app'); await settle(e, 'app'); } assert.equal(e.cfg.projects[0].profile.history.length, 30);
  assert.throws(() => e.analysisJob('missing'), /No such project/);
  e._analyzeWith = async () => { throw new Error('clone failed: nope'); }; e.startAnalysis('app'); const bad = await settle(e, 'app'); assert.equal(bad.state, 'error'); assert.match(bad.error, /nope/); assert.ok(e.cfg.projects[0].profile.metrics, 'previous result is kept');
});

test('engine: "Queue fix" works for repeated code and for untested files, and refuses unknown keys; stored input is sanitised', async () => {
  const e = eng(); await e.addProject({ repo: 'o/app' }); e.startAnalysis('app'); await settle(e, 'app'); const made = []; e.createTicket = async (id, t) => { made.push(t); return {}; };
  const pr = e.cfg.projects[0].profile; await e.findingTicket('app', pr.duplicates.blocks[0].key); await e.findingTicket('app', pr.structure.untested[0].key);
  assert.match(made[0].title, /^Remove duplicated code in src\/b\.js$/); assert.match(made[0].body, /src\/a\.js \(lines \d+-\d+\) and src\/b\.js \(lines \d+-\d+\)/); assert.match(made[1].title, /^Add tests for src\//); assert.match(made[1].body, /no test/);
  await assert.rejects(e.findingTicket('app', 'dup:nope:1'), /re-analyze first/);
  const evil = { structure: { dirs: [{ path: '../../etc/pass wd;rm', files: 1e15, lines: -4 }], untested: [{ file: 'a b;c.js', lines: 5 }], sourceFiles: 'x' }, duplicates: { pct: 900, blocks: [{ lines: 3, a: { file: '`x`\n', start: 1, end: 2 }, b: { file: 'y.js', start: 4, end: 6 } }] } };
  const p2 = await e.addProject({ id: 'two', repo: 'o/two', profile: evil }); assert.doesNotMatch(JSON.stringify([p2.profile.structure, p2.profile.duplicates]), /[;`\n ]/); assert.equal(p2.profile.duplicates.pct, 100); assert.equal(p2.profile.structure.dirs[0].lines, 0);
});
