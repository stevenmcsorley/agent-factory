// Live preview: look at, and use, a project's site without deploying it.
// ONE gateway (default port ui.port + 1) serves every project on a stable address: http://<project>.localhost:<port>/ (a pull request or branch is <project>--<branch>).
// Browsers send *.localhost to this machine, and each name is its own origin, so one project's page cannot read another's storage, or the factory UI's (which is on a different port).
// Static sites only: files are served as they are, nothing is built or run. A preview starts on demand the first time its address is opened, follows its branch (it re-fetches when
// the branch moves), and an index page at http://localhost:<port>/ lists every project. Installed on Engine.prototype (see the bottom of engine.mjs).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { run } from './util.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const MAX_PREVIEWS = 12; const IDLE_MS = 2 * 60 * 60_000; const FRESH_MS = 5_000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A static file handler over one folder. Dotfiles (.git, .env), symlinks and anything outside the folder are never served.
export function serveStatic(root) {
  const real = fs.realpathSync(root);
  return (req, res) => {
    const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(msg); };
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Method not allowed');
    let rel; try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return fail(400, 'Bad request'); }
    if (rel.includes('\0') || rel.split('/').some((seg) => seg.startsWith('.') && seg !== '')) return fail(404, 'Not found');
    const tryFile = (f) => { try { const st = fs.lstatSync(f); if (st.isSymbolicLink()) return null; if (st.isDirectory()) return tryFile(path.join(f, 'index.html')); return st.isFile() ? f : null; } catch { return null; } };
    let file = path.join(real, rel); file = tryFile(file) ?? (path.extname(file) ? null : tryFile(`${file}.html`)); if (!file || !file.startsWith(`${real}${path.sep}`)) return fail(404, 'Not found');
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
export const staticServer = (root) => http.createServer(serveStatic(root));

