import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { staticServer } from '../src/engine-livepreview.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';

const get = (port, p, method = 'GET') => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, body: Buffer.concat(c).toString() })); }); r.on('error', reject); r.end(); });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('static server: serves files as they are, and never dotfiles, symlinks or anything outside the folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-')); const site = path.join(root, 'site'); fs.mkdirSync(path.join(site, 'sub'), { recursive: true }); fs.mkdirSync(path.join(site, '.git')); fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>Home</h1>'); fs.writeFileSync(path.join(site, 'about.html'), '<h1>About</h1>'); fs.writeFileSync(path.join(site, 'sub', 'index.html'), '<h1>Sub</h1>'); fs.writeFileSync(path.join(site, 'app.js'), 'x'); fs.writeFileSync(path.join(site, 'logo.svg'), '<svg/>');
  fs.writeFileSync(path.join(site, '.env'), 'KEY=1'); fs.writeFileSync(path.join(site, '.git', 'config'), 'x'); fs.symlinkSync(path.join(root, 'secret.txt'), path.join(site, 'link.txt'));
  const srv = staticServer(site); const port = await listen(srv);
  try {
    assert.match((await get(port, '/')).body, /Home/); assert.match((await get(port, '/about')).body, /About/, '/about finds about.html'); assert.match((await get(port, '/sub/')).body, /Sub/);
    const js = await get(port, '/app.js'); assert.match(js.type, /javascript/); assert.equal(js.headers['x-content-type-options'], 'nosniff'); assert.match((await get(port, '/logo.svg')).type, /svg/); assert.equal((await get(port, '/', 'HEAD')).body, '');
    for (const bad of ['/.env', '/.git/config', '/link.txt', '/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/nope', '/%00']) assert.notEqual((await get(port, bad)).status, 200, `${bad} must not be served`);
    assert.doesNotMatch((await get(port, '/../secret.txt')).body, /SECRET/); assert.equal((await get(port, '/x', 'POST')).status, 405);
  } finally { srv.close(); }
});

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-')); const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Main site</h1>'); git('add', '-A'); git('commit', '-qm', 'i');
  git('checkout', '-q', '-b', 'agent/1-new-page'); fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Branch site</h1>'); git('commit', '-qam', 'b'); git('checkout', '-q', 'main'); return dir;
}
function boot(dirRepo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'le-'));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } }] });
  return new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: { hostAdapter: () => ({ pr: { listAgentPrs: async () => [{ number: 4, branch: 'agent/1-new-page' }] }, cloneUrl: () => dirRepo, gitEnv: () => ({}), prUrl: () => '' }), tickets: () => ({}) } });
}

import net from 'node:net';
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const via = (port, host, p = '/', method = 'GET') => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: host } }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); }); r.on('error', reject); r.end(); });

test('preview gateway: each project has a stable name, starts on first use, follows its branch, and only known names are answered', async () => {
  const d = repo(); const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, stdio: 'pipe' }).toString(); const e = boot(d); const port = await freePort(); await e.startPreviewGateway({ port });
  const at = (name) => `${name}.localhost:${port}`;
  try {
    assert.match(e.previewInfo().index, new RegExp(`:${port}/$`)); assert.equal(e.listLivePreviews().length, 0);
    const first = await via(port, at('a')); assert.equal(first.status, 200); assert.match(first.body, /Main site/, 'opening the project address starts the preview on demand'); assert.equal(first.headers['x-content-type-options'], 'nosniff');
    assert.equal(e.listLivePreviews()[0].url, `http://a.localhost:${port}/`, 'the address is stable and named');
    assert.equal((await via(port, at('a'), '/.git/HEAD')).status, 404, 'no repository history is served');
    git('checkout', '-q', 'main'); fs.writeFileSync(path.join(d, 'index.html'), '<h1>Main site, changed</h1>'); git('commit', '-qam', 'change'); e.listLivePreviews()[0]; e.livePreviews.get('a').checkedAt = 0;
    assert.match((await via(port, at('a'))).body, /changed/, 'it follows the branch when it moves');
    const pr = await e.startLivePreview('a', { pr: 4 }); assert.equal(pr.label, 'a--agent-1-new-page'); assert.equal(pr.url, `http://a--agent-1-new-page.localhost:${port}/`); assert.match((await via(port, at('a--agent-1-new-page'))).body, /Branch site/);
    const idx = await via(port, `localhost:${port}`); assert.equal(idx.status, 200); assert.match(idx.body, /Previews/); assert.match(idx.body, /href="http:\/\/a\.localhost/); assert.match(idx.body, /PR #4/);
    for (const host of [at('nosuchproject'), `evil.example:${port}`, `a.localhost:${port + 1}`]) assert.ok([400, 404, 421].includes((await via(port, host)).status), `${host} must not be served`);
    assert.equal((await via(port, at('a'), '/', 'POST')).status, 405);
    assert.deepEqual(await e.stopLivePreview('a', { ref: 'main' }), { stopped: 1 }); assert.equal(e.listLivePreviews().length, 1);
  } finally { await e.stopAllLivePreviews(); e.halt(); }
});

test('preview gateway: a branch with no index.html says so instead of failing; previews are off when no port is given', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-')); const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, stdio: 'pipe' }).toString(); git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'README.md'), 'x'); git('add', '-A'); git('commit', '-qm', 'i');
  const e = boot(d); await assert.rejects(() => e.startLivePreview('a'), /Previews are switched off/); const port = await freePort(); await e.startPreviewGateway({ port });
  try { const r = await via(port, `a.localhost:${port}`); assert.equal(r.status, 200); assert.match(r.body, /no <code>index\.html<\/code> yet/); } finally { await e.stopAllLivePreviews(); e.halt(); }
});

test('preview gateway: the MCP tools return the stable address', async () => {
  const e = boot(repo()); const port = await freePort(); await e.startPreviewGateway({ port });
  try { const r = await callOp(e, 'start_live_preview', { project: 'a' }); assert.equal(r.url, `http://a.localhost:${port}/`); assert.equal((await callOp(e, 'list_live_previews', {})).port, port); await assert.rejects(() => callOp(e, 'start_live_preview', { project: 'a', ref: '../etc' }), /not a branch/); await assert.rejects(() => callOp(e, 'start_live_preview', { project: 'a', pr: 99 }), /No open pull request/); } finally { await e.stopAllLivePreviews(); e.halt(); }
});
