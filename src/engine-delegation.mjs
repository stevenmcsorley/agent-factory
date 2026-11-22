// Who does each job. Every agent call goes through one wrapper (engine-roles.mjs: _agentFor) which asks the delegation rules (delegation.mjs) which provider should do THIS call:
// Codex, OpenRouter's free models, or (in 'mix') whichever suits the role, the ticket's size and the attempt, with Codex as the escalation when a cheap attempt fails or cannot run.
// Config: cfg.agents = { mode: 'mix' | 'codex' | 'openrouter', routes: { role: 'codex' | 'openrouter' | 'auto' } }. Installed on Engine.prototype (see the bottom of engine.mjs).
import { agents } from './adapters/agents.mjs';
import { parseUsageLimit, retryAtMs } from './agentlimit.mjs';
import { parseVerdict } from './review.mjs';
import { recordUsage, readUsage } from './usage.mjs';
import * as pk from './pack.mjs';
import { ROLE_KEYS } from './presets.mjs';
import { HARNESS, DEFAULT_TIERS, validateOutput } from './harness.mjs';
import { MODES, ROUTES, DEFAULT_ROUTES, JUDGES, decide, effectiveRoute } from './delegation.mjs';
import { buildAccounts, accountsCsv } from './accounts.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const addTokens = (a, b) => (!a && !b ? null : ({ input: (a?.input ?? 0) + (b?.input ?? 0), output: (a?.output ?? 0) + (b?.output ?? 0), cached: (a?.cached ?? 0) + (b?.cached ?? 0), reasoning: (a?.reasoning ?? 0) + (b?.reasoning ?? 0), steps: (a?.steps ?? 0) + (b?.steps ?? 0) }));
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const ZERO = { input: 0, output: 0, cached: 0, reasoning: 0, steps: 0 };
const clockOf = (ms) => { const d = new Date(ms); const h = d.getHours(); return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const SHOT_LINE = /You may read any file in this checkout, but you MUST NOT edit, create or delete files: your job is to judge, not to fix\./;

export const delegationMethods = {
  // The policy as configured, with the older per-role OpenRouter list folded in (an explicit route always wins).
  _policy() {
    const a = this.cfg.agents ?? {}; const legacy = this.cfg.openrouter?.roles ?? []; const routes = {};
    for (const r of ROLE_KEYS) if (legacy.includes('*') || legacy.includes(r)) routes[r] = 'openrouter';
    for (const [r, v] of Object.entries(a.routes ?? {})) if (ROLE_KEYS.includes(r) && ROUTES.includes(v)) routes[r] = v;
    return { mode: MODES.includes(a.mode) ? a.mode : 'mix', routes };
  },
  _ticketSize(project, ticketId) { try { if (!project || ticketId == null) return null; const pack = pk.loadPack(pk.packDir(this.cfg.stateDir, project)); return pk.planTickets(pack.plan ?? { epics: [] }).find((t) => String(t.ticketId) === String(ticketId))?.size ?? null; } catch { return null; } },
  // Everything the rules need to decide this one call.
  _delegationCtx(role, ctx, meta) {
    const pol = this._policy(); const or = this._orConf(); const key = !!this._orKey(); const r = this.router(); const orUsable = or.enabled && key && !r.s.authFailed; const judge = JUDGES.has(role);
    const orReady = orUsable && !!r.pick({ role, need: { tools: !judge } }); const budget = r.budget(); const limited = !!this.planLimit();
    let attempt = 1; if (meta.run && (role === 'builder' || role === 'fixer')) { this._attempts ??= new Map(); attempt = (this._attempts.get(meta.run) ?? 0) + 1; this._attempts.set(meta.run, attempt); if (this._attempts.size > 500) this._attempts.delete(this._attempts.keys().next().value); }
    const ls = this._localState(role, judge); return { role, mode: pol.mode, routes: pol.routes, size: this._ticketSize(ctx.project ?? meta.project, meta.ticket), attempt, orUsable, orReady, orRemaining: budget.remaining, planLimited: limited, codexUsable: !limited, localUsable: ls.usable, localReady: ls.ready };
  },
  // Can OpenRouter stand in for this role while the plan is limited? Never in codex-only mode, and never for a role you pinned to Codex.
  _fallbackCovers(role) {
    const pol = this._policy(); if (pol.mode === 'codex') return false; if (pol.routes[role] === 'codex') return false; const or = this._orConf(); if (!or.enabled || !or.fallback.enabled || !this._orKey()) return false;
    const r = this.router(); const need = { tools: !JUDGES.has(role) }; return !r.s.authFailed && (!!r.pick({ role, need }) || !!r.nextReady({ role, need }));
  },
  // Can local models stand in for this role when the plan runs out in the middle of a call? Never in codex-only mode, and never for a role you pinned to Codex.
  _localCovers(role) { const pol = this._policy(); if (pol.mode === 'codex' || pol.mode === 'openrouter' || pol.routes[role] === 'codex') return false; return this._localState(role, JUDGES.has(role)).ready; },
  // Model steps inside Codex: tiers = { role: [first model, then the next on a retry, ...] }, ending with the strongest.
  _tiers() { const t = this.cfg.agents?.tiers; return t && typeof t === 'object' ? Object.fromEntries(Object.entries(t).filter(([r, v]) => ROLE_KEYS.includes(r) && Array.isArray(v))) : {}; },
  // The models a role steps through, cheapest first: yours if you set them (an empty list = the usual model only), else the harness defaults (the usual model is always the last step), else none.
  _ladder(role, size = null) {
    const mine = this._tiers()[role]; if (mine) return { models: mine, source: mine.length ? 'you' : 'none' };
    if (this.cfg.agents?.defaultTiers === false || !/codex/i.test(String(this.cfg.agent?.kind ?? ''))) return { models: [], source: 'none' };
    const avail = new Set(this.codexModels().map((m) => m.id)); const usual = this.cfg.roles?.[role]?.agent?.model ?? this.cfg.agent?.model; const def = DEFAULT_TIERS[role] ?? {}; if (def.sizes && !def.sizes.includes(size)) return { models: [], source: 'none' };   // e.g. builders start cheaper only on small tickets
    const cheap = (def.models ?? []).filter((m) => avail.has(m) && m !== usual);
    return cheap.length && usual ? { models: [...cheap, usual], source: 'default' } : { models: [], source: 'none' };
  },
  _tierModel(role, attempt = 1, size = null) { const t = this._ladder(role, size).models; return t.length ? t[Math.min(Math.max(1, attempt), t.length) - 1] : null; },
  // The Codex models this login offers (from Codex's own list), so a step can be chosen by name.
  codexModels() { const home = this.cfg.agent?.codexHome; for (const f of [home && path.join(home, 'models_cache.json'), path.join(os.homedir(), '.codex', 'models_cache.json')].filter(Boolean)) { try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); const list = (d.models ?? []).filter((m) => m.visibility === 'list').map((m) => ({ id: m.slug, name: m.display_name ?? m.slug, description: m.description ?? '', context: m.context_window ?? null })); if (list.length) return list; } catch { /* try the next */ } } return []; },
  _fallbackAny() { return ROLE_KEYS.some((r) => this._fallbackCovers(r)); },
  _shotPrompt(prompt) { return String(prompt).replace(SHOT_LINE, 'No checkout is available: judge from the diff and context below.'); },
  // Did the free models give something the factory can use? A verdict must parse; a task must not have stopped on a limit or come back empty.
  _orUnusable(role, r) { if (!r || r.limited || r.error || parseUsageLimit(r.out)) return true; if (!String(r.out ?? '').trim()) return true; if (JUDGES.has(role)) return parseVerdict(r.out).verdict === 'error'; return false; },
  _noProviderResult(dec) {
    const lim = this.planLimit(); const next = this._orConf().enabled ? this.router().nextReady({ role: 'builder' }) : null; const until = lim?.until ?? next ?? Date.now() + 10 * 60_000;
    return { out: `You've hit your usage limit: ${dec.why}. Try again at ${clockOf(until)}.`, costUsd: 0, tokens: { ...ZERO }, model: null, limited: true };
  },
  _recordUse(role, ctx, args, r, t0, via, why, extra = {}) {
    this.notify('usage'); const meta = args[3]?.meta ?? {}; recordUsage(this.cfg.stateDir, { role, project: ctx.project ?? meta.project ?? null, run: meta.run ?? null, ticket: meta.ticket ?? null, ref: meta.ref ?? null, model: r?.model ?? ((this.cfg.roles?.[role]?.agent?.model ?? this.cfg.agent.model) ?? null), via, why: String(why ?? '').slice(0, 280), input: r?.tokens?.input ?? 0, cached: r?.tokens?.cached ?? 0, output: r?.tokens?.output ?? 0, steps: r?.tokens?.steps ?? 0, ms: Date.now() - t0, ...extra });
  },

  // The agent the factory uses for a role: a wrapper that decides, per call, who does it.
  _delegatedAgent(role, log, ctx = {}) {
    const plan = (model) => { const a = { ...this.cfg.agent, ...(this.cfg.roles?.[role]?.agent ?? {}), ...(model ? { model } : {}) }; return agents[a.kind]({ ...a, image: this.cfg.sandbox.agentImage, log }); }; const base = plan();
    const onPlan = async (args, model) => { const r = await plan(model).run(...args); const lim = parseUsageLimit(r?.out); if (lim) this._noteLimit(lim); return { r, lim }; };
    const onFree = (args, shot) => this._orAgent(role, log, ctx).run(args[0], args[1], shot ? this._shotPrompt(args[2]) : args[2], { ...(args[3] ?? {}), meta: { ...(args[3]?.meta ?? {}), ...(shot ? { shot: true } : {}) } });
    const onLocal = (args, shot) => this._localAgent(role, log, ctx).run(args[0], args[1], shot ? this._shotPrompt(args[2]) : args[2], { ...(args[3] ?? {}), meta: { ...(args[3]?.meta ?? {}), ...(shot ? { shot: true } : {}) } });
    return { name: base.name, info: base.info, run: async (...args) => {
      await this._localEnsure().catch(() => null); const t0 = Date.now(); const meta = args[3]?.meta ?? {}; const call = this._delegationCtx(role, ctx, meta); const dec = decide(call); let why = dec.why; let via = dec.provider; let r; let escalated = false;
      if (dec.provider === 'none') { r = this._noProviderResult(dec); this._recordUse(role, ctx, args, r, t0, 'none', why, { limited: true }); return r; }
      if (dec.provider === 'local') {
        r = await onLocal(args, dec.shot); via = 'local';
        // the local models could not give a usable answer: the next provider in line does the job (free models, then Codex)
        for (const next of dec.chain ?? []) { if (!this._orUnusable(role, r)) break; this._audit({ what: 'local', action: 'next', role, project: ctx.project ?? null, to: next, why: r?.limited ? 'the local models were resting' : 'the local models gave no usable answer' }); if (next === 'openrouter') { r = await onFree(args, dec.shot); via = 'openrouter'; } else { const o = await onPlan(args, this._tierModel(role, 99)); r = o.r; via = 'codex'; } escalated = true; why = `${why} → ${next === 'codex' ? 'Codex' : 'free models'} took over`; }
      } else if (dec.provider === 'openrouter') {
        r = await onFree(args, dec.shot);
        if (dec.escalate && call.codexUsable && this._orUnusable(role, r)) { this._audit({ what: 'openrouter', action: 'back-to-plan', role, project: ctx.project ?? null, why: r?.limited ? 'the free models were limited' : 'the free models gave no usable answer' }); const o = await onPlan(args, this._tierModel(role, 99)); r = o.r; via = 'codex'; escalated = true; why = `${why} The free models could not give a usable answer, so Codex did it.`; if (o.lim) this._recordUse(role, ctx, args, r, t0, via, why, { limited: true, escalated }); }
      } else {
        // a role may start on an older, cheaper Codex model and step up on each retry (cfg.agents.tiers); the model that did the work is what gets recorded
        // the harness: builders step up a model on each retry; every other role steps up when its output fails the check for that role (a verdict that does not parse, an empty or token-thin answer)
        const seq = this._ladder(role, call.size).models; const climbs = role === 'builder' || role === 'fixer'; let idx = climbs ? Math.min(Math.max(1, call.attempt), seq.length || 1) - 1 : 0; let tier = seq[idx] ?? null; let o = await onPlan(args, tier); r = o.r; let spent = null;
        while (!climbs && !o.lim && seq.length && idx < seq.length - 1 && !validateOutput(role, r?.out).ok) { const bad = validateOutput(role, r?.out); this._audit({ what: 'harness', action: 'step-up', role, project: ctx.project ?? null, from: tier, to: seq[idx + 1], why: bad.why }); spent = addTokens(spent, r?.tokens); idx++; const prev = tier; tier = seq[idx]; o = await onPlan(args, tier); r = o.r; escalated = true; why = `${why}; ${prev} ${bad.why}, so ${tier} took over`; }
        if (spent && r) r = { ...r, tokens: addTokens(r.tokens, spent) };   // the calls that failed their check still cost tokens: they are counted, not lost
        if (tier && r) { r = { ...r, model: r.model ?? tier }; why = `${why}; model ${tier}${seq.length > 1 ? ` (step ${idx + 1} of ${seq.length})` : ''}`; }
        // the plan ran out in the middle of this call: if the free models may stand in, do the same job on them instead of failing it
        if (o.lim && this._fallbackCovers(role)) { this._audit({ what: 'openrouter', action: 'fallback', role, project: ctx.project ?? null }); r = await onFree(args, JUDGES.has(role)); via = 'openrouter'; escalated = true; why = `${why} → Codex limit: the free models carried on`; }
        else if (o.lim && this._localCovers(role)) { this._audit({ what: 'local', action: 'fallback', role, project: ctx.project ?? null }); r = await onLocal(args, JUDGES.has(role)); via = 'local'; escalated = true; why = `${why} → Codex limit: local models carried on`; }
      }
      // OpenRouter's own limit is never recorded as the plan limit: only the plan's text reaches _noteLimit (in onPlan)
      this._recordUse(role, ctx, args, r, t0, via, why, { ...(parseUsageLimit(r?.out) ? { limited: true } : {}), ...(escalated ? { escalated: true } : {}), ...(r?.models?.length ? { models: r.models } : {}) }); return r;
    } };
  },

  // ---- the policy for the UI and MCP
  agentPolicy() {
    const pol = this._policy(); const or = this._orConf(); const key = !!this._orKey(); const limited = !!this.planLimit();
    const ls = this._localState('builder', false);
    const roles = Object.fromEntries(ROLE_KEYS.map((role) => { const eff = effectiveRoute(role, pol); const d = decide({ role, mode: pol.mode, routes: pol.routes, size: 'S', attempt: 1, orUsable: or.enabled && key, orReady: true, orRemaining: null, planLimited: limited, codexUsable: !limited, localUsable: ls.usable, localReady: ls.ready }); return [role, { route: eff.route, source: eff.source, why: eff.why ?? null, default: DEFAULT_ROUTES[role]?.route ?? 'codex', defaultWhy: DEFAULT_ROUTES[role]?.why ?? null, judge: JUDGES.has(role), first: d.provider, firstWhy: d.why, harness: HARNESS[role] ?? null, ladder: { ...this._ladder(role, DEFAULT_TIERS[role]?.sizes?.[0] ?? null), sizes: DEFAULT_TIERS[role]?.sizes ?? null, evidence: DEFAULT_TIERS[role]?.evidence ?? 'none' } }]; }));
    return { mode: pol.mode, modes: MODES, routes: pol.routes, roles, tiers: this._tiers(), defaultTiers: this.cfg.agents?.defaultTiers !== false, openrouterReady: or.enabled && key, localEnabled: this._localConf().enabled, localReady: ls.ready, codexLimited: limited, usage: this.usageByProvider(7) };
  },
  setAgentPolicy(patch = {}) {
    const next = { ...(this.cfg.agents ?? {}) }; const before = JSON.stringify(this._policy());
    if (patch.mode !== undefined) { if (!MODES.includes(patch.mode)) throw bad(`mode must be one of ${MODES.join(', ')}`); next.mode = patch.mode; }
    if (patch.routes !== undefined) { if (!patch.routes || typeof patch.routes !== 'object') throw bad('routes must map a role to codex, openrouter or auto'); const routes = { ...(next.routes ?? {}) }; for (const [r, v] of Object.entries(patch.routes)) { if (!ROLE_KEYS.includes(r)) throw bad(`Unknown role "${r}"`); if (v === null || v === '' || v === 'default') delete routes[r]; else if (ROUTES.includes(v)) routes[r] = v; else throw bad(`The route for ${r} must be codex, openrouter, auto (or default to clear it)`); } next.routes = routes; }
    if (patch.tiers !== undefined) { if (!patch.tiers || typeof patch.tiers !== 'object') throw bad('tiers must map a role to a list of Codex models'); const tiers = { ...(next.tiers ?? {}) }; for (const [r, v] of Object.entries(patch.tiers)) { if (!ROLE_KEYS.includes(r)) throw bad(`Unknown role "${r}"`); if (v === null) { delete tiers[r]; continue; } if (Array.isArray(v) && !v.length) { tiers[r] = []; continue; } if (!Array.isArray(v) || v.length > 3 || v.some((m) => !/^[A-Za-z0-9._-]{1,60}$/.test(String(m)))) throw bad('Each role takes up to three Codex model names, cheapest first'); tiers[r] = v.map(String); } next.tiers = tiers; }
    if (patch.defaultTiers !== undefined) { if (typeof patch.defaultTiers !== 'boolean') throw bad('defaultTiers must be true or false'); next.defaultTiers = patch.defaultTiers; }
    this.cfg.agents = next; this._persist(); this._audit({ what: 'agent-policy', from: JSON.parse(before), to: this._policy() }); return this.agentPolicy();
  },
  // The accounting for the Usage page: what each agent and model used and when, what the limits did, and the credit position.
  async accounts({ days = 7, calls = 200 } = {}) {
    const d = Math.min(90, Math.max(1, Number(days) || 7)); const r = this.router(); if (this._orKey()) await r.refreshCredits().catch(() => null);
    const audit = (() => { try { return fs.readFileSync(path.join(this.cfg.stateDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-6000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } })();
    const lim = this.planLimit?.() ?? null; const st = r.status();
    return buildAccounts({ usage: readUsage(this.cfg.stateDir), orCalls: r.recent(3000), audit, days: d, planLimit: lim, budget: st.budget, credits: st.credits, keyInfo: st.keyInfo, freeUntil: st.freeUntil, callsLimit: Math.min(1000, Number(calls) || 200) });
  },
  async accountsCsv(days) { return accountsCsv(await this.accounts({ days, calls: 1000 })); },
  // Where the tokens went: by provider and by role, over the last few days (the number that tells you whether delegation is paying off).
  usageByProvider(days = 7) {
    const since = Date.now() - days * 86_400_000; const sum = () => ({ calls: 0, input: 0, cached: 0, output: 0, weighted: 0, escalated: 0 }); const prov = { codex: sum(), openrouter: sum(), local: sum() }; const byRole = {};
    for (const u of readUsage(this.cfg.stateDir)) { if (Date.parse(u.at) < since || u.via === 'none') continue; const p = u.via === 'openrouter' ? 'openrouter' : u.via === 'local' ? 'local' : 'codex'; const w = (u.input - u.cached) + u.cached * 0.1 + u.output * 6;
      for (const s of [prov[p], ((byRole[u.role] ??= { codex: sum(), openrouter: sum(), local: sum() })[p])]) { s.calls++; s.input += u.input; s.cached += u.cached; s.output += u.output; s.weighted += w; if (u.escalated) s.escalated++; } }
    return { days, byProvider: prov, byRole };
  },
};
