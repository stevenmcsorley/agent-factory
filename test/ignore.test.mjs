import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeIgnore, cleanPatterns, globToRegExp, DEFAULT_IGNORE } from '../src/ignore.mjs';
import { analyzeRepo } from '../src/analyze.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';

const mk = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-')); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } return d; };
const lines = (n, t) => Array.from({ length: n }, (_, i) => `export const ${t}${i} = ${i} + 424242;`).join('\n') + '\n';

test('matcher: names match at any depth, dir/ matches folders, paths are anchored, wildcards stay inside a segment, look-alikes are not hit', () => {
  const m = makeIgnore({ patterns: ['docs/api/*.md', '/legacy', 'fixtures/', '*.sql', 'gen/**/out.js'] });
  const yes = { 'package-lock.json': 'default', 'a/b/yarn.lock': 'default', 'x.lock': 'default', 'src/app.min.js': 'default', 'dist/a.js': 'default', 'src/build/a.js': 'default', 'a/__snapshots__/x.snap': 'default', 'logo.png': 'default',
    'docs/api/x.md': 'yours', 'legacy/a.js': 'yours', 'src/fixtures/a.js': 'yours', 'db/seed.sql': 'yours', 'gen/a/b/out.js': 'yours' };
  for (const [f, why] of Object.entries(yes)) assert.equal(m.test(f), why, f);
  for (const f of ['src/app.js', 'src/lock.js', 'distribution/a.js', 'docs/other/x.md', 'src/legacy/a.js', 'docs/api/sub/x.md', 'src/buildings/a.js', 'README.md', 'gen/a.js']) assert.equal(m.test(f), null, f);
  assert.equal(makeIgnore({ useDefaults: false }).test('package-lock.json'), null); assert.equal(makeIgnore({ patterns: ['package-lock.json'], useDefaults: false }).test('package-lock.json'), 'yours');
  assert.ok(DEFAULT_IGNORE.includes('package-lock.json') && DEFAULT_IGNORE.includes('pnpm-lock.yaml'));
});

test('patterns are validated: no traversal, negation, shell or regex tricks, bounded count/length/wildcards; and hostile globs are fast', () => {
  const r = cleanPatterns(['*.sql', ' ./docs/*.md ', '# comment', '', '!keep', '../etc', 'a;b', 'x'.repeat(200), '*'.repeat(7), '(a+)+$', 'dup', 'dup']);
  assert.deepEqual(r.patterns, ['*.sql', 'docs/*.md', 'dup']); assert.equal(r.dropped.length, 6);
  assert.equal(cleanPatterns(Array.from({ length: 200 }, (_, i) => `p${i}`)).patterns.length, 60); assert.deepEqual(cleanPatterns('nope').patterns, []);
  const t0 = Date.now(); const re = globToRegExp('**/*a*a*a*a*a*b'); for (let i = 0; i < 200; i++) re.test('a'.repeat(300)); assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
});

test('analysis skips lock files, minified and generated files entirely, and says what it skipped', () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0', integrity: `sha512-${'A'.repeat(60)}` }])) }, null, 2);
  const p = analyzeRepo(mk({ 'package.json': '{"scripts":{"test":"x"}}', 'package-lock.json': lock, 'yarn.lock': 'x\n'.repeat(5000), 'src/app.js': lines(30, 'a'), 'src/app.min.js': 'var a=1;'.repeat(5000), 'dist/out.js': lines(300, 'd'), 'coverage/report.js': lines(100, 'c'), 'test/app.test.js': lines(10, 't'), 'src/key.lock': 'k = "AKIAABCDEFGHIJKLMNOP"' }));
  assert.equal(p.metrics.codeLines, 40); assert.equal(p.metrics.secrets.length, 0); assert.deepEqual(p.metrics.hotspots.map((h) => h.file), ['src/app.js']);
  assert.ok(p.ignored.defaults >= 4); assert.equal(p.ignored.yours, 0); assert.ok(p.ignored.folders >= 1); assert.ok(p.ignored.examples.some((e) => e.path === 'package-lock.json' && e.why === 'default'));
});

test('your patterns, the repo\'s own .agent-factory.json, and switching the defaults off all combine as expected', () => {
  const files = { 'src/a.js': lines(30, 'a'), 'src/gen/big.js': lines(500, 'g'), 'legacy/old.js': lines(200, 'o'), 'sql/x.sql': 'select 1;\n', 'package-lock.json': lines(100, 'p').replace(/export const/g, '"k":') };
  const base = analyzeRepo(mk(files)); assert.equal(base.metrics.codeLines, 731);
  const mine = analyzeRepo(mk(files), { ignore: ['src/gen/', '/legacy'] }); assert.equal(mine.metrics.codeLines, 31); assert.equal(mine.ignored.yours, 0); assert.equal(mine.ignored.folders >= 2, true); assert.deepEqual(mine.ignored.patterns, ['src/gen/', '/legacy']);
  const repo = analyzeRepo(mk({ ...files, '.agent-factory.json': JSON.stringify({ analysis: { ignore: ['legacy/'] } }) }), { ignore: ['src/gen/'] }); assert.equal(repo.metrics.codeLines, 31);        // project + repo patterns are added together
  const noDef = analyzeRepo(mk({ 'src/a.js': lines(30, 'a'), 'src/app.min.js': lines(50, 'm') }), { ignoreDefaults: false }); assert.equal(noDef.metrics.codeLines, 80); assert.equal(noDef.ignored.useDefaults, false);
  const repoOff = analyzeRepo(mk({ 'src/a.js': lines(30, 'a'), 'src/app.min.js': lines(50, 'm'), '.agent-factory.json': JSON.stringify({ analysis: { ignoreDefaults: false } }) })); assert.equal(repoOff.metrics.codeLines, 80);
  const junk = analyzeRepo(mk({ 'src/a.js': lines(30, 'a'), '.agent-factory.json': JSON.stringify({ analysis: { ignore: ['../../etc', '!x', 'ok/'] } }) })); assert.equal(junk.metrics.codeLines, 30);   // bad entries are dropped, not fatal
});

