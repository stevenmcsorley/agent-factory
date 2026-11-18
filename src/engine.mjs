import fs from 'node:fs';
import path from 'node:path';
import { tick } from './factory.mjs';
import { feedbackTick } from './feedback.mjs';
import { buildTickets, identifySource, publicSources, SOURCES, TOKEN_ENV, ossiconeSignupInfo } from './sources.mjs';
import { buildHost, identifyHost, publicHosts, hostKind, HOSTS } from './hosts.mjs';
import { sandbox as makeSandbox } from './adapters/sandbox.mjs';
import { agents } from './adapters/agents.mjs';
import { gitVcs } from './adapters/vcs.mjs';
import { startEgress } from './egress.mjs';
import { spentToday, runsToday } from './budget.mjs';
import { validateConfig, saveConfig } from './config.mjs';
import { stateOf } from './ops.mjs';
import { normalizeRepo } from './repoRef.mjs';
import { analyzeRepo, profileSummary } from './analyze.mjs';
import { sonarApi, scanProject, ensureManaged, stopManaged, waitUp, MANAGED, SONAR_TOKEN_ENV, projectKey } from './sonar.mjs';
import { checkBaseUrl } from './sources.mjs';
import { addHistory } from './quality.mjs';
import { assessTicket } from './gate.mjs';
import { AGENT_LABELS } from './labels.mjs';
import { inspectRepo, ensureLabels, createProjectRepo, whoami } from './github.mjs';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// The engine owns projects and runs them. Adapter factories are injectable so the whole thing is testable without GitHub/Docker.
// A profile arrives from the browser: keep only known, bounded fields so it cannot smuggle anything into the agent prompt.
const sanitizeMetrics = (m) => { if (!m || typeof m !== 'object') return null; const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1e9, Math.round(v))) : 0); const r = (v) => (/^[A-E]$/.test(v) ? v : 'E');
  return { files: n(m.files), codeLines: n(m.codeLines), commentLines: n(m.commentLines), blankLines: n(m.blankLines), sourceFiles: n(m.sourceFiles), testFiles: n(m.testFiles), testRatioPct: n(m.testRatioPct), duplicatedPct: n(m.duplicatedPct), todoCount: n(m.todoCount), largeFiles: n(m.largeFiles), heuristic: true, capped: !!m.capped,
    languages: (Array.isArray(m.languages) ? m.languages : []).slice(0, 6).map((l) => ({ name: String(l?.name ?? '').slice(0, 20), lines: n(l?.lines) })), hotspots: (Array.isArray(m.hotspots) ? m.hotspots : []).slice(0, 5).map((h) => ({ file: String(h?.file ?? '').replace(/[^\w./@+-]/g, '').slice(0, 120), lines: n(h?.lines) })),
    secrets: (Array.isArray(m.secrets) ? m.secrets : []).slice(0, 10).map((x) => ({ file: String(x?.file ?? '').replace(/[^\w./@+-]/g, '').slice(0, 120), kind: String(x?.kind ?? '').slice(0, 30) })), ratings: Object.fromEntries(['size', 'tests', 'duplication', 'maintainability', 'security'].map((k) => [k, r(m.ratings?.[k])])) }; };
