// Who does which job: Codex (the plan), OpenRouter (free models), local models (on this machine), or a mix. Pure rules so every decision can be explained and tested.
//   mode   'mix' (default) | 'codex' | 'openrouter'
//   routes per role: 'codex' | 'openrouter' | 'auto'   (auto = the free models first, when they are suited and available, and Codex when not or when a cheap attempt failed)
// A decision is { provider: 'codex' | 'openrouter' | 'none', shot, why, escalate }:
//   shot     for a judging role the whole job is one request (the diff is in the prompt): no tools, no exploring
//   escalate when the free models cannot give a usable answer, the job is redone on Codex (never in 'openrouter' mode)
export const MODES = ['mix', 'codex', 'openrouter', 'local'];
export const ROUTES = ['codex', 'openrouter', 'local', 'auto'];
export const JUDGES = new Set(['reviewer', 'security']);   // roles whose job is a verdict on a diff

// What each role does by default in 'mix', and why. Judging is the cheapest thing to move (one request; measured: see docs/evidence/review-bench-*.json), then drafting; building and designing start on Codex's side until a free model
// has proved itself on that kind of work: `auto` lets small, first-attempt jobs go to the free models and escalates the rest.
export const DEFAULT_ROUTES = {
  reviewer: { route: 'openrouter', why: 'Checking a change takes one short request, and free models did as well as a full agent in our tests.' },
  security: { route: 'codex', why: 'Not tested on free models yet, so it stays on Codex.' },
  'spec-writer': { route: 'auto', why: 'A short piece of writing. Free models first, and Codex if they cannot do it.' },
  'skill-writer': { route: 'auto', why: 'A short piece of writing. Free models first, and Codex if they cannot do it.' },
  tester: { route: 'auto', why: 'Tests for a small change. Free models first, and Codex if they cannot do it.' },
  designer: { route: 'auto', why: 'Mockups and artwork. Free models first, and Codex if they cannot do it.' },
  planner: { route: 'codex', why: 'Everything else follows the plan, so quality comes first (quality first).' },
  builder: { route: 'auto', why: 'Small tickets on the first try go to free models. Bigger tickets and retries go to Codex.' },
  fixer: { route: 'auto', why: 'Small fixes on the first try go to free models. Retries go to Codex.' },
};

export function effectiveRoute(role, policy = {}) { const user = policy.routes?.[role]; if (ROUTES.includes(user)) return { route: user, source: 'you' }; const d = DEFAULT_ROUTES[role] ?? { route: 'codex', why: 'no default for this role' }; return { route: d.route, source: 'default', why: d.why }; }

// ctx: { role, mode, routes, size ('S'|'M'|'L'|null), attempt (1-based), orUsable, orReady, orRemaining (requests left today, null = unknown), planLimited, codexUsable }
function decideBase(ctx) {
  const { role, mode = 'mix', size = null, attempt = 1, orUsable = false, orReady = false, orRemaining = null, planLimited = false, codexUsable = true } = ctx; const shot = JUDGES.has(role);
  const need = shot ? 1 : 8;   // requests a job needs: a verdict is one; a tool-using task is a handful
  const orOk = orUsable && orReady && (orRemaining === null || orRemaining >= need);
  if (mode === 'codex') return codexUsable ? { provider: 'codex', shot: false, escalate: false, why: 'Codex only' } : { provider: 'none', shot: false, escalate: false, why: 'Codex only, and Codex is not available' };
  if (mode === 'openrouter') return orOk ? { provider: 'openrouter', shot, escalate: false, why: 'OpenRouter only' } : { provider: 'none', shot, escalate: false, why: orUsable ? (orReady ? 'OpenRouter only: not enough of today\'s allowance is left' : 'OpenRouter only: every free model is resting') : 'OpenRouter only: it is not set up' };
  // mix
  const { route, source, why } = effectiveRoute(role, ctx);
  const codex = (reason) => (codexUsable ? { provider: 'codex', shot: false, escalate: false, why: reason } : orOk ? { provider: 'openrouter', shot, escalate: false, why: `${reason}; Codex is limited, so the free models stand in` } : { provider: 'none', shot, escalate: false, why: `${reason}; and neither provider is available` });
  const or = (reason, escalate) => (orOk ? { provider: 'openrouter', shot, escalate: escalate && codexUsable, why: reason } : codex(`${reason.split(':')[0]}: the free models are not available (${orUsable ? (orReady ? 'allowance used' : 'all resting') : 'not set up'}), so Codex`));
  if (!codexUsable && orOk && route !== 'codex') return { provider: 'openrouter', shot, escalate: false, why: 'Codex is limited: the free models stand in' };
  if (route === 'codex' && source === 'you') return codexUsable ? { provider: 'codex', shot: false, escalate: false, why: 'you set this role to Codex' } : { provider: 'none', shot, escalate: false, why: 'you set this role to Codex, and Codex is limited: it waits for Codex' };   // a pin is a pin
  if (route === 'codex') return codex(why);
  if (route === 'openrouter') return or(source === 'you' ? 'you set this role to OpenRouter' : why, true);
  // auto
  if (['builder', 'fixer'].includes(role)) { if (attempt > 1) return codex('a retry after a failed attempt goes to Codex'); if (size && size !== 'S') return codex(`a bigger ticket (size ${size}) goes to Codex`); if (!size) return codex('the ticket\'s size is not known, so Codex does it'); }
  return or(why ?? 'Free models first.', true);
}

// The full decision. Local models are switched on separately (cfg.local.enabled) and are only used where you ask for them: mode 'local' (only local models), a role routed to 'local' (they go first, then the free
// models, then Codex when the answer is unusable), or as the last stand-in when Codex is limited and the free models are not available. ctx adds: localUsable, localReady.
// A decision is { provider: 'codex' | 'openrouter' | 'local' | 'none', shot, why, escalate, chain } where chain lists who is tried next, in order, when the first answer cannot be used.
export function decide(ctx) {
  const { role, mode = 'mix', orUsable = false, orReady = false, orRemaining = null, codexUsable = true, localUsable = false, localReady = false } = ctx; const shot = JUDGES.has(role); const localOk = localUsable && localReady;
  if (mode === 'local') return localOk ? { provider: 'local', shot, escalate: false, chain: [], why: 'Local models only' } : { provider: 'none', shot, escalate: false, chain: [], why: localUsable ? 'Local models only: every local model is resting' : 'Local models only: they are not switched on, or the server cannot be reached' };
  if (mode !== 'mix') return { ...decideBase(ctx), chain: [] };
  const { route, source } = effectiveRoute(role, ctx); const need = shot ? 1 : 8; const orOk = orUsable && orReady && (orRemaining === null || orRemaining >= need);
  if (route === 'local') {
    if (localOk) { const chain = [...(orOk ? ['openrouter'] : []), ...(codexUsable ? ['codex'] : [])]; return { provider: 'local', shot, escalate: chain.length > 0, chain, why: source === 'you' ? 'you set this role to local models' : 'local models first' }; }
    const b = decideBase({ ...ctx, routes: { ...(ctx.routes ?? {}), [role]: 'auto' } }); return { ...b, chain: [], why: `local models are not available (${localUsable ? 'all resting' : 'not switched on'}): ${b.why}` };
  }
  const b = decideBase(ctx);
  if (b.provider === 'none' && localOk && !(route === 'codex' && source === 'you')) return { provider: 'local', shot, escalate: false, chain: [], why: 'Codex is limited and the free models are not available: local models stand in' };
  return { ...b, chain: [] };
}