test('copies, untested files and findings all ignore ignored files', () => {
  const dup = `export function f() {\n${Array.from({ length: 9 }, (_, i) => `  const v${i} = compute(${i}, "same arguments here");`).join('\n')}\n}\n`;
  const files = { 'src/a.js': dup, 'src/b.js': dup, 'src/c.js': 'eval(x);\n' + lines(20, 'c') };
  assert.equal(analyzeRepo(mk(files)).duplicates.blocks.length, 1);
  const p = analyzeRepo(mk(files), { ignore: ['src/b.js', 'src/c.js'] }); assert.equal(p.duplicates.blocks.length, 0); assert.equal(p.quality.counts.vulnerabilities, 0); assert.ok(!p.structure.untested.some((u) => u.file === 'src/c.js'));
});

function eng() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-')); const repoDir = mk({ 'src/a.js': lines(30, 'a'), 'src/gen/big.js': lines(300, 'g') });
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [], limits: { analysis: { ignore: ['sql/'] } } }), { configPath: path.join(root, 'c.json'), env: {} });
  e.f.sandbox = { create: async () => ({ dir: repoDir, destroy() {} }) }; e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} }; return e;
}
const settle = async (e, id) => { for (let i = 0; i < 300 && e.analysisJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10)); return e.analysisJob(id); };

test('engine: patterns are saved per project, validated, re-analyze runs, global + project rules combine, and the factory receives them', async () => {
  const e = eng(); await e.addProject({ repo: 'o/app' });
  assert.deepEqual(e._analysisCfg(e.cfg.projects[0]), { ignore: ['sql/'], ignoreDefaults: true });
  await assert.rejects(e.setIgnore('app', { patterns: ['../x', 'ok/'] }), /not allowed: \.\.\/x/); assert.equal(e.cfg.projects[0].config?.analysis, undefined, 'nothing saved on a bad pattern');
  const job = await e.setIgnore('app', { patterns: ['src/gen/', 'src/gen/'] }); assert.equal(job.state, 'running'); await settle(e, 'app');
  const pr = e.cfg.projects[0].profile; assert.equal(pr.metrics.codeLines, 30); assert.deepEqual(pr.ignored.patterns, ['sql/', 'src/gen/']); assert.ok(pr.ignored.folders >= 1);
  assert.deepEqual(e.cfg.projects[0].config.analysis, { ignore: ['src/gen/'] }); assert.deepEqual(e._analysisCfg(e.cfg.projects[0]).ignore, ['sql/', 'src/gen/']);
  assert.match(fs.readFileSync(e.configPath, 'utf8'), /"ignore": \[\s*"src\/gen\/"/);
  await e.setIgnore('app', { patterns: [], useDefaults: false }); await settle(e, 'app'); assert.equal(e._analysisCfg(e.cfg.projects[0]).ignoreDefaults, false); assert.equal(e.cfg.projects[0].profile.ignored.useDefaults, false);
  const evil = await e.addProject({ id: 'two', repo: 'o/two', profile: { ignored: { defaults: 1e15, patterns: ['../../x', 'ok/', '!y'], examples: [{ path: 'a b;c', why: 'x' }] } } }); assert.deepEqual(evil.profile.ignored.patterns, ['ok/']); assert.equal(evil.profile.ignored.examples[0].path, 'abc'); assert.ok(evil.profile.ignored.defaults <= 1e7);
});

test('CLI: --ignore and --no-default-ignore change the report', () => {
  const d = mk({ 'src/a.js': lines(30, 'a'), 'src/gen/big.js': lines(300, 'g'), 'src/x.min.js': lines(40, 'm') }); const cli = path.resolve('src/cli.mjs'); const lines_of = (extra) => JSON.parse(execFileSync('node', [cli, 'analyze', d, '--json', ...extra], { cwd: os.tmpdir() }).toString()).metrics.codeLines;
  assert.equal(lines_of([]), 330); assert.equal(lines_of(['--ignore=src/gen/']), 30); assert.equal(lines_of(['--no-default-ignore']), 370);
  assert.match(execFileSync('node', [cli, 'analyze', d, '--ignore=src/gen/'], { cwd: os.tmpdir() }).toString(), /Ignored: .*by default rules/);
});
