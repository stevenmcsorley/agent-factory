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

test('live preview: the base branch and an open PR each get their own localhost address; history is not served; refresh and stop work', async () => {
  const e = boot(repo());
  try {
    const main = await callOp(e, 'start_live_preview', { project: 'a' }); assert.match(main.url, /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.equal(main.hasIndex, true); assert.match((await get(main.port, '/')).body, /Main site/);
    const pr = await callOp(e, 'start_live_preview', { project: 'a', pr: 4 }); assert.equal(pr.ref, 'agent/1-new-page'); assert.match((await get(pr.port, '/')).body, /Branch site/); assert.notEqual(pr.port, main.port);
    assert.equal((await get(main.port, '/.git/HEAD')).status, 404, 'no repository history is served');
    assert.equal((await callOp(e, 'list_live_previews', { project: 'a' })).previews.length, 2);
    const again = await callOp(e, 'start_live_preview', { project: 'a' }); assert.equal((await callOp(e, 'list_live_previews', {})).previews.length, 2, 'starting again replaces, not adds'); assert.match((await get(again.port, '/')).body, /Main site/);
    await assert.rejects(() => callOp(e, 'start_live_preview', { project: 'a', pr: 99 }), /No open pull request/); await assert.rejects(() => callOp(e, 'start_live_preview', { project: 'a', ref: '../etc' }), /not a branch/); await assert.rejects(() => callOp(e, 'start_live_preview', { project: 'a', ref: 'nope' }), /Could not get that branch/);
    assert.deepEqual(await callOp(e, 'stop_live_preview', { project: 'a', ref: 'main' }), { stopped: 1 }); assert.equal((await callOp(e, 'list_live_previews', { project: 'a' })).previews.length, 1);
    await assert.rejects(() => get(main.port, '/'), /ECONNREFUSED/, 'the stopped one is really closed');
  } finally { await e.stopAllLivePreviews(); }
});
test('live preview: no more than four at once', async () => {
  const d = repo(); const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' }); for (let i = 0; i < 4; i++) git('branch', `b${i}`); const e = boot(d);
  try { for (let i = 0; i < 4; i++) await callOp(e, 'start_live_preview', { project: 'a', ref: `b${i}` }); await assert.rejects(() => callOp(e, 'start_live_preview', { project: 'a' }), /At most 4/); } finally { await e.stopAllLivePreviews(); }
});