export const livePreviewMethods = {
  previewInfo() { const g = this.previewGateway; return { enabled: !!g, port: g?.port ?? null, index: g ? `http://localhost:${g.port}/` : null }; },
  listLivePreviews(id) { return [...(this.livePreviews ?? new Map()).values()].filter((v) => !id || v.project === id).map((v) => ({ ...v })); },
  _previewUrl(label) { const g = this.previewGateway; return g ? `http://${label}.localhost:${g.port}/` : null; },

  // Fetch a branch into `dir` (replacing what is there), without its history. Returns the commit it holds.
  async _fetchRef(p, branch, dir) {
    const d = this.deps(p); const tmp = `${dir}.new`; fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(path.dirname(tmp), { recursive: true });
    const c = await run('git', ['clone', '--depth', '1', '--branch', branch, d.config.cloneUrl, tmp], { env: { ...process.env, ...(d.config.gitEnv ?? {}) } });
    if (c.code !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw bad(`Could not get that branch: ${c.out.replace(/Authorization: [^\s]+/g, 'Authorization: ***').slice(0, 200)}`); }
    const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: tmp })).out.trim();
    fs.rmSync(path.join(tmp, '.git'), { recursive: true, force: true });   // only the files are served; no history, no config
    fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(tmp, dir); return sha;
  },
  async startLivePreview(id, { ref, pr } = {}) {
    const p = this.project(id); const d = this.deps(p); this.livePreviews ??= new Map(); if (!this.previewGateway) throw bad('Previews are switched off: set ui.previewPort in the config, or free the port it names', 409);
    let branch = ref ?? p.base;
    if (pr !== undefined) { const found = (await d.host.listAgentPrs()).find((x) => Number(x.number) === Number(pr)); if (!found) throw bad(`No open pull request #${pr} on this project`, 404); branch = found.branch; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(String(branch)) || String(branch).includes('..')) throw bad('That is not a branch name');
    const label = branch === p.base ? id : `${id}--${slug(branch)}`.slice(0, 63); const old = this.livePreviews.get(label);
    if (!old && this.livePreviews.size >= MAX_PREVIEWS) throw bad(`At most ${MAX_PREVIEWS} previews are kept at once. Stop one first.`, 409);
    const dir = old?.dir ?? path.join(this.cfg.stateDir, 'live', label); const sha = await this._fetchRef(p, branch, dir);
    const entry = { label, project: id, ref: branch, pr: pr ?? null, dir, sha, startedAt: old?.startedAt ?? new Date().toISOString(), lastAt: Date.now(), checkedAt: Date.now(), hasIndex: fs.existsSync(path.join(dir, 'index.html')), url: this._previewUrl(label) };
    this.livePreviews.set(label, entry); if (!old) this._audit({ what: 'live-preview', project: id, ref: branch }); return { ...entry };
  },
  // Follow the branch: if it moved since the files were fetched, fetch again (checked at most every few seconds).
  async _ensureFresh(entry) {
    if (Date.now() - entry.checkedAt < FRESH_MS) return; entry.checkedAt = Date.now();
    try { const p = this.project(entry.project); const d = this.deps(p); const r = await run('git', ['ls-remote', d.config.cloneUrl, `refs/heads/${entry.ref}`], { env: { ...process.env, ...(d.config.gitEnv ?? {}) } });
      const head = r.out.split(/\s/)[0]; if (r.code === 0 && head && head !== entry.sha) { entry.sha = await this._fetchRef(p, entry.ref, entry.dir); entry.hasIndex = fs.existsSync(path.join(entry.dir, 'index.html')); } } catch { /* keep serving what we have */ }
  },
  async _stopLive(label) { const e = this.livePreviews?.get(label); if (!e) return false; fs.rmSync(e.dir, { recursive: true, force: true }); this.livePreviews.delete(label); return true; },
  async stopLivePreview(id, { ref } = {}) { const labels = [...(this.livePreviews ?? new Map()).values()].filter((v) => v.project === id && (!ref || v.ref === ref)).map((v) => v.label); for (const l of labels) await this._stopLive(l); return { stopped: labels.length }; },
  async stopAllLivePreviews() { for (const k of [...(this.livePreviews ?? new Map()).keys()]) await this._stopLive(k); },

  // The one server. Names: <project>.localhost (the base branch) and <project>--<branch>.localhost; anything else is refused, which also defeats DNS-rebinding.
  async startPreviewGateway({ host = '127.0.0.1', port } = {}) {
    if (!port) return null; this.livePreviews ??= new Map(); const starting = new Map(); const handlers = new Map();
    const server = http.createServer(async (req, res) => {
      const text = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(msg); };
      const m = /^([a-z0-9.-]+|\[::1\]):(\d+)$/i.exec(String(req.headers.host ?? '')); if (!m || Number(m[2]) !== port) return text(421, 'Unrecognised Host header');
      const name = m[1].toLowerCase(); const sub = name.endsWith('.localhost') ? name.slice(0, -'.localhost'.length) : null;
      if (!sub) { if (!['localhost', '127.0.0.1', '[::1]'].includes(name)) return text(421, 'Unrecognised Host header'); return this._previewIndex(req, res, port); }
      let entry = this.livePreviews.get(sub);
      if (!entry) {   // a project's own name starts its preview on first use
        const proj = this.cfg.projects.find((x) => x.id === sub); if (!proj) return text(404, 'No such project. Open http://localhost:' + port + '/ to see the list.');
        try { if (!starting.has(sub)) starting.set(sub, this.startLivePreview(sub).finally(() => starting.delete(sub))); entry = this.livePreviews.get(sub) ?? (await starting.get(sub)); entry = this.livePreviews.get(sub); } catch (e) { return text(e.status ?? 500, `Could not start the preview: ${e.message}`); }
      }
      entry.lastAt = Date.now(); await this._ensureFresh(entry);
      if (!entry.hasIndex && (req.url === '/' || req.url === '')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(`<!doctype html><meta charset="utf-8"><title>${esc(entry.project)}</title><body style="font:16px system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>${esc(entry.project)}</h1><p>The <b>${esc(entry.ref)}</b> branch has no <code>index.html</code> yet, so there is nothing to show. It appears here as soon as a page is merged; this page checks again whenever you reload.</p>`); }
      if (!handlers.has(entry.dir)) handlers.set(entry.dir, serveStatic(entry.dir)); try { handlers.get(entry.dir)(req, res); } catch { handlers.delete(entry.dir); text(500, 'Could not read the preview'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    const timer = setInterval(() => { for (const e of [...this.livePreviews.values()]) if (Date.now() - e.lastAt > IDLE_MS) this._stopLive(e.label); }, 10 * 60_000); timer.unref?.();
    this.previewGateway = { port, host, server, timer }; return { port };
  },
  _previewIndex(req, res, port) {
    const running = new Map([...this.livePreviews.values()].map((e) => [e.label, e]));
    const rows = this.cfg.projects.map((p) => { const e = running.get(p.id); return `<li><a href="http://${esc(p.id)}.localhost:${port}/"><b>${esc(p.id)}</b></a> <small>${e ? `running · ${esc(e.ref)}${e.hasIndex ? '' : ' · no index.html yet'}` : 'starts when you open it'}</small></li>`; }).join('');
    const extra = [...running.values()].filter((e) => e.label !== e.project).map((e) => `<li><a href="${esc(e.url)}">${esc(e.project)} · ${e.pr ? `PR #${e.pr}` : esc(e.ref)}</a></li>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Factory previews</title><style>body{font:16px/1.5 system-ui;max-width:40rem;margin:2.5rem auto;padding:0 1rem;color:#1c1b19}li{margin:.4rem 0}small{color:#6b675e}a{color:#0f5f63}</style><body><h1>Previews</h1><p>Every project's site as it is on its main branch, served from this machine only. Nothing here is deployed.</p><ul>${rows}</ul>${extra ? `<h2>Branches and pull requests</h2><ul>${extra}</ul>` : ''}`);
  },
};
