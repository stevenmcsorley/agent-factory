// Autonomous mode, continued: when a pull request is held because it conflicts or the reviewers asked for changes, try to FIX it (a few bounded rounds) instead of
// waiting for a person; and one switch that sets a project up to run start to finish unattended. Installed on Engine.prototype (see the bottom of engine.mjs).
import { hostKind } from './hosts.mjs';
import { resolveConflicts } from './resolve.mjs';
import { reviewFixRound } from './autofix.mjs';
import { AUTONOMY_DEFAULTS } from './autonomy.mjs';
import * as pk from './pack.mjs';
import * as ds from './designs.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export const unattendedMethods = {
  // Called by the autonomous pass for a held PR. Returns the superseding run record when something changed (so the gate can look again), else null.
  // One call = one round, counted per PR; once the project's fixReviewRounds are used up the PR stays held (and the usual notifications fire).
  async _autoFix(p, pr, run, verdict, st, d) {
    const auto = { ...AUTONOMY_DEFAULTS, ...(p.autonomy ?? {}) }; const rounds = auto.fixReviewRounds; if (!rounds || !run) return null;
    const reviewerChanges = run.review?.verdict === 'changes'; const reviewerError = run.review?.verdict === 'error'; let conflicts = false;   // an error = the reviewers could not run (a limit, a timeout): look again instead of holding the PR forever
    if (hostKind(p) === 'local' && auto.autoResolveConflicts) { const c = await this._forge(p).mergeCheck(pr.number).catch(() => null); conflicts = c?.clean === false; }
    if (!reviewerChanges && !reviewerError && !conflicts) return null;
    const hardBlockers = (verdict.blockers ?? []).filter((b) => !/reviewer asked for changes|reviewer did not approve|no reviewer agent/.test(b)); if (hardBlockers.length && !conflicts) return null;   // something a fix round cannot cure (failed checks, caps…)
    st.fixRounds ??= {}; st.retryAt ??= {}; const key = `${p.id}:${pr.number}`; const used = st.fixRounds[key] ?? 0; if (used >= rounds) return null; if ((st.retryAt[key] ?? 0) > Date.now()) return null;   // a review that could not run is retried after a pause, not on every pass
    st.fixRounds[key] = used + 1; this._autoSave(st); const base = p.base ?? 'main';
    const ticket = await d.tickets.get?.(run.ticket).catch(() => null) ?? { id: run.ticket, title: pr.title, body: '' };
    this._audit({ what: 'auto-fix', project: p.id, pr: pr.number, round: used + 1, of: rounds, conflicts, reviewer: run.review?.verdict ?? null });
    if (conflicts) { const r = await resolveConflicts(this.deps(p, 'fixer'), pr, { base, findings: this._findingsText(this._assessment(p, run, pr.number)) }); if (r.status !== 'ok') return null; }
    const out = await reviewFixRound(this.deps(p, 'reviewer'), pr, { run, ticket: { id: ticket.id ?? run.ticket, title: ticket.title ?? pr.title, body: ticket.body ?? '' }, reviewFirst: conflicts || reviewerError, round: used + 1 });
    this.cache.delete(`p:${p.id}`);
    // the reviewers could not run (a limit, a timeout): that was not a fix round, so it does not use one up; try again in ten minutes
    if (out.status === 'review-error' || (reviewerError && out.review?.verdict === 'error')) { st.fixRounds[key] = used; st.retryAt[key] = Date.now() + 10 * 60_000; this._autoSave(st); return null; }
    if (!out.review || out.status === 'error') return null;
    const fresh = (await import('./budget.mjs')).readRuns(this.cfg.stateDir).filter((r) => r.project === p.id && r.status === 'ok' && r.pr && /(\d+)$/.exec(String(r.pr))?.[1] === String(pr.number)).at(-1); return fresh ?? null;
  },

  // ---- designs and artwork first. A project that builds unattended should not start building before its screens and artwork exist: the designer makes one screen per page
  // and one artwork set from the brief and the attached sources, each is approved automatically (this is the unattended path; by hand you review them), and the
  // builders then follow them. Tickets are not released while this runs. Idempotent: pages that already have a design are left alone.
  designPassStatus(id) { const s = this._designPass?.get(id); const dir = this._packDir(id); const inUse = ds.inUse(dir).designs.length; return { state: s?.state ?? (inUse ? 'done' : 'none'), total: s?.total ?? 0, done: s?.done ?? 0, error: s?.error ?? null, inUse }; },
  designProject(id, { pages, assets = true, approve = true, force = false, extra = '', onDone } = {}) {
    const dir = this._packDir(id); const pack = pk.loadPack(dir); const goal = (pack.brief?.goal ?? '').trim(); if (!goal) throw bad('Write the brief first (at least the goal): the designer works from it.');
    this._designPass ??= new Map(); if (this._designPass.get(id)?.state === 'running') throw bad('The designer is already working on this project', 409);
    this.assertAgentAvailable(); const have = ds.listDesigns(dir).filter((d) => d.status !== 'archived');
    const found = pages ?? this._designPages(pack); const list = (found.length ? found : ['index.html']).slice(0, 5);
    const jobs = []; const slug = (f) => f.replace(/\.html$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'home'; const scope = pack.brief?.scope ?? '';
    for (const f of list) { if (!force && have.some((d) => d.kind === 'screen' && d.area === slug(f))) continue;
      const line = scope.split('\n').find((l) => l.includes(`\`${f}\``)) ?? '';
      jobs.push({ title: `${f.replace(/\.html$/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())} page`, kind: 'screen', area: slug(f), request: `Design the ${f} page of this site, as a finished full-page mockup at desktop width that also works on a phone.\n\nWhat the project is: ${goal}\n\nThis page, from the brief: ${line.replace(/^[-*\s]+/, '') || f}\n\nFollow the project's design system, copy and artwork sources exactly (colours, type, spacing, components, wording, navigation and footer). Use the real copy; do not invent text.${extra ? `\n\n${extra}` : ''}` }); }
    if (assets && (force || !have.some((d) => d.kind === 'assets'))) jobs.push({ title: 'Brand and artwork set', kind: 'assets', request: `Draw every illustration listed in the project's artwork sources, one SVG per entry, with the file names and sizes given there, in the palette of the design system. Simple geometric shapes, flat fills, clean strokes. No text, fonts, raster data, scripts or external references inside the SVGs.\n\nWhat the project is: ${goal}${extra ? `\n\n${extra}` : ''}` });
    if (!jobs.length) return { started: false, reason: 'every page and the artwork already have a design', ...this.designPassStatus(id) };
    this._designPass.set(id, { state: 'running', total: jobs.length, done: 0, startedAt: Date.now() }); this._audit({ what: 'design-pass', project: id, jobs: jobs.length, approve });
    (async () => { const st = this._designPass.get(id);
      try { for (const j of jobs) { const d = this.startDesign(id, j); const key = `${id}:${d.id}`; while (this.designJobs?.has(key)) await new Promise((r) => setTimeout(r, 500));
          const got = ds.getDesign(dir, d.id); if (got.error || !got.versions.length) throw bad(`The designer could not make "${j.title}": ${got.error ?? 'no result'}`);
          if (approve) this.setDesignStatus(id, d.id, 'approved', got.versions.at(-1).n); st.done++; }
        st.state = 'done'; if (typeof onDone === 'function') await onDone(); } catch (e) { st.state = 'failed'; st.error = String(e.message ?? e).slice(0, 300); }
      this._audit({ what: 'design-pass-end', project: id, state: st.state, done: st.done, error: st.error ?? null }); })();
    return { started: true, jobs: jobs.map((j) => j.title), approve };
  },

  // ---- unattended mode: one switch for "build this project start to finish without me".
  // It sets the roles that suit it (reviewer on; the tester and spec writer on; the security reviewer a choice), and puts the project in autonomous mode with fix rounds and
  // automatic conflict resolution. It still needs what autonomous mode needs (a test command, the factory-wide switch): it explains what is missing instead of half-applying.
  // rounds, autoResolveConflicts and maxMergesPerDay are the values the engine will really use (defaults filled in)
  unattendedStatus(id) {
    const p = this.project(id); const a = p.autonomy; const on = a?.mode === 'merge' && !!this.cfg.autonomy?.allow;
    return { project: id, design: this.designPassStatus(id), designStage: this.designPhaseState(id).state, on, rounds: a ? (a.fixReviewRounds ?? AUTONOMY_DEFAULTS.fixReviewRounds) : null, autoResolveConflicts: a ? (a.autoResolveConflicts ?? AUTONOMY_DEFAULTS.autoResolveConflicts) : null, maxMergesPerDay: a ? (a.maxMergesPerDay ?? AUTONOMY_DEFAULTS.maxMergesPerDay) : null, factorySwitch: !!this.cfg.autonomy?.allow, factoryMergesPerDay: this.cfg.autonomy?.maxMergesPerDay ?? 10,
      roles: Object.fromEntries(['reviewer', 'security', 'tester', 'spec-writer'].map((r) => [r, this._roleOn(p, r)])), hasTestCommand: !!(p.config?.verify || p.profile?.verify), needs: [!this.cfg.autonomy?.allow && 'Turn on autonomous merging for the factory (Settings, or set_autonomy_allowed)', !(p.config?.verify || p.profile?.verify) && 'Set a test command for the project (Code tab, or set_verify)'].filter(Boolean) };
  },
  setUnattended(id, { on = true, rounds = 2, security = false, maxMergesPerDay = 20, designs = true } = {}) {
    const p = this.project(id);
    if (!on) { this.setAutonomy(id, { mode: 'off' }); this._audit({ what: 'unattended', project: id, on: false }); return this.unattendedStatus(id); }
    const st = this.unattendedStatus(id); if (st.needs.length) throw bad(`Unattended mode needs: ${st.needs.join('; ')}.`);
    const before = p.roles ?? null; this._applyProjectRoles(p, { reviewer: true, security: !!security, tester: true, 'spec-writer': true });
    try { this.setAutonomy(id, { mode: 'merge', requireReviewer: true, requireChecks: true, fixFailures: true, fixReviewRounds: rounds, autoResolveConflicts: true, maxMergesPerDay }); }
    catch (e) { if (before) p.roles = before; else delete p.roles; throw e; }   // all or nothing
    this._persist(); this._audit({ what: 'unattended', project: id, on: true, rounds, security: !!security, designs: !!designs });
    let design = null; if (designs) { try { design = this.designProject(id, {}); } catch (e) { design = { started: false, reason: String(e.message ?? e) }; } }   // best effort: the switch itself is already on
    return { ...this.unattendedStatus(id), design };
  },
};
