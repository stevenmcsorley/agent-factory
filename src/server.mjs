import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { doctor } from './doctor.mjs';
import { DEFAULT_IGNORE } from './ignore.mjs';
import { callOp, OPS } from './ops.mjs';
import { assessTicket } from './gate.mjs';
import { templateNames } from './github.mjs';
import { handleRpc, directTools, codeTools } from './mcp.mjs';
import { sandboxAvailable } from './jssandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(here, '..', 'ui');
const TYPES = { '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 64 * 1024;

const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req, max = MAX_BODY) {
  if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) throw fail(415, 'Content-Type must be application/json');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw fail(413, 'Request body too large'); chunks.push(c); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw fail(400, 'Invalid JSON'); }
}

// A small JSON API plus the static UI. Security model: loopback bind (enforced by config validation), bearer token on every
// /api route (no cookies, so no CSRF), Host allowlist (DNS rebinding), Origin must match Host for writes, strict CSP, bounded bodies.
export function createServer(engine, { token, allowedHosts }) {
  if (!token || token.length < 24) throw new Error('A UI token of at least 24 characters is required');
  const doc = { at: 0, v: null };
  // A fingerprint of the UI files served right now: an open browser tab compares it with what it loaded and offers a reload when it changes.
  const BUILD = (() => { try { const h = crypto.createHash('sha1'); for (const f of fs.readdirSync(UI).filter((x) => /\.(js|css|html)$/.test(x)).sort()) h.update(f).update(fs.readFileSync(path.join(UI, f))); return h.digest('hex').slice(0, 10); } catch { return 'dev'; } })();

  const routes = [
    ['GET', /^\/api\/status$/, async () => ({ ...engine.status(), build: BUILD })],
    ['GET', /^\/api\/health$/, async () => { if (Date.now() - doc.at > 10000) { doc.v = await doctor(engine.cfg, { env: engine.env }); doc.at = Date.now(); } return doc.v; }],
    ['GET', /^\/api\/templates$/, async () => templateNames()],
    ['GET', /^\/api\/whoami$/, async () => ({ login: await engine.gh.whoami() })],
    ['POST', /^\/api\/check-ticket$/, async (_m, body) => assessTicket({ title: body.title ?? '', body: body.body ?? '' }, engine.cfg.limits.gate)],
    ['GET', /^\/api\/catalog$/, async () => engine.catalog()],
    ['POST', /^\/api\/sources\/test$/, async (_m, b) => engine.testSource(b)],
    ['POST', /^\/api\/hosts\/test$/, async (_m, b) => engine.testHost(b)],
    ['POST', /^\/api\/hosts\/analyze$/, async (_m, b) => engine.analyzeDraft(b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/analyze$/, async (m) => engine.startAnalysis(m[1])],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/analyze$/, async (m) => engine.analysisJob(m[1])],
    ['GET', /^\/api\/ops$/, async () => OPS.map((o) => ({ name: o.name, description: o.description, readOnly: !!o.readOnly, input: o.input }))],
    ['POST', /^\/api\/op\/([a-z_]+)$/, async (m, b) => callOp(engine, m[1], b)],
    ['GET', /^\/api\/portfolio$/, async () => engine.portfolio()],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/pack$/, async (m) => engine.getPack(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/pack$/, async (m, b) => engine.setPack(m[1], b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/pack\/sources$/, async (m, b) => engine.addSource(m[1], b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/pack\/sources\/([a-f0-9]{8})\/remove$/, async (m) => engine.removeSource(m[1], m[2])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/pack\/publish$/, async (m) => engine.publishPack(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/plan$/, async (m) => engine.startPlanning(m[1])],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/plan$/, async (m) => engine.getPlan(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/plan\/edit$/, async (m, b) => engine.editPlan(m[1], b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/plan\/discard$/, async (m) => engine.discardPlan(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/plan\/launch$/, async (m) => engine.launchPlan(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/analysis-ignore$/, async (m, b) => engine.setIgnore(m[1], b)],
    ['GET', /^\/api\/analysis-defaults$/, async () => ({ defaults: DEFAULT_IGNORE })],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/finding-ticket$/, async (m, b) => engine.findingTicket(m[1], String(b.key ?? ''))],
    ['POST', /^\/api\/sources\/signup-info$/, async (_m, b) => engine.signupInfo(b.baseUrl).catch((e) => { throw fail(400, e.message); })],
    ['GET', /^\/api\/inbox$/, async () => engine.inbox()],
    ['GET', /^\/api\/inbox\/count$/, async () => engine.inboxCount()],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/tickets\/([\w-]{1,40})\/(requeue|comment|update|close)$/, async (m, b) => engine.ticketAction(m[1], m[2], m[3], b)],
    ['GET', /^\/api\/overview$/, async () => engine.overview()],
    ['GET', /^\/api\/connect$/, async () => { const t = (x) => Math.round(JSON.stringify(x).length / 4); return { directTools: directTools().length, directTokens: t(directTools()), codeTokens: t(codeTools()), codeAvailable: await sandboxAvailable() }; }],
    ['GET', /^\/api\/activity$/, async () => engine.activity()],
    ['GET', /^\/api\/metrics$/, async (_m, _b, url) => engine.metrics({ days: Math.min(Number(url.searchParams.get('days')) || 14, 90) })],
    ['GET', /^\/api\/runs\/([a-f0-9]{8})$/, async (m) => engine.getRun(m[1])],
    ['GET', /^\/api\/runs$/, async (_m, _b, url) => engine.runs({ project: url.searchParams.get('project') || undefined, limit: Math.min(Number(url.searchParams.get('limit')) || 100, 500) })],
    ['POST', /^\/api\/control\/(pause|resume)$/, async (m) => { m[1] === 'pause' ? engine.pause() : engine.resume(); return engine.status(); }],
    // Long jobs run in the background; the UI watches `busy` in /api/status.
    ['POST', /^\/api\/control\/(tick|feedback)$/, async (m) => { if (engine.busy) throw fail(409, 'The factory is already running'); (m[1] === 'tick' ? engine.tickAll() : engine.feedbackAll()).catch((e) => console.error(e.message)); return { started: m[1] }; }],
    ['GET', /^\/api\/projects$/, async () => engine.cfg.projects],
    ['POST', /^\/api\/projects$/, async (_m, b) => engine.addProject(b)],
    ['POST', /^\/api\/projects\/new$/, async (_m, b) => engine.createProject(b)],
    ['DELETE', /^\/api\/projects\/([a-z0-9-]+)$/, async (m) => { engine.removeProject(m[1]); return { removed: m[1] }; }],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/(pause|resume)$/, async (m) => engine.setProjectPaused(m[1], m[2] === 'pause')],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/tickets$/, async (m) => engine.listTickets(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/tickets$/, async (m, b) => engine.createTicket(m[1], b)],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/prs$/, async (m) => engine.listPrs(m[1])],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/log$/, async (m) => {
      const dir = path.join(engine.projectDir(engine.project(m[1])), 'logs'); const files = fs.readdirSync(dir).sort();
      return { lines: files.length ? fs.readFileSync(path.join(dir, files.at(-1)), 'utf8').split('\n').slice(-200) : [] };
    }],
  ];

  const send = (res, status, body, headers = {}) => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(data);
  };

  return http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!allowedHosts.includes(host)) return send(res, 421, { error: 'Unrecognised Host header' });
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true, paused: engine.paused() }); // for uptime monitors: no secrets, no data
      const hook = /^\/hook\/([a-z0-9-]{1,41})\/([\w-]{20,64})$/.exec(url.pathname);
      if (hook) {   // inbound webhook: the secret in the path is the credential (no cookies, no UI token), JSON only, bounded
        if (req.method !== 'POST') return send(res, 405, { error: 'POST JSON to this endpoint' }, { Allow: 'POST' });
        try { const out = await engine.inboundTicket(hook[1], hook[2], await readJson(req)); return send(res, out.created ? 201 : 200, out); }
        catch (e) { return send(res, e.status ?? 500, { error: e.message, ...(e.problems ? { problems: e.problems } : {}) }); }
      }
      const protectedPath = url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname === '/mcp-code';
      if (!protectedPath) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        // Flat UI files, plus exactly one subfolder for fonts. path.basename() makes traversal impossible.
        const name = url.pathname === '/' ? 'index.html' : url.pathname.startsWith('/fonts/') ? path.join('fonts', path.basename(url.pathname)) : path.basename(url.pathname);
        const file = path.join(UI, name);
        if (!TYPES[path.extname(name)] || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': TYPES[path.extname(name)], ...(name.startsWith('fonts') ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}),
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      }
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!bearer || !same(bearer, token)) return send(res, 401, { error: 'Missing or invalid token' }, { 'WWW-Authenticate': 'Bearer' });
      const write = req.method !== 'GET';
      if (write && req.headers.origin && new URL(req.headers.origin).host !== host) return send(res, 403, { error: 'Cross-origin write refused' });
      if (url.pathname === '/mcp' || url.pathname === '/mcp-code') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST JSON-RPC to this endpoint' }, { Allow: 'POST' });
        const body = await readJson(req);
        const out = Array.isArray(body) ? (await Promise.all(body.map((m) => handleRpc(engine, m, { code: url.pathname === '/mcp-code' })))).filter(Boolean) : await handleRpc(engine, body, { code: url.pathname === '/mcp-code' });
        return out === null || (Array.isArray(out) && !out.length) ? (res.writeHead(202, { 'Cache-Control': 'no-store' }), res.end()) : send(res, 200, out);
      }
      for (const [method, re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (m && method === req.method) return send(res, 200, await fn(m, ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req, /\/pack\/sources$/.test(url.pathname) ? 12 * 1024 * 1024 : MAX_BODY) : {}, url) ?? {});
      }
      send(res, 404, { error: 'No such endpoint' });
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) console.error('API error:', e.message);
      send(res, status, { error: status === 500 ? String(e.message).slice(0, 300) : e.message });
    }
  });
}

export const hostsFor = (host, port) => (['127.0.0.1', 'localhost', '::1'].includes(host) ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`] : [`${host}:${port}`]);
