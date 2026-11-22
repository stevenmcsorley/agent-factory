// The accounting: what each agent, model, role and project used, when, what it cost, and when limits were hit and lifted. Pure: it is given the logs and returns numbers, so every
// figure on the Usage page can be checked against a test. "weighted" counts cached input at a tenth (providers charge it that way) and output at six times: one number to compare mixes by.
const DAY = 86_400_000;
const W = (u) => Math.max(0, (u.input ?? 0) - (u.cached ?? 0)) + (u.cached ?? 0) * 0.1 + (u.output ?? 0) * 6;
const provOf = (u) => (u.via === 'openrouter' ? 'openrouter' : u.via === 'local' ? 'local' : u.via === 'none' ? 'none' : 'codex');
const blank = () => ({ calls: 0, input: 0, cached: 0, output: 0, steps: 0, weighted: 0, ms: 0, limited: 0, escalated: 0 });
const add = (s, u) => { s.calls++; s.input += u.input ?? 0; s.cached += u.cached ?? 0; s.output += u.output ?? 0; s.steps += u.steps ?? 0; s.weighted += W(u); s.ms += u.ms ?? 0; if (u.limited) s.limited++; if (u.escalated) s.escalated++; return s; };
const day = (iso) => String(iso).slice(0, 10);
const outcome = (u) => (u.via === 'none' ? 'not run' : u.limited ? 'limited' : u.escalated ? 'escalated' : 'ok');

