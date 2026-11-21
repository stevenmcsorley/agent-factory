import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { needsTests } from '../src/tester.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';

test('needsTests: source changed with no test beside it; docs and config alone do not need tests', () => {
  assert.deepEqual(needsTests(' M src/a.js\n?? src/b.ts'), ['src/a.js', 'src/b.ts']);
  assert.equal(needsTests(' M src/a.js\n?? test/a.test.js'), null, 'a test came with it');
  assert.equal(needsTests(' M README.md\n M package.json\n M styles.css'), null);
  assert.equal(needsTests(' M src/__tests__/x.js'), null);
  assert.equal(needsTests(''), null);
});

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-')); git(dir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n'); fs.writeFileSync(path.join(dir, 'notes.md'), 'x\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\nexport const negate = (n) => -n;\n');   // the builder's uncommitted change
  return { dir, destroy() {} };
}
function boot(agentRun) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-'));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, roles: { tester: { enabled: true } }, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } }] });
  const e = new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: { agent: { name: 'fake', run: agentRun } } });
  return e._tester(e.project('a'), {}, undefined);
}
const job = (ws, rerun = async () => true) => ({ ws, ticket: { id: 1, title: 'Add negate', body: 'x' }, files: ['a.mjs'], rerun });
const builderStillThere = (ws) => assert.match(fs.readFileSync(path.join(ws.dir, 'a.mjs'), 'utf8'), /negate/);

test('tester: adds test files, runs the tests again, and keeps the builder\'s change', async () => {
  const ws = repo(); const hook = boot(async (_s, w, prompt) => { assert.match(prompt, /Source files the builder changed[\s\S]*a\.mjs/); assert.match(prompt, /TEST FILES ONLY/); fs.writeFileSync(path.join(w.dir, 'a.test.mjs'), 'test\n'); return { out: 'Tested negate for positives and zero.', code: 0 }; });
  const r = await hook(job(ws)); assert.equal(r.status, 'added'); assert.deepEqual(r.files, ['a.test.mjs']); assert.ok(fs.existsSync(path.join(ws.dir, 'a.test.mjs'))); builderStillThere(ws);
});
test('tester: touching a source file undoes everything, and the builder\'s change is exactly as it was', async () => {
  const ws = repo(); const before = fs.readFileSync(path.join(ws.dir, 'a.mjs'), 'utf8');
  const r = await boot(async (_s, w) => { fs.writeFileSync(path.join(w.dir, 'a.test.mjs'), 't\n'); fs.appendFileSync(path.join(w.dir, 'a.mjs'), '// sneaky\n'); return { out: 'ok' }; })(job(ws));
  assert.equal(r.status, 'reverted'); assert.match(r.summary, /non-test files: a\.mjs/); assert.equal(fs.readFileSync(path.join(ws.dir, 'a.mjs'), 'utf8'), before); assert.ok(!fs.existsSync(path.join(ws.dir, 'a.test.mjs')));
});
test('tester: a new non-test file, a failing test command, or no tests at all are each undone', async () => {
  let ws = repo(); let r = await boot(async (_s, w) => { fs.writeFileSync(path.join(w.dir, 'helper.mjs'), 'x\n'); return { out: '' }; })(job(ws)); assert.equal(r.status, 'reverted'); assert.match(r.summary, /helper\.mjs/); assert.ok(!fs.existsSync(path.join(ws.dir, 'helper.mjs'))); builderStillThere(ws);
  ws = repo(); r = await boot(async (_s, w) => { fs.writeFileSync(path.join(w.dir, 'a.test.mjs'), 't\n'); return { out: '' }; })(job(ws, async () => false)); assert.equal(r.status, 'reverted'); assert.match(r.summary, /test command failed/); assert.ok(!fs.existsSync(path.join(ws.dir, 'a.test.mjs'))); builderStillThere(ws);
  ws = repo(); r = await boot(async () => ({ out: 'nothing to do' }))(job(ws)); assert.equal(r.status, 'reverted'); assert.match(r.summary, /no tests/); builderStillThere(ws);
});
test('tester: off by default (no hook), so the loop is unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } }] }), { configPath: path.join(root, 'c.json'), factories: {} });
  assert.equal(e._tester(e.project('a')), undefined);
});
