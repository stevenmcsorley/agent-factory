// Who does each job. Every agent call goes through one wrapper (engine-roles.mjs: _agentFor) which asks the delegation rules (delegation.mjs) which provider should do THIS call:
// Codex, OpenRouter's free models, or (in 'mix') whichever suits the role, the ticket's size and the attempt, with Codex as the escalation when a cheap attempt fails or cannot run.
// Config: cfg.agents = { mode: 'mix' | 'codex' | 'openrouter', routes: { role: 'codex' | 'openrouter' | 'auto' } }. Installed on Engine.prototype (see the bottom of engine.mjs).
import { agents } from './adapters/agents.mjs';
import { parseUsageLimit, retryAtMs } from './agentlimit.mjs';
import { parseVerdict } from './review.mjs';
import { recordUsage, readUsage } from './usage.mjs';
import * as pk from './pack.mjs';
import { ROLE_KEYS } from './presets.mjs';
import { MODES, ROUTES, DEFAULT_ROUTES, JUDGES, decide, effectiveRoute } from './delegation.mjs';

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
    return { role, mode: pol.mode, routes: pol.routes, size: this._ticketSize(ctx.project ?? meta.project, meta.ticket), attempt, orUsable, orReady, orRemaining: budget.remaining, planLimited: limited, codexUsable: !limited };
  },
  // Can OpenRouter stand in for this role while the plan is limited? Never in codex-only mode, and never for a role you pinned to Codex.
  _fallbackCovers(role) {
    const pol = this._policy(); if (pol.mode === 'codex') return false; if (pol.routes[role] === 'codex') return false; const or = this._orConf(); if (!or.enabled || !or.fallback.enabled || !this._orKey()) return false;
    const r = this.router(); const need = { tools: !JUDGES.has(role) }; return !r.s.authFailed && (!!r.pick({ role, need }) || !!r.nextReady({ role, need }));
  },
  _fallbackAny() { return ROLE_KEYS.some((r) => this._fallbackCovers(r)); },
  _shotPrompt(prompt) { return String(prompt).replace(SHOT_LINE, 'No checkout is available: judge from the diff and context below.'); },
  // Did the free models give something the factory can use? A verdict must parse; a task must not have stopped on a limit or come back empty.
  _orUnusable(role, r) { if (!r || r.limited || r.error || parseUsageLimit(r.out)) return true; if (!String(r.out ?? '').trim()) return true; if (JUDGES.has(role)) return parseVerdict(r.out).verdict === 'error'; return false; },
  _noProviderResult(dec) {
    const lim = this.planLimit(); const next = this._orConf().enabled ? this.router().nextReady({ role: 'builder' }) : null; const until = lim?.until ?? next ?? Date.now() + 10 * 60_000;
    return { out: `You've hit your usage limit: ${dec.why}. Try again at ${clockOf(until)}.`, costUsd: 0, tokens: { ...ZERO }, model: null, limited: true };
  },
  _recordUse(role, ctx, args, r, t0, via, why, extra = {}) {
    const meta = args[3]?.meta ?? {}; recordUsage(this.cfg.stateDir, { role, project: ctx.project ?? meta.project ?? null, run: meta.run ?? null, ticket: meta.ticket ?? null, ref: meta.ref ?? null, model: r?.model ?? ((this.cfg.roles?.[role]?.agent?.model ?? this.cfg.agent.model) ?? null), via, why: String(why ?? '').slice(0, 160), input: r?.tokens?.input ?? 0, cached: r?.tokens?.cached ?? 0, output: r?.tokens?.output ?? 0, steps: r?.tokens?.steps ?? 0, ms: Date.now() - t0, ...extra });
  },

  // The agent the factory uses for a role: a wrapper that decides, per call, who does it.
  _delegatedAgent(role, log, ctx = {}) {
    const plan = () => { const a = { ...this.cfg.agent, ...(this.cfg.roles?.[role]?.agent ?? {}) }; return agents[a.kind]({ ...a, image: this.cfg.sandbox.agentImage, log }); }; const base = plan();
    const onPlan = async (args) => { const r = await plan().run(...args); const lim = parseUsageLimit(r?.out); if (lim) this._noteLimit(lim); return { r, lim }; };
    const onFree = (args, shot) => this._orAgent(role, log, ctx).run(args[0], args[1], shot ? this._shotPrompt(args[2]) : args[2], { ...(args[3] ?? {}), meta: { ...(args[3]?.meta ?? {}), ...(shot ? { shot: true } : {}) } });
    return { name: base.name, info: base.info, run: async (...args) => {
      const t0 = Date.now(); const meta = args[3]?.meta ?? {}; const call = this._delegationCtx(role, ctx, meta); const dec = decide(call); let why = dec.why; let via = dec.provider; let r; let escalated = false;
      if (dec.provider === 'none') { r = this._noProviderResult(dec); this._recordUse(role, ctx, args, r, t0, 'none', why, { limited: true }); return r; }
      if (dec.provider === 'openrouter') {
        r = await onFree(args, dec.shot);
        if (dec.escalate && call.codexUsable && this._orUnusable(role, r)) { this._audit({ what: 'openrouter', action: 'back-to-plan', role, project: ctx.project ?? null, why: r?.limited ? 'the free models were limited' : 'the free models gave no usable answer' }); const o = await onPlan(args); r = o.r; via = 'codex'; escalated = true; why = `${why} → escalated to Codex`; if (o.lim) this._recordUse(role, ctx, args, r, t0, via, why, { limited: true, escalated }); }
      } else {
        const o = await onPlan(args); r = o.r;
        // the plan ran out in the middle of this call: if the free models may stand in, do the same job on them instead of failing it
        if (o.lim && this._fallbackCovers(role)) { this._audit({ what: 'openrouter', action: 'fallback', role, project: ctx.project ?? null }); r = await onFree(args, JUDGES.has(role)); via = 'openrouter'; escalated = true; why = `${why} → Codex limit: the free models carried on`; }
      }
      // OpenRouter's own limit is never recorded as the plan limit: only the plan's text reaches _noteLimit (in onPlan)
      this._recordUse(role, ctx, args, r, t0, via, why, { ...(parseUsageLimit(r?.out) ? { limited: true } : {}), ...(escalated ? { escalated: true } : {}), ...(r?.models?.length ? { models: r.models } : {}) }); return r;
    } };
  },

  // ---- the policy for the UI and MCP
  agentPolicy() {
    const pol = this._policy(); const or = this._orConf(); const key = !!this._orKey(); const limited = !!this.planLimit();
    const roles = Object.fromEntries(ROLE_KEYS.map((role) => { const eff = effectiveRoute(role, pol); const d = decide({ role, mode: pol.mode, routes: pol.routes, size: 'S', attempt: 1, orUsable: or.enabled && key, orReady: true, orRemaining: null, planLimited: limited, codexUsable: !limited }); return [role, { route: eff.route, source: eff.source, why: eff.why ?? null, default: DEFAULT_ROUTES[role]?.route ?? 'codex', defaultWhy: DEFAULT_ROUTES[role]?.why ?? null, judge: JUDGES.has(role), first: d.provider, firstWhy: d.why }]; }));
    return { mode: pol.mode, modes: MODES, routes: pol.routes, roles, openrouterReady: or.enabled && key, codexLimited: limited, usage: this.usageByProvider(7) };
  },
  setAgentPolicy(patch = {}) {
    const next = { ...(this.cfg.agents ?? {}) }; const before = JSON.stringify(this._policy());
    if (patch.mode !== undefined) { if (!MODES.includes(patch.mode)) throw bad(`mode must be one of ${MODES.join(', ')}`); next.mode = patch.mode; }
    if (patch.routes !== undefined) { if (!patch.routes || typeof patch.routes !== 'object') throw bad('routes must map a role to codex, openrouter or auto'); const routes = { ...(next.routes ?? {}) }; for (const [r, v] of Object.entries(patch.routes)) { if (!ROLE_KEYS.includes(r)) throw bad(`Unknown role "${r}"`); if (v === null || v === '' || v === 'default') delete routes[r]; else if (ROUTES.includes(v)) routes[r] = v; else throw bad(`The route for ${r} must be codex, openrouter, auto (or default to clear it)`); } next.routes = routes; }
    this.cfg.agents = next; this._persist(); this._audit({ what: 'agent-policy', from: JSON.parse(before), to: this._policy() }); return this.agentPolicy();
  },
  // Where the tokens went: by provider and by role, over the last few days (the number that tells you whether delegation is paying off).
  usageByProvider(days = 7) {
    const since = Date.now() - days * 86_400_000; const sum = () => ({ calls: 0, input: 0, cached: 0, output: 0, weighted: 0, escalated: 0 }); const prov = { codex: sum(), openrouter: sum() }; const byRole = {};
    for (const u of readUsage(this.cfg.stateDir)) { if (Date.parse(u.at) < since || u.via === 'none') continue; const p = u.via === 'openrouter' ? 'openrouter' : 'codex'; const w = (u.input - u.cached) + u.cached * 0.1 + u.output * 6;
      for (const s of [prov[p], ((byRole[u.role] ??= { codex: sum(), openrouter: sum() })[p])]) { s.calls++; s.input += u.input; s.cached += u.cached; s.output += u.output; s.weighted += w; if (u.escalated) s.escalated++; } }
    return { days, byProvider: prov, byRole };
  },
};
