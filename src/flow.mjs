// Flow metrics: how long work really takes from "ready" to "merged", where it waits, how often it needs a second go, and what an accepted change costs.
// Built from two things the factory already writes: run records (runs.jsonl) and lifecycle events (events.jsonl: ready, claimed, pr-opened, parked, failed, closed).
// Pure and deterministic so it can be tested with synthetic timelines. Small samples are reported as such: a median of two tickets is not a trend.
//
//   ready ──queue wait──► claimed ──build time──► pr-opened ──review wait──► closed(merged)        parked ──decision wait──► ready again
//   └──────────────────────────────── ready → merged ────────────────────────────────────────────┘
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p90 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; };
const stat = (xs) => ({ n: xs.length, median: median(xs), p90: p90(xs) });
const rate = (num, den) => (den ? { n: den, value: Math.round((num / den) * 1000) / 1000 } : { n: 0, value: null });
export const ENOUGH = 5;

// One ticket's events in order -> its completed cycles. A cycle ends when the ticket is closed.
export function cycles(events) {
  const out = []; let c = null; const fresh = () => ({ readyAt: null, claimedAt: null, prAt: null, decisionMs: 0, parkedAt: null, claims: 0, parks: 0, failures: 0 });
  for (const e of events) {
    const t = Date.parse(e.at); if (!Number.isFinite(t)) continue; c ??= fresh();
    if (e.event === 'ready') { if (c.parkedAt !== null) { c.decisionMs += t - c.parkedAt; c.parkedAt = null; } c.readyAt ??= t; }
    else if (e.event === 'claimed') { c.claimedAt ??= t; c.claims++; c.readyAt ??= t; }
    else if (e.event === 'pr-opened') { c.prAt = t; }
    else if (e.event === 'parked') { if (c.parkedAt === null) { c.parkedAt = t; c.parks++; } }
    else if (e.event === 'failed') { c.failures++; }
    else if (e.event === 'closed') { if (c.prAt !== null || c.claimedAt !== null) out.push({ ...c, closedAt: t }); c = null; }
  }
  return out;
}

export function flowMetrics({ runs = [], events = [], days = 30, now = Date.now(), project } = {}) {
  const since = now - days * 86_400_000; const inProject = (x) => !project || x.project === project;
  const byTicket = new Map(); for (const e of events.filter(inProject)) { const k = `${e.project}\u0000${e.ticket}`; if (!byTicket.has(k)) byTicket.set(k, []); byTicket.get(k).push(e); }
  const done = []; for (const [k, list] of byTicket) { list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); const [proj, ticket] = k.split('\u0000'); for (const c of cycles(list)) if (c.closedAt >= since) done.push({ project: proj, ticket, ...c }); }
  const ms = (a, b) => (a !== null && b !== null && b >= a ? b - a : null); const keep = (xs) => xs.filter((x) => x !== null);
  const readyToMerged = keep(done.map((c) => ms(c.readyAt, c.closedAt))), queueWait = keep(done.map((c) => ms(c.readyAt, c.claimedAt))), build = keep(done.map((c) => ms(c.claimedAt, c.prAt))), review = keep(done.map((c) => ms(c.prAt, c.closedAt))), decision = done.filter((c) => c.decisionMs > 0).map((c) => c.decisionMs);

  // Runs in the window (ticket runs only, not feedback rounds) for the rates that need attempts, cost and verification.
  const ticketRuns = runs.filter((r) => inProject(r) && r.finished && Date.parse(r.finished) >= since && r.ticket !== undefined && !('round' in r));
  const okRuns = ticketRuns.filter((r) => r.status === 'ok'); const provenance = okRuns.filter((r) => 'commit' in r || 'verifyCmd' in r);   // runs from before provenance existed cannot say either way
  const firstPass = rate(okRuns.filter((r) => r.attempts === 1).length, okRuns.length); const verified = rate(provenance.filter((r) => r.verifyCmd).length, provenance.length);
  const closedKeys = new Set(done.map((c) => `${c.project}\u0000${c.ticket}`)); const acceptedRuns = runs.filter((r) => inProject(r) && r.ticket !== undefined && !('round' in r) && closedKeys.has(`${r.project}\u0000${r.ticket}`));
  const accepted = done.length; const cost = acceptedRuns.reduce((n, r) => n + (r.costUsd ?? 0), 0); const attempts = acceptedRuns.reduce((n, r) => n + (r.attempts ?? 0), 0);
  const rework = rate(done.filter((c) => c.failures > 0 || c.claims > c.parks + 1).length, done.length);     // a claim after the ticket was parked is waiting on a human, not rework
  const feedbackRounds = runs.filter((r) => inProject(r) && 'round' in r && r.finished && Date.parse(r.finished) >= since).length;

  return { days, project: project ?? null, since: events.length ? events.reduce((m, e) => (m === null || e.at < m ? e.at : m), null) : null, accepted,
    readyToMergedMs: stat(readyToMerged), queueWaitMs: stat(queueWait), buildMs: stat(build), reviewWaitMs: stat(review), decisionWaitMs: stat(decision),
    firstPassRate: firstPass, reworkRate: rework, verifiedShare: verified, feedbackRounds,
    perAccepted: { n: accepted, costUsd: accepted ? Math.round((cost / accepted) * 1e4) / 1e4 : null, attempts: accepted ? Math.round((attempts / accepted) * 100) / 100 : null },
    enough: accepted >= ENOUGH, note: accepted >= ENOUGH ? null : `Only ${accepted} accepted change${accepted === 1 ? '' : 's'} so far: treat these as examples, not a trend (about ${ENOUGH} are needed before the medians mean much).` };
}
