// Autonomous mode, continued: when a pull request is held because it conflicts or the reviewers asked for changes, try to FIX it (a few bounded rounds) instead of
// waiting for a person; and one switch that sets a project up to run start to finish unattended. Installed on Engine.prototype (see the bottom of engine.mjs).
import { hostKind } from './hosts.mjs';
import { resolveConflicts } from './resolve.mjs';
import { reviewFixRound } from './autofix.mjs';
import { AUTONOMY_DEFAULTS } from './autonomy.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export const unattendedMethods = {
  // Called by the autonomous pass for a held PR. Returns the superseding run record when something changed (so the gate can look again), else null.
  // One call = one round, counted per PR; once the project's fixReviewRounds are used up the PR stays held (and the usual notifications fire).
  async _autoFix(p, pr, run, verdict, st, d) {
    const auto = { ...AUTONOMY_DEFAULTS, ...(p.autonomy ?? {}) }; const rounds = auto.fixReviewRounds; if (!rounds || !run) return null;
    const reviewerChanges = run.review?.verdict === 'changes'; let conflicts = false;
    if (hostKind(p) === 'local' && auto.autoResolveConflicts) { const c = await this._forge(p).mergeCheck(pr.number).catch(() => null); conflicts = c?.clean === false; }
    if (!reviewerChanges && !conflicts) return null;
    const hardBlockers = (verdict.blockers ?? []).filter((b) => !/reviewer asked for changes|reviewer did not approve|no reviewer agent/.test(b)); if (hardBlockers.length && !conflicts) return null;   // something a fix round cannot cure (failed checks, caps…)
    st.fixRounds ??= {}; const key = `${p.id}:${pr.number}`; const used = st.fixRounds[key] ?? 0; if (used >= rounds) return null;
    st.fixRounds[key] = used + 1; this._autoSave(st); const base = p.base ?? 'main';
    const ticket = await d.tickets.get?.(run.ticket).catch(() => null) ?? { id: run.ticket, title: pr.title, body: '' };
    this._audit({ what: 'auto-fix', project: p.id, pr: pr.number, round: used + 1, of: rounds, conflicts, reviewer: run.review?.verdict ?? null });
    if (conflicts) { const r = await resolveConflicts(this.deps(p, 'fixer'), pr, { base, findings: this._findingsText(this._assessment(p, run, pr.number)) }); if (r.status !== 'ok') return null; }
    const out = await reviewFixRound(this.deps(p, 'reviewer'), pr, { run, ticket: { id: ticket.id ?? run.ticket, title: ticket.title ?? pr.title, body: ticket.body ?? '' }, reviewFirst: conflicts, round: used + 1 });
    this.cache.delete(`p:${p.id}`); if (!out.review || out.status === 'error') return null;
    const fresh = (await import('./budget.mjs')).readRuns(this.cfg.stateDir).filter((r) => r.project === p.id && r.status === 'ok' && r.pr && /(\d+)$/.exec(String(r.pr))?.[1] === String(pr.number)).at(-1); return fresh ?? null;
  },

  // ---- unattended mode: one switch for "build this project start to finish without me".
  // It sets the roles that suit it (reviewer on; the tester and spec writer on; the security reviewer a choice), and puts the project in autonomous mode with fix rounds and
  // automatic conflict resolution. It still needs what autonomous mode needs (a test command, the factory-wide switch): it explains what is missing instead of half-applying.
  // rounds, autoResolveConflicts and maxMergesPerDay are the values the engine will really use (defaults filled in)
  unattendedStatus(id) {
    const p = this.project(id); const a = p.autonomy; const on = a?.mode === 'merge' && !!this.cfg.autonomy?.allow;
    return { project: id, on, rounds: a ? (a.fixReviewRounds ?? AUTONOMY_DEFAULTS.fixReviewRounds) : null, autoResolveConflicts: a ? (a.autoResolveConflicts ?? AUTONOMY_DEFAULTS.autoResolveConflicts) : null, maxMergesPerDay: a ? (a.maxMergesPerDay ?? AUTONOMY_DEFAULTS.maxMergesPerDay) : null, factorySwitch: !!this.cfg.autonomy?.allow, factoryMergesPerDay: this.cfg.autonomy?.maxMergesPerDay ?? 10,
      roles: Object.fromEntries(['reviewer', 'security', 'tester', 'spec-writer'].map((r) => [r, this._roleOn(p, r)])), hasTestCommand: !!(p.config?.verify || p.profile?.verify), needs: [!this.cfg.autonomy?.allow && 'Turn on autonomous merging for the factory (Settings, or set_autonomy_allowed)', !(p.config?.verify || p.profile?.verify) && 'Set a test command for the project (Code tab, or set_verify)'].filter(Boolean) };
  },
  setUnattended(id, { on = true, rounds = 2, security = false, maxMergesPerDay = 20 } = {}) {
    const p = this.project(id);
    if (!on) { this.setAutonomy(id, { mode: 'off' }); this._audit({ what: 'unattended', project: id, on: false }); return this.unattendedStatus(id); }
    const st = this.unattendedStatus(id); if (st.needs.length) throw bad(`Unattended mode needs: ${st.needs.join('; ')}.`);
    const before = p.roles ?? null; this._applyProjectRoles(p, { reviewer: true, security: !!security, tester: true, 'spec-writer': true });
    try { this.setAutonomy(id, { mode: 'merge', requireReviewer: true, requireChecks: true, fixFailures: true, fixReviewRounds: rounds, autoResolveConflicts: true, maxMergesPerDay }); }
    catch (e) { if (before) p.roles = before; else delete p.roles; throw e; }   // all or nothing
    this._persist(); this._audit({ what: 'unattended', project: id, on: true, rounds, security: !!security }); return this.unattendedStatus(id);
  },
};
