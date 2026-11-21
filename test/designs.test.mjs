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

const LOGO = '<?xml version="1.0"?><svg viewBox="0 0 24 24"><script>alert(1)</script><g onclick="x()"><path d="M2 2h20v20H2z" fill="currentColor"/></g><image href="https://evil/x.png"/><use href="https://evil/s.svg#a"/><a xlink:href="javascript:alert(1)"><circle cx="12" cy="12" r="4" style="fill:url(https://evil/p)"/></a><foreignObject><div>hi</div></foreignObject></svg>';
test('svg cleaning: nothing active, nothing that fetches, and it must really be an svg', () => {
  const c = ds.cleanSvg(LOGO); assert.doesNotMatch(c, /script|onclick|<image|evil|javascript|foreignObject|<\?xml/i); assert.match(c, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/); assert.match(c, /M2 2h20v20H2z/);
  assert.equal(ds.cleanSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><use href="#a"/></svg>').includes('href="#a"'), true, 'a fragment reference inside the file is fine');
  assert.throws(() => ds.cleanSvg('<div>no</div>'), /not an SVG/); assert.throws(() => ds.cleanSvg('<svg viewBox="0 0 1 1">'), /not closed/); assert.throws(() => ds.cleanSvg(`<svg>${'x'.repeat(61_000)}</svg>`), /at most/);
});

test('assets: versions of files with a contact sheet, approval, what the builder is told, and published paths', () => {
  const p = dir(); const d = ds.createDesign(p, { title: 'Brand', request: 'A logo mark and three icons for a gym booking app', kind: 'assets' }); assert.equal(d.kind, 'assets');
  assert.throws(() => ds.addVersion(p, d.id, { html: PAGE }), /set of assets/); assert.throws(() => ds.createDesign(p, { title: 'x', request: 'long enough request', kind: 'nope' }), /kind must be/);
  const v1 = ds.addAssetVersion(p, d.id, { files: [{ name: 'Logo Mark.svg', svg: LOGO }, { name: 'logo-mark', svg: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>' }], rationale: 'Bold mark.' });
  assert.deepEqual(v1.versions[0].files, ['logo-mark', 'logo-mark-2']); assert.equal(v1.status, 'proposed'); assert.match(ds.readHtml(p, d.id), /<span class="i"[^>]*><svg/); assert.doesNotMatch(ds.readHtml(p, d.id), /<img/);   // inline, so currentColor follows the panel assert.match(ds.readHtml(p, d.id), /logo-mark\.svg/);
  assert.equal(ds.designContext(p), '', 'proposed is not approved'); ds.setStatus(p, d.id, 'approved', 1);
  assert.match(ds.designContext(p), /Approved artwork[\s\S]*do not draw your own[\s\S]*\.factory-context\/designs\/[a-f0-9]{8}\/[\s\S]*logo-mark\.svg, logo-mark-2\.svg/);
  const ws = dir(); ds.materializeDesigns(p, ws); assert.ok(fs.existsSync(path.join(ws, '.factory-context', 'designs', d.id, 'logo-mark.svg')));
  ds.setPublished(p, d.id, { dir: 'public/brand', pr: 'https://x/pr/1' }); assert.match(ds.designContext(p), /already in the repository at public\/brand\//);
  assert.throws(() => ds.addAssetVersion(p, d.id, { files: [] }), /no files/); assert.throws(() => ds.addAssetVersion(p, d.id, { files: Array.from({ length: 13 }, (_, i) => ({ name: `f${i}`, svg: '<svg viewBox="0 0 1 1"></svg>' })) }), /At most 12/);
});

import { execFileSync } from 'node:child_process';
test('assets over MCP: request, revise, hand edit, approve, publish to the repo as a PR; a screen cannot be published', async () => {
  const prompts = []; let n = 0;
  const e = boot(async (_sb, ws, prompt) => { prompts.push(prompt); n++; const out = path.join(ws.dir, '.factory-design', 'assets'); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'logo.svg'), `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="${n + 3}"/></svg>`); fs.writeFileSync(path.join(out, 'icon-home.svg'), '<svg viewBox="0 0 24 24"><path d="M3 12l9-9 9 9"/></svg>'); return { out: `Round ${n}.`, code: 0 }; });
  const made = await callOp(e, 'create_design', { project: 'a', title: 'Brand set', request: 'A logo and a home icon for the app, calm and simple', kind: 'assets' });
  let d = await settle(e, made.id); assert.equal(d.status, 'proposed'); assert.deepEqual(d.versions[0].files.sort(), ['icon-home', 'logo']); assert.match(prompts[0], /SET of SVG artwork[\s\S]*What to draw/);
  await callOp(e, 'revise_design', { project: 'a', design: d.id, feedback: 'Make the circle bigger' }); d = await settle(e, d.id); assert.equal(d.versions.length, 2); assert.match(prompts[1], /previous\/[\s\S]*bigger/);
  await callOp(e, 'edit_design', { project: 'a', design: d.id, files: [{ name: 'icon-search', svg: '<svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6"/></svg>' }, { name: 'icon-home', svg: null }], note: 'swapped an icon' }); d = e.getDesign('a', d.id);
  assert.deepEqual(d.versions[2].files.sort(), ['icon-search', 'logo']); assert.equal(d.versions[2].by, 'you');
  await assert.rejects(() => callOp(e, 'publish_assets', { project: 'a', design: d.id }), /Approve the artwork first/); await callOp(e, 'approve_design', { project: 'a', design: d.id });
  // publish into a real git checkout with a fake host
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-')); const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString(); git(remote, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(remote, 'README.md'), 'x\n'); git(remote, 'add', '-A'); git(remote, 'commit', '-qm', 'i');
  const pushed = []; e.f.sandbox = { create: async () => { const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-')); git(dd, 'clone', '-q', remote, '.'); return { dir: dd, destroy() {} }; } };
  e.f.vcs = { diffStat: async (ws) => git(ws.dir, 'status', '--porcelain'), commitAndPush: async (ws, o) => { git(ws.dir, 'add', '-A'); git(ws.dir, 'commit', '-qm', o.message); pushed.push({ files: git(ws.dir, 'ls-files').split('\n').filter((f) => f.endsWith('.svg')), msg: o.message }); }, openPr: async (_ws, o) => { pushed.at(-1).title = o.title; return 'https://example.test/pr/9'; } };
  await assert.rejects(() => callOp(e, 'publish_assets', { project: 'a', design: d.id, dir: '../../etc' }), /not allowed/);
  const r = await callOp(e, 'publish_assets', { project: 'a', design: d.id, dir: 'public/brand' }); assert.deepEqual(r, { published: true, pr: 'https://example.test/pr/9', dir: 'public/brand' });
  assert.deepEqual(pushed[0].files.sort(), ['public/brand/icon-search.svg', 'public/brand/logo.svg']); assert.equal(pushed[0].title, 'Add artwork: Brand set'); assert.match(e._designContext('a'), /already in the repository at public\/brand\//);
  const screen = await callOp(e, 'create_design', { project: 'a', title: 'Home', request: 'A home screen with a queue of tickets' }); await settle(e, screen.id).catch(() => {});
});

test('assets: you can start a set by hand when the designer produced nothing', async () => {
  const e = boot(async () => ({ out: 'no files', code: 0 }));
  const made = await callOp(e, 'create_design', { project: 'a', title: 'By hand', request: 'A set I will draw myself, starting empty', kind: 'assets' }); const d = await settle(e, made.id); assert.equal(d.status, 'failed');
  await callOp(e, 'edit_design', { project: 'a', design: d.id, files: [{ name: 'mine', svg: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>' }] });
  const after = e.getDesign('a', d.id); assert.equal(after.status, 'proposed'); assert.deepEqual(after.versions[0].files, ['mine']);
});

test('areas: approving a design retires the older approved one in the same area; restore never puts it back in use', () => {
  const p = dir(); const mk = (title, area) => { const d = ds.createDesign(p, { title, area, request: 'A screen with a list of things to do' }); ds.addVersion(p, d.id, { html: PAGE.replace('Home', title) }); return d; };
  const a = mk('Login v1', 'Login screen'); const b = mk('Login v2', ' login SCREEN '); const c = mk('Settings', 'Settings'); assert.equal(a.area, 'Login screen');
  ds.setStatus(p, a.id, 'approved'); ds.setStatus(p, c.id, 'approved'); const out = ds.setStatus(p, b.id, 'approved'); assert.deepEqual(out.retired, [a.id]);
  const after = ds.getDesign(p, a.id); assert.equal(after.status, 'archived'); assert.equal(after.supersededBy, b.id); assert.equal(after.approvedVersion, undefined);
  assert.equal(ds.getDesign(p, c.id).status, 'approved', 'a different area is untouched'); assert.match(ds.designContext(p), /Login v2/); assert.doesNotMatch(ds.designContext(p), /Login v1/);
  const back = ds.restoreDesign(p, a.id); assert.equal(back.status, 'proposed'); assert.doesNotMatch(ds.designContext(p), /Login v1/); assert.throws(() => ds.restoreDesign(p, c.id), /archived or rejected/);
});

test('archive keeps everything and removes it from use; metadata can be renamed; versions can be deleted unless in use', () => {
  const p = dir(); const d = ds.createDesign(p, { title: 'Home', request: 'A home screen with a queue of tickets' }); for (const t of ['one', 'two', 'three']) ds.addVersion(p, d.id, { html: PAGE.replace('Home', t) });
  ds.setStatus(p, d.id, 'approved', 2); assert.throws(() => ds.deleteVersion(p, d.id, 2), /in use/); assert.throws(() => ds.deleteVersion(p, d.id, 9), /No such version/);
  const v = ds.deleteVersion(p, d.id, 1); assert.deepEqual(v.versions.map((x) => x.n), [2, 3]); assert.ok(!fs.existsSync(path.join(p, 'designs', d.id, 'v1.html')));
  assert.match(ds.readHtml(p, d.id, 3), /three/); const next = ds.addVersion(p, d.id, { html: PAGE.replace('Home', 'four') }); assert.deepEqual(next.versions.map((x) => x.n), [2, 3, 4]);
  assert.equal(ds.getDesign(p, d.id).status, 'approved', 'a newer version waits; the approved one stays in use'); assert.match(ds.designContext(p), /Home|two/); assert.doesNotMatch(ds.designContext(p), /four/);
  ds.setStatus(p, d.id, 'archived'); const arch = ds.getDesign(p, d.id); assert.equal(arch.status, 'archived'); assert.equal(arch.archivedFrom, 'approved'); assert.equal(ds.designContext(p), ''); assert.equal(arch.versions.length, 3, 'history kept');
  assert.equal(ds.updateMeta(p, d.id, { title: 'Home page', area: 'Home' }).area, 'Home'); assert.equal(ds.updateMeta(p, d.id, { area: '' }).area, undefined); assert.throws(() => ds.updateMeta(p, d.id, { title: ' ' }), /title/);
  const solo = ds.createDesign(p, { title: 'Solo', request: 'Only one version here for testing' }); ds.addVersion(p, solo.id, { html: PAGE }); assert.throws(() => ds.deleteVersion(p, solo.id, 1), /only version/);
});

test('the builder is told about at most six approved designs, and the rest are reported as over the limit', () => {
  const p = dir(); for (let i = 0; i < 8; i++) { const d = ds.createDesign(p, { title: `Design ${i}`, request: 'A screen with a list of things to do' }); ds.addVersion(p, d.id, { html: PAGE.replace('Home', `Design ${i}`) }); ds.setStatus(p, d.id, 'approved'); }
  const u = ds.inUse(p); assert.equal(u.designs.length, 8); assert.equal(u.told, 6); assert.equal(u.overLimit, 2); assert.equal((ds.designContext(p).match(/^#### /gm) ?? []).length, 6);
});

test('organising designs over MCP: area, archive, restore, in-use view, version delete', async () => {
  let n = 0; const e = boot(async (_s, ws) => { n++; fs.writeFileSync(path.join(ws.dir, '.factory-design', 'design.html'), PAGE.replace('Home', `Draft ${n}`)); return { out: 'ok', code: 0 }; });
  const a = await callOp(e, 'create_design', { project: 'a', title: 'Login A', area: 'Login', request: 'A login screen with email and password fields' }); await settle(e, a.id);
  const b = await callOp(e, 'create_design', { project: 'a', title: 'Login B', area: 'Login', request: 'A different take on the login screen with a magic link' }); await settle(e, b.id);
  await callOp(e, 'approve_design', { project: 'a', design: a.id }); const r = await callOp(e, 'approve_design', { project: 'a', design: b.id }); assert.deepEqual(r.retired, [a.id]);
  const use = await callOp(e, 'designs_in_use', { project: 'a' }); assert.deepEqual(use.designs.map((d) => d.title), ['Login B']); assert.match(use.text, /Login B|Draft/); assert.equal(use.overLimit, 0);
  assert.equal((await callOp(e, 'list_designs', { project: 'a' })).inUse.told, 1);
  await callOp(e, 'archive_design', { project: 'a', design: b.id }); assert.equal((await callOp(e, 'designs_in_use', { project: 'a' })).designs.length, 0); assert.equal(e.getDesign('a', b.id).status, 'archived');
  await callOp(e, 'restore_design', { project: 'a', design: b.id }); assert.equal(e.getDesign('a', b.id).status, 'proposed');
  await callOp(e, 'update_design', { project: 'a', design: b.id, title: 'Login B (magic link)', area: 'Login' }); assert.equal(e.getDesign('a', b.id).title, 'Login B (magic link)');
  await callOp(e, 'revise_design', { project: 'a', design: b.id, feedback: 'Bigger button' }); await settle(e, b.id); assert.equal(e.getDesign('a', b.id).versions.length, 2);
  await callOp(e, 'delete_design_version', { project: 'a', design: b.id, version: 1 }); assert.deepEqual(e.getDesign('a', b.id).versions.map((v) => v.n), [2]);
});