export function buildAccounts({ usage = [], orCalls = [], audit = [], now = Date.now(), days = 7, planLimit = null, budget = null, credits = null, keyInfo = null, freeUntil = null, callsLimit = 200 } = {}) {
  const from = now - days * DAY; const inRange = (at) => Date.parse(at) >= from; const rows = usage.filter((u) => inRange(u.at));
  const totals = blank(); const byProvider = { codex: blank(), openrouter: blank(), local: blank(), none: blank() }; const dayMap = new Map(); const models = new Map(); const roles = new Map(); const projects = new Map();
  // every day in the range appears, so a quiet day is a visible gap, not a missing bar
  for (let t = Date.parse(`${new Date(from).toISOString().slice(0, 10)}T00:00:00Z`); t <= now; t += DAY) dayMap.set(new Date(t).toISOString().slice(0, 10), { day: new Date(t).toISOString().slice(0, 10), codex: blank(), openrouter: blank(), local: blank() });
  for (const u of rows) { const p = provOf(u); add(totals, u); add(byProvider[p], u); const d = dayMap.get(day(u.at)); if (d && p !== 'none') add(d[p], u);
    const mk = `${p}\u0000${u.model ?? '?'}`; add(models.get(mk) ?? models.set(mk, { model: u.model ?? 'unknown', provider: p, ...blank(), last: null }).get(mk), u); models.get(mk).last = u.at;
    const r = roles.get(u.role) ?? roles.set(u.role, { role: u.role, codex: blank(), openrouter: blank(), local: blank() }).get(u.role); if (p !== 'none') add(r[p], u);
    if (u.project) add(projects.get(u.project) ?? projects.set(u.project, { project: u.project, ...blank() }).get(u.project), u); }
  const orInRange = orCalls.filter((c) => inRange(new Date(c.at).toISOString())); const badTools = new Map(); for (const c of orInRange) if (c.kind === 'bad-tool-call' || c.kind === 'bad-request') badTools.set(c.model, (badTools.get(c.model) ?? 0) + 1);
  const modelRows = [...models.values()].map((m) => ({ ...m, avgMs: m.calls ? Math.round(m.ms / m.calls) : 0, avgSteps: m.calls ? Math.round((m.steps / m.calls) * 10) / 10 : 0, tokensPerStep: m.steps ? Math.round(m.input / m.steps) : null, toolFailures: badTools.get(m.model) ?? 0 })).sort((a, b) => b.weighted - a.weighted);
  // events: what happened to limits, in plain terms, newest first
  const events = []; let open = false;
  // The audit trail records a limit each time it is re-noted and cleared each time it is checked: one hit and one resume is what actually happened.
  for (const a of [...audit].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) {
    if (a.what === 'plan-limit') { if (open) continue; open = true; if (inRange(a.at)) events.push({ at: a.at, kind: 'codex-limit', title: 'Codex ran out of usage', detail: '', until: a.until ?? null }); continue; }
    if (a.what === 'plan-limit-cleared') { if (!open) continue; open = false; if (inRange(a.at)) events.push({ at: a.at, kind: 'codex-resume', title: 'Codex is working again', detail: '' }); continue; }
    if (!inRange(a.at)) continue;
    if (a.what === 'openrouter' && a.action === 'fallback') events.push({ at: a.at, kind: 'fallback', title: 'Free models took over from Codex', detail: `${a.role ?? 'an agent'}${a.project ? ` on ${a.project}` : ''}` });
    else if (a.what === 'openrouter' && a.action === 'back-to-plan') events.push({ at: a.at, kind: 'escalation', title: 'Codex redid a job the free models could not do', detail: `${a.role ?? 'an agent'}: ${a.why ?? ''}`.trim() });
    else if (a.what === 'local' && a.action === 'fallback') events.push({ at: a.at, kind: 'fallback', title: 'Local models took over from Codex', detail: `${a.role ?? 'an agent'}${a.project ? ` on ${a.project}` : ''}` });
    else if (a.what === 'local' && a.action === 'next') events.push({ at: a.at, kind: 'escalation', title: `Local models could not do a job, so ${a.to === 'codex' ? 'Codex' : 'the free models'} did`, detail: `${a.role ?? 'an agent'}: ${a.why ?? ''}`.trim() });
    else if (a.what === 'agent-policy') events.push({ at: a.at, kind: 'policy', title: 'Delegation changed', detail: `${a.from?.mode ?? '?'} → ${a.to?.mode ?? '?'}` }); }
  for (const c of orInRange) { const at = new Date(c.at).toISOString(); if (c.ok) continue;
    if (c.kind === 'daily-limit') events.push({ at, kind: 'free-daily', title: 'Free models used up their allowance for the day', detail: 'It resets at midnight (UTC)', model: c.model });
    else if (c.kind === 'rate-limit') events.push({ at, kind: 'free-rest', title: `${String(c.model).split('/').pop()} rate limited`, detail: 'It rests, then returns to the rotation', model: c.model });
    else if (c.kind === 'unavailable') events.push({ at, kind: 'free-down', title: `${String(c.model).split('/').pop()} unavailable`, detail: 'The provider is not serving it right now', model: c.model }); }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  // Codex limit history: each hit, when it was expected back, when it actually lifted
  const hits = audit.filter((a) => a.what === 'plan-limit' || a.what === 'plan-limit-cleared').sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); const history = [];
  for (const a of hits) { const last = history.at(-1); if (a.what === 'plan-limit') { if (last && !last.resumedAt) { if (a.until) last.expected = a.until; } else history.push({ at: a.at, expected: a.until ?? null, resumedAt: null }); } else if (last && !last.resumedAt) last.resumedAt = a.at; }
  for (const h of history) if (!h.resumedAt && h.expected && Date.parse(h.expected) < now) h.resumedAt = h.expected;   // it lifts by itself at the stated time
  for (const h of history) h.durationMs = h.resumedAt ? Math.max(0, Date.parse(h.resumedAt) - Date.parse(h.at)) : null;
  for (let i = history.length - 1; i >= 0; i--) if (!inRange(history[i].at) && !(history[i].resumedAt && inRange(history[i].resumedAt))) history.splice(i, 1);
  const calls = rows.slice(-callsLimit).reverse().map((u) => ({ at: u.at, provider: provOf(u), model: u.model ?? null, role: u.role, project: u.project ?? null, ticket: u.ticket ?? null, run: u.run ?? null, input: u.input ?? 0, cached: u.cached ?? 0, output: u.output ?? 0, steps: u.steps ?? 0, ms: u.ms ?? 0, outcome: outcome(u), why: u.why ?? null }));
  const share = totals.weighted ? byProvider.openrouter.weighted / totals.weighted : 0;
  return { range: { days, from: new Date(from).toISOString(), to: new Date(now).toISOString() }, totals: { ...totals, freeShare: share, localShare: totals.weighted ? byProvider.local.weighted / totals.weighted : 0 }, byProvider, byDay: [...dayMap.values()], byModel: modelRows, byRole: [...roles.values()].sort((a, b) => (b.codex.weighted + b.openrouter.weighted + b.local.weighted) - (a.codex.weighted + a.openrouter.weighted + a.local.weighted)), byProject: [...projects.values()].sort((a, b) => b.weighted - a.weighted),
    events: events.slice(0, 80), limits: { codex: { current: planLimit ? { until: planLimit.until, untilText: planLimit.untilText } : null, history: history.reverse().slice(0, 30) }, free: { budget, freeUntil, credits, freeTier: keyInfo?.freeTier ?? null } }, calls };
}

export function accountsCsv(a) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['time', 'provider', 'model', 'agent', 'project', 'ticket', 'run', 'tokens_in', 'tokens_cached', 'tokens_out', 'steps', 'ms', 'outcome', 'why'];
  return [head.join(','), ...a.calls.map((c) => [c.at, c.provider, c.model, c.role, c.project, c.ticket, c.run, c.input, c.cached, c.output, c.steps, c.ms, c.outcome, c.why].map(q).join(','))].join('\n') + '\n';
}
