// Reviewing the pull requests the factory opens on a LOCAL forge, from the Inbox: what the reviewers said, merging (which also closes the ticket: it is accepted),
// and rejecting (the PR is closed WITHOUT merging, so the ticket is NOT done and the plan does not move on). Installed on Engine.prototype (see the bottom of engine.mjs).
import { readRuns } from './budget.mjs';
import { hostKind } from './hosts.mjs';
import * as pk from './pack.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const clip = (s, n) => String(s ?? '').slice(0, n);

export const reviewMethods = {
  // The ticket a pull request was built for: the factory's own run record, else the agent/<ticket>-… branch name.
  async _ticketOfPr(p, n) {
    const re = new RegExp(`(?:^|/)${Number(n)}$`); const run = readRuns(this.cfg.stateDir).filter((r) => r.project === p.id && r.ticket != null && re.test(String(r.pr ?? ''))).at(-1);
    if (run) return { ticket: run.ticket, run };
    try { const d = await this._forge(p).diff(n); const m = /^agent\/([\w-]+?)-/.exec(d.pr?.branch ?? ''); if (m) return { ticket: m[1] }; } catch { /* not found */ }
    return null;
  },
  // Everything a person needs to decide, in one place: the reviewers' verdicts and findings, the visual check, the tests added, and why autonomous mode held it back.
  _assessment(p, run, prNumber) {
    if (!run) return null; const r = run.review; const held = (this._autoState().held?.[p.id] ?? []).find((h) => h.pr === prNumber);
    return { reviewer: r ? { verdict: r.verdict, summary: clip(r.summary, 400), passes: r.passes ?? null, findings: (r.findings ?? []).filter((f) => f.severity !== 'minor').slice(0, 5).map((f) => ({ severity: f.severity, source: f.source ?? 'reviewer', file: f.file, line: f.line, issue: clip(f.issue, 300), fix: clip(f.fix, 200) })) } : null,
      visual: run.visual ? { status: run.visual.status, summary: clip(run.visual.summary, 200) } : null, tests: run.tests ? { status: run.tests.status, files: run.tests.files ?? [], summary: clip(run.tests.summary, 200) } : null, held: held?.blockers ?? null };
  },
  // Merge it: the change is accepted, so its ticket closes with it (otherwise the plan would wait on a ticket nobody can close).
  async mergePr(id, n) {
    const p = this.project(id); const f = this._forge(p); const link = await this._ticketOfPr(p, n); const out = await f.merge(n); let ticketClosed = false;
    if (link) { try { const t = this.deps(p).tickets; await t.comment?.(link.ticket, `Merged by you from the Agent Factory review page (#${n}).`); await t.close?.(link.ticket); ticketClosed = true; } catch { /* the merge happened; closing the ticket is best effort */ } this.cache.delete(`t:${id}`); }
    this._audit({ what: 'merge', auto: false, project: id, pr: Number(n), ticket: link?.ticket ?? null }); return { ...out, ticketClosed };
  },
  // Reject it: close the PR without merging. The ticket goes back to "failed" (not done), so what depends on it keeps waiting until you requeue it or decide otherwise.
  // With requeue:true the ticket is also sent straight back to the factory with your reason AND what the reviewers found, so the next attempt starts from that feedback.
  async rejectPr(id, n, { reason, requeue, extra } = {}) {
    const p = this.project(id); const f = this._forge(p); const link = await this._ticketOfPr(p, n); const out = await f.close(n); let marked = false, requeued = false, requeueError = null;
    if (link) {
      const why = [reason ? clip(reason, 800) : '', extra ?? '', requeue ? this._findingsText(this._assessment(p, link.run, Number(n))) : ''].filter(Boolean).join('\n\n');
      try { const t = this.deps(p).tickets; await t.comment?.(link.ticket, `The pull request (#${n}) was closed without merging${reason ? `: ${clip(reason, 500)}` : ''}. This ticket is not done.${requeue ? ' It is going back to the factory.' : ' Requeue it (with more detail) to try again, or close it yourself if you no longer want it.'}`); await t.label?.(link.ticket, ['agent-failed'], ['agent-review', 'agent-working', 'agent-ready']); marked = true; } catch { /* best effort */ }
      this.cache.delete(`t:${id}`);
      if (requeue) { try { await this.ticketAction(id, link.ticket, 'requeue', { details: why ? `Previous attempt (PR #${n}) was rejected.\n${why}` : undefined }); requeued = true; } catch (e) { requeueError = String(e.message ?? e).slice(0, 300); } }
    }
    this._audit({ what: requeue ? 'rebuild' : 'reject', project: id, pr: Number(n), ticket: link?.ticket ?? null }); return { ...out, ticketMarkedFailed: marked, requeued, requeueError };
  },
  // What the reviewers found, as plain text a builder can act on.
  _findingsText(a) { const fs_ = a?.reviewer?.findings ?? []; if (!fs_.length) return ''; return `What the reviewers found:\n${fs_.map((f) => `- ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.issue}${f.fix ? ` (suggested: ${f.fix})` : ''}`.trim()).join('\n')}`; },
  // Throw the attempt away and build it again on the CURRENT main: for a change that conflicts with what has been merged since (the usual cause: it recreated a shared file).
  async rebuildPr(id, n, { reason } = {}) {
    const p = this.project(id); let extra = '';
    if (hostKind(p) === 'local') { const c = await this._forge(p).mergeCheck(n).catch(() => null); const base = p.base ?? 'main'; if (c && c.clean === false) extra = `It conflicted with ${base} in: ${c.conflicts.join(', ') || 'several files'}. ${base} already contains those files: build on top of them, change only what this ticket needs, and do not recreate shared files such as the home page or the stylesheet.`; else if (c?.behind) extra = `${base} has moved on by ${c.behind} commit${c.behind === 1 ? '' : 's'} since this was built: build on top of the current ${base} and do not recreate files that already exist there.`; }
    return this.rejectPr(id, n, { reason: reason || 'Rebuild on the current main.', requeue: true, extra });
  },
  // A ticket whose pull request is still open cannot be "done": merge or reject the PR instead. Works for every host (the open list is read from the host itself).
  async _openAgentPrs(p) { try { return (await this.deps(p).host?.listAgentPrs?.()) ?? []; } catch { return []; } },
  async assertNoOpenPr(p, ticketId) {
    const open = (await this._openAgentPrs(p)).find((x) => String(x.branch ?? '').startsWith(`agent/${ticketId}-`));
    if (open) throw bad(`This ticket's pull request (#${open.number}) is still open. Merge it (the ticket closes with it) or reject it (the ticket goes back to failed) from its review page.`, 409);
  },
  // The number of the pull request a ticket's last run opened, and what became of it on the host: 'merged', 'open', 'closed' (WITHOUT merging) or null when it cannot be known.
  async _ticketPrOutcome(p, ticketId) {
    const run = readRuns(this.cfg.stateDir).filter((r) => r.project === p.id && String(r.ticket) === String(ticketId) && r.pr != null).at(-1); const n = /(\d+)$/.exec(String(run?.pr ?? ''))?.[1]; if (!n) return null;
    const host = this.deps(p).host; if (typeof host?.prState !== 'function') return null; try { return (await host.prState(Number(n))) ?? null; } catch { return null; }
  },
  // Position of a ticket in the plan (epics in order), for "merge this one first".
  _planIndex(id) { const pack = pk.loadPack(this._packDir(id)); const idx = new Map(); let i = 0; for (const e of pack.plan?.epics ?? []) for (const t of e.tickets) { if (t.ticketId) idx.set(String(t.ticketId), i); i++; } return idx; },
  // For the Inbox: would each local pull request merge cleanly, and which ones touch the same files? Computed from the repository, never guessed.
  async _annotateReviews(p, items) {
    if (hostKind(p) !== 'local') return; const f = this._forge(p); const idx = this._planIndex(p.id);
    for (const it of items) { if (!it.pr) continue; it.planOrder = idx.get(String(it.id)) ?? null; try { it.merge = await f.mergeCheck(it.pr.number); } catch { it.merge = null; } }
    for (const a of items) { if (!a.merge?.files?.length) continue; a.overlaps = [];
      for (const b of items) { if (a === b || !b.merge?.files?.length) continue; const mine = new Set(a.merge.files.map((x) => x.path)); const both = b.merge.files.filter((x) => mine.has(x.path)).map((x) => x.path); if (both.length) a.overlaps.push({ pr: b.pr.number, ticket: b.id, title: b.title, files: both.slice(0, 6), earlier: a.planOrder != null && b.planOrder != null ? b.planOrder < a.planOrder : null }); }
      a.mergeAfter = a.overlaps.filter((o) => o.earlier).map((o) => o.pr); }
  },
  // Is this project's plan stuck on a person? Nothing is running or queued, yet work is waiting on pull requests or failures.
  planHealth(id) {
    const pack = pk.loadPack(this._packDir(id)); const plan = pack.plan; if (plan?.status !== 'launched') return null; const pr = this.planProgress(plan);
    if (pr.queued + pr.working > 0) return { stuck: false, ...pr }; if (!pr.review && !pr.failed) return null;
    const held = this._autoState().held?.[id] ?? []; const reasons = [];
    if (pr.review) reasons.push(`${pr.review} pull request${pr.review === 1 ? ' is' : 's are'} waiting for you to merge or reject`);
    if (held.length) { const top = [...new Set(held.flatMap((h) => h.blockers))].slice(0, 3); if (top.length) reasons.push(`autonomous mode is holding ${held.length} back: ${top.join('; ')}`); }
    if (pr.failed) reasons.push(`${pr.failed} ticket${pr.failed === 1 ? '' : 's'} failed`);
    const lim = this.planLimit?.(); if (lim) reasons.push(`agents are also paused by the plan usage limit until ${lim.untilText}${lim.autoResume ? ' (they resume by themselves)' : ''}`);
    if (pr.planned) reasons.push(`${pr.planned} more ticket${pr.planned === 1 ? '' : 's'} cannot start until those are merged`);
    return { stuck: true, ...pr, reasons };
  },
};
