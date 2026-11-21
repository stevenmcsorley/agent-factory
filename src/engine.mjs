import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.mjs';
import { SAFE_GIT } from './gitguard.mjs';
import * as lb from './library.mjs';
import { fileURLToPath } from 'node:url';
import * as sc from './scenarios.mjs';
import { loadPlugins, readEnabled, discover as discoverPlugins } from './plugins.mjs';
import { getPrompt } from './prompts.mjs';
import { runSandboxed } from './jssandbox.mjs';
import crypto from 'node:crypto';
import { LIBRARY_README, PARTS_WORKFLOW, CHECK_PARTS } from './library-seed.mjs';
import { tick } from './factory.mjs';
import { feedbackTick } from './feedback.mjs';
import { buildTickets, identifySource, publicSources, SOURCES, TOKEN_ENV, ossiconeSignupInfo } from './sources.mjs';
import { flowMetrics } from './flow.mjs';
import { failingWorkflows, fetchBaseRuns } from './deploywatch.mjs';
import { buildHost, identifyHost, publicHosts, hostKind, HOSTS, validateHost } from './hosts.mjs';
import { initForge, forgeDir } from './adapters/host-local.mjs';
import { sandbox as makeSandbox } from './adapters/sandbox.mjs';
import { agents, codexExecArgs } from './adapters/agents.mjs';
import { LIMIT_FIELDS, LIMIT_DEFAULTS, MODEL_AGENTS, EFFORT_AGENTS, readCodexModels, validateAgentPatch, validateLimitsPatch, parseCodexHeader } from './settings.mjs';
import { gitVcs } from './adapters/vcs.mjs';
import { startEgress } from './egress.mjs';
import { spentToday, runsToday } from './budget.mjs';
import { validateConfig, saveConfig } from './config.mjs';
import { stateOf } from './ops.mjs';
import { normalizeRepo } from './repoRef.mjs';
import { analyzeRepo, profileSummary } from './analyze.mjs';
import * as pk from './pack.mjs';
import { checkBaseUrl } from './sources.mjs';
import { addHistory } from './quality.mjs';
import { cleanPatterns, DEFAULT_IGNORE } from './ignore.mjs';
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
    byRule: Object.fromEntries(Object.entries(q.byRule && typeof q.byRule === 'object' ? q.byRule : {}).slice(0, 40).map(([k, v]) => [t(k, 40), n(v)])), bySeverity: Object.fromEntries(['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'].map((k) => [k, n(q.bySeverity?.[k])])),
    findings: (Array.isArray(q.findings) ? q.findings : []).slice(0, 80).map((f) => ({ snippet: String(f?.snippet ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160), key: t(f?.key, 200), rule: t(f?.rule, 40), type: t(f?.type, 20), severity: ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'].includes(f?.severity) ? f.severity : 'INFO', file: t(f?.file, 120), line: n(f?.line), message: t(f?.message, 160) })) }; };
const sanitizeStructure = (st) => { if (!st || typeof st !== 'object') return null; const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1e7, Math.round(v))) : 0); const pth = (v) => String(v ?? '').replace(/[^\w./@+()-]/g, '').slice(0, 120);
  return { files: (Array.isArray(st.files) ? st.files : []).slice(0, 40).map((f) => ({ file: pth(f?.file), lines: n(f?.lines), lang: String(f?.lang ?? '').replace(/[^\w#+ -]/g, '').slice(0, 20), tested: f?.tested === true ? true : f?.tested === false ? false : null, findings: n(f?.findings) })), sourceFiles: n(st.sourceFiles), testedFiles: n(st.testedFiles), dirs: (Array.isArray(st.dirs) ? st.dirs : []).slice(0, 14).map((d) => ({ path: pth(d?.path), files: n(d?.files), lines: n(d?.lines), testLines: n(d?.testLines) })),
    untested: (Array.isArray(st.untested) ? st.untested : []).slice(0, 12).map((u) => ({ file: pth(u?.file), lines: n(u?.lines), key: `untested:${pth(u?.file)}:1` })) }; };
const sanitizeDuplicates = (d) => { if (!d || typeof d !== 'object') return null; const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1e7, Math.round(v))) : 0); const pth = (v) => String(v ?? '').replace(/[^\w./@+()-]/g, '').slice(0, 120); const loc = (x) => ({ file: pth(x?.file), start: n(x?.start), end: n(x?.end) });
  return { pct: Math.min(100, n(d.pct)), blocks: (Array.isArray(d.blocks) ? d.blocks : []).slice(0, 12).map((b) => ({ lines: n(b?.lines), a: loc(b?.a), b: loc(b?.b), key: `dup:${pth(b?.b?.file)}:${n(b?.b?.start)}` })) }; };
const sanitizeIgnored = (g) => { if (!g || typeof g !== 'object') return null; const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1e7, Math.round(v))) : 0); const pth = (v) => String(v ?? '').replace(/[^\w./@+()-]/g, '').slice(0, 120);
  return { defaults: n(g.defaults), yours: n(g.yours), folders: n(g.folders), useDefaults: g.useDefaults !== false, patterns: cleanPatterns(g.patterns).patterns, examples: (Array.isArray(g.examples) ? g.examples : []).slice(0, 8).map((x) => ({ path: pth(x?.path), why: x?.why === 'yours' ? 'yours' : 'default' })) }; };
const sanitizeFingerprints = (list) => (Array.isArray(list) ? list : []).slice(0, 330).map((f) => ({ ...(f?.kind === 'boilerplate' ? { kind: 'boilerplate' } : {}), file: String(f?.file ?? '').replace(/[^\w./@+()-]/g, '').slice(0, 120), lines: Math.max(0, Math.min(1e6, Math.round(Number(f?.lines) || 0))), exports: (Array.isArray(f?.exports) ? f.exports : []).slice(0, 12).map((x) => String(x).replace(/[^\w$]/g, '').slice(0, 60)).filter(Boolean),
  sig: (Array.isArray(f?.sig) ? f.sig : []).map((n) => Number(n) >>> 0) })).filter((f) => f.file && f.sig.length === 24);
const sanitizeProfile = (p) => { const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null); const arr = (v, n, m) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, m)).slice(0, n) : []);
  return { languages: arr(p.languages, 6, 30), packageManager: str(p.packageManager, 20), framework: str(p.framework, 30), verify: str(p.verify, 500), image: str(p.image, 80), verifyReason: str(p.verifyReason), tests: !!p.verify, hasRepoConfig: !!p.hasRepoConfig, hasReadme: !!p.hasReadme, ci: str(p.ci, 30),
    topLevel: arr(p.topLevel, 30, 41).map((x) => x.replace(/[^\w./@+-]/g, '')), metrics: sanitizeMetrics(p.metrics), quality: sanitizeQuality(p.quality), fingerprints: sanitizeFingerprints(p.fingerprints), ignored: sanitizeIgnored(p.ignored), structure: sanitizeStructure(p.structure), duplicates: sanitizeDuplicates(p.duplicates), notes: arr(p.notes, 8, 200), warnings: arr(p.warnings, 8, 200), analyzedAt: str(p.analyzedAt, 40) }; };

export class Engine {
  constructor(cfg, { configPath, env = process.env, factories = {}, github = { inspectRepo, ensureLabels, createProjectRepo, whoami } } = {}) {
    this.cfg = cfg; this.configPath = configPath; this.env = env; this.f = factories; this.gh = github;
    this.events = []; this.active = new Map(); this.outcomes = new Map();
    this.pluginReport = []; this.lanes = new Map(); this.jobs = new Map(); this.planJobs = new Map(); this._libCat = null; this._libPulledAt = 0;
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
    await this.loadPlugins().catch((e) => console.error(`plugins: ${e.message}`));
    const s = this.cfg.sandbox;
    if (s.kind === 'docker' && s.egress && !this.f.sandbox) this.egress = await (this.f.startEgress ?? startEgress)({ allow: s.egress.allow, image: s.image });
    this.deployFailures(false).catch(() => {});   // warm the post-merge pipeline check so the first Inbox visit does not wait on GitHub
  }
  async stopEgress() { await this.egress?.stop?.(); this.egress = null; }

  // Everything the core loop needs for one project, built fresh from config.
  deps(p) {
    const dir = this.projectDir(p);
    const log = path.join(dir, 'logs', `${new Date().toISOString().slice(0, 10)}.log`);
    const hostAdapter = this.f.hostAdapter?.(p) ?? buildHost(p, { stateDir: this.cfg.stateDir, env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec });
    const tickets = this.f.tickets?.(p) ?? buildTickets(p.tickets, { repo: p.repo, dir: this.projectDir(p), projectId: p.id, env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec });
    const sb = this.f.sandbox ?? makeSandbox({ ...this.cfg.sandbox, ...(this.egress ? { network: this.egress.network, extraEnv: this.egress.env } : {}), log });
    const a = this.cfg.agent;
    const agent = this.f.agent ?? agents[a.kind]({ ...a, image: this.cfg.sandbox.agentImage, log });
    const vcs = this.f.vcs ?? gitVcs({ log, openPr: (args) => hostAdapter.openPr({ repo: p.repo, ...args }), gitEnv: hostAdapter.gitEnv() });
    const host = this.f.host?.(p) ?? hostAdapter.pr; // the PR/MR feedback side
    const repos = p.allowedRepos?.length ? Object.fromEntries([p.repo, ...p.allowedRepos].map((r) => [r, { base: p.repoBases?.[r] ?? p.base }])) : undefined;
    // What the Code tab shows as "detected" must be what a run actually executes: analysis finds commands in sub-folders (backend/, api/) that a look at the repository root cannot.
    // Precedence stays: the repo's .agent-factory.json, then the project's own setting, then this detection, then root detection at run time.
    const detected = !p.config?.verify && p.profile?.verify ? { verify: p.profile.verify, ...(!p.config?.image && p.profile.image ? { image: p.profile.image } : {}) } : {};
    const config = { ...this.cfg.limits, ...detected, ...(p.config ?? {}), repo: p.repo, projectId: p.id, base: p.base, analysis: this._analysisCfg(p),
      contextFor: (t) => { try { const d = pk.packDir(this.cfg.stateDir, p.id); return [pk.renderContext(pk.loadPack(d), d, t), this._planContext(p, t), this._partsContext(p, t).text].filter(Boolean).join('\n\n'); } catch { return ''; } },
      materializeContext: (wsDir, t) => { const d = pk.packDir(this.cfg.stateDir, p.id); const pack = pk.loadPack(d); if (pack.brief && (Object.keys(pack.brief).length || pack.stack || pack.decisions || pack.sources.length)) pk.materialize(pack, d, wsDir); this._materializeParts(p, t, wsDir); },
      recordEvent: (ev) => this.recordEvent(p.id, ev.ticket, ev.event),
      briefRev: () => { const d = pk.packDir(this.cfg.stateDir, p.id); const pack = pk.loadPack(d); return pack.brief && (Object.keys(pack.brief).length || pack.stack || pack.decisions) ? pk.revision(pack) : undefined; },
      promptRules: () => getPrompt('task-rules', {}, this._promptDirs()),
      libraryParts: () => this._catalogNow().filter((x) => x.origin?.project !== p.id), recordParts: (wsDir, t) => this._recordParts(p, t, wsDir), profileSummary: profileSummary(p.profile), cloneUrl: hostAdapter.cloneUrl(p.repo), cloneUrlFor: (r) => hostAdapter.cloneUrl(r), prLink: (n) => hostAdapter.prUrl(p.repo, n), gitEnv: hostAdapter.gitEnv(), runsDir: this.cfg.stateDir, repos, onEvent: (e) => this._event(e) };
    return { tickets, host, sandbox: sb, agent, vcs, config, stateDir: dir };
  }

