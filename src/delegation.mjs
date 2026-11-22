// Who does which job: Codex (the plan), OpenRouter (free models), or a mix. Pure rules so every decision can be explained and tested.
//   mode   'mix' (default) | 'codex' | 'openrouter'
//   routes per role: 'codex' | 'openrouter' | 'auto'   (auto = the free models first, when they are suited and available, and Codex when not or when a cheap attempt failed)
// A decision is { provider: 'codex' | 'openrouter' | 'none', shot, why, escalate }:
//   shot     for a judging role the whole job is one request (the diff is in the prompt): no tools, no exploring
//   escalate when the free models cannot give a usable answer, the job is redone on Codex (never in 'openrouter' mode)
export const MODES = ['mix', 'codex', 'openrouter'];
export const ROUTES = ['codex', 'openrouter', 'auto'];
export const JUDGES = new Set(['reviewer', 'security']);   // roles whose job is a verdict on a diff

// What each role does by default in 'mix', and why. Judging is the cheapest thing to move (one request; measured: see docs/evidence/review-bench-*.json), then drafting; building and designing start on Codex's side until a free model
// has proved itself on that kind of work: `auto` lets small, first-attempt jobs go to the free models and escalates the rest.
export const DEFAULT_ROUTES = {
  reviewer: { route: 'openrouter', why: 'a verdict on a diff is one request, measured about as good as an exploring agent on planted defects at a fraction of the tokens' },
  security: { route: 'codex', why: 'security verdicts have not been benchmarked on free models yet: Codex until they have' },
  'spec-writer': { route: 'auto', why: 'a short written spec; escalates to Codex if the free models fail' },
  'skill-writer': { route: 'auto', why: 'a short written skill; escalates to Codex if the free models fail' },
  tester: { route: 'auto', why: 'tests for a small change; escalates to Codex if the free models fail' },
  designer: { route: 'auto', why: 'HTML and SVG mockups; escalates to Codex if the free models fail' },
  planner: { route: 'codex', why: 'the plan everything else follows: quality first' },
  builder: { route: 'auto', why: 'small tickets (size S) on the first attempt go to free models; anything bigger, or a retry, goes to Codex' },
  fixer: { route: 'auto', why: 'small fixes on the first attempt go to free models; a retry goes to Codex' },
};

export function effectiveRoute(role, policy = {}) { const user = policy.routes?.[role]; if (ROUTES.includes(user)) return { route: user, source: 'you' }; const d = DEFAULT_ROUTES[role] ?? { route: 'codex', why: 'no default for this role' }; return { route: d.route, source: 'default', why: d.why }; }

// ctx: { role, mode, routes, size ('S'|'M'|'L'|null), attempt (1-based), orUsable, orReady, orRemaining (requests left today, null = unknown), planLimited, codexUsable }
export function decide(ctx) {
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
  if (['builder', 'fixer'].includes(role)) { if (attempt > 1) return codex('a retry after a failed attempt goes to Codex'); if (size && size !== 'S') return codex(`a ticket of size ${size} goes to Codex`); if (!size) return codex('the ticket\'s size is not known, so Codex'); }
  return or(why ?? 'free models first', true);
}
