import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePreview, runVisual, evaluate, findingsOf, visualFeedback } from '../src/visual.mjs';
import { mergeVerdict } from '../src/autonomy.mjs';

const page = (over = {}) => ({ route: '/', width: 360, scheme: 'light', status: 200, error: null, shot: null, consoleErrors: [], failedRequests: [], overflow: null, tapTargets: [], contrast: [], ...over });

test('preview settings are validated: one-line command, a real port, sane routes', () => {
  assert.equal(normalizePreview(null), null);
  const ok = normalizePreview({ command: 'npm run dev -- --port 4173', port: 4173, routes: '/, /settings\n/a/b?x=1' }); assert.deepEqual(ok.routes, ['/', '/settings', '/a/b?x=1']);
  assert.deepEqual(normalizePreview({ command: 'x', port: 3000 }).routes, ['/']);
  assert.throws(() => normalizePreview({ port: 3000 }), /command is required/); assert.throws(() => normalizePreview({ command: 'a\nb', port: 3000 }), /one line/);
  assert.throws(() => normalizePreview({ command: 'x', port: 80 }), /port/); assert.throws(() => normalizePreview({ command: 'x', port: 3000, routes: ['//evil.test'] }), /not a route/);
  assert.throws(() => normalizePreview({ command: 'x', port: 3000, routes: ['http://evil.test/'] }), /not a route/); assert.throws(() => normalizePreview({ command: 'x', port: 3000, nope: 1 }), /not a preview setting/);
});

test('findings: what counts as a failure, what is only a warning, and the same problem at many widths is one finding', () => {
  const rep = { ok: true, pages: [
    page({ width: 360, overflow: { scrollWidth: 380, innerWidth: 360, elements: ['div.table'] } }), page({ width: 360, scheme: 'dark', overflow: { scrollWidth: 380, innerWidth: 360, elements: ['div.table'] } }),
    page({ route: '/s', contrast: [{ el: 'p.hint', ratio: 2.1, need: 4.5, text: 'Hint' }, { el: 'p.sub', ratio: 4.0, need: 4.5, text: 'Sub' }], tapTargets: [{ el: 'button.x', w: 30, h: 30, text: 'x' }] }),
    page({ route: '/b', consoleErrors: ['boom'], status: 500 }) ] };
  const f = findingsOf(rep); const by = (k) => f.filter((x) => x.kind === k);
  assert.equal(by('overflow').length, 1); assert.deepEqual(by('overflow')[0].schemes.sort(), ['dark', 'light']);
  assert.equal(by('contrast').find((x) => /hint/.test(x.detail)).severity, 'fail'); assert.equal(by('contrast').find((x) => /Sub/.test(x.detail)).severity, 'warn');
  assert.equal(by('tap')[0].severity, 'warn'); assert.equal(by('console')[0].severity, 'fail'); assert.equal(by('load')[0].severity, 'fail');
});

test('baseline: problems already on the base branch do not count, new ones do', () => {
  const rep = { ok: true, pages: [page({ overflow: { scrollWidth: 400, innerWidth: 360, elements: ['div.old'] } })] };
  const first = evaluate(rep, null); assert.equal(first.status, 'fail');
  const again = evaluate(rep, first.keys); assert.equal(again.status, 'pass'); assert.equal(again.counts.existing, 1); assert.match(again.summary, /1 already on the base branch/);
  const worse = { ok: true, pages: [...rep.pages, page({ route: '/new', overflow: { scrollWidth: 500, innerWidth: 360, elements: ['div.new'] } })] };
  const v = evaluate(worse, first.keys); assert.equal(v.status, 'fail'); assert.equal(v.findings.length, 1); assert.equal(v.findings[0].route, '/new');
  assert.match(visualFeedback(v), /\/new at 360px: Scrolls sideways/);
  assert.equal(evaluate({ ok: false, error: 'app never started' }).status, 'error');
  assert.equal(evaluate({ ok: true, pages: [page({ tapTargets: [{ el: 'a', w: 20, h: 20, text: '' }] })] }, null).status, 'warn');
});

// A stand-in for the container: writes what the real runner would.
const fakeSandbox = (report, { shots = [], code = 0 } = {}) => ({ calls: [], async exec(ws, cmd, args, o) { this.calls.push({ cmd, args, o }); const out = path.join(ws.dir, '.factory-visual', 'out'); if (report) fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report)); for (const s of shots) fs.writeFileSync(path.join(out, s), 'png'); return { code, out: '' }; } });
const mkws = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-')); fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true }); return { dir }; };

