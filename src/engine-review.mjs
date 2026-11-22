// Reviewing the pull requests the factory opens on a LOCAL forge, from the Inbox: what the reviewers said, merging (which also closes the ticket: it is accepted),
// and rejecting (the PR is closed WITHOUT merging, so the ticket is NOT done and the plan does not move on). Installed on Engine.prototype (see the bottom of engine.mjs).
import { readRuns } from './budget.mjs';
import { hostKind } from './hosts.mjs';

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
  async rejectPr(id, n, { reason } = {}) {
    const p = this.project(id); const f = this._forge(p); const link = await this._ticketOfPr(p, n); const out = await f.close(n); let ticketReopened = false;
    if (link) { try { const t = this.deps(p).tickets; await t.comment?.(link.ticket, `The pull request (#${n}) was closed without merging${reason ? `: ${clip(reason, 500)}` : ''}. This ticket is not done. Requeue it (with more detail) to try again, or close it yourself if you no longer want it.`); await t.label?.(link.ticket, ['agent-failed'], ['agent-review', 'agent-working', 'agent-ready']); ticketReopened = true; } catch { /* best effort */ } this.cache.delete(`t:${id}`); }
    this._audit({ what: 'reject', project: id, pr: Number(n), ticket: link?.ticket ?? null }); return { ...out, ticketMarkedFailed: ticketReopened };
  },
  // A ticket whose pull request is still open cannot be "done": merge or reject the PR instead.
  async assertNoOpenPr(p, ticketId) {
    if (hostKind(p) !== 'local') return;   // other hosts: the PR link works and the factory cannot see what you did there
    const open = (await this.listPrs(p.id).catch(() => [])).find((x) => String(x.branch ?? '').startsWith(`agent/${ticketId}-`));
    if (open) throw bad(`This ticket's pull request (#${open.number}) is still open. Merge it (the ticket closes with it) or reject it (the ticket goes back to failed) from its review page.`, 409);
  },
};