  async _exclusive(kind, fn) {
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    try { const r = await fn(); this.last[kind] = { at: new Date().toISOString(), results: r.length }; return r; } finally { this.busy = false; }
  }
  // Projects take turns by default; limits.parallelProjects (1 to 8) lets that many projects build at the same time, each in its own lane. Mind disk and the agent's rate limits.
  tickAll() { return this._exclusive('tick', async () => { const out = []; if (this.cfg.library?.remote && Date.now() - this._libPulledAt > 300_000) await this.libraryPull().catch(() => {}); await sc.advanceAll(this, this.scenarios()).catch(() => {});
    const queue = this.cfg.projects.filter((p) => !p.paused); const lanes = Math.max(1, Math.min(8, Number(this.cfg.limits.parallelProjects) || 1)); let next = 0;
    const lane = async () => { while (next < queue.length) { const p = queue[next++]; await this.releasePlan(p.id).catch(() => {}); const d = this.deps(p); this.lanes.set(p.id, Date.now()); try { out.push(...(await tick(d)).map((r) => ({ project: p.id, ...r }))); } finally { this.lanes.delete(p.id); } } };
    await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, lane)); return out; }); }
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
  // ---- lifecycle events (ready, claimed, pr-opened, parked, failed, closed): the raw material for flow metrics. Append-only, one line each.
  lifecycleEvents() { try { return fs.readFileSync(path.join(this.cfg.stateDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
  _evIndex() { if (!this._evIdx) { this._evIdx = new Map(); for (const e of this.lifecycleEvents()) this._evIdx.set(`${e.project}\u0000${e.ticket}`, e.event); } return this._evIdx; }
  recordEvent(project, ticket, event, at = new Date().toISOString()) {
    try { const idx = this._evIndex(); const k = `${project}\u0000${ticket}`; if (idx.get(k) === event) return false;           // a ticket sitting in the queue is "ready" once, not every minute
      fs.mkdirSync(this.cfg.stateDir, { recursive: true }); fs.appendFileSync(path.join(this.cfg.stateDir, 'events.jsonl'), `${JSON.stringify({ at, project, ticket: String(ticket), event })}\n`); idx.set(k, event); return true; } catch { return false; }     // metrics never break the loop
  }
  // A ticket we have followed that is now closed was accepted (merged, or closed by a human). Observed, so accurate to the polling interval, not the second.
  _observeClosed(project, list) { const idx = this._evIndex(); for (const t of list ?? []) if (t.state === 'CLOSED') { const last = idx.get(`${project}\u0000${t.id}`); if (last && last !== 'closed') this.recordEvent(project, t.id, 'closed'); } }
  flow({ days = 30, project } = {}) { return flowMetrics({ runs: this.runs({ limit: 100000 }).filter((r) => r.finished), events: this.lifecycleEvents(), days, project }); }
  metrics({ days = 14 } = {}) {
    const NEUTRAL = new Set(['needs-info', 'stopped', 'budget-exhausted', 'rate-limited', 'recovered-requeued', 'repo-not-allowed']);
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
    for (const r of runs) { const s = per[r.project]; if (!s) continue; s.runs++; if (r.status === 'ok') s.ok++; else if (!['needs-info', 'stopped', 'budget-exhausted', 'rate-limited', 'recovered-requeued'].includes(r.status)) s.failed++; s.lastRun ??= r; }
    const l = this.cfg.limits;
    return { demo: !!this.demo, paused: this.paused(), busy: this.busy, last: this.last, active: this.active.size, nextAt: this.nextAt ? new Date(this.nextAt).toISOString() : null, pollMs: this.pollMs ?? null, agent: this.cfg.agent.kind,
      today: { runs: runsToday(this.cfg.stateDir), maxRuns: l.maxRunsPerDay ?? null, costUsd: Number(spentToday(this.cfg.stateDir).toFixed(4)), maxCostUsd: l.dailyBudgetUsd ?? null },
      lanes: { parallel: Math.max(1, Math.min(8, Number(l.parallelProjects) || 1)), running: [...this.lanes.keys()] },
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
      const out = { id: p.id, repo: p.repo, base: p.base, paused: !!p.paused, host: hostKind(p), source: p.tickets.kind, repoUrl: this.repoUrl(p), verify: p.config?.verify ?? null, image: p.config?.image ?? null, profile: p.profile ?? null, ...(() => { const pack = pk.loadPack(pk.packDir(this.cfg.stateDir, p.id)); return { brief: pk.completeness(pack), plan: pack.plan ? { status: pack.plan.status, ...this.planProgress(pack.plan) } : null }; })(), verify: p.config?.verify ?? p.profile?.verify ?? null, queue: {}, prs: 0, metrics: m.projects[p.id] ?? null };
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
    for (const f of await this.deployFailures()) items.push({ ...f, id: `deploy-${f.runId}`, kind: 'deploy', state: 'failed', title: `${f.workflow} is failing on ${f.base}`, updatedAt: f.at });
    const rank = { deploy: 0, decision: 1, review: 2 };
    items.sort((a, b) => (a.kind === b.kind ? String(b.updatedAt).localeCompare(String(a.updatedAt)) : (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3)));
    return { items, errors, counts: { deploys: items.filter((i) => i.kind === 'deploy').length, decisions: items.filter((i) => i.kind === 'decision').length, reviews: items.filter((i) => i.kind === 'review').length } };
  }
  // What happens after a merge: workflows on a project's base branch whose latest finished run failed (see deploywatch.mjs). GitHub projects only, and a
  // project can opt out with deployWatch:false. Asking GitHub about every project takes seconds, and the UI polls, so this serves the last answer at once and
  // refreshes in the background when it is older than two minutes. Only the very first call waits (and only when `wait` is true). A GitHub or `gh` problem
  // for one project is not an Inbox item, so it is skipped quietly.
  async deployFailures(wait = true) {
    if (this.demo) return [];
    const stale = !this._deploy || Date.now() - this._deploy.at > 120_000;
    if (stale && !this._deployScan) this._deployScan = this._scanDeploys().then((v) => { this._deploy = { at: Date.now(), v }; }).catch(() => {}).finally(() => { this._deployScan = null; });
    if (!this._deploy && wait && this._deployScan) await this._deployScan;
    return this._deploy?.v ?? [];
  }
  async _scanDeploys() {
    const out = [];
    await Promise.all(this.cfg.projects.filter((p) => p.deployWatch !== false && p.repo && hostKind(p) === 'github').map(async (p) => {
      try { for (const f of failingWorkflows(await (this.f.baseRuns ?? fetchBaseRuns)(p.repo, p.base ?? 'main', this.f.exec))) out.push({ project: p.id, repo: p.repo, base: p.base ?? 'main', ...f }); } catch { /* skip */ }
    }));
    return out;
  }
  async inboxCount() { const ov = await this.overview(); let n = 0; for (const p of ov) n += (p.queue.review ?? 0) + (p.queue.failed ?? 0) + (p.queue['needs-info'] ?? 0) + (p.queue['needs-human'] ?? 0); n += (await this.deployFailures(false)).length; return { count: n }; }

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
    if (action === 'reopen') { if (typeof adapter.reopen !== 'function') throw bad('This tracker cannot reopen tickets from here; reopen it there'); await adapter.reopen(ticketId); this.cache.delete(`t:${projectId}`); return { reopened: true }; }
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

  async listTickets(id) { const p = this.project(id); return this.overlay(id, await this._cached(`t:${id}`, 15000, async () => { const list = await this.deps(p).tickets.listAgentTickets(); this._observeClosed(id, list); return list; })); }
  // The command that checks the agent's work (and the container image it runs in) for one project. Empty clears it, so detection applies again.
  // The repo's own .agent-factory.json still wins over this, as everywhere else.
  setVerify(id, { verify, image } = {}) {
    const p = this.project(id); const bad = (m) => Object.assign(new Error(m), { status: 400 }); const cfg = { ...(p.config ?? {}) };
    if (verify !== undefined) { const v = String(verify ?? '').trim(); if (/[\r\n\0]/.test(v)) throw bad('The test command must be one line (join steps with &&)'); if (v.length > 500) throw bad('The test command is too long (500 characters at most)'); if (v) cfg.verify = v; else delete cfg.verify; }
    if (image !== undefined) { const i = String(image ?? '').trim(); if (i && !/^[a-z0-9][a-z0-9._\/:@-]{0,199}$/i.test(i)) throw bad('That does not look like a container image name (for example python:3.12-bookworm)'); if (i) cfg.image = i; else delete cfg.image; }
    if (Object.keys(cfg).length) p.config = cfg; else delete p.config; this._persist(); return { verify: p.config?.verify ?? null, image: p.config?.image ?? null };
  }
  // ---- settings: the agent's model and reasoning effort, and a few guardrail limits. Applied from the next run; no restart.
  // Human actions only (UI and REST): these are deliberately NOT agent operations, so an agent cannot widen its own limits.
  settings() {
    const a = this.cfg.agent; const l = this.cfg.limits;
    const models = a.kind === 'codexContainer' ? readCodexModels(a.codexHome) : [];
    const limits = Object.fromEntries(Object.keys(LIMIT_FIELDS).map((k) => [k, l[k] ?? LIMIT_DEFAULTS[k] ?? null]));
    return { agent: { kind: a.kind, model: a.model ?? null, reasoningEffort: a.reasoningEffort ?? null, acceptsModel: MODEL_AGENTS.includes(a.kind), acceptsEffort: EFFORT_AGENTS.includes(a.kind), codexHome: a.codexHome ?? null, image: this.cfg.sandbox.agentImage },
      models, limits, limitFields: LIMIT_FIELDS, limitDefaults: LIMIT_DEFAULTS, probe: this._readProbe(), probing: !!this._probing, history: this._settingsHistory(8) };
  }
  setSettings(patch = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Send an object like { agent: { model }, limits: { maxRunsPerDay } }');
    const unknown = Object.keys(patch).filter((k) => !['agent', 'limits'].includes(k)); if (unknown.length) throw bad(`"${unknown[0]}" cannot be changed here`);
    const a = this.cfg.agent; const models = a.kind === 'codexContainer' ? readCodexModels(a.codexHome) : [];
    const ag = validateAgentPatch(patch.agent ?? {}, { kind: a.kind, models, current: { model: a.model ?? null } }); const lim = validateLimitsPatch(patch.limits ?? {});
    const errors = [...ag.errors, ...lim.errors]; if (errors.length) throw bad(errors.join('. '));
    const before = { agent: { model: a.model ?? null, reasoningEffort: a.reasoningEffort ?? null }, limits: this.settings().limits };
    for (const [k, v] of Object.entries(ag.value)) { if (v === null) delete a[k]; else a[k] = v; }
    for (const [k, v] of Object.entries(lim.value)) { if (v === null) delete this.cfg.limits[k]; else this.cfg.limits[k] = v; }
    const after = { agent: { model: a.model ?? null, reasoningEffort: a.reasoningEffort ?? null }, limits: this.settings().limits };
    const changes = {};
    for (const group of ['agent', 'limits']) for (const k of Object.keys(after[group])) if (before[group][k] !== after[group][k]) (changes[group] ??= {})[k] = { from: before[group][k], to: after[group][k] };
    if (Object.keys(changes).length) { this._persist(); this._audit({ what: 'settings', changes }); }
    return { ...this.settings(), changed: Object.keys(changes).length > 0, appliesTo: 'the next run' };
  }
  _audit(entry) { try { fs.appendFileSync(path.join(this.cfg.stateDir, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch { /* never block a change on its log */ } }
  _settingsHistory(n) { try { return fs.readFileSync(path.join(this.cfg.stateDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.what === 'settings').slice(-n).reverse(); } catch { return []; } }
  _readProbe() { try { return JSON.parse(fs.readFileSync(path.join(this.cfg.stateDir, 'agent-probe.json'), 'utf8')); } catch { return null; } }
  // Ask the agent container itself what it would use, with one tiny prompt: the only reliable answer when no model is pinned, because
  // Codex then picks its own default. Costs one small request on the subscription, so it only runs when the operator asks.
  async probeAgent() {
    const a = this.cfg.agent; const bad = (m, status = 400) => Object.assign(new Error(m), { status });
    if (a.kind !== 'codexContainer') throw bad('Checking the model is only available for the Codex agent');
    if (!a.codexHome || !fs.existsSync(path.join(a.codexHome, 'auth.json'))) throw bad('The Codex login is missing (agent.codexHome/auth.json)');
    if (this._probing) throw bad('A check is already running', 409);
    this._probing = true; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-probe-'));
    try {
      const sb = this.f.sandbox ?? makeSandbox({ ...this.cfg.sandbox, ...(this.egress ? { network: this.egress.network, extraEnv: this.egress.env } : {}) });
      if (sb.kind !== 'docker') throw bad('Checking the model needs the docker sandbox');
      const r = await sb.exec({ dir }, 'codex', codexExecArgs({ model: a.model, reasoningEffort: a.reasoningEffort, prompt: 'Reply with the single word ok and nothing else.', probe: true }),
        { timeoutMs: 120_000, image: this.cfg.sandbox.agentImage, mounts: [`${path.resolve(a.codexHome)}:/home/node/.codex`], env: { HOME: '/home/node' } });
      const info = parseCodexHeader(r.out);
      const result = { ok: r.code === 0 && !!info.model, ...info, configuredModel: a.model ?? null, configuredEffort: a.reasoningEffort ?? null, at: new Date().toISOString(),
        error: r.code === 0 && info.model ? null : String(r.out ?? '').split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) || 'The check did not return a model' };
      try { fs.writeFileSync(path.join(this.cfg.stateDir, 'agent-probe.json'), JSON.stringify(result)); } catch { /* shown once even if it cannot be saved */ }
      return result;
    } finally { this._probing = false; fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // ---- the local forge: review, merge and publish. Human actions only (UI, REST, CLI): none of these is an agent operation.
  _forge(p) { const a = this.f.hostAdapter?.(p) ?? buildHost(p, { stateDir: this.cfg.stateDir, env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec }); if (!a.forge) throw Object.assign(new Error('This project does not use the local forge'), { status: 400 }); return a; }
  prDetail(id, n) { return this._forge(this.project(id)).diff(n); }
  async prAction(id, n, action, body = {}) {
    const f = this._forge(this.project(id)); this.cache.delete(`p:${id}`);
    if (action === 'merge') return f.merge(n); if (action === 'close') return f.close(n); if (action === 'comment') return f.comment(n, body.text);
    throw Object.assign(new Error('Unknown action'), { status: 400 });
  }
  async setPublishTarget(id, { kind, repo: input, fields = {}, token }) {
    const p = this.project(id); this._forge(p); const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!['github', 'gitlab', 'bitbucket', 'git'].includes(kind)) throw bad('Publish to github, gitlab, bitbucket or git');
    const repo = this._repoFor(kind, input); const { token: _t, ...clean } = fields; const upper = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const target = { kind, repo, ...clean, ...(HOSTS[kind].fields.some((x) => x.secret) ? { tokenEnv: `AF_${upper}_PUBLISH_TOKEN` } : {}) };
    const problems = validateHost({ id, repo, host: target }); if (problems.length) throw bad(problems.join('; '));
    if (token && target.tokenEnv) this.saveSecret(target.tokenEnv, token);
    p.publish = target; this._persist(); return { publish: this.publishInfo(id) };
  }
  publishInfo(id) { const p = this.project(id); this._forge(p); return p.publish ? { kind: p.publish.kind, repo: p.publish.repo } : null; }
  _publishTarget(p) { if (!p.publish) throw Object.assign(new Error('Set a publish target first (where should this code go?)'), { status: 400 }); const t = buildHost({ id: p.id, repo: p.publish.repo, host: p.publish, tickets: p.tickets, feedbackAuthors: p.feedbackAuthors ?? [] }, { stateDir: this.cfg.stateDir, env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec }); return { remoteUrl: t.cloneUrl(p.publish.repo), gitEnv: t.gitEnv() }; }
  async publishStatus(id) { const p = this.project(id); const f = this._forge(p); if (!p.publish) return { target: null, open: f.list({ state: 'open' }).length }; const r = await f.ahead({ ...this._publishTarget(p), branch: p.base }); return { target: this.publishInfo(id), ...r, open: f.list({ state: 'open' }).length }; }
  async publish(id, { switchHost = false, feedbackAuthors } = {}) {
    const p = this.project(id); const f = this._forge(p); const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (switchHost && !(Array.isArray(feedbackAuthors) && feedbackAuthors.length)) throw bad('To switch this project to the published repository, say which usernames there may comment on pull requests (feedbackAuthors).');
    const t = this._publishTarget(p); const st = await f.ahead({ ...t, branch: p.base }); let r = { pushed: false, upToDate: true, sha: st.local };
    if (!st.upToDate) r = await f.publish({ ...t, branch: p.base });
    if (switchHost) { const { repo: newRepo, ...hostCfg } = p.publish; p.host = hostCfg; p.repo = newRepo; p.feedbackAuthors = feedbackAuthors.map(String); delete p.publish; this._persist(); this.cache.delete(`p:${id}`); r.switched = true; }
    return r;
  }
  repoUrl(p) { const k = hostKind(p); return k === 'github' ? `https://github.com/${p.repo}` : k === 'gitlab' ? `${(p.host.baseUrl ?? 'https://gitlab.com').replace(/\/$/, '')}/${p.repo}` : k === 'bitbucket' ? `https://bitbucket.org/${p.repo}` : null; }
  async listPrs(id) { const p = this.project(id); const h = this.f.hostAdapter?.(p) ?? buildHost(p, { stateDir: this.cfg.stateDir, env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec }); return (await this._cached(`p:${id}`, 15000, () => this.deps(p).host.listAgentPrs())).map((x) => ({ ...x, url: h.prUrl(p.repo, x.number) })); }
  async createTicket(id, { title, body, repo, epic }) {
    const p = this.project(id);
    if (!title || title.length > 200) throw Object.assign(new Error('title is required (max 200 chars)'), { status: 400 });
    this.cache.delete(`t:${id}`);
    return this.deps(p).tickets.create({ title, body: body ?? '', repo, epic });
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
  async _testHost({ kind, fields, token, repo }) { if (kind === 'local') return { user: 'you', defaultBranch: 'main', private: true, supportsPrs: true }; return kind === 'github' ? { ...(await this.gh.inspectRepo(repo)), user: await this.gh.whoami(), supportsPrs: true } : identifyHost({ kind, fields, token, repo, fetchImpl: this.f.fetch, exec: this.f.exec }); }
  signupInfo(baseUrl) { return ossiconeSignupInfo(baseUrl, this.f.fetch); }

  // Add a project. Any ticket source × any code host. Tokens arrive as `secret` (tickets) / `hostSecret` (code host), are verified
  // against the real service BEFORE anything is saved, are written only to the secrets file, and never appear in the config or any response.
  async addProject({ id, repo: repoInput, base, host, hostSecret, source, secret, tickets, config, allowedRepos, feedbackAuthors, profile, verify }) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    let importFrom; if (host?.kind === 'local') { importFrom = host.importFrom; host = { kind: 'local' }; const slug = String(repoInput || id || '').replace(/^local\//, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, ''); if (!slug) throw bad('Give the project a name'); repoInput = `local/${slug}`; }
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
    const hostInfo = hk === 'local' ? { defaultBranch: base || 'main', user: 'you', private: true } : hk === 'github' ? { ...(await this.gh.inspectRepo(repo)), user: await this.gh.whoami().catch(() => null) } : await identifyHost({ kind: hk, fields: hostFields, token: hostToken, repo, fetchImpl: this.f.fetch, exec: this.f.exec });
    // 2. ticket source
    let t = tickets, ticketToken;
    if (source) {
      const def = SOURCES[source.kind]; if (!def || def.hidden) throw bad(`Unsupported ticket source: ${source.kind}`);
      const { token: _s, pick, ...fields } = source.fields ?? {};
      const tokenEnv = ['github', 'local'].includes(source.kind) ? undefined : (source.tokenEnv ?? `AF_${upper}_TOKEN`);
      ticketToken = ['github', 'local'].includes(source.kind) ? undefined : (secret ?? this.env[tokenEnv]);
      const identity = await identifySource({ kind: source.kind, fields, token: ticketToken, whoami: this.gh.whoami, fetchImpl: this.f.fetch });
      const pickVal = source.pick !== undefined && def.pick?.type === 'number' ? Number(source.pick) : source.pick;
      t = { kind: source.kind, ...fields, ...(tokenEnv ? { tokenEnv } : {}), ...(def.pick ? { [def.pick.key]: pickVal } : {}), ...def.allow(identity) };
    }
    t ??= hk === 'local' ? { kind: 'local' } : hk === 'github' ? { kind: 'github', allowedAuthors: hostInfo.user ? [hostInfo.user] : [] } : null;
    if (!t) throw bad(`Choose where tickets live (GitHub Issues only works with a GitHub repo): Jira, Linear or Ossicone`);
    const p = { id, repo, base: base || hostInfo.defaultBranch, ...(hk !== 'github' ? { host: hostCfg } : {}), tickets: t, ...((config || verify) ? { config: { ...(config ?? {}), ...(verify ? { verify: String(verify).slice(0, 500) } : {}) } } : {}), ...(profile && typeof profile === 'object' ? (() => { const sp = sanitizeProfile(profile); sp.history = addHistory([], sp); return { profile: sp }; })() : {}), ...(allowedRepos ? { allowedRepos } : {}),
      ...((feedbackAuthors ?? (t.kind !== 'github' && hostInfo.user ? [hostInfo.user] : null)) ? { feedbackAuthors: feedbackAuthors ?? [hostInfo.user] } : {}) };
    const problems = validateConfig({ ...this.cfg, projects: [...this.cfg.projects, p] });
    if (problems.length) throw bad(problems.join('; '));
    // 3. side effects only after everything checked out
    if (hk === 'local') await initForge({ dir: forgeDir(this.cfg.stateDir, id), base: p.base, importFrom, exec: this.f.exec });
    if (hostSecret) this.saveSecret(hostCfg.tokenEnv, hostSecret);
    if (secret && t.tokenEnv) this.saveSecret(t.tokenEnv, secret);
    if (t.kind === 'github') await this.gh.ensureLabels(repo);
    this.cfg.projects.push(p); this._persist();
    return p;
  }
  // Shallow, read-only clone -> profile. Nothing is executed from the repo and nothing is persisted here.
  async _analyzeWith(hostAdapter, repo, base, { onPhase, onProfile, gate, ignore } = {}) {
    const sb = this.f.sandbox ?? makeSandbox({ ...this.cfg.sandbox, log: path.join(this.cfg.stateDir, 'analyze.log') });
    let ws;
    onPhase?.('cloning the repository');
    try {
      ws = await sb.create({ cloneUrl: hostAdapter.cloneUrl(repo), branch: 'analyze', base, newBranch: false, gitEnv: hostAdapter.gitEnv(), depth: 1 });
      onPhase?.('reading the code'); const profile = analyzeRepo(ws.dir, { gate, ignore: ignore?.ignore, ignoreDefaults: ignore?.ignoreDefaults }); onProfile?.(profile);
      return profile;
    } catch (e) { const m = String(e.message ?? e); if (/clone failed/.test(m) && /(Remote branch .* not found|empty|did not match)/i.test(m)) return { ...analyzeRepo(os.tmpdir() + '/__nonexistent__'), warnings: ['the base branch was not found or the repository is empty'], languages: [], topLevel: [] }; throw Object.assign(new Error(m.slice(0, 300)), { status: 400 }); }
    finally { try { ws?.destroy(); } catch { /* best effort */ } }
  }

  // "Queue a fix": turn one finding from the last scan into a normal ticket (it still goes through the usual pipeline and review).
  async findingTicket(id, key) {
    const p = this.project(id); const pr = p.profile ?? {}; const gone = () => Object.assign(new Error('That finding is not in the last analysis; re-analyze first'), { status: 404 });
    const tail = 'Keep the existing behaviour and tests passing, make the smallest correct change, and do not touch unrelated code.';
    const dup = pr.duplicates?.blocks?.find((x) => x.key === key);
    if (dup) return this.createTicket(id, { title: `Remove duplicated code in ${dup.b.file}`.slice(0, 120), body: `The same ${dup.lines} lines of code appear in ${dup.a.file} (lines ${dup.a.start}-${dup.a.end}) and ${dup.b.file} (lines ${dup.b.start}-${dup.b.end}). Move the shared logic into one function or module and use it from both places. ${tail}` });
    if (key.startsWith('big:')) { const f = pr.structure?.files?.find((x) => `big:${x.file}` === key); if (f) return this.createTicket(id, { title: `Split ${f.file} into smaller modules`.slice(0, 120), body: `${f.file} has ${f.lines} lines of code, which makes it hard to read and to change safely. Split it into a few smaller, well-named modules or functions along its natural boundaries, and update the imports. ${tail}` }); }
    const un = pr.structure?.untested?.find((x) => x.key === key);
    if (un) return this.createTicket(id, { title: `Add tests for ${un.file}`.slice(0, 120), body: `${un.file} (${un.lines} lines) has no test. Add focused tests that cover its current behaviour, using the repo's existing test setup. Do not change ${un.file} itself unless a test exposes a clear bug (then describe it). ${tail}` });
    const i = pr.quality?.findings?.find((x) => x.key === key); if (!i) throw gone();
    const where = `${i.file}${i.line ? `:${i.line}` : ''}`;
    return this.createTicket(id, { title: `Fix ${i.type.toLowerCase().replace('_', ' ')}: ${i.message}`.slice(0, 120), body: `The code quality scan reports ${i.rule} (${i.severity}) at ${where}: ${i.message}\n\nFix this finding. ${tail}` });
  }

  async analyzeDraft({ kind = 'github', fields = {}, token, repo: input, base }) {
    const repo = this._repoFor(kind, input); const env = { ...this.env }; const draft = { id: 'draft', repo, host: { kind, ...fields, tokenEnv: 'AF_DRAFT_GIT_TOKEN' } };
    if (token) env.AF_DRAFT_GIT_TOKEN = token; else if (fields.tokenEnv) env.AF_DRAFT_GIT_TOKEN = this.env[fields.tokenEnv];
    const hostAdapter = buildHost(draft, { stateDir: this.cfg.stateDir, env, fetchImpl: this.f.fetch, exec: this.f.exec });
    const baseBranch = base || (kind === 'github' ? (await this.gh.inspectRepo(repo)).defaultBranch : (await this._testHost({ kind, fields, token, repo })).defaultBranch);
    return { repo, base: baseBranch, profile: await this._analyzeWith(hostAdapter, repo, baseBranch, { ignore: this._analysisCfg(null) }) };
  }
  // Ignore rules = built-in defaults + global (limits.analysis) + this project's own (config.analysis); the repo's .agent-factory.json is added when the repo is read.
  _analysisCfg(p) { const g = this.cfg.limits.analysis ?? {}, q = p?.config?.analysis ?? {}; return { ignore: cleanPatterns([...(g.ignore ?? []), ...(q.ignore ?? [])]).patterns, ignoreDefaults: g.ignoreDefaults !== false && q.ignoreDefaults !== false }; }
  async setIgnore(id, { patterns, useDefaults } = {}) {
    const p = this.project(id); const { patterns: clean, dropped } = cleanPatterns(patterns);
    if (dropped.length) throw Object.assign(new Error(`These patterns are not allowed: ${dropped.join(', ')}. Use plain names and globs like *.sql, docs/*.md, generated/ (no .., no !, no ;).`), { status: 400 });
    p.config = { ...(p.config ?? {}), analysis: { ...(p.config?.analysis ?? {}), ignore: clean, ...(useDefaults === false ? { ignoreDefaults: false } : { ignoreDefaults: undefined }) } }; if (p.config.analysis.ignoreDefaults === undefined) delete p.config.analysis.ignoreDefaults;
    this._persist(); return this.startAnalysis(id);
  }
  // Re-analysis is a background job (a big repository takes a few seconds): start it, then poll analysisJob().
  startAnalysis(id) {
    this.project(id); const cur = this.jobs.get(id); if (cur?.state === 'running') return cur;
    const job = { state: 'running', phase: 'starting', startedAt: Date.now() }; this.jobs.set(id, job);
    this.analyzeProject(id, { onPhase: (ph) => { job.phase = ph; } }).then(() => { job.state = 'done'; job.phase = ''; job.finishedAt = Date.now(); })
      .catch((e) => { job.state = 'error'; job.error = String(e.message ?? e).slice(0, 300); job.finishedAt = Date.now(); });
    return job;
  }
  analysisJob(id) { this.project(id); return this.jobs.get(id) ?? { state: 'idle' }; }
  async analyzeProject(id, { onPhase } = {}) {
    const p = this.project(id); const hostAdapter = this.f.hostAdapter?.(p) ?? buildHost(p, { stateDir: this.cfg.stateDir, env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec });
    const prevHistory = p.profile?.history;
    const profile = await this._analyzeWith(hostAdapter, p.repo, p.base, { gate: this.cfg.limits.qualityRepoGate, ignore: this._analysisCfg(p), onPhase, onProfile: (pr) => { const { chunks, ...rest } = pr; this._saveChunks(p.id, chunks); p.profile = { ...rest, history: prevHistory ?? [] }; this._persist(); } });
    profile.history = addHistory(prevHistory, profile);
    p.profile = profile; this._persist(); return p.profile;
  }
  // Brief, sources and (optionally) a plan request supplied when a project is created or added.
  async _seedPack(id, { brief, stack, decisions, sources, plan } = {}) {
    if (!brief && !stack && !decisions && !sources?.length) return {};
    this.setPack(id, { brief, stack, decisions }); for (const s of sources ?? []) this.addSource(id, s);
    const out = { pack: pk.completeness(pk.loadPack(this._packDir(id))) };
    if (plan) { try { out.planning = this.startPlanning(id); } catch (e) { out.planningError = e.message; } }
    return out;
  }
  // ---------------------------------------------------------------- Project Pack: brief, sources, plan
  _packDir(id) { this.project(id); return pk.packDir(this.cfg.stateDir, id); }
  getPack(id) {
    const dir = this._packDir(id); const pack = pk.loadPack(dir);
    return { ...pack, completeness: pk.completeness(pack), fields: pk.BRIEF_FIELDS.map(([key, label, hint]) => ({ key, label, hint })), kinds: pk.SOURCE_KINDS, job: this.planJobs.get(id) ?? { state: 'idle' } };
  }
  setPack(id, patch = {}) { pk.patchPack(this._packDir(id), patch); return this.getPack(id); }
  addSource(id, a = {}) {
    const dir = this._packDir(id); const base = { title: a.title, kind: a.kind };
    if (a.url) pk.addSourceLink(dir, { ...base, url: a.url });
    else if (typeof a.text === 'string') pk.addSourceText(dir, { ...base, text: a.text });
    else if (a.dataBase64 && a.filename) { if (a.dataBase64.length > 8_000_000) throw Object.assign(new Error('That file is too large'), { status: 413 }); pk.addSourceFile(dir, { ...base, filename: a.filename, data: Buffer.from(a.dataBase64, 'base64') }); }
    else throw Object.assign(new Error('Give a url, some text, or a file'), { status: 400 });
    return this.getPack(id);
  }
  removeSource(id, sid) { pk.removeSource(this._packDir(id), sid); return this.getPack(id); }
  sourceFile(id, sid) { const dir = this._packDir(id); const s = pk.loadPack(dir).sources.find((x) => x.id === sid); if (!s?.file) throw Object.assign(new Error('No such file'), { status: 404 }); return { type: s.type, name: s.file, data: fs.readFileSync(path.join(dir, 'sources', path.basename(s.file))) }; }

  // Planning is a background job: the agent reads the brief and returns epics and tickets for you to review.
  startPlanning(id) {
    const dir = this._packDir(id); const pack = pk.loadPack(dir); const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (this.planJobs.get(id)?.state === 'running') return this.planJobs.get(id);
    if (pack.plan && pack.plan.status !== 'proposed') throw bad('This plan is already launched, so its tickets exist. Add new work as tickets, or edit the brief for future runs.');
    if (!pk.completeness(pack).ready) throw bad('Fill in at least the Goal and In scope first (Brief tab)');
    const job = { state: 'running', phase: 'starting', startedAt: Date.now() }; this.planJobs.set(id, job);
    this.planProject(id, { onPhase: (ph) => { job.phase = ph; } }).then(() => { job.state = 'done'; job.phase = ''; })
      .catch((e) => { job.state = 'error'; job.error = String(e.message ?? e).slice(0, 400); }).finally(() => { job.finishedAt = Date.now(); });
    return job;
  }
  async planProject(id, { onPhase } = {}) {
    const p = this.project(id); const dir = this._packDir(id); const pack = pk.loadPack(dir); const d = this.deps(p);
    onPhase?.('cloning the repository'); let ws;
    try {
      ws = await d.sandbox.create({ cloneUrl: d.config.cloneUrl, branch: 'plan', base: p.base, newBranch: false, gitEnv: d.config.gitEnv, depth: 1 });
      pk.materialize(pack, dir, ws.dir); onPhase?.('the agent is reading your brief and planning (a few minutes)');
      const ask = async (prompt) => d.agent.run(d.sandbox, ws, prompt, { timeoutMs: this.cfg.limits.timeoutMs ?? 900000 });
      let raw = pk.extractJson((await ask(pk.planPrompt(pack))).out);
      if (!raw) { onPhase?.('asking again for a clean plan'); raw = pk.extractJson((await ask(`${pk.planPrompt(pack)}\nYour previous answer was not valid JSON. Reply with ONLY the JSON object.`)).out); }
      const plan = pk.normalizePlan(raw, { sourceIds: pack.sources.map((x) => x.id) });
      const fresh = pk.loadPack(dir); fresh.plan = plan; pk.savePack(dir, fresh); return plan;
    } finally { try { ws?.destroy(); } catch { /* best effort */ } }
  }
  // You can edit the proposed plan (retitle, reword, remove tickets, change dependencies) before launching it.
  editPlan(id, { epics, summary } = {}) {
    const dir = this._packDir(id); const pack = pk.loadPack(dir); const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!pack.plan) throw bad('There is no plan yet'); if (pack.plan.status !== 'proposed') throw bad('A launched plan cannot be edited');
    const next = pk.normalizePlan({ summary: summary ?? pack.plan.summary, epics }, { sourceIds: pack.sources.map((x) => x.id) }); next.createdAt = pack.plan.createdAt; pack.plan = next; pk.savePack(dir, pack); return this.getPack(id);
  }
  discardPlan(id) { const dir = this._packDir(id); const pack = pk.loadPack(dir); if (pack.plan && pack.plan.status !== 'proposed') throw Object.assign(new Error('A launched plan cannot be discarded'), { status: 400 }); pack.plan = null; pk.savePack(dir, pack); return this.getPack(id); }
  async launchPlan(id) {
    const dir = this._packDir(id); const pack = pk.loadPack(dir); const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!pack.plan) throw bad('There is no plan to launch'); if (pack.plan.status !== 'proposed') throw bad('This plan is already launched');
    pack.plan.status = 'launched'; pack.plan.launchedAt = new Date().toISOString();
    // If the tracker supports epics (Ossicone, Jira), the plan's structure goes there too, so people and the AI see the same picture.
    const adapter = this.deps(this.project(id)).tickets;
    if (typeof adapter.createEpic === 'function') for (const e of pack.plan.epics) { if (e.trackerId) continue; try { const r = await adapter.createEpic({ title: e.title, body: `${e.goal || ''}\n\nTickets in this epic:\n${e.tickets.map((t) => `- ${t.title}`).join('\n')}\n\n(Created by Agent Factory from the project plan.)`.trim() }); e.trackerId = String(r?.id ?? ''); e.trackerUrl = r?.url; } catch (err) { e.trackerError = String(err.message ?? err).slice(0, 200); } }
    pk.savePack(dir, pack);
    await this.releasePlan(id); return this.getPack(id);
  }
  // Keep plan ticket statuses in step with the tracker: planned -> queued/working/review -> done (closed).
  async syncPlan(id) {
    const dir = this._packDir(id); const pack = pk.loadPack(dir); if (pack.plan?.status !== 'launched') return pack;
    // fresh read: dependents are released the moment a ticket closes
    this.cache.delete(`t:${id}`); const live = await this.listTickets(id).catch(() => null); if (!live) return pack; const byId = new Map(live.map((t) => [String(t.id), t])); let changed = false;
    for (const e of pack.plan.epics) for (const t of e.tickets) {
      if (!t.ticketId) continue; const tk = byId.get(String(t.ticketId)); if (!tk) continue;
      const next = tk.state === 'CLOSED' ? 'done' : stateOf(tk.labels); const status = next === 'ready' ? 'queued' : next; if (t.status !== status || t.url !== tk.url) { t.status = status; t.url = tk.url ?? t.url; changed = true; }
    }
    if (pack.plan.epics.every((e) => e.tickets.every((t) => t.status === 'done')) && pack.plan.status !== 'complete') { pack.plan.status = 'complete'; changed = true; }
    if (changed) pk.savePack(dir, pack); return pack;
  }
  // A ticket is created only when everything it depends on is done (merged and closed), so each one builds on real code.
  async releasePlan(id) {
    const dir = this._packDir(id); let pack = pk.loadPack(dir); if (pack.plan?.status !== 'launched') return { released: 0 };
    pack = await this.syncPlan(id); if (pack.plan?.status !== 'launched') return { released: 0 };
    const all = pk.planTickets(pack.plan); const done = new Set(all.filter((t) => t.status === 'done').map((t) => t.id)); let released = 0;
    for (const e of pack.plan.epics) for (const t of e.tickets) {
      if (t.status !== 'planned' || !t.dependsOn.every((d) => done.has(d))) continue;
      const res = await this.createTicket(id, { title: t.title, body: pk.ticketBody(t, e), epic: e.trackerId || undefined });
      t.status = 'queued'; t.url = res?.url; t.ticketId = res?.id ?? (res?.url ? /([\w-]+)$/.exec(res.url)?.[1] : undefined); t.queuedAt = new Date().toISOString(); released++;
    }
    if (released) pk.savePack(dir, pack); return { released };
  }
  planProgress(plan) { const all = pk.planTickets(plan); const n = (s) => all.filter((t) => t.status === s).length; return { total: all.length, planned: n('planned'), queued: n('queued'), working: n('working'), review: n('review'), done: n('done'), failed: n('failed') + n('needs-info') }; }
  async getPlan(id) { const pack = await this.syncPlan(id); return { plan: pack.plan, progress: pack.plan ? this.planProgress(pack.plan) : null, job: this.planJobs.get(id) ?? { state: 'idle' } }; }

  // Publish the pack into the repo as a reviewable PR under .factory/ (the factory's copy stays the working copy).
  async publishPack(id) {
    const p = this.project(id); const dir = this._packDir(id); const pack = pk.loadPack(dir); const d = this.deps(p); const branch = `factory/project-pack-${Date.now().toString(36)}`; let ws;
    try {
      ws = await d.sandbox.create({ cloneUrl: d.config.cloneUrl, branch, base: p.base, gitEnv: d.config.gitEnv, depth: 1 });
      for (const [rel, content] of pk.publishFiles(pack, dir)) { const full = path.join(ws.dir, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); }
      if (!(await d.vcs.diffStat(ws))) return { published: false, message: 'The repository already has the latest pack.' };
      await d.vcs.commitAndPush(ws, { branch, message: 'Project pack: brief, conventions, sources and plan (.factory/)' });
      const url = await d.vcs.openPr(ws, { branch, base: p.base, repo: p.repo, title: 'Project pack: brief, conventions, sources and plan', body: 'Published by Agent Factory. Adds `.factory/` so the brief, conventions, decisions, source material and plan are versioned with the code and readable by any agent or teammate. Review and merge, or edit.' });
      const fresh = pk.loadPack(dir); fresh.publishedAt = new Date().toISOString(); fresh.publishedPr = url ?? branch; pk.savePack(dir, fresh); return { published: true, pr: url ?? branch };
    } finally { try { ws?.destroy(); } catch { /* best effort */ } }
  }
  // One row per project: the whole picture at a glance (used by the portfolio page, the CLI and MCP).
  async portfolio() {
    const ov = await this.overview(); const m = this.metrics(); const ready = Object.fromEntries(await Promise.all(ov.map(async (o) => [o.id, await this.readiness(o.id).catch(() => null)])));
    return ov.map((o) => { const dir = pk.packDir(this.cfg.stateDir, o.id); const pack = pk.loadPack(dir); const pr = o.profile;
      return { id: o.id, repo: o.repo, paused: o.paused, queue: o.queue, openPrs: o.prs, error: o.error ?? null, runs: o.metrics ? { total: o.metrics.runs, shipped: o.metrics.ok } : null,
        brief: pk.completeness(pack), plan: pack.plan ? { status: pack.plan.status, ...this.planProgress(pack.plan) } : null, target: this.project(o.id).target ?? 'prototype', readiness: ready[o.id] ? { passed: ready[o.id].passed, total: ready[o.id].total, ready: ready[o.id].ready, checks: ready[o.id].checks } : null, publishedToRepo: !!pack.publishedAt, partsUsed: [...new Set(this._usage().entries.filter((u) => u.project === o.id).map((u) => u.slug))], sources: pack.sources.length,
        quality: pr?.quality ? { gate: pr.quality.gate?.status ?? 'NONE', findings: pr.quality.counts?.total ?? 0, secrets: pr.quality.counts?.secrets ?? 0 } : null, tests: pr?.structure ? `${pr.structure.testedFiles}/${pr.structure.sourceFiles}` : null, copiedPct: pr?.duplicates?.pct ?? null, verify: pr?.verify ?? null, verification: this.project(o.id).config?.verify ? 'set' : pr?.verify ? 'detected' : pr ? 'none' : 'unknown', verifyCmd: this.project(o.id).config?.verify ?? pr?.verify ?? null }; });
  }

  // ================================================================ Reuse library
  _lib() { const c = this.cfg.library; if (!c?.remote) throw Object.assign(new Error('There is no reuse library yet. Create one (Library page) or connect an existing repo.'), { status: 400 }); return { base: 'main', ...c }; }
  _libDir() { return path.join(this.cfg.stateDir, 'library', 'repo'); }
  async _git(args, { cwd } = {}) { const r = await run('git', [...SAFE_GIT, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); if (r.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} failed: ${r.out.replace(/Authorization: [^\s]+/g, 'Authorization: ***').trim().slice(0, 300)}`); return r.out; }
  async _gh(args) { const r = await (this.f.gh ?? ((a) => run('gh', a)))(args); if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(r.out).trim().slice(0, 300)}`); return r.out; }
  async _identity() { const login = await this.gh.whoami().catch(() => 'agent-factory'); return ['-c', `user.name=${login}`, '-c', `user.email=${login}@users.noreply.github.com`]; }
  _catalogNow() { if (this._libCat) return this._libCat; try { this._libCat = this.cfg.library?.remote && fs.existsSync(path.join(this._libDir(), '.git')) ? lb.readCatalog(this._libDir()) : []; } catch { this._libCat = []; } return this._libCat; }
  async libraryPull() {
    const c = this._lib(); const dir = this._libDir(); fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) { fs.rmSync(dir, { recursive: true, force: true }); await this._git(['clone', '--depth', '20', '--branch', c.base, c.remote, dir]); }
    else { await this._git(['fetch', '--depth', '20', 'origin', c.base], { cwd: dir }); await this._git(['reset', '--hard', `origin/${c.base}`], { cwd: dir }); }
    this._libCat = null; this._libPulledAt = Date.now(); return this._catalogNow();
  }
  async libraryStatus() {
    const c = this.cfg.library; if (!c?.remote) return { configured: false };
    const cat = this._catalogNow(); const usage = this._usage().entries;
    return { configured: true, repo: c.repo ?? null, remote: /^https?:/.test(c.remote) ? c.remote.replace(/\/\/[^@/]*@/, '//') : c.remote, base: c.base ?? 'main', parts: cat.length, tested: cat.filter((p) => p.tested).length, pulledAt: this._libPulledAt ? new Date(this._libPulledAt).toISOString() : null, uses: usage.length, url: c.repo ? `https://github.com/${c.repo}` : null };
  }
  _seedFiles(name) { return new Map([['README.md', LIBRARY_README(name)], ['.github/workflows/parts.yml', PARTS_WORKFLOW], ['scripts/check-parts.mjs', CHECK_PARTS], ['parts/.gitkeep', '']]); }
  async _pushSeed(remote, name, base = 'main') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-libseed-')); try {
      await this._git(['clone', remote, tmp]); await this._git(['checkout', '-B', base], { cwd: tmp });
      for (const [rel, content] of this._seedFiles(name)) { const full = path.join(tmp, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); }
      await this._git(['add', '-A'], { cwd: tmp }); await this._git([...(await this._identity()), 'commit', '-m', 'Start the reuse library (Agent Factory)'], { cwd: tmp }); await this._git(['push', '-u', 'origin', base], { cwd: tmp });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  // Create a new, private library repo on GitHub with the structure and CI check, and connect it.
  async libraryInit({ name = 'factory-library', visibility = 'private' } = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 }); if (this.cfg.library?.remote) throw bad('A library is already connected');
    if (!/^[\w.-]{1,80}$/.test(name)) throw bad('Repository name may only contain letters, numbers, dots, dashes and underscores'); if (!['private', 'public'].includes(visibility)) throw bad('visibility must be private or public');
    const owner = await this.gh.whoami(); const repo = `${owner}/${name}`; await this._gh(['repo', 'create', repo, `--${visibility}`, '--description', 'Reusable parts managed by Agent Factory']);
    const remote = this.f.libraryRemote?.(repo) ?? `https://github.com/${repo}.git`; await this._pushSeed(remote, name);
    this.cfg.library = { repo, remote, base: 'main' }; this._persist(); await this.libraryPull(); return this.libraryStatus();
  }
  async libraryConnect({ repo, remote, base = 'main' } = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 }); if (!repo && !remote) throw bad('Give a repository (owner/name) or a clone URL');
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw bad('Repository must look like owner/name'); const url = remote ?? `https://github.com/${repo}.git`;
    if (!/^(https:\/\/|ssh:\/\/|git@|\/)/.test(url) || /[\s"'`;|&$<>]/.test(url)) throw bad('That does not look like a git remote'); if (!/^[\w./-]{1,60}$/.test(base)) throw bad('Invalid branch name');
    const prev = this.cfg.library; this.cfg.library = { ...(repo ? { repo } : {}), remote: url, base };
    try { try { await this.libraryPull(); } catch (e) { if (!/not found|empty|did not match|Remote branch/i.test(e.message)) throw e; await this._pushSeed(url, repo?.split('/')[1] ?? 'library', base); fs.rmSync(this._libDir(), { recursive: true, force: true }); await this.libraryPull(); } }
    catch (e) { if (prev) this.cfg.library = prev; else delete this.cfg.library; throw bad(`Could not reach that library: ${e.message}`); }
    this._persist(); return this.libraryStatus();
  }
  libraryDisconnect() { delete this.cfg.library; this._libCat = null; this._persist(); return { configured: false }; }
  async libraryList() { if (!this.cfg.library?.remote) throw this._lib(); if (!this._libPulledAt) await this.libraryPull().catch(() => {}); const use = this._usage().entries; return this._catalogNow().map((p) => ({ ...lb.publicPart(p), usedBy: [...new Set(use.filter((u) => u.slug === p.slug).map((u) => u.project))] })); }
  async librarySearch(query, { project, limit = 8 } = {}) { this._lib(); const stack = project ? (this.project(project).profile?.languages ?? []) : []; if (!this._libPulledAt && this.cfg.library?.remote) await this.libraryPull().catch(() => {}); return lb.searchCatalog(this._catalogNow(), query, { stack, limit }).map((r) => ({ ...lb.publicPart(r.part), score: r.score, why: r.why })); }
  libraryPart(slug) { this._lib(); return { ...lb.readPart(this._libDir(), slug), usedBy: this._usage().entries.filter((u) => u.slug === lb.slugify(slug)) }; }

  // Repeated code across (and within) your projects, from the fingerprints stored with each analysis; marks what the library already has.
  // Function-level fingerprints live next to the project's state, not in the config file (hundreds per project).
  _saveChunks(id, chunks) { try { const f = path.join(this.projectDir(this.project(id)), 'chunks.json'); fs.writeFileSync(`${f}.tmp`, JSON.stringify({ at: new Date().toISOString(), chunks: Array.isArray(chunks) ? chunks.slice(0, 500) : [] })); fs.renameSync(`${f}.tmp`, f); } catch { /* optional data: never blocks an analysis */ } }
  _loadChunks(id) { try { const j = JSON.parse(fs.readFileSync(path.join(this.cfg.stateDir, 'projects', id, 'chunks.json'), 'utf8')); return (Array.isArray(j.chunks) ? j.chunks : []).filter((c) => c && c.kind === 'chunk' && Array.isArray(c.sig) && c.sig.length === 24); } catch { return []; } }
  libraryCandidates() {
    const prints = {}; for (const p of this.cfg.projects) { const all = [...(p.profile?.fingerprints ?? []), ...this._loadChunks(p.id)]; if (all.length) prints[p.id] = all; } const cat = this._catalogNow();
    return lb.candidates(prints).map((c) => { const hit = c.locations.map((l) => { const fp = prints[l.project]?.find((f) => f.file === l.file && (l.name ? f.name === l.name : !f.name)); let best = null; for (const part of cat) for (const pr of part.prints) { const s = fp ? lb.similarity(fp.sig, pr.sig) : 0; if (s >= 0.6 && (!best || s > best.s)) best = { s, slug: part.slug }; } return best; }).find(Boolean);
      return { ...c, inLibrary: hit?.slug ?? null }; });
  }
  async _projectFiles(p, paths, { withTests = true } = {}) {
    const d = this.deps(p); const ws = await d.sandbox.create({ cloneUrl: d.config.cloneUrl, branch: 'promote', base: p.base, newBranch: false, gitEnv: d.config.gitEnv, depth: 1 }); const bad = (m) => Object.assign(new Error(m), { status: 400 });
    try {
      const want = [...new Set((Array.isArray(paths) ? paths : []).map((x) => String(x).replace(/^\.?\//, '')))]; if (!want.length || want.length > 12) throw bad('Pick between 1 and 12 files');
      const read = (rel) => { if (rel.includes('..') || rel.startsWith('.git/') || path.isAbsolute(rel)) throw bad(`Not allowed: ${rel}`); const full = path.join(ws.dir, rel); const st = fs.lstatSync(full, { throwIfNoEntry: false }); if (!st?.isFile() || st.isSymbolicLink()) throw bad(`No such file in ${p.id}: ${rel}`); if (st.size > 200_000) throw bad(`${rel} is too large for a part (200 KB max)`); return { rel, content: fs.readFileSync(full, 'utf8') }; };
      const files = want.map(read);
      if (withTests) { const base = (r) => path.basename(r).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[._-](test|spec)$|^test[_-]/g, ''); const names = new Set(files.map((f) => base(f.rel)));
        const walk = (dir, depth = 0, acc = []) => { if (depth > 6 || acc.length > 3000) return acc; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (['.git', 'node_modules', 'dist', 'build'].includes(e.name) || e.isSymbolicLink()) continue; const f = path.join(dir, e.name); e.isDirectory() ? walk(f, depth + 1, acc) : acc.push(path.relative(ws.dir, f)); } return acc; };
        for (const rel of walk(ws.dir)) if (/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|^test_.*\.py$/i.test(rel) && names.has(base(rel)) && !files.some((f) => f.rel === rel)) { try { files.push(read(rel)); } catch { /* skip unreadable test */ } } }
      return files;
    } finally { try { ws.destroy(); } catch { /* best effort */ } }
  }
  // Turn files from a project into a library part and open a PR in the library (or push straight to it with direct:true).
  async promotePart({ project, files, name, kind, summary, tags, usage, withTests, direct = false, note } = {}) {
    const c = this._lib(); const p = this.project(project); await this.libraryPull().catch(() => {});
    const picked = await this._projectFiles(p, files, { withTests }); const slug = lb.slugify(name); const existing = this._catalogNow().find((x) => x.slug === slug);
    const built = lb.buildPart({ name, kind, summary, tags, usage, files: picked, existing, note, origin: { project: p.id, repo: p.repo, base: p.base, files: picked.map((f) => f.rel) } });
    if (existing) { const cur = lb.readPart(this._libDir(), existing.slug); const key = (list) => JSON.stringify(list.sort((a, b) => a[0].localeCompare(b[0])));
      const old = cur.files.map((f) => [f.path, f.content]); const now = [...built.files].filter(([rel]) => !/\/(part\.json|README\.md)$/.test(rel)).map(([rel, c]) => [rel.replace(`parts/${existing.slug}/`, ''), c]);
      if (key(old) === key(now) && !summary && !tags && !usage && !kind) return { part: lb.publicPart({ ...existing, prints: [] }), changed: false, message: 'The library already has exactly this.' }; }
    const m = built.meta; const verb = existing ? `Update ${m.slug} to ${m.version}` : `Add ${m.slug} ${m.version}`;
    const out = await this._libPropose({ branch: `part/${m.slug}-${m.version}-${Date.now().toString(36)}`, files: built.files, message: `${verb} (from ${p.id})`, title: `${verb}`, body: `${existing ? 'Updates' : 'Adds'} the **${m.name}** part (${m.kind}), extracted from \`${p.repo}\` by Agent Factory.\n\n${m.summary || ''}\n\nExports: ${m.exports.map((e) => `\`${e.signature || e.name}\``).join(', ') || 'n/a'}\nFiles: ${m.files.map((f) => `\`${f.path}\``).join(', ')}${note ? `\n\nNote: ${note}` : ''}`, direct });
    return { part: lb.publicPart({ ...m, prints: [] }), ...out };
  }
  async _libPropose({ branch, files, message, title, body, direct }) {
    const c = this._lib(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-lib-'));
    try {
      await this._git(['clone', '--depth', '1', '--branch', c.base, c.remote, tmp]); if (!direct) await this._git(['checkout', '-b', branch], { cwd: tmp });
      for (const [rel, content] of files) { const full = path.join(tmp, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); }
      await this._git(['add', '-A'], { cwd: tmp }); if (!(await this._git(['status', '--porcelain'], { cwd: tmp })).trim()) return { changed: false, message: 'The library already has exactly this.' };
      await this._git([...(await this._identity()), 'commit', '-m', message], { cwd: tmp }); await this._git(['push', 'origin', direct ? c.base : branch], { cwd: tmp });
      if (direct) { await this.libraryPull().catch(() => {}); return { changed: true, direct: true }; }
      let pr = null; if (c.repo) { try { pr = (await this._gh(['pr', 'create', '-R', c.repo, '--head', branch, '--base', c.base, '--title', title, '--body', body])).trim().split('\n').pop(); } catch (e) { return { changed: true, branch, prError: e.message }; } }
      return { changed: true, branch, pr };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // ---- Profiles: a house style (theme, patterns, forms, skills, conventions) a project starts from. The agent always gets its parts and conventions.
  async libraryProfiles() { this._lib(); if (!this._libPulledAt) await this.libraryPull().catch(() => {}); const cat = this._catalogNow(); return lb.readProfiles(this._libDir()).map((pf) => ({ ...pf, partsInfo: pf.parts.map((s) => { const x = cat.find((c) => c.slug === s); return x ? { slug: s, kind: x.kind, name: x.name } : { slug: s, missing: true }; }), usedBy: this.cfg.projects.filter((p) => p.styleProfile === pf.slug).map((p) => p.id) })); }
  async saveProfile({ name, description, parts, conventions, stack, direct = false } = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 }); this._lib(); await this.libraryPull().catch(() => {}); const pf = lb.cleanProfile({ name, description, parts, conventions, stack });
    const have = new Set(this._catalogNow().map((c) => c.slug)); const unknown = pf.parts.filter((s) => !have.has(s)); if (unknown.length) throw bad(`These parts are not in the library: ${unknown.join(', ')}`);
    const out = await this._libPropose({ branch: `profile/${pf.slug}-${Date.now().toString(36)}`, files: new Map([[`profiles/${pf.slug}.json`, `${JSON.stringify(pf, null, 2)}\n`]]), message: `Profile: ${pf.name}`, title: `Profile: ${pf.name}`, body: `${pf.description || 'A house style for new projects.'}\n\nParts: ${pf.parts.join(', ') || 'none'}`, direct }); return { profile: pf, ...out };
  }
  setProjectProfile(id, slug) { const p = this.project(id); if (slug) { const pf = lb.readProfiles(this._libDir()).find((x) => x.slug === lb.slugify(slug)); if (!pf) throw Object.assign(new Error(`No such profile: ${slug}`), { status: 404 }); p.styleProfile = pf.slug; } else delete p.styleProfile; this._persist(); return { id, profile: p.styleProfile ?? null }; }
  // ---- using parts: what the agent is told, what it is given, what we record afterwards
  _partsContext(p, t) {
    const cat = this._catalogNow().filter((x) => x.origin?.project !== p.id && !x.deprecated); const prof = p.styleProfile && this.cfg.library?.remote ? lb.readProfiles(this._libDir()).find((x) => x.slug === p.styleProfile) : null; if (!cat.length && !prof) return { text: '', parts: [] };
    const pack = pk.loadPack(pk.packDir(this.cfg.stateDir, p.id)); const q = `${t?.title ?? ''} ${t?.body ?? ''} ${pack.brief.goal ?? ''} ${pack.brief.scope ?? ''}`; const stack = p.profile?.languages ?? [];
    const found = lb.searchCatalog(cat, q, { stack, limit: 5 }).map((r) => ({ part: r.part, why: r.why }));
    const text = `${t?.title ?? ''} ${t?.body ?? ''}`.toLowerCase(); for (const part of cat) if (!found.some((f) => f.part.slug === part.slug) && text.includes(part.slug)) found.push({ part, why: ['named in the ticket'] });
    const house = []; if (prof) for (const s of prof.parts) { const part = cat.find((c) => c.slug === s); if (part && !found.some((f) => f.part.slug === s)) { found.push({ part, why: [`in your house style “${prof.name}”`] }); house.push(part); } }
    if (!found.length && !prof) return { text: '', parts: [] };
    const lines = found.slice(0, 10).map(({ part: x, why }) => `- ${x.slug}@${x.version} [${x.kind}${x.tested ? ', tested' : ''}] ${x.summary || x.name}${x.exports.length ? `\n  API: ${x.exports.slice(0, 6).map((e) => e.signature || e.name).join('; ')}` : ''}\n  files: .factory-context/library/${x.slug}/src/  (matched: ${why.slice(0, 3).join(', ')})`);
    const skills = []; if (prof) for (const s of prof.parts) { const part = cat.find((c) => c.slug === s && c.kind === 'skill'); if (part) { try { const meta = lb.readPart(this._libDir(), s); const f = meta.files.find((x) => x.role === 'source' && /\.md$/i.test(x.path)); if (f) skills.push(`#### Skill: ${meta.name}\n${f.content.trim().slice(0, 1200)}`); } catch { /* skip */ } } }
    const profileText = prof ? `### House style: ${prof.name}\n${prof.description ? `${prof.description}\n` : ''}${prof.conventions ? `Follow these conventions:\n${prof.conventions}\n` : ''}${prof.parts.length ? `Use these parts for UI, UX and structure unless the ticket says otherwise: ${prof.parts.join(', ')}.\n` : ''}${skills.join('\n\n')}` : '';
    const partsText = lines.length ? `### Reusable parts you already have (prefer these over writing the same thing again)\n${lines.join('\n')}\nTo use a part: copy its src files (and its tests) into the project where the conventions say, keep the \`factory-part:\` header line at the top of each copied file, and adapt imports. Do not rewrite it from scratch; if it almost fits, copy it and make the smallest change, and say what you changed.` : '';
    return { parts: found.map((f) => f.part), text: [profileText, partsText].filter(Boolean).join('\n\n') };
  }
  _materializeParts(p, t, wsDir) {
    const { parts } = this._partsContext(p, t); if (!parts.length) return; const lib = this._libDir(); pk.excludeContext(wsDir);
    for (const part of parts) { const meta = lb.readPart(lib, part.slug); const root = path.join(wsDir, '.factory-context', 'library', part.slug); fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'README.md'), meta.readme);
      for (const f of meta.files) { const dest = path.join(root, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); const ext = path.extname(f.path).slice(1).toLowerCase(); fs.writeFileSync(dest, f.role === 'source' ? lb.provenanceHeader(meta, ext) + f.content : f.content); } }
  }
  _usage() { try { const u = JSON.parse(fs.readFileSync(path.join(this.cfg.stateDir, 'library', 'usage.json'), 'utf8')); return { entries: Array.isArray(u.entries) ? u.entries : [] }; } catch { return { entries: [] }; } }
  _saveUsage(u) { const f = path.join(this.cfg.stateDir, 'library', 'usage.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, JSON.stringify(u, null, 2)); fs.renameSync(`${f}.tmp`, f); }
  // After an agent run: which parts did it use? Write the lock file into the checkout (so it is committed with the change) and remember the use.
  async _recordParts(p, t, wsDir) {
    const cat = this._catalogNow(); if (!cat.length) return [];
    const g = async (a) => (await run('git', [...SAFE_GIT, ...a], { cwd: wsDir })).out; const list = [...new Set([...(await g(['ls-files', '-m'])).split('\n'), ...(await g(['ls-files', '-o', '--exclude-standard'])).split('\n')].filter(Boolean))].filter((f) => !f.startsWith('.factory/') && !f.startsWith('.factory-context/') && !f.includes('..')).slice(0, 60);
    const files = []; for (const rel of list) { try { const full = path.join(wsDir, rel); const st = fs.lstatSync(full); if (st.isFile() && !st.isSymbolicLink() && st.size < 200_000) files.push({ rel, content: fs.readFileSync(full, 'utf8') }); } catch { /* skip */ } }
    const used = lb.detectUsage(files, cat); if (!used.length) return [];
    const lockPath = path.join(wsDir, '.factory', 'parts.lock.json'); let lock = null; try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* none yet */ }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true }); fs.writeFileSync(lockPath, `${JSON.stringify(lb.updateLock(lock, used, { library: this.cfg.library?.repo }), null, 2)}\n`);
    const u = this._usage(); for (const x of used) { u.entries = u.entries.filter((e) => !(e.slug === x.slug && e.project === p.id)); u.entries.push({ slug: x.slug, version: x.version, project: p.id, ticket: t?.id, file: x.file, at: new Date().toISOString() }); } this._saveUsage(u);
    return [...new Map(used.map((x) => [x.slug, x])).values()].map(({ slug, version }) => ({ slug, version }));
  }
  // Ask for a part to be used in a project: a normal ticket, so the usual review and verification apply.
  async usePart({ part, project, note = '' } = {}) {
    const meta = this.libraryPart(part); this.project(project);
    return this.createTicket(project, { title: `Use the ${meta.slug} library part${note ? `: ${note}`.slice(0, 60) : ''}`, body: `Add the reusable part \`${meta.slug}@${meta.version}\` (${meta.kind}) to this project${note ? ` for this purpose: ${note}` : ''}.\n\n${meta.summary}\n\nThe part's files are provided in .factory-context/library/${meta.slug}/. Copy its src files (and tests) into the project following the project conventions, keep the \`factory-part:\` header on each copied file, adapt imports, and add or adapt tests so \`npm test\` passes.\n\nAcceptance criteria:\n- the part's files are in the project with their provenance header\n- existing code that duplicated this logic uses the part instead (if any)\n- tests pass` });
  }
  libraryUpgrades() {
    const cat = this._catalogNow(); const out = [];
    for (const e of this._usage().entries) { const cur = cat.find((x) => x.slug === e.slug); if (cur && lb.cmpVersion(e.version, cur.version) < 0) out.push({ slug: e.slug, project: e.project, from: e.version, to: cur.version, ticketed: !!e.upgradeTicket, deprecated: !!cur.deprecated, replacedBy: cur.replacedBy ?? null }); }
    return out;
  }
  // Open an upgrade ticket for each project still on an older version of a part.
  async upgradeUsers(slug) {
    const meta = this.libraryPart(slug); const u = this._usage(); const done = [];
    for (const e of u.entries) { if (e.slug !== meta.slug || e.upgradeTicket || lb.cmpVersion(e.version, meta.version) >= 0 || !this.cfg.projects.some((p) => p.id === e.project)) continue;
      const notes = meta.changelog.filter((c) => lb.cmpVersion(c.version, e.version) > 0).map((c) => `- ${c.version}: ${c.note}`).join('\n');
      const r = await this.createTicket(e.project, { title: `Upgrade library part ${meta.slug} from ${e.version} to ${meta.version}`, body: `The reuse library has a newer version of \`${meta.slug}\` (this project uses ${e.version}; latest is ${meta.version}).\n\nWhat changed:\n${notes || '- see the part README'}\n\nThe new files are in .factory-context/library/${meta.slug}/. Replace the project's copies (${(e.file ?? 'see .factory/parts.lock.json')}) with the new version, keep the \`factory-part:\` header, and fix any callers that the changes affect.\n\nAcceptance criteria:\n- the copied files match ${meta.slug}@${meta.version}\n- tests pass` });
      e.upgradeTicket = r?.url ?? true; done.push({ project: e.project, ticket: r?.url }); }
    this._saveUsage(u); return { upgraded: done };
  }

  // ---- Phase 3: run a part, and ask for a clean extraction
  // Run one exported function of a part in the QuickJS sandbox (no network, no files, time and memory limited). Pure JavaScript parts only.
  async tryPart({ part, fn, args = [] } = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 }); const meta = this.libraryPart(part);
    const sources = meta.files.filter((f) => f.role === 'source'); if (!sources.length || sources.some((f) => !/\.(m?js|cjs)$/.test(f.path))) throw bad('Only plain JavaScript parts can be tried here');
    const exp = meta.exports.find((e) => e.name === fn && e.kind === 'function'); if (!exp) throw bad(`${fn} is not an exported function of ${meta.slug}`);
    if (!Array.isArray(args) || JSON.stringify(args).length > 20_000) throw bad('args must be a JSON array (max 20 KB)');
    for (const f of sources) if (/^\s*(import\s|import\()|require\(/m.test(f.content)) throw bad(`${f.path} imports other modules, so it cannot run on its own in the sandbox`);
    const code = sources.map((f) => f.content.replace(/^\s*export\s+default\s+/gm, 'const __default = ').replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '').replace(/^\s*export\s+/gm, '')).join('\n');
    const t0 = Date.now(); const out = await runSandboxed(`async () => {\n${code}\nconst __f = ${fn};\nreturn await __f(...${JSON.stringify(args)});\n}`, {}, { timeoutMs: 3000, memoryBytes: 32 * 1024 * 1024, maxCalls: 1 }).catch((e) => ({ error: String(e.message ?? e) }));
    if (out.error) return { ok: false, error: String(out.error).replace(/^"|"$/g, '').slice(0, 500), ms: Date.now() - t0 };
    if (JSON.stringify(out.result ?? null).length > 50_000) return { ok: false, error: 'The result is too large to show', ms: Date.now() - t0 };
    return { ok: true, result: out.result === undefined ? null : out.result, ms: Date.now() - t0 };
  }
  // Code that is tangled into a project cannot be promoted as-is. This queues a normal ticket asking the agent to extract it into a clean, standalone module with its own tests; promote it once that PR is merged.
  async extractPartTicket({ project, name, files = [], description = '' } = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 }); this.project(project); const slug = lb.slugify(name); if (!slug) throw bad('Give the part a name');
    const list = (Array.isArray(files) ? files : []).map((f) => String(f).replace(/[^\w./@+-]/g, '')).filter(Boolean).slice(0, 12);
    return this.createTicket(project, { title: `Extract ${name} into a standalone reusable module`.slice(0, 120), body: `Extract the logic behind "${name}"${list.length ? ` (currently in ${list.join(', ')})` : ''} into a clean, standalone module that other projects could reuse.${description ? `\n\nWhat it should cover: ${String(description).slice(0, 600)}` : ''}\n\nRules for the extracted module:\n- put it in its own file(s), e.g. src/lib/${slug}.js (match the project's language and layout), with a short comment saying what it does\n- it must NOT import anything from this project's other modules, only the standard library or dependencies already declared; pass anything it needs in as arguments\n- export a small, clear API\n- add tests next to it that import only the new module\n- change the project to use the new module and keep its behaviour and tests passing\n\nAcceptance criteria:\n- the new module has no imports from the rest of the project\n- it has its own passing tests\n- the project's existing tests still pass\n\nAfter this PR is merged it can be promoted to the reuse library.` });
  }

  // ---- Phase 4: inbound webhooks (alerts, monitors, other tools -> tickets)
  _hookFile(id) { return path.join(this.cfg.stateDir, 'projects', id, 'inbound.json'); }
  _hook(id) { this.project(id); let h = {}; try { h = JSON.parse(fs.readFileSync(this._hookFile(id), 'utf8')); } catch { /* new */ }
    if (!h.token) { h = { token: crypto.randomBytes(24).toString('base64url'), seen: {}, hourly: [] }; this._saveHook(id, h); } return h; }
  _saveHook(id, h) { const f = this._hookFile(id); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, JSON.stringify(h), { mode: 0o600 }); fs.renameSync(`${f}.tmp`, f); }
  webhookInfo(id) { const h = this._hook(id); return { path: `/hook/${id}/${h.token}`, example: { title: 'Checkout fails with a 500 when the cart is empty', body: 'Seen 14 times in the last hour. Stack: …', source: 'skylark', severity: 'high', url: 'https://…', key: 'issue-1234' }, received: Object.keys(h.seen).length }; }
  webhookRotate(id) { const h = this._hook(id); h.token = crypto.randomBytes(24).toString('base64url'); this._saveHook(id, h); return this.webhookInfo(id); }
  // payload: { title, body|message|text, source, severity, url, key }. Same clarity check as any ticket; a repeated key within 24h is ignored; at most 30 tickets an hour per project.
  async inboundTicket(id, token, payload = {}) {
    const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, ...extra }); const p = this.project(id); const h = this._hook(id);
    const a = Buffer.from(String(token ?? '')), b = Buffer.from(h.token); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail(401, 'Invalid webhook token');
    if (p.paused) throw fail(409, 'This project is paused');
    const clip = (v, n) => String(v ?? '').replace(/\u0000/g, '').slice(0, n); const title = clip(payload.title ?? payload.message ?? payload.name, 160).trim(); const text = clip(payload.body ?? payload.description ?? payload.text ?? payload.message, 6000).trim();
    if (!title) throw fail(422, 'A title is required (title, message or name)');
    const key = payload.key ? clip(payload.key, 120) : null; const now = Date.now();
    h.seen = Object.fromEntries(Object.entries(h.seen).filter(([, t]) => now - t < 86_400_000)); h.hourly = h.hourly.filter((t) => now - t < 3_600_000);
    if (key && h.seen[key]) return { deduped: true, key };
    if (h.hourly.length >= 30) throw fail(429, 'Too many alerts for this project this hour');
    const source = clip(payload.source, 40).replace(/[^\w .-]/g, '') || 'webhook'; const sev = ['low', 'medium', 'high', 'critical'].includes(String(payload.severity).toLowerCase()) ? String(payload.severity).toLowerCase() : null;
    const body = `${text || title}\n\n---\nReported by ${source}${sev ? ` (severity: ${sev})` : ''}${payload.url && /^https?:\/\//.test(String(payload.url)) ? `\nLink: ${clip(payload.url, 400)}` : ''}${key ? `\nKey: ${key}` : ''}\n\nInvestigate and fix the root cause with the smallest correct change, and add a test that would have caught it.\n\nAcceptance criteria:\n- the reported problem no longer occurs\n- a test covers it and npm test passes`;
    const g = assessTicket({ title, body }, this.cfg.limits.gate); if (!g.ok) throw fail(422, `Not enough to act on: ${g.problems.join('; ')}`, { problems: g.problems });
    const r = await this.createTicket(id, { title: `[${source}] ${title}`.slice(0, 200), body }); if (key) h.seen[key] = now; h.hourly.push(now); this._saveHook(id, h); return { created: true, ticket: r?.url ?? null };
  }

  // "Where this fits": the AI is told which plan ticket it is on, what is already done, what is in flight and what comes next, so it works from the plan, not in isolation.
  _planContext(p, t) {
    const plan = pk.loadPack(pk.packDir(this.cfg.stateDir, p.id)).plan; if (!plan || plan.status === 'proposed' || !t) return '';
    const all = pk.planTickets(plan); const mine = all.find((x) => x.ticketId && String(x.ticketId) === String(t.id)); if (!mine) return '';
    const epic = plan.epics.find((e) => e.id === mine.epic); const list = (xs) => xs.map((x) => `${x.title} (${x.id})`).join('; ') || 'none';
    const done = all.filter((x) => x.status === 'done'), going = all.filter((x) => ['queued', 'working', 'review'].includes(x.status) && x.id !== mine.id), next = all.filter((x) => x.dependsOn.includes(mine.id));
    return `### Where this fits in the project plan\n${plan.summary ? `Plan: ${plan.summary}\n` : ''}You are on "${mine.title}" (${mine.id}), part of the epic "${epic?.title ?? mine.epic}"${epic?.trackerUrl ? ` (${epic.trackerUrl})` : ''}. ${mine.dependsOn.length ? `It builds on: ${mine.dependsOn.join(', ')}, which are already merged.` : 'Nothing has to be merged before it.'}\nAlready done: ${list(done).slice(0, 500)}\nIn progress or in review (do not duplicate): ${list(going).slice(0, 400)}\nComes next and depends on your work, so keep your interfaces stable: ${list(next).slice(0, 400)}`;
  }
  // The project's target: stop at a prototype, or aim to deploy. Readiness says how many of the checks before a go-live already pass; a human still approves.
  setTarget(id, target) { const p = this.project(id); if (!['prototype', 'deploy'].includes(target)) throw Object.assign(new Error('target must be "prototype" or "deploy"'), { status: 400 }); p.target = target; this._persist(); return { id, target }; }
  async readiness(id) {
    const p = this.project(id); const target = p.target ?? 'prototype'; const names = target === 'deploy' ? ['brief-ready', 'plan-complete', 'queue-empty', 'gate-ok'] : ['brief-ready', 'plan-complete', 'gate-ok'];
    const title = { 'brief-ready': 'Brief has a goal and scope', 'plan-complete': 'Every planned ticket is merged', 'queue-empty': 'Nothing waiting in review', 'gate-ok': 'Quality gate passes' };
    const checks = []; for (const n of names) { try { const r = await sc.runCheck(this, id, n); checks.push({ id: n, title: title[n], ok: !!r.ok, detail: r.detail }); } catch (e) { checks.push({ id: n, title: title[n], ok: false, detail: String(e.message ?? e) }); } }
    return { target, scenario: target === 'deploy' ? 'ship' : 'prototype', checks, passed: checks.filter((c) => c.ok).length, total: checks.length, ready: checks.every((c) => c.ok) };
  }
  // ================================================================ Extensions: plugins, scenarios, prompts
  _configDir() { return this.configPath ? path.dirname(path.resolve(this.configPath)) : this.cfg.stateDir; }
  _root() { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); }
  _pluginDirs() { return [path.join(this._root(), 'plugins'), path.join(this._configDir(), 'plugins')]; }
  _scenarioDirs() { return [path.join(this._root(), 'scenarios'), path.join(this._configDir(), 'scenarios')]; }
  _promptDirs() { return [path.join(this._configDir(), 'prompts')]; }
  async loadPlugins() { this.pluginReport = await loadPlugins({ dirs: this._pluginDirs(), enabled: readEnabled(this._configDir()), env: this.env, log: (m) => console.error(m) }); return this.pluginReport; }
  plugins() { return { plugins: this.pluginReport, stepTypes: sc.stepTypes(), dirs: this._pluginDirs() }; }
  scenarios() { return sc.loadScenarios(this._scenarioDirs()); }
  async startScenario({ project, scenario, params, apply = false } = {}) {
    const def = this.scenarios().find((s) => s.id === scenario); if (!def || def.error) throw Object.assign(new Error(def?.error ? `Scenario ${scenario} is invalid: ${def.error}` : `No such scenario: ${scenario}`), { status: def ? 400 : 404 });
    const run = sc.startRun(this, { scenario: def, project, params: params ?? {}, dryRun: apply !== true }); return sc.advance(this, project, run.id, { scenarios: this.scenarios() });
  }
  async ticketDetail(id, ticketId) { const p = this.project(id); if (!/^[\w-]{1,40}$/.test(String(ticketId))) throw Object.assign(new Error('Invalid ticket id'), { status: 400 }); return this.deps(p).tickets.get(ticketId); }
  async trackerOverview(id) { const a = this.deps(this.project(id)).tickets; if (typeof a.overview !== 'function') throw Object.assign(new Error('Only the built-in tracker keeps an overview'), { status: 400 }); return a.overview(); }
  async freshTickets(id) { this.cache.delete(`t:${id}`); return this.listTickets(id); }   // scenario waits must see a ticket close the moment it does
  async scenarioRuns(project) { return sc.listRuns(this, project); }
  async scenarioRun(project, id) { this.project(project); return sc.advance(this, project, id, { scenarios: this.scenarios() }); }
  scenarioApprove(project, id, stepId, by) { return sc.approveStep(this, project, id, stepId, by); }
  scenarioCancel(project, id) { return sc.cancelRun(this, project, id); }

  removeProject(id) { this.project(id); this.cfg.projects = this.cfg.projects.filter((p) => p.id !== id); this._persist(); }
  setProjectPaused(id, paused) { const p = this.project(id); p.paused = !!paused; this._persist(); return p; }

  // Create a brand-new repo from a template, register it, and queue its first ticket (the spec).
  async createProject({ id, name, description, visibility, template, spec, brief, stack, decisions, sources, plan, target, profile, tracker, host, verify }) {
    if (host === 'local') {          // a project that lives entirely on this machine: no GitHub repository to create
      const p = await this.addProject({ id, repo: name || id, host: { kind: 'local' }, ...(verify ? { verify } : {}) });
      if (target) this.setTarget(id, target); if (profile) { try { this.setProjectProfile(id, profile); } catch { /* never blocks creation */ } }
      const out = { project: p, url: null }; Object.assign(out, await this._seedPack(id, { brief, stack, decisions, sources, plan })); if (spec) await this.createTicket(id, { title: `Build ${name}`, body: spec }); return out;
    }
    const owner = await this.gh.whoami();
    const repo = await this.gh.createProjectRepo({ owner, name, description, visibility, template, identity: { name: owner, email: `${owner}@users.noreply.github.com` } });
    const p = await this.addProject({ id, repo: repo.repo, base: repo.defaultBranch, ...(tracker === 'local' ? { source: { kind: 'local' } } : {}), ...(verify ? { verify } : {}) });
    if (target) this.setTarget(id, target);
    if (profile) { try { this.setProjectProfile(id, profile); } catch { /* an unknown profile never blocks creation */ } }
    const out = { project: p, url: repo.url }; Object.assign(out, await this._seedPack(id, { brief, stack, decisions, sources, plan }));
    if (spec) await this.createTicket(id, { title: `Build ${name}`, body: spec });
    return out;
  }
}
