import fs from 'node:fs';
import path from 'node:path';
import { tick } from './factory.mjs';
import { feedbackTick } from './feedback.mjs';
import { fileTickets } from './adapters/tickets-file.mjs';
import { githubTickets } from './adapters/tickets-github.mjs';
import { ossiconeTickets } from './adapters/tickets-ossicone.mjs';
import { githubHost } from './adapters/githost-github.mjs';
import { sandbox as makeSandbox } from './adapters/sandbox.mjs';
import { agents } from './adapters/agents.mjs';
import { gitVcs } from './adapters/vcs.mjs';
import { startEgress } from './egress.mjs';
import { spentToday, runsToday } from './budget.mjs';
import { validateConfig, saveConfig } from './config.mjs';
import { stateOf } from './ops.mjs';
import { inspectRepo, ensureLabels, createProjectRepo, whoami } from './github.mjs';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// The engine owns projects and runs them. Adapter factories are injectable so the whole thing is testable without GitHub/Docker.
export class Engine {
  constructor(cfg, { configPath, env = process.env, factories = {}, github = { inspectRepo, ensureLabels, createProjectRepo, whoami } } = {}) {
    this.cfg = cfg; this.configPath = configPath; this.env = env; this.f = factories; this.gh = github;
    this.events = []; this.active = new Map();
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
    const t = p.tickets;
    const tickets = this.f.tickets?.(p) ?? (t.kind === 'github' ? githubTickets({ repo: p.repo, allowedAuthors: t.allowedAuthors })
      : t.kind === 'ossicone' ? ossiconeTickets({ baseUrl: t.baseUrl, token: this.env[t.tokenEnv ?? 'OSSICONE_TOKEN'], projectId: t.projectId, allowedReporterIds: t.allowedReporterIds })
      : fileTickets(t.path));
    const sb = this.f.sandbox ?? makeSandbox({ ...this.cfg.sandbox, ...(this.egress ? { network: this.egress.network, extraEnv: this.egress.env } : {}), log });
    const a = this.cfg.agent;
    const agent = this.f.agent ?? agents[a.kind]({ ...a, image: this.cfg.sandbox.agentImage, log });
    const vcs = this.f.vcs ?? gitVcs({ log, repo: p.repo });
    const host = this.f.host?.(p) ?? githubHost({ repo: p.repo, allowedAuthors: p.feedbackAuthors ?? t.allowedAuthors ?? [] });
    const repos = p.allowedRepos?.length ? Object.fromEntries([p.repo, ...p.allowedRepos].map((r) => [r, { base: p.repoBases?.[r] ?? p.base }])) : undefined;
    const config = { ...this.cfg.limits, ...(p.config ?? {}), repo: p.repo, projectId: p.id, base: p.base, cloneUrl: `https://github.com/${p.repo}.git`, runsDir: this.cfg.stateDir, repos, onEvent: (e) => this._event(e) };
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
    if (e.type === 'start') this.active.set(e.run, { run: e.run, project: e.project, ticket: e.ticket, pr: e.pr, title: e.title, started: e.at, phase: 'queued', phaseStarted: e.at, phases: [] });
    const a = this.active.get(e.run);
    if (e.type === 'phase' && a) { a.phase = e.phase; a.detail = e.detail; a.phaseStarted = e.at; a.phases.push({ name: e.phase, at: e.at }); }
    if (e.type === 'end') this.active.delete(e.run);
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
  // One call for the dashboard: per-project queue by state, open PRs and metrics. A failing project never breaks the page.
  async overview() {
    const m = this.metrics();
    return Promise.all(this.cfg.projects.map(async (p) => {
      const out = { id: p.id, repo: p.repo, base: p.base, paused: !!p.paused, queue: {}, prs: 0, metrics: m.projects[p.id] ?? null };
      try { (await this.listTickets(p.id)).forEach((t) => { const s = stateOf(t.labels); out.queue[s] = (out.queue[s] ?? 0) + 1; }); out.prs = (await this.listPrs(p.id)).length; } catch (e) { out.error = String(e.message).slice(0, 160); }
      return out;
    }));
  }
  async listTickets(id) { const p = this.project(id); return this._cached(`t:${id}`, 15000, () => this.deps(p).tickets.listAgentTickets()); }
  async listPrs(id) { const p = this.project(id); return (await this._cached(`p:${id}`, 15000, () => this.deps(p).host.listAgentPrs())).map((x) => ({ ...x, url: `https://github.com/${p.repo}/pull/${x.number}` })); }
  async createTicket(id, { title, body, repo }) {
    const p = this.project(id);
    if (!title || title.length > 200) throw Object.assign(new Error('title is required (max 200 chars)'), { status: 400 });
    this.cache.delete(`t:${id}`);
    return this.deps(p).tickets.create({ title, body: body ?? '', repo });
  }

  // ---- project management (persisted to the config file)
  _persist() { if (this.configPath) saveConfig(this.configPath, this.cfg); }
  async addProject({ id, repo, base, tickets, config, allowedRepos, feedbackAuthors }) {
    const user = tickets?.kind === 'github' || !tickets ? await this.gh.whoami().catch(() => null) : null;
    const info = await this.gh.inspectRepo(repo);
    const p = { id, repo, base: base || info.defaultBranch, tickets: tickets ?? { kind: 'github', allowedAuthors: user ? [user] : [] }, ...(config ? { config } : {}), ...(allowedRepos ? { allowedRepos } : {}), ...(feedbackAuthors ? { feedbackAuthors } : {}) };
    const next = { ...this.cfg, projects: [...this.cfg.projects, p] };
    const problems = validateConfig(next);
    if (problems.length) throw Object.assign(new Error(problems.join('; ')), { status: 400 });
    await this.gh.ensureLabels(repo);
    this.cfg.projects.push(p); this._persist();
    return p;
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