test('runVisual: starts the app and the runner in the visual image, keeps the folder out of git, copies screenshots out', async () => {
  const ws = mkws(); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-')); const sb = fakeSandbox({ ok: true, pages: [page({ shot: 'home-360-light.png' })] }, { shots: ['home-360-light.png'] });
  const r = await runVisual({ sandbox: sb, ws, preview: { command: 'npm run dev', port: 4173, routes: ['/'], install: 'npm ci' }, outDir: out });
  assert.equal(r.ok, true); assert.deepEqual(r.shots, ['home-360-light.png']); assert.ok(fs.existsSync(path.join(out, 'home-360-light.png')));
  const call = sb.calls[0]; assert.equal(call.o.image, 'agent-factory-visual:latest'); assert.match(call.args[1], /npm ci[\s\S]*npm run dev[\s\S]*runner\.mjs/);
  assert.match(fs.readFileSync(path.join(ws.dir, '.git', 'info', 'exclude'), 'utf8'), /\.factory-visual/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws.dir, '.factory-visual', 'spec.json'), 'utf8')).port, 4173);
});
test('runVisual: a runner that wrote nothing is reported as a failure to run, not a pass', async () => {
  const r = await runVisual({ sandbox: fakeSandbox(null, { code: 1 }), ws: mkws(), preview: { command: 'x', port: 4000, routes: ['/'] }, outDir: os.tmpdir() });
  assert.equal(r.ok, false); assert.match(r.error, /did not finish/); assert.equal(evaluate(r).status, 'error');
});

test('autonomy: new visual problems, or a check that could not run, hold the merge', () => {
  const base = { global: { allow: true }, auto: { mode: 'merge' }, run: { status: 'ok', pr: 'x/pull/1', verifyCmd: 'npm test', review: { verdict: 'approve' } }, feedback: { failedChecks: [], pending: false, comments: [] } };
  assert.equal(mergeVerdict({ ...base, run: { ...base.run, visual: { status: 'pass' } } }).ok, true); assert.equal(mergeVerdict({ ...base, run: { ...base.run, visual: { status: 'warn' } } }).ok, true);
  assert.match(mergeVerdict({ ...base, run: { ...base.run, visual: { status: 'fail' } } }).blockers.join(), /visual check found/); assert.match(mergeVerdict({ ...base, run: { ...base.run, visual: { status: 'error' } } }).blockers.join(), /could not run/);
});

import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
test('switching the check on or off keeps the baseline; changing the app set-up discards it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'));
  const e = new Engine(withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } }] }), { configPath: path.join(root, 'c.json'), factories: {} });
  const pv = { command: 'npm run dev', port: 4173, routes: ['/'], enabled: false }; await callOp(e, 'set_preview', { project: 'a', preview: pv });
  const f = path.join(e._visualDir('a'), 'baseline.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), keys: [], findings: [], counts: {}, shots: [] }));
  await callOp(e, 'set_preview', { project: 'a', preview: { ...pv, enabled: true } }); assert.ok(fs.existsSync(f), 'on/off keeps it');
  await callOp(e, 'set_preview', { project: 'a', preview: { ...pv, enabled: true, routes: ['/', '/x'] } }); assert.ok(!fs.existsSync(f), 'a different app set-up discards it');
});

test('a change that removes problems from the baseline says so', () => {
  const bad = { ok: true, pages: [page({ tapTargets: [{ el: 'button.a', w: 30, h: 30, text: 'a' }, { el: 'button.b', w: 30, h: 30, text: 'b' }] })] };
  const base = evaluate(bad, null); const fixed = evaluate({ ok: true, pages: [page({ tapTargets: [{ el: 'button.b', w: 30, h: 30, text: 'b' }] })] }, base.keys);
  assert.equal(fixed.status, 'pass'); assert.equal(fixed.counts.resolved, 1); assert.equal(fixed.counts.existing, 1); assert.match(fixed.summary, /1 already on the base branch, 1 fixed by this change/);
});

test('preview image: an optional container image name, validated', () => {
  assert.equal(normalizePreview({ command: 'x', port: 3000, image: 'agent-factory-visual-python:latest' }).image, 'agent-factory-visual-python:latest'); assert.equal(normalizePreview({ command: 'x', port: 3000 }).image, undefined);
  assert.throws(() => normalizePreview({ command: 'x', port: 3000, image: 'bad image; rm' }), /image name/);
});
