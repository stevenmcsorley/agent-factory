// Live preview: look at, and use, a project's site without deploying it.
// It clones a branch (the base branch, or an open pull request's branch) and serves the files AS THEY ARE on an address only this machine can reach.
// Static sites only (HTML, CSS, JS, images): nothing from the repository is run, installed or built, it is just served.
// Installed on Engine.prototype (see the bottom of engine.mjs).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { run } from './util.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const MAX_PREVIEWS = 4; const IDLE_MS = 30 * 60_000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);

// A tiny static file server over one folder. Dotfiles (.git, .env), symlinks and anything outside the folder are never served.
export function staticServer(root, { onHit } = {}) {
  const real = fs.realpathSync(root);
  return http.createServer((req, res) => {
    onHit?.();
    const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(msg); };
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Method not allowed');
    let rel; try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return fail(400, 'Bad request'); }
    if (rel.includes('\0') || rel.split('/').some((seg) => seg.startsWith('.') && seg !== '')) return fail(404, 'Not found');
    let file = path.join(real, rel);
    const tryFile = (f) => { try { const st = fs.lstatSync(f); if (st.isSymbolicLink()) return null; if (st.isDirectory()) return tryFile(path.join(f, 'index.html')); return st.isFile() ? f : null; } catch { return null; } };
    file = tryFile(file) ?? (path.extname(file) ? null : tryFile(`${file}.html`)); if (!file) return fail(404, 'Not found');
    if (!file.startsWith(`${real}${path.sep}`)) return fail(404, 'Not found');
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

export const livePreviewMethods = {
  listLivePreviews(id) { return [...(this.livePreviews ?? new Map()).values()].filter((v) => !id || v.project === id).map(({ server, timer, ...v }) => v); },
  async startLivePreview(id, { ref, pr } = {}) {
    const p = this.project(id); const d = this.deps(p); this.livePreviews ??= new Map();
    let branch = ref ?? p.base;
    if (pr !== undefined) { const found = (await d.host.listAgentPrs()).find((x) => Number(x.number) === Number(pr)); if (!found) throw bad(`No open pull request #${pr} on this project`, 404); branch = found.branch; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(String(branch)) || String(branch).includes('..')) throw bad('That is not a branch name');
    const key = `${id}:${branch}`; const old = this.livePreviews.get(key); if (old) await this._stopLive(key);
    if (this.livePreviews.size >= MAX_PREVIEWS) throw bad(`At most ${MAX_PREVIEWS} previews run at once. Stop one first.`, 409);
    const dir = path.join(this.cfg.stateDir, 'live', slug(`${id}-${branch}`)); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.dirname(dir), { recursive: true });
    const c = await run('git', ['clone', '--depth', '1', '--branch', branch, d.config.cloneUrl, dir], { env: { ...process.env, ...(d.config.gitEnv ?? {}) } });
    if (c.code !== 0) throw bad(`Could not get that branch: ${c.out.replace(/Authorization: [^\s]+/g, 'Authorization: ***').slice(0, 200)}`);
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });   // only the files are served; no history, no config
    const entry = { key, project: id, ref: branch, pr: pr ?? null, dir, startedAt: new Date().toISOString(), lastAt: Date.now(), hasIndex: fs.existsSync(path.join(dir, 'index.html')) };
    const server = staticServer(dir, { onHit: () => { entry.lastAt = Date.now(); } });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    entry.port = server.address().port; entry.url = `http://127.0.0.1:${entry.port}/`; entry.server = server;
    entry.timer = setInterval(() => { if (Date.now() - entry.lastAt > IDLE_MS) this._stopLive(key); }, 60_000); entry.timer.unref?.();
    this.livePreviews.set(key, entry); this._audit({ what: 'live-preview', project: id, ref: branch });
    const { server: _s, timer: _t, ...pub } = entry; return pub;
  },
  async _stopLive(key) { const e = this.livePreviews?.get(key); if (!e) return false; clearInterval(e.timer); await new Promise((r) => e.server.close(() => r())); e.server.closeAllConnections?.(); fs.rmSync(e.dir, { recursive: true, force: true }); this.livePreviews.delete(key); return true; },
  async stopLivePreview(id, { ref } = {}) { const keys = [...(this.livePreviews ?? new Map()).keys()].filter((k) => k.startsWith(`${id}:`) && (!ref || k === `${id}:${ref}`)); for (const k of keys) await this._stopLive(k); return { stopped: keys.length }; },
  async stopAllLivePreviews() { for (const k of [...(this.livePreviews ?? new Map()).keys()]) await this._stopLive(k); },
};
