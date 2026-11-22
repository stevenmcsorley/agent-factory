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
const TYPES = { '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const MAX_BODY = 64 * 1024;
// Most calls are small. A new project carries the repo analysis (about 100 KB for a mid-sized repo) and can carry files; MCP calls can carry an attached file.
const bodyLimit = (p) => (/\/pack\/sources$/.test(p) || /^\/mcp(-code)?$/.test(p) ? 12 * 1024 * 1024 : /^\/api\/projects(\/new)?$/.test(p) ? 4 * 1024 * 1024 : MAX_BODY);

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
  const doc = { at: 0, v: null }; const previews = new Map();
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
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/scenario-runs\/([a-f0-9]{8})\/approve\/([a-z0-9-]+)$/, async (m) => engine.scenarioApprove(m[1], m[2], m[3], 'the UI user')],
    ['GET', /^\/api\/plugins$/, async () => engine.plugins()],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/tickets\/([\w-]{1,40})$/, async (m) => engine.ticketDetail(m[1], m[2])],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/tracker$/, async (m) => engine.trackerOverview(m[1])],
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
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/tickets\/([\w-]{1,40})\/(requeue|comment|update|close|reopen)$/, async (m, b) => engine.ticketAction(m[1], m[2], m[3], b)],
    ['GET', /^\/api\/overview$/, async () => engine.overview()],
    ['GET', /^\/api\/connect$/, async () => { const t = (x) => Math.round(JSON.stringify(x).length / 4); return { directTools: directTools().length, directTokens: t(directTools()), codeTokens: t(codeTools()), codeAvailable: await sandboxAvailable() }; }],
    ['GET', /^\/api\/activity$/, async () => engine.activity()],
    ['GET', /^\/api\/flow$/, async (_m, _b, url) => engine.flow({ days: Math.min(Number(url.searchParams.get('days')) || 30, 365), project: url.searchParams.get('project') || undefined })],
    ['GET', /^\/api\/metrics$/, async (_m, _b, url) => engine.metrics({ days: Math.min(Number(url.searchParams.get('days')) || 14, 90) })],
    ['GET', /^\/api\/runs\/([a-f0-9]{8})$/, async (m) => engine.getRun(m[1])],
    ['GET', /^\/api\/runs$/, async (_m, _b, url) => engine.runs({ project: url.searchParams.get('project') || undefined, limit: Math.min(Number(url.searchParams.get('limit')) || 100, 500) })],
    ['POST', /^\/api\/control\/(pause|resume)$/, async (m) => { m[1] === 'pause' ? engine.pause() : engine.resume(); return engine.status(); }],
    // Long jobs run in the background; the UI watches `busy` in /api/status.
    ['POST', /^\/api\/control\/(tick|feedback)$/, async (m) => { if (engine.busy) throw fail(409, 'The factory is already running'); (m[1] === 'tick' ? engine.tickAll() : engine.feedbackAll()).catch((e) => console.error(e.message)); return { started: m[1] }; }],
    ['GET', /^\/api\/settings$/, async () => engine.settings()],
    ['POST', /^\/api\/settings$/, async (_m, b) => engine.setSettings(b)],
    ['POST', /^\/api\/settings\/probe$/, async () => engine.probeAgent()],
    // ---- schedule, autonomy, roles
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/waiting$/, async (m) => engine.waiting(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/schedule$/, async (m, b) => engine.setSchedule(m[1], b.schedule ?? null)],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/autonomy$/, async (m) => engine.autonomyStatus(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/autonomy$/, async (m, b) => engine.setAutonomy(m[1], b.settings ?? null)],
    ['GET', /^\/api\/autonomy$/, async () => engine.autonomy()],
    ['POST', /^\/api\/autonomy$/, async (_m, b) => engine.setAutonomyAllowed(b)],
    ['GET', /^\/api\/roles$/, async () => engine.roles()],
    ['POST', /^\/api\/roles$/, async (_m, b) => engine.setRoles(b.roles ?? {})],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/roles$/, async (m, b) => engine.setProjectRoles(m[1], b.roles ?? {})],
    ['GET', /^\/api\/previews$/, async () => ({ ...engine.previewInfo(), previews: engine.listLivePreviews() })],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/live$/, async (m) => ({ previews: engine.listLivePreviews(m[1]), ...engine.previewInfo() })],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/live$/, async (m, b) => engine.startLivePreview(m[1], b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/live\/stop$/, async (m, b) => engine.stopLivePreview(m[1], b)],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/screens$/, async (m) => engine.getScreens(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/screens\/capture$/, async (m) => engine.startScreenshots(m[1])],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/preview$/, async (m) => engine.getPreview(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/preview$/, async (m, b) => engine.setPreview(m[1], b.preview ?? null)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/preview\/check$/, async (m) => engine.startVisualCheck(m[1])],
    ['GET', /^\/api\/usage$/, async (_m, _b, url) => engine.usageReport({ days: Number(url.searchParams.get('days')) || 14, project: url.searchParams.get('project') || undefined })],
    ['GET', /^\/api\/setups$/, async () => engine.presets()],
    ['POST', /^\/api\/setups$/, async (_m, b) => engine.savePreset(b)],
    ['POST', /^\/api\/setups\/default$/, async (_m, b) => engine.setNewProjectPreset(b.name ?? null)],
    ['POST', /^\/api\/setups\/([a-z0-9-]{1,31})\/apply$/, async (m, b) => engine.applyPreset(m[1], b)],
    ['POST', /^\/api\/setups\/([a-z0-9-]{1,31})\/delete$/, async (m) => engine.deletePreset(m[1])],
    ['GET', /^\/api\/limit$/, async () => ({ limit: engine.planLimit(), autoResume: engine.autoResume() })],
    ['POST', /^\/api\/limit\/resume$/, async () => engine.clearPlanLimit()],
    ['GET', /^\/api\/notify$/, async () => engine.getNotify()],
    ['POST', /^\/api\/notify$/, async (_m, b) => engine.setNotify(b.notify ?? null)],
    ['POST', /^\/api\/notify\/test$/, async () => engine.testNotify()],
    // ---- skills
    ['GET', /^\/api\/skills$/, async () => engine.skills()],
    ['GET', /^\/api\/skills\/preview$/, async (_m, _b, url) => engine.previewSkills(url.searchParams.get('role') ?? '', url.searchParams.get('project') || undefined)],
    ['POST', /^\/api\/skills\/draft$/, async (_m, b) => engine.startSkillDraft(b)],
    ['GET', /^\/api\/skills\/draft\/([a-f0-9]{8})$/, async (m) => engine.skillDraft(m[1])],
    ['POST', /^\/api\/skills$/, async (_m, b) => engine.saveSkill(b)],
    ['GET', /^\/api\/skills\/([a-z0-9-]{1,41})$/, async (m) => engine.getSkill(m[1])],
    ['POST', /^\/api\/skills\/([a-z0-9-]{1,41})\/delete$/, async (m) => engine.deleteSkill(m[1])],
    // ---- designs
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/designs$/, async (m) => engine.designs(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs$/, async (m, b) => engine.startDesign(m[1], b)],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})$/, async (m) => engine.getDesign(m[1], m[2])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/revise$/, async (m, b) => engine.reviseDesign(m[1], m[2], b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/edit$/, async (m, b) => engine.editDesign(m[1], m[2], b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/(approve|reject|reopen)$/, async (m, b) => engine.setDesignStatus(m[1], m[2], { approve: 'approved', reject: 'rejected', reopen: 'proposed' }[m[3]], b.version)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/publish$/, async (m, b) => engine.publishAssets(m[1], m[2], b)],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/files$/, async (m, _b, url) => ({ files: engine.designAssets(m[1], m[2], Number(url.searchParams.get('version')) || undefined) })],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/designs\/in-use$/, async (m) => engine.designContextFor(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/archive$/, async (m) => engine.archiveDesign(m[1], m[2])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/restore$/, async (m) => engine.restoreDesign(m[1], m[2])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/meta$/, async (m, b) => engine.updateDesign(m[1], m[2], b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/versions\/(\d{1,3})\/delete$/, async (m) => engine.deleteDesignVersion(m[1], m[2], m[3])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/delete$/, async (m) => engine.deleteDesign(m[1], m[2])],
    // The mockup is shown in a frame, and a frame cannot send the bearer token: so the UI asks for a short-lived, unguessable address and the frame loads that.
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/designs\/([a-f0-9]{8})\/view$/, async (m, b) => { const html = engine.designHtml(m[1], m[2], Number.isInteger(b.version) ? b.version : undefined); for (const [k, v] of previews) if (v.exp < Date.now()) previews.delete(k); const t = crypto.randomBytes(18).toString('hex'); previews.set(t, { html, exp: Date.now() + 5 * 60_000 }); return { path: `/preview/${t}` }; }],
    ['GET', /^\/api\/projects$/, async () => engine.cfg.projects],
    ['POST', /^\/api\/projects$/, async (_m, b) => engine.addProject(b)],
    ['POST', /^\/api\/projects\/new$/, async (_m, b) => engine.createProject(b)],
    ['DELETE', /^\/api\/projects\/([a-z0-9-]+)$/, async (m) => { engine.removeProject(m[1]); return { removed: m[1] }; }],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/(pause|resume)$/, async (m) => engine.setProjectPaused(m[1], m[2] === 'pause')],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/tickets$/, async (m) => engine.listTickets(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/tickets$/, async (m, b) => engine.createTicket(m[1], b)],
    ['GET', /^\/api\/accounts$/, async (_m, _b, url) => engine.accounts({ days: url.searchParams.get('days'), calls: url.searchParams.get('calls') })],
    ['GET', /^\/api\/agents\/policy$/, async () => engine.agentPolicy()],
    ['POST', /^\/api\/agents\/policy$/, async (_m, b) => engine.setAgentPolicy(b ?? {})],
    ['GET', /^\/api\/openrouter$/, async () => engine.openrouterStatus()],
    ['POST', /^\/api\/openrouter\/key$/, async (_m, b) => engine.setOpenRouterKey(b?.key)],
    ['POST', /^\/api\/openrouter\/config$/, async (_m, b) => engine.setOpenRouter(b ?? {})],
    ['POST', /^\/api\/openrouter\/refresh$/, async () => engine.refreshOpenRouter()],
    ['POST', /^\/api\/openrouter\/test$/, async (_m, b) => engine.testOpenRouterModel(b?.model)],
    ['POST', /^\/api\/openrouter\/reset$/, async (_m, b) => engine.resetOpenRouter(b?.model)],
    ['GET', /^\/api\/codex\/models$/, async () => engine.codexModels()],
    ['GET', /^\/api\/improvements$/, async (_m, _b, url) => engine.improvements({ days: url?.searchParams?.get('days') ?? 14 })],
    ['GET', /^\/api\/runscores$/, async (_m, _b, url) => engine.runScores({ days: url?.searchParams?.get('days') ?? 14, limit: url?.searchParams?.get('limit') ?? 100 })],
    ['POST', /^\/api\/improvements\/([a-f0-9]{10})\/(apply|dismiss|reopen)$/, async (m, b) => (m[2] === 'apply' ? engine.applyImprovement(m[1], b ?? {}) : m[2] === 'dismiss' ? engine.dismissImprovement(m[1], b?.note) : engine.reopenImprovement(m[1]))],
    ['GET', /^\/api\/local$/, async () => { await engine._localEnsure().catch(() => null); return engine.localStatus(); }],
    ['POST', /^\/api\/local\/config$/, async (_m, b) => engine.setLocal(b ?? {})],
    ['POST', /^\/api\/local\/refresh$/, async () => engine.refreshLocal()],
    ['POST', /^\/api\/local\/test$/, async (_m, b) => engine.testLocalModel(b?.model)],
    ['POST', /^\/api\/local\/reset$/, async (_m, b) => engine.resetLocal(b?.model)],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/unattended$/, async (m) => engine.unattendedStatus(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/unattended$/, async (m, b) => engine.setUnattended(m[1], b ?? {})],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/prs$/, async (m) => engine.listPrs(m[1])],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/prs\/(\d{1,9})$/, async (m) => engine.prDetail(m[1], m[2])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/prs\/(\d{1,9})\/(merge|close|comment|rebuild|resolve)$/, async (m, b) => engine.prAction(m[1], m[2], m[3], b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/verify$/, async (m, b) => engine.setVerify(m[1], b)],
    ['GET', /^\/api\/projects\/([a-z0-9-]+)\/publish$/, async (m) => engine.publishStatus(m[1])],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/publish-target$/, async (m, b) => engine.setPublishTarget(m[1], b)],
    ['POST', /^\/api\/projects\/([a-z0-9-]+)\/publish$/, async (m, b) => engine.publish(m[1], b)],
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

  const streams = new Set();
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
      const prev = /^\/preview\/([a-f0-9]{36})$/.exec(url.pathname);
      if (prev) {   // a design mockup: the address is the credential, it expires, and the page can run nothing and fetch nothing
        const v = previews.get(prev[1]); if (req.method !== 'GET' || !v || v.exp < Date.now()) return send(res, 404, { error: 'Not found' });
        return send(res, 200, v.html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox", 'Referrer-Policy': 'no-referrer' });
      }
      const protectedPath = url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname === '/mcp-code';
      if (!protectedPath) {
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        // Flat UI files, plus exactly two subfolders (fonts and art). path.basename() makes traversal impossible.
        const name = url.pathname === '/' ? 'index.html' : url.pathname.startsWith('/fonts/') ? path.join('fonts', path.basename(url.pathname)) : url.pathname.startsWith('/art/') ? path.join('art', path.basename(url.pathname)) : path.basename(url.pathname);
        const file = path.join(UI, name);
        if (!TYPES[path.extname(name)] || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': TYPES[path.extname(name)], ...(name.startsWith('fonts') ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : { 'Cache-Control': 'no-cache' }),
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      }
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!bearer || !same(bearer, token)) return send(res, 401, { error: 'Missing or invalid token' }, { 'WWW-Authenticate': 'Bearer' });
      const write = req.method !== 'GET';
      if (write && req.headers.origin && new URL(req.headers.origin).host !== host) return send(res, 403, { error: 'Cross-origin write refused' });
      if (url.pathname === '/mcp' || url.pathname === '/mcp-code') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST JSON-RPC to this endpoint' }, { Allow: 'POST' });
        const body = await readJson(req, bodyLimit(url.pathname));
        const out = Array.isArray(body) ? (await Promise.all(body.map((m) => handleRpc(engine, m, { code: url.pathname === '/mcp-code' })))).filter(Boolean) : await handleRpc(engine, body, { code: url.pathname === '/mcp-code' });
        return out === null || (Array.isArray(out) && !out.length) ? (res.writeHead(202, { 'Cache-Control': 'no-store' }), res.end()) : send(res, 200, out);
      }
      if (url.pathname === '/api/stream' && req.method === 'GET') {   // push: "something changed" the moment it does (text/event-stream; same bearer token as everything else)
        if (streams.size >= 16) return send(res, 429, { error: 'Too many open live connections' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write('retry: 3000\nevent: hello\ndata: {}\n\n');
        const onChange = (topics) => { try { res.write(`event: change\ndata: ${JSON.stringify({ topics })}\n\n`); } catch { /* the connection is gone */ } }; const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
        const done = () => { clearInterval(beat); engine.bus.off('change', onChange); streams.delete(res); }; streams.add(res); engine.bus.on('change', onChange); req.on('close', done); res.on('close', done); return;
      }
      if (url.pathname === '/api/accounts.csv' && req.method === 'GET') return send(res, 200, await engine.accountsCsv(url.searchParams.get('days')), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="agent-factory-usage.csv"' });
      const shot = /^\/api\/projects\/([a-z0-9-]+)\/visual\/(baseline|screens|[a-f0-9]{8})\/([a-z0-9-]+\.png)$/.exec(url.pathname);
      if (shot && req.method === 'GET') return send(res, 200, engine.visualFile(shot[1], shot[2], shot[3]), { 'Content-Type': 'image/png' });
      for (const [method, re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (m && method === req.method) return send(res, 200, await fn(m, ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req, bodyLimit(url.pathname)) : {}, url) ?? {});
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