const sanitizeQuality = (q) => { if (!q || typeof q !== 'object') return null; const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1e6, Math.round(v))) : 0); const t = (v, m) => String(v ?? '').replace(/[^\w./@+ :,%()'-]/g, '').slice(0, m);
  return { counts: Object.fromEntries(['secrets', 'vulnerabilities', 'bugs', 'smells', 'total'].map((k) => [k, n(q.counts?.[k])])), gate: { status: q.gate?.status === 'ERROR' ? 'ERROR' : 'OK', failed: (Array.isArray(q.gate?.failed) ? q.gate.failed : []).slice(0, 6).map((x) => t(x, 120)) },
    findings: (Array.isArray(q.findings) ? q.findings : []).slice(0, 15).map((f) => ({ key: t(f?.key, 200), rule: t(f?.rule, 40), type: t(f?.type, 20), severity: ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'].includes(f?.severity) ? f.severity : 'INFO', file: t(f?.file, 120), line: n(f?.line), message: t(f?.message, 160) })) }; };
const sanitizeProfile = (p) => { const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null); const arr = (v, n, m) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, m)).slice(0, n) : []);
  return { languages: arr(p.languages, 6, 30), packageManager: str(p.packageManager, 20), framework: str(p.framework, 30), verify: str(p.verify, 500), image: str(p.image, 80), verifyReason: str(p.verifyReason), tests: !!p.verify, hasRepoConfig: !!p.hasRepoConfig, hasReadme: !!p.hasReadme, ci: str(p.ci, 30),
    topLevel: arr(p.topLevel, 30, 41).map((x) => x.replace(/[^\w./@+-]/g, '')), metrics: sanitizeMetrics(p.metrics), quality: sanitizeQuality(p.quality), notes: arr(p.notes, 8, 200), warnings: arr(p.warnings, 8, 200), analyzedAt: str(p.analyzedAt, 40) }; };

export class Engine {
  constructor(cfg, { configPath, env = process.env, factories = {}, github = { inspectRepo, ensureLabels, createProjectRepo, whoami } } = {}) {
    this.cfg = cfg; this.configPath = configPath; this.env = env; this.f = factories; this.gh = github;
    this.events = []; this.active = new Map(); this.outcomes = new Map();
    this.jobs = new Map(); this.sonarJob = null;
    this.busy = false; this.egress = null; this.last = { tick: null, feedback: null }; this.timer = null; this.cache = new Map();
    fs.mkdirSync(cfg.stateDir, { recursive: true });
  }

  get stop() { return path.join(this.cfg.stateDir, 'STOP'); }
  paused() { return fs.existsSync(this.stop); }
  pause() { fs.writeFileSync(this.stop, new Date().toISOString()); }
  resume() { fs.rmSync(this.stop, { force: true }); }
  project(id) { const p = this.cfg.projects.find((x) => x.id === id); if (!p) throw Object.assign(new Error(`No such project: ${id}`), { status: 404 }); return p; }
  projectDir(p) { const d = path.join(this.cfg.stateDir, 'projects', p.id); fs.mkdirSync(path.join(d, 'logs'), { recursive: true }); return d; }

  async start() {
    const s = this.cfg.sandbox;
    if (s.kind === 'docker' && s.egress && !this.f.sandbox) this.egress = await (this.f.startEgress ?? startEgress)({ allow: s.egress.allow, image: s.image });
  }
  async stopEgress() { await this.egress?.stop?.(); this.egress = null; }

  // Everything the core loop needs for one project, built fresh from config.
  deps(p) {
    const dir = this.projectDir(p);
    const log = path.join(dir, 'logs', `${new Date().toISOString().slice(0, 10)}.log`);
    const hostAdapter = this.f.hostAdapter?.(p) ?? buildHost(p, { env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec });
    const tickets = this.f.tickets?.(p) ?? buildTickets(p.tickets, { repo: p.repo, env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec });
    const sb = this.f.sandbox ?? makeSandbox({ ...this.cfg.sandbox, ...(this.egress ? { network: this.egress.network, extraEnv: this.egress.env } : {}), log });
    const a = this.cfg.agent;
    const agent = this.f.agent ?? agents[a.kind]({ ...a, image: this.cfg.sandbox.agentImage, log });
    const vcs = this.f.vcs ?? gitVcs({ log, openPr: (args) => hostAdapter.openPr({ repo: p.repo, ...args }), gitEnv: hostAdapter.gitEnv() });
    const host = this.f.host?.(p) ?? hostAdapter.pr; // the PR/MR feedback side
    const repos = p.allowedRepos?.length ? Object.fromEntries([p.repo, ...p.allowedRepos].map((r) => [r, { base: p.repoBases?.[r] ?? p.base }])) : undefined;
    const config = { ...this.cfg.limits, ...(p.config ?? {}), repo: p.repo, projectId: p.id, base: p.base, profileSummary: profileSummary(p.profile), cloneUrl: hostAdapter.cloneUrl(p.repo), cloneUrlFor: (r) => hostAdapter.cloneUrl(r), prLink: (n) => hostAdapter.prUrl(p.repo, n), gitEnv: hostAdapter.gitEnv(), runsDir: this.cfg.stateDir, repos, onEvent: (e) => this._event(e) };
    return { tickets, host, sandbox: sb, agent, vcs, config, stateDir: dir };
  }

  async _exclusive(kind, fn) {
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    try { const r = await fn(); this.last[kind] = { at: new Date().toISOString(), results: r.length }; return r; } finally { this.busy = false; }
  }
  tickAll() { return this._exclusive('tick', async () => { const out = []; for (const p of this.cfg.projects) { if (p.paused) continue; const d = this.deps(p); out.push(...(await tick(d)).map((r) => ({ project: p.id, ...r }))); } return out; }); }
  feedbackAll() { return this._exclusive('feedback', async () => { const out = []; for (const p of this.cfg.projects) { if (p.paused) continue; const d = this.deps(p); out.push(...(await feedbackTick(d)).map((r) => ({ project: p.id, ...r }))); } return out; }); }

  loop(ms = this.cfg.pollMs) {
    this.pollMs = ms;
    const cycle = async () => { try { await this.tickAll(); await this.feedbackAll(); } catch (e) { console.error('cycle failed:', e.message); } this.nextAt = Date.now() + ms; this.timer = setTimeout(cycle, ms); };
    this.nextAt = Date.now() + 1000;
    this.timer = setTimeout(cycle, 1000);
  }
  halt() { clearTimeout(this.timer); }

  // ---- live activity: runs publish phase events; we keep a ring buffer and the set of runs in flight
  _event(e) {
    this.events.push(e); if (this.events.length > 300) this.events.shift();
    if (e.type === 'start' || e.type === 'end') this.cache.clear(); // queue counts must reflect a run starting/finishing immediately, not 15s later
    if (e.type === 'start') this.active.set(e.run, { run: e.run, project: e.project, ticket: e.ticket, pr: e.pr, title: e.title, started: e.at, phase: 'queued', phaseStarted: e.at, phases: [] });
    const a = this.active.get(e.run);
    if (e.type === 'phase' && a) { a.phase = e.phase; a.detail = e.detail; a.phaseStarted = e.at; a.phases.push({ name: e.phase, at: e.at }); }
    if (e.type === 'end') { const a2 = this.active.get(e.run); this.active.delete(e.run); if (a2?.ticket != null) this.outcomes.set(`${a2.project}#${a2.ticket}`, { status: e.status, at: Date.now() }); }
  }
  activity() { return { active: [...this.active.values()], events: this.events.slice(-80).reverse() }; }
  getRun(id) { const r = this.runs({ limit: 100000 }).find((x) => x.id === id); if (!r) throw Object.assign(new Error(`No such run: ${id}`), { status: 404 }); return r; }

  // Charts and KPIs, derived from the run log. "Neutral" outcomes (gate bounces, pauses, requeues) are not failures.
  metrics({ days = 14 } = {}) {
    const NEUTRAL = new Set(['needs-info', 'stopped', 'budget-exhausted', 'recovered-requeued', 'repo-not-allowed']);
    const all = this.runs({ limit: 100000 }).filter((r) => r.finished);
    const day = (d) => d.toISOString().slice(0, 10);
    const series = []; for (let i = days - 1; i >= 0; i--) series.push({ date: day(new Date(Date.now() - i * 86400000)), ok: 0, failed: 0, neutral: 0 });
    const idx = Object.fromEntries(series.map((x, i) => [x.date, i]));
    const projects = {}; const dur = [];
    let cost = 0, tIn = 0, tOut = 0, ok = 0, failed = 0;
    for (const r of all) {
      const kind = r.status === 'ok' ? 'ok' : NEUTRAL.has(r.status) ? 'neutral' : 'failed';
      const i = idx[r.finished.slice(0, 10)];
      if (i !== undefined) series[i][kind]++;
      const p = (projects[r.project] ??= { runs: 0, ok: 0, failed: 0, ms: [], spark: new Array(days).fill(0) });
      if (kind !== 'neutral') p.runs++;
      if (kind === 'ok') { p.ok++; ok++; } if (kind === 'failed') { p.failed++; failed++; }
      if (i !== undefined && kind !== 'neutral') p.spark[i]++;
      const ms = new Date(r.finished) - new Date(r.started);
      if (kind !== 'neutral' && ms >= 0) { p.ms.push(ms); dur.push(ms); }
      cost += r.costUsd ?? 0; tIn += r.tokens?.input ?? 0; tOut += r.tokens?.output ?? 0;
    }
    const med = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
    return { days: series,
      totals: { runs: ok + failed, ok, failed, successRate: ok + failed ? ok / (ok + failed) : null, avgMs: avg(dur), p50Ms: med(dur), costUsd: Number(cost.toFixed(4)), tokens: { input: tIn, output: tOut } },
      projects: Object.fromEntries(Object.entries(projects).map(([k, v]) => [k, { runs: v.runs, ok: v.ok, failed: v.failed, avgMs: avg(v.ms), spark: v.spark }])) };
  }

  // ---- read models for the UI
  runs({ project, limit = 100 } = {}) {
    return read(path.join(this.cfg.stateDir, 'runs.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => !project || r.project === project).reverse().slice(0, limit);
  }
  status() {
    const runs = this.runs({ limit: 1000 });
    const per = Object.fromEntries(this.cfg.projects.map((p) => [p.id, { project: p.id, repo: p.repo, paused: !!p.paused, runs: 0, ok: 0, failed: 0, lastRun: null }]));
    for (const r of runs) { const s = per[r.project]; if (!s) continue; s.runs++; if (r.status === 'ok') s.ok++; else if (!['needs-info', 'stopped', 'budget-exhausted', 'recovered-requeued'].includes(r.status)) s.failed++; s.lastRun ??= r; }
    const l = this.cfg.limits;
    return { paused: this.paused(), busy: this.busy, last: this.last, active: this.active.size, nextAt: this.nextAt ? new Date(this.nextAt).toISOString() : null, pollMs: this.pollMs ?? null, agent: this.cfg.agent.kind,
      today: { runs: runsToday(this.cfg.stateDir), maxRuns: l.maxRunsPerDay ?? null, costUsd: Number(spentToday(this.cfg.stateDir).toFixed(4)), maxCostUsd: l.dailyBudgetUsd ?? null },
      projects: Object.values(per) };
  }
  async _cached(key, ttl, fn) { const c = this.cache.get(key); if (c && Date.now() - c.at < ttl) return c.v; const v = await fn(); this.cache.set(key, { at: Date.now(), v }); return v; }
  // Trackers lag after a write (GitHub's lists by ~6s), so for a short while the label they report can be one step behind what the line
  // itself knows. Overlay the factory's own live knowledge so the hopper/board never flicker back to a stale state.
  overlay(projectId, tickets) {
    const live = new Set([...this.active.values()].filter((a) => a.project === projectId).map((a) => String(a.ticket)));
    return tickets.map((t) => {
      const swap = (to) => ({ ...t, labels: [...t.labels.filter((l) => !['agent-ready', 'agent-working', 'agent-review', 'agent-failed', 'agent-needs-info'].includes(l)), to] });
      if (live.has(String(t.id))) return swap('agent-working');
      const o = this.outcomes.get(`${projectId}#${t.id}`);
      if (o && Date.now() - o.at < 30000 && ['agent-ready', 'agent-working'].some((l) => t.labels.includes(l))) return swap(o.status === 'ok' ? 'agent-review' : o.status === 'needs-info' ? 'agent-needs-info' : 'agent-failed');
      return t;
    });
  }

  // One call for the dashboard: per-project queue by state, open PRs and metrics. A failing project never breaks the page.
  async overview() {
    const m = this.metrics();
    return Promise.all(this.cfg.projects.map(async (p) => {
      // closed tickets are history, not queue (see the CLOSED filter below)
      const out = { id: p.id, repo: p.repo, base: p.base, paused: !!p.paused, host: hostKind(p), source: p.tickets.kind, repoUrl: this.repoUrl(p), profile: p.profile ?? null, sonarUrl: this.cfg.sonar ? `${this.sonarCfg().url}/dashboard?id=${projectKey(p.id)}` : null, verify: p.config?.verify ?? p.profile?.verify ?? null, queue: {}, prs: 0, metrics: m.projects[p.id] ?? null };
      try { (await this.listTickets(p.id)).filter((t) => t.state !== 'CLOSED').forEach((t) => { const s = stateOf(t.labels); out.queue[s] = (out.queue[s] ?? 0) + 1; }); out.prs = (await this.listPrs(p.id)).length; } catch (e) { out.error = String(e.message).slice(0, 160); }
      return out;
    }));
  }
  // ---- inbox: everything that needs a human, with the reason and the run behind it
  async inbox() {
    const ATTN = new Set(['failed', 'needs-info', 'needs-human']); const items = []; const errors = []; let budget = 12; const runs = this.runs({ limit: 500 });
    for (const p of this.cfg.projects) {
      let tickets; try { tickets = (await this.listTickets(p.id)).filter((t) => t.state !== 'CLOSED'); } catch (e) { errors.push({ project: p.id, error: String(e.message).slice(0, 160) }); continue; }
      const mine = tickets.filter((t) => ATTN.has(stateOf(t.labels)) || stateOf(t.labels) === 'review'); if (!mine.length) continue;
      const prs = mine.some((t) => stateOf(t.labels) === 'review') ? await this.listPrs(p.id).catch(() => []) : [];
      for (const t of mine) {
        const state = stateOf(t.labels); const item = { project: p.id, id: t.id, title: t.title, url: t.url, state, kind: state === 'review' ? 'review' : 'decision', updatedAt: t.updatedAt };
        const run = runs.find((r) => r.project === p.id && String(r.ticket) === String(t.id)); if (run) item.run = { id: run.id, status: run.status, error: run.error, finished: run.finished };
        if (state === 'review') { const pr = prs.find((x) => x.branch.startsWith(`agent/${t.id}-`)); if (pr) item.pr = pr; }
        else if (budget-- > 0) { try { const d = await this._cached(`d:${p.id}:${t.id}`, 20000, () => this.deps(p).tickets.get(t.id)); item.body = d.body; item.comments = d.comments.slice(-4); } catch (e) { item.detailError = String(e.message).slice(0, 120); } }
        items.push(item);
      }
    }
    items.sort((a, b) => (a.kind === b.kind ? String(b.updatedAt).localeCompare(String(a.updatedAt)) : a.kind === 'decision' ? -1 : 1));
    return { items, errors, counts: { decisions: items.filter((i) => i.kind === 'decision').length, reviews: items.filter((i) => i.kind === 'review').length } };
  }
  async inboxCount() { const ov = await this.overview(); let n = 0; for (const p of ov) n += (p.queue.review ?? 0) + (p.queue.failed ?? 0) + (p.queue['needs-info'] ?? 0) + (p.queue['needs-human'] ?? 0); return { count: n }; }

  // Act on a ticket from the inbox. Everything is validated; re-queueing re-runs the clarity gate so a vague ticket cannot just bounce back.
  async ticketAction(projectId, ticketId, action, payload = {}) {
    const bad = (m, status = 400) => Object.assign(new Error(m), { status });
    const p = this.project(projectId); if (!/^[\w-]{1,40}$/.test(String(ticketId))) throw bad('Invalid ticket id');
    const text = (v, max = 20000) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`Text is required (max ${max} characters)`); return v.trim(); };
    const adapter = this.deps(p).tickets; if (!adapter.get) throw bad('This ticket source does not support that action', 501);
    this.cache.delete(`t:${projectId}`); this.cache.delete(`d:${projectId}:${ticketId}`);
    if (action === 'comment') { await adapter.comment(ticketId, text(payload.text)); return { commented: true }; }
    if (action === 'update') { if (payload.title === undefined && payload.body === undefined) throw bad('Nothing to update'); await adapter.update(ticketId, { ...(payload.title !== undefined ? { title: text(payload.title, 200) } : {}), ...(payload.body !== undefined ? { body: text(payload.body) } : {}) }); return { updated: true }; }
    if (action === 'close') { await adapter.close(ticketId); return { closed: true }; }
    if (action === 'requeue') {
      const cur = await adapter.get(ticketId); const details = payload.details === undefined || payload.details === '' ? '' : text(payload.details);
      const body = details ? `${cur.body}\n\n---\nAdditional detail:\n${details}`.trim() : cur.body;
      const g = assessTicket({ title: cur.title, body }, this.cfg.limits.gate);
      if (!g.ok) throw bad(`Still too vague for the factory to start: ${g.problems.join('; ')}. Add concrete detail (function/file names, expected behaviour) and try again.`);
      if (details) await adapter.update(ticketId, { body });
      await adapter.label(ticketId, ['agent-ready'], AGENT_LABELS.filter((l) => l !== 'agent-ready'));
      this.outcomes.delete(`${projectId}#${ticketId}`); await adapter.comment(ticketId, `agent-factory: requeued by you${details ? ' with extra detail' : ''}.`).catch(() => {});
      return { requeued: true };
    }
    throw bad(`Unknown action: ${action}`, 404);
  }

  async listTickets(id) { const p = this.project(id); return this.overlay(id, await this._cached(`t:${id}`, 15000, () => this.deps(p).tickets.listAgentTickets())); }
  repoUrl(p) { const k = hostKind(p); return k === 'github' ? `https://github.com/${p.repo}` : k === 'gitlab' ? `${(p.host.baseUrl ?? 'https://gitlab.com').replace(/\/$/, '')}/${p.repo}` : k === 'bitbucket' ? `https://bitbucket.org/${p.repo}` : null; }
  async listPrs(id) { const p = this.project(id); const h = this.f.hostAdapter?.(p) ?? buildHost(p, { env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec }); return (await this._cached(`p:${id}`, 15000, () => this.deps(p).host.listAgentPrs())).map((x) => ({ ...x, url: h.prUrl(p.repo, x.number) })); }
  async createTicket(id, { title, body, repo }) {
    const p = this.project(id);
    if (!title || title.length > 200) throw Object.assign(new Error('title is required (max 200 chars)'), { status: 400 });
    this.cache.delete(`t:${id}`);
    return this.deps(p).tickets.create({ title, body: body ?? '', repo });
  }

  // ---- project management (persisted to the config file)
  _persist() { if (this.configPath) saveConfig(this.configPath, this.cfg); }
  // Persist a token in the owner-only secrets file and make it visible to this process. Names are restricted to AF_* so a project
  // can only ever reference secrets the factory itself stored (never arbitrary environment variables).
  saveSecret(name, value) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!TOKEN_ENV.test(name)) throw bad('Secret names must look like AF_MYPROJECT_TOKEN');
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\r\n\0]/.test(value)) throw bad('That token looks invalid (empty, multi-line or too long)');
    const f = path.join(this.cfg.stateDir, 'secrets.env'); const lines = read(f).split('\n').filter((l) => l && !l.startsWith(`${name}=`));
    lines.push(`${name}=${value.trim()}`); const tmp = `${f}.tmp`; fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 }); fs.renameSync(tmp, f);
    this.env[name] = value.trim();
  }
  catalog() { return { sources: publicSources(), hosts: publicHosts() }; }
  async testSource({ kind, fields, token }) { return identifySource({ kind, fields, token, whoami: this.gh.whoami, fetchImpl: this.f.fetch }); }
  // Accept whatever the user pasted; return the canonical repo. A URL for a different host than the selected card is a clear, fixable mistake.
  _repoFor(kind, input) {
    const n = normalizeRepo(input, kind); const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!n.repo) throw bad('Enter the repository, e.g. owner/name or its web URL');
    const names = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
    if (n.host && n.host !== kind) throw bad(`That looks like a ${names[n.host]} URL, but ${names[kind] ?? kind} is selected. Choose ${names[n.host]} in step 1.`);
    return n.repo;
  }
  async testHost({ kind, fields, token, repo: input }) { const repo = this._repoFor(kind, input); const r = await this._testHost({ kind, fields, token, repo }); return { ...r, repo }; }
  async _testHost({ kind, fields, token, repo }) { return kind === 'github' ? { ...(await this.gh.inspectRepo(repo)), user: await this.gh.whoami(), supportsPrs: true } : identifyHost({ kind, fields, token, repo, fetchImpl: this.f.fetch, exec: this.f.exec }); }
  signupInfo(baseUrl) { return ossiconeSignupInfo(baseUrl, this.f.fetch); }

  // Add a project. Any ticket source × any code host. Tokens arrive as `secret` (tickets) / `hostSecret` (code host), are verified
  // against the real service BEFORE anything is saved, are written only to the secrets file, and never appear in the config or any response.
  async addProject({ id, repo: repoInput, base, host, hostSecret, source, secret, tickets, config, allowedRepos, feedbackAuthors, profile, verify }) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    const kindGuess = host?.kind ?? (normalizeRepo(repoInput).host ?? 'github');
    const repo = this._repoFor(kindGuess, repoInput); if (!host && kindGuess !== 'github') host = { kind: kindGuess }; // pasted a GitLab/Bitbucket URL with no host chosen: use it
    id = id || repo.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const upper = String(id ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
    // 1. code host
    const hk = host?.kind ?? 'github';
    const { kind: _k, token: _t, ...hostFields } = host ?? {};
    const hostCfg = { kind: hk, ...hostFields };
    const hostDef = HOSTS[hk]; if (!hostDef) throw bad(`Unsupported code host: ${hk}`);
    if (hk !== 'github' && hostDef.fields.some((f) => f.secret)) hostCfg.tokenEnv ??= `AF_${upper}_GIT_TOKEN`;
    const hostToken = hostSecret ?? (hostCfg.tokenEnv ? this.env[hostCfg.tokenEnv] : undefined);
    const hostInfo = hk === 'github' ? { ...(await this.gh.inspectRepo(repo)), user: await this.gh.whoami().catch(() => null) } : await identifyHost({ kind: hk, fields: hostFields, token: hostToken, repo, fetchImpl: this.f.fetch, exec: this.f.exec });
    // 2. ticket source
    let t = tickets, ticketToken;
    if (source) {
      const def = SOURCES[source.kind]; if (!def || def.hidden) throw bad(`Unsupported ticket source: ${source.kind}`);
      const { token: _s, pick, ...fields } = source.fields ?? {};
      const tokenEnv = source.kind === 'github' ? undefined : (source.tokenEnv ?? `AF_${upper}_TOKEN`);
      ticketToken = source.kind === 'github' ? undefined : (secret ?? this.env[tokenEnv]);
      const identity = await identifySource({ kind: source.kind, fields, token: ticketToken, whoami: this.gh.whoami, fetchImpl: this.f.fetch });
      const pickVal = source.pick !== undefined && def.pick?.type === 'number' ? Number(source.pick) : source.pick;
      t = { kind: source.kind, ...fields, ...(tokenEnv ? { tokenEnv } : {}), ...(def.pick ? { [def.pick.key]: pickVal } : {}), ...def.allow(identity) };
    }
    t ??= hk === 'github' ? { kind: 'github', allowedAuthors: hostInfo.user ? [hostInfo.user] : [] } : null;
    if (!t) throw bad(`Choose where tickets live (GitHub Issues only works with a GitHub repo): Jira, Linear or Ossicone`);
    const p = { id, repo, base: base || hostInfo.defaultBranch, ...(hk !== 'github' ? { host: hostCfg } : {}), tickets: t, ...((config || verify) ? { config: { ...(config ?? {}), ...(verify ? { verify: String(verify).slice(0, 500) } : {}) } } : {}), ...(profile && typeof profile === 'object' ? (() => { const sp = sanitizeProfile(profile); sp.history = addHistory([], sp); return { profile: sp }; })() : {}), ...(allowedRepos ? { allowedRepos } : {}),
      ...((feedbackAuthors ?? (t.kind !== 'github' && hostInfo.user ? [hostInfo.user] : null)) ? { feedbackAuthors: feedbackAuthors ?? [hostInfo.user] } : {}) };
    const problems = validateConfig({ ...this.cfg, projects: [...this.cfg.projects, p] });
    if (problems.length) throw bad(problems.join('; '));
    // 3. side effects only after everything checked out
    if (hostSecret) this.saveSecret(hostCfg.tokenEnv, hostSecret);
    if (secret && t.tokenEnv) this.saveSecret(t.tokenEnv, secret);
    if (t.kind === 'github') await this.gh.ensureLabels(repo);
    this.cfg.projects.push(p); this._persist();
    if (this.cfg.sonar) this.startAnalysis(p.id); // SonarQube is on: scan the new project in the background
    return p;
  }
  // Shallow, read-only clone -> profile. Nothing is executed from the repo and nothing is persisted here.
  async _analyzeWith(hostAdapter, repo, base, { onPhase, onProfile, sonarFor, gate } = {}) {
    const sb = this.f.sandbox ?? makeSandbox({ ...this.cfg.sandbox, log: path.join(this.cfg.stateDir, 'analyze.log') });
    let ws;
    onPhase?.('cloning the repository');
    try {
      ws = await sb.create({ cloneUrl: hostAdapter.cloneUrl(repo), branch: 'analyze', base, newBranch: false, gitEnv: hostAdapter.gitEnv(), depth: 1 });
      onPhase?.('reading the code'); const profile = analyzeRepo(ws.dir, { gate }); onProfile?.(profile);
      if (sonarFor) profile.sonar = await this._sonarScan(ws.dir, sonarFor, onPhase).catch((e) => ({ error: String(e.message ?? e).slice(0, 400), analyzedAt: new Date().toISOString() }));
      return profile;
    } catch (e) { const m = String(e.message ?? e); if (/clone failed/.test(m) && /(Remote branch .* not found|empty|did not match)/i.test(m)) return { ...analyzeRepo(os.tmpdir() + '/__nonexistent__'), warnings: ['the base branch was not found or the repository is empty'], languages: [], topLevel: [] }; throw Object.assign(new Error(m.slice(0, 300)), { status: 400 }); }
    finally { try { ws?.destroy(); } catch { /* best effort */ } }
  }

  // ---- SonarQube (optional, the real analyser). Settings live in cfg.sonar; the token only in secrets.env.
  sonarCfg() {
    const c = this.cfg.sonar; if (!c) return null;
    const managed = c.mode === 'managed'; const url = managed ? MANAGED.hostUrl : c.url; const host = (() => { try { return new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } })();
    return { mode: c.mode, url, innerUrl: managed ? MANAGED.innerUrl : url, network: managed ? MANAGED.network : ['localhost', '127.0.0.1', '::1'].includes(host) ? 'host' : undefined, token: this.env[SONAR_TOKEN_ENV] };
  }
  async _sonarScan(dir, { id }, onPhase) {
    const c = this.sonarCfg(); if (!c?.token) throw new Error('SonarQube is not set up (Health page → Code quality)');
    return (this.f.sonarScan ?? scanProject)({ dir, id, name: id, url: c.url, innerUrl: c.innerUrl, token: c.token, network: c.network, exec: this.f.dockerExec, fetchImpl: this.f.fetch, onPhase, log: path.join(this.cfg.stateDir, 'sonar.log') });
  }
  async sonarStatus() {
    const c = this.sonarCfg(); const job = this.sonarJob;
    if (job?.state === 'running') return { enabled: false, state: 'starting', phase: job.phase, mode: 'managed' };
    if (!c) return { enabled: false, state: job?.state === 'error' ? 'error' : 'off', error: job?.error, mode: null };
    const up = await this._cached('sonar', 8000, async () => { try { const s = await sonarApi({ url: c.url, fetchImpl: this.f.fetch, timeoutMs: 2500 }).get('/api/system/status'); return s?.status === 'UP' ? s.version : null; } catch { return null; } });
    return { enabled: true, mode: c.mode, url: c.url, state: up ? 'ready' : 'down', version: up || undefined, hasToken: !!c.token };
  }
  async sonarEnable({ mode, url, token } = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (this.sonarJob?.state === 'running') throw bad('SonarQube is already being set up');
    this.cache.delete('sonar');
    if (mode === 'external') {
      let base; try { base = checkBaseUrl(url ?? ''); } catch (e) { throw bad(e.message); }
      if (typeof token !== 'string' || !token.trim()) throw bad('Paste a SonarQube token (My Account → Security → Generate)');
      const v = await sonarApi({ url: base, token: token.trim(), fetchImpl: this.f.fetch }).get('/api/authentication/validate').catch((e) => { throw bad(`Could not connect: ${e.message}`); });
      if (!v?.valid) throw bad('SonarQube rejected that token');
      this.saveSecret(SONAR_TOKEN_ENV, token.trim()); this.cfg.sonar = { mode: 'external', url: base }; this._persist(); return this.sonarStatus();
    }
    if (mode !== 'managed') throw bad('Choose "managed" (the factory runs SonarQube) or "external" (your own server)');
    const job = this.sonarJob = { state: 'running', phase: 'starting' };
    (this.f.ensureManaged ?? ensureManaged)({ exec: this.f.dockerExec, fetchImpl: this.f.fetch, env: this.env, saveSecret: (n, v) => this.saveSecret(n, v), onPhase: (ph) => { job.phase = ph; } })
      .then(() => { this.cfg.sonar = { mode: 'managed' }; this._persist(); this.sonarJob = null; this.cache.delete('sonar'); })
      .catch((e) => { this.sonarJob = { state: 'error', error: String(e.message ?? e).slice(0, 400) }; });
    return { enabled: false, state: 'starting', phase: job.phase, mode: 'managed' };
  }
  async sonarDisable({ stop } = {}) {
    const was = this.cfg.sonar; delete this.cfg.sonar; this.sonarJob = null; this.cache.delete('sonar'); this._persist();
    if (stop && was?.mode === 'managed') await (this.f.stopManaged ?? stopManaged)({ exec: this.f.dockerExec });
    return { enabled: false, state: 'off', mode: null };
  }
  // "Queue a fix": turn one SonarQube finding from the last scan into a normal ticket (it still goes through the usual pipeline and review).
  async sonarIssueTicket(id, issueKey) {
    const p = this.project(id); const sq = p.profile?.sonar?.issues?.find((x) => x.key === issueKey); const own = p.profile?.quality?.findings?.find((x) => x.key === issueKey); const i = sq ?? own;
    if (!i) throw Object.assign(new Error('That finding is not in the last analysis; re-analyze first'), { status: 404 });
    const where = `${i.file}${i.line ? `:${i.line}` : ''}`; const src = sq ? 'SonarQube' : 'the code quality scan';
    return this.createTicket(id, { title: `Fix ${i.type.toLowerCase().replace('_', ' ')}: ${i.message}`.slice(0, 120),
      body: `${src} rule ${i.rule} (${i.severity}) reports at ${where}: ${i.message}\n\nFix this finding with the smallest correct change and keep the existing tests passing. Do not touch unrelated code.` });
  }

  async analyzeDraft({ kind = 'github', fields = {}, token, repo: input, base }) {
    const repo = this._repoFor(kind, input); const env = { ...this.env }; const draft = { id: 'draft', repo, host: { kind, ...fields, tokenEnv: 'AF_DRAFT_GIT_TOKEN' } };
    if (token) env.AF_DRAFT_GIT_TOKEN = token; else if (fields.tokenEnv) env.AF_DRAFT_GIT_TOKEN = this.env[fields.tokenEnv];
    const hostAdapter = buildHost(draft, { env, fetchImpl: this.f.fetch, exec: this.f.exec });
    const baseBranch = base || (kind === 'github' ? (await this.gh.inspectRepo(repo)).defaultBranch : (await this._testHost({ kind, fields, token, repo })).defaultBranch);
    return { repo, base: baseBranch, profile: await this._analyzeWith(hostAdapter, repo, baseBranch) };
  }
  // Re-analysis is a background job (the SonarQube scan takes a minute or two): start it, then poll analysisJob().
  startAnalysis(id) {
    this.project(id); const cur = this.jobs.get(id); if (cur?.state === 'running') return cur;
    const job = { state: 'running', phase: 'starting', startedAt: Date.now() }; this.jobs.set(id, job);
    this.analyzeProject(id, { onPhase: (ph) => { job.phase = ph; } }).then(() => { job.state = 'done'; job.phase = ''; job.finishedAt = Date.now(); })
      .catch((e) => { job.state = 'error'; job.error = String(e.message ?? e).slice(0, 300); job.finishedAt = Date.now(); });
    return job;
  }
  analysisJob(id) { this.project(id); return this.jobs.get(id) ?? { state: 'idle' }; }
  async analyzeProject(id, { onPhase } = {}) {
    const p = this.project(id); const hostAdapter = this.f.hostAdapter?.(p) ?? buildHost(p, { env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec });
    const prev = p.profile?.sonar; const prevHistory = p.profile?.history; const wantSonar = !!this.cfg.sonar;
    const profile = await this._analyzeWith(hostAdapter, p.repo, p.base, { gate: this.cfg.limits.qualityRepoGate, onPhase, sonarFor: wantSonar ? { id: p.id } : null,
      onProfile: (pr) => { p.profile = { ...pr, history: prevHistory ?? [], ...(prev ? { sonar: prev } : {}) }; this._persist(); } }); // the fast scan shows up at once; the SonarQube result follows
    if (!profile.sonar && prev) profile.sonar = prev;
    profile.history = addHistory(prevHistory, profile);
    p.profile = profile; this._persist(); return p.profile;
  }
  removeProject(id) { this.project(id); this.cfg.projects = this.cfg.projects.filter((p) => p.id !== id); this._persist(); }
  setProjectPaused(id, paused) { const p = this.project(id); p.paused = !!paused; this._persist(); return p; }

  // Create a brand-new repo from a template, register it, and queue its first ticket (the spec).
  async createProject({ id, name, description, visibility, template, spec }) {
    const owner = await this.gh.whoami();
    const repo = await this.gh.createProjectRepo({ owner, name, description, visibility, template, identity: { name: owner, email: `${owner}@users.noreply.github.com` } });
    const p = await this.addProject({ id, repo: repo.repo, base: repo.defaultBranch });
    if (spec) await this.createTicket(id, { title: `Build ${name}`, body: spec });
    return { project: p, url: repo.url };
  }
}
