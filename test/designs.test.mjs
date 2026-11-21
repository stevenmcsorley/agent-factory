import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ds from '../src/designs.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
const PAGE = '<!doctype html><html><head><style>:root{--brand:#c2410c} body{font:16px system-ui}</style></head><body><h1>Home</h1><link rel="stylesheet" href="https://evil/x.css"><p>After the link tag</p></body></html>';

test('cleaning: active content is gone, ordinary markup survives, a void <link> does not eat the page', () => {
  const dirty = '<html><body onload="x()"><script>alert(1)</script><a href="javascript:alert(1)" onclick="y()">go</a><iframe src="https://e"></iframe><img src="https://t/p.gif" onerror="z()"><div style="background:url(https://t/b.png)">k</div><p>kept</p></body></html>';
  const out = ds.cleanDesignHtml(dirty);
  assert.doesNotMatch(out, /<script|alert|onclick|onload|onerror|<iframe|javascript:/i); assert.match(out, /kept/); assert.doesNotMatch(out, /url\(https/);
  const page = ds.cleanDesignHtml(PAGE); assert.match(page, /After the link tag/); assert.doesNotMatch(page, /<link/); assert.match(page, /--brand/);
  assert.match(ds.cleanDesignHtml('<div class="card">just a fragment</div>'), /^<!doctype html>/);
  assert.throws(() => ds.cleanDesignHtml('plain words, no markup'), /HTML page/);
  assert.throws(() => ds.cleanDesignHtml(`<div>${'x'.repeat(401_000)}</div>`), /at most/);
});

test('a design goes drafting -> proposed -> approved; changing it reopens; only approved designs reach the builder', () => {
  const p = dir(); const d = ds.createDesign(p, { title: 'Home screen', request: 'A dashboard home with a queue of tickets and a big start button' });
  assert.equal(d.status, 'drafting'); assert.equal(ds.designContext(p), '');
  const v1 = ds.addVersion(p, d.id, { html: PAGE, rationale: 'Queue first.' }); assert.equal(v1.status, 'proposed'); assert.equal(v1.versions[0].n, 1);
  assert.equal(ds.designContext(p), '', 'proposed is not approved');
  ds.addComment(p, d.id, 'Make the button bigger'); const v2 = ds.addVersion(p, d.id, { html: PAGE.replace('Home', 'Home v2'), rationale: 'Bigger button.', feedback: 'Make the button bigger' }); assert.equal(v2.versions.length, 2);
  const ok = ds.setStatus(p, d.id, 'approved', 2); assert.equal(ok.approvedVersion, 2);
  const ctx = ds.designContext(p); assert.match(ctx, /Approved designs/); assert.match(ctx, /--brand:#c2410c/); assert.match(ctx, new RegExp(`designs/${d.id}\\.html`));
  assert.match(ds.readHtml(p, d.id), /Home v2/);   // default is the approved version
  const ws = dir(); ds.materializeDesigns(p, ws); assert.match(fs.readFileSync(path.join(ws, '.factory-context', 'designs', `${d.id}.html`), 'utf8'), /Home v2/);
  ds.setStatus(p, d.id, 'proposed'); assert.equal(ds.designContext(p), '');
  assert.throws(() => ds.setStatus(p, d.id, 'approved', 9), /Nothing to approve/);
  ds.removeDesign(p, d.id); assert.equal(ds.listDesigns(p).length, 0);
});

test('bad input: empty request, path-like ids, approving with no version', () => {
  const p = dir();
  assert.throws(() => ds.createDesign(p, { title: '', request: 'long enough request here' }), /title/); assert.throws(() => ds.createDesign(p, { title: 'x', request: 'short' }), /Describe/);
  assert.throws(() => ds.getDesign(p, '../../etc'), /Bad design id/);
  const d = ds.createDesign(p, { title: 'x', request: 'a decent length request' }); assert.throws(() => ds.setStatus(p, d.id, 'approved'), /Nothing to approve/);
  ds.setError(p, d.id, 'agent failed'); assert.equal(ds.getDesign(p, d.id).status, 'failed');
});

import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
import { buildPrompt } from '../src/factory.mjs';

function boot(agentRun) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'de-'));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } }] });
  const sandbox = { create: async () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dws-')); return { dir: d, destroy: () => fs.rmSync(d, { recursive: true, force: true }) }; } };
  return new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: { sandbox, agent: { name: 'fake', run: agentRun }, hostAdapter: () => ({ pr: {}, cloneUrl: () => 'x', gitEnv: () => ({}), prUrl: () => '' }), tickets: () => ({}) } });
}
const settle = async (e, did) => { for (let i = 0; i < 100; i++) { const d = e.getDesign('a', did); if (!d.working) return d; await new Promise((r) => setTimeout(r, 20)); } throw new Error('designer never finished'); };

test('designer flow over MCP: request, review, revise on feedback, hand edit, approve, and the builder is told', async () => {
  const prompts = []; let n = 0;
  const e = boot(async (_sb, ws, prompt) => { prompts.push(prompt); n++; fs.writeFileSync(path.join(ws.dir, '.factory-design', 'design.html'), PAGE.replace('Home', `Home draft ${n}`)); return { out: `Notes for draft ${n}.`, code: 0 }; });
  const made = await callOp(e, 'create_design', { project: 'a', title: 'Home', request: 'A dashboard home with a queue and a big start button' });
  let d = await settle(e, made.id); assert.equal(d.status, 'proposed'); assert.match(prompts[0], /What to design \(data\)[\s\S]*big start button/); assert.match(prompts[0], /ui-design/);
  assert.match(d.versions[0].rationale, /Notes for draft 1/); assert.match((await callOp(e, 'get_design', { project: 'a', design: d.id, html: true })).html, /Home draft 1/);
  await callOp(e, 'revise_design', { project: 'a', design: d.id, feedback: 'Make the button bigger' }); d = await settle(e, d.id);
  assert.equal(d.versions.length, 2); assert.match(prompts[1], /previous\.html[\s\S]*Make the button bigger/); assert.equal(d.comments[0].text, 'Make the button bigger');
  await callOp(e, 'edit_design', { project: 'a', design: d.id, html: PAGE.replace('Home', 'Home by hand'), note: 'tweaked' }); d = e.getDesign('a', d.id); assert.equal(d.versions[2].by, 'you');
  assert.match(e._designContext('a'), /^$/, 'not approved yet: the builder hears nothing');
  await callOp(e, 'approve_design', { project: 'a', design: d.id }); assert.match(e._designContext('a'), /Approved designs[\s\S]*--brand/);
  assert.match(buildPrompt({ id: 1, title: 'T', body: 'B' }, '', '', e.deps(e.project('a')).config.contextFor({ id: 1, title: 'T', body: 'B' })), /Approved designs/);
  await callOp(e, 'reject_design', { project: 'a', design: d.id }); assert.equal(e._designContext('a'), '');
  await callOp(e, 'delete_design', { project: 'a', design: d.id }); assert.equal((await callOp(e, 'list_designs', { project: 'a' })).designs.length, 0);
});

test('designer failing is shown on the design, not lost', async () => {
  const e = boot(async () => ({ out: 'I could not do that', code: 0 }));
  const made = await callOp(e, 'create_design', { project: 'a', title: 'Broken', request: 'A screen that will not get made' }); const d = await settle(e, made.id);
  assert.equal(d.status, 'failed'); assert.match(d.error, /did not produce a design/);
});
