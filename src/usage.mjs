// Where the agent plan goes. Every agent call, whichever role made it (builder, reviewer, security, tester, spec-writer, designer, planner, fixer, skill-writer),
// is logged with the tokens it used, split into FRESH input, CACHED input and OUTPUT, so "487k tokens" stops being one opaque number.
// Why the split matters: the agent re-sends its whole conversation at every step, and the provider bills (and limits) re-sent text that it has cached at a small fraction of fresh text.
// Codex's published rate card prices cached input at about a tenth of fresh input and output at several times it, so `weighted` below is an ESTIMATE of plan cost in "fresh-input equivalents",
// not a measured quota. The weights are approximations and live in one place (WEIGHTS) so they can be corrected when the rate card changes.
import fs from 'node:fs';
import path from 'node:path';

export const WEIGHTS = { fresh: 1, cached: 0.1, output: 6 };
const file = (stateDir) => path.join(stateDir, 'usage.jsonl');

// input_tokens normally INCLUDES the cached part (OpenAI's usage reports a cached subset of the prompt). If a source reports more cached than input they were counted separately: then nothing is subtracted.
export const split = (t) => { const n = (v) => Math.max(0, Number(v) || 0); const input = n(t?.input), cached = n(t?.cached), output = n(t?.output); return { fresh: cached <= input ? input - cached : input, cached, output }; };
export const weighted = (u) => Math.round(u.fresh * WEIGHTS.fresh + u.cached * WEIGHTS.cached + u.output * WEIGHTS.output);

export function recordUsage(stateDir, e) {
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.appendFileSync(file(stateDir), `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`); } catch { /* measuring must never break a run */ }
}
export function readUsage(stateDir) {
  try { return fs.readFileSync(file(stateDir), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

const zero = () => ({ calls: 0, fresh: 0, cached: 0, output: 0, ms: 0, weighted: 0, estimated: 0 });
const add = (a, e) => { a.calls++; a.fresh += e.fresh; a.cached += e.cached; a.output += e.output; a.ms += e.ms ?? 0; a.weighted += e.weighted; if (e.estimated) a.estimated++; return a; };

// entries: usage log lines. legacy: older runs that recorded only the builder's input/output (no cached split), included for runs the log does not cover.
export function summarize({ entries, runs = [], days = 14, project, now = Date.now() }) {
  const since = now - days * 86_400_000; const seen = new Set(entries.map((e) => e.run).filter(Boolean)); const all = [];
  for (const e of entries) { if (Date.parse(e.at) < since || (project && e.project !== project)) continue; const u = split({ input: e.input, cached: e.cached, output: e.output }); all.push({ ...e, ...u, weighted: weighted(u) }); }
  for (const r of runs) {   // builder-only history from before the log existed: the cached split is unknown, so everything counts as fresh (an over-estimate, marked)
    if (!r.tokens?.input || seen.has(r.id) || Date.parse(r.finished ?? r.started ?? 0) < since || (project && r.project !== project)) continue;
    const u = { fresh: r.tokens.input, cached: 0, output: r.tokens.output ?? 0 }; all.push({ at: r.finished ?? r.started, role: 'builder', project: r.project, run: r.id, ticket: r.ticket, ...u, weighted: weighted(u), estimated: true });
  }
  const by = (key) => { const m = new Map(); for (const e of all) add(m.get(e[key] ?? '(none)') ?? m.set(e[key] ?? '(none)', zero()).get(e[key] ?? '(none)'), e); return [...m.entries()].map(([k, v]) => ({ [key]: k, ...v })).sort((a, b) => b.weighted - a.weighted); };
  const totals = all.reduce(add, zero()); const dayOf = (e) => String(e.at).slice(0, 10); const byDay = new Map(); for (const e of all) add(byDay.get(dayOf(e)) ?? byDay.set(dayOf(e), zero()).get(dayOf(e)), e);
  const perRun = new Map(); for (const e of all) if (e.run) add(perRun.get(e.run) ?? perRun.set(e.run, { ...zero(), run: e.run, project: e.project, ticket: e.ticket ?? null }).get(e.run), e);
  const share = (rows) => rows.map((r) => ({ ...r, share: totals.weighted ? r.weighted / totals.weighted : 0 }));
  return { days, totals: { ...totals, cachedShare: totals.fresh + totals.cached ? totals.cached / (totals.fresh + totals.cached) : 0, avgInputPerCall: totals.calls ? Math.round((totals.fresh + totals.cached) / totals.calls) : 0 },
    byRole: share(by('role')), byProject: share(by('project')), byDay: [...byDay.entries()].sort().map(([day, v]) => ({ day, ...v })), topRuns: [...perRun.values()].sort((a, b) => b.weighted - a.weighted).slice(0, 8), weights: WEIGHTS, legacyRuns: all.filter((e) => e.estimated).length };
}
