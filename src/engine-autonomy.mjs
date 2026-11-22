// Engine methods for autonomous mode: merge what is safe to merge, watch what was merged, file a fix when the pipeline breaks.
// Installed on Engine.prototype (see the bottom of engine.mjs). Nothing here runs unless the factory-wide switch AND the project's mode are on.
import fs from 'node:fs';
import path from 'node:path';
import { readRuns } from './budget.mjs';
import { buildHost, hostKind } from './hosts.mjs';
import { normalizeAutonomy, mergeVerdict, fixTicket, AUTONOMY_DEFAULTS } from './autonomy.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const day = () => new Date().toISOString().slice(0, 10);

export const autonomyMethods = {
  autonomy() { return { allow: !!this.cfg.autonomy?.allow, maxMergesPerDay: this.cfg.autonomy?.maxMergesPerDay ?? 10, mergedToday: this._mergesToday() }; },
  // The factory-wide switch. Turning it off stops every project at once; nothing already merged is touched.
  setAutonomyAllowed({ allow, maxMergesPerDay } = {}) {
    const next = { ...(this.cfg.autonomy ?? {}) };
    if (allow !== undefined) { if (typeof allow !== 'boolean') throw bad('allow must be true or false'); next.allow = allow; }
    if (maxMergesPerDay !== undefined) { const n = Number(maxMergesPerDay); if (!Number.isInteger(n) || n < 1 || n > 500) throw bad('maxMergesPerDay must be a whole number from 1 to 500'); next.maxMergesPerDay = n; }
    const before = this.cfg.autonomy ?? {}; this.cfg.autonomy = next; this._persist(); this._audit({ what: 'autonomy', scope: 'factory', from: before, to: next }); return this.autonomy();
  },
  setAutonomy(id, input) {
    const p = this.project(id); const next = normalizeAutonomy(input, p.autonomy ?? {});
    if (next?.mode === 'merge') {
      if (!this.cfg.autonomy?.allow) throw bad('Autonomous merging is switched off for the whole factory. Turn it on in Settings (or set_autonomy_allowed) first.');
      if (next.requireReviewer && !this._roleOn(p, 'reviewer')) throw bad('Autonomous mode needs the reviewer agent on for this project (set_project_roles), or set requireReviewer to false.');
      if (next.requireChecks && !(p.config?.verify || p.profile?.verify)) throw bad('Autonomous mode needs a test command for this project, so every change is machine-checked. Set one on the Code tab, or set requireChecks to false.');
      if (!['github', 'local', 'gitlab', 'bitbucket'].includes(hostKind(p))) throw bad(`Autonomous merging works with GitHub, GitLab, Bitbucket and the local forge, not ${hostKind(p)} (a plain git remote has no pull requests to merge).`);
    }
    const before = p.autonomy ?? null; if (next) p.autonomy = next; else delete p.autonomy;
    this._persist(); this._audit({ what: 'autonomy', project: id, from: before, to: p.autonomy ?? null }); return this.autonomyStatus(id);
  },
  autonomyStatus(id) { const p = this.project(id); const st = this._autoState(); return { project: id, global: this.autonomy(), settings: { ...AUTONOMY_DEFAULTS, ...(p.autonomy ?? {}) }, active: p.autonomy?.mode === 'merge' && !!this.cfg.autonomy?.allow, held: st.held?.[id] ?? [], recent: (st.merges ?? []).filter((m) => m.project === id).slice(-10).reverse(), fixes: Object.entries(st.fixCounts ?? {}).filter(([k]) => k.startsWith(`${id}:`)).map(([k, n]) => ({ workflow: k.slice(id.length + 1), attempts: n })) }; },

  _autoFile() { return path.join(this.cfg.stateDir, 'autopilot.json'); },
  _autoState() { try { return JSON.parse(fs.readFileSync(this._autoFile(), 'utf8')); } catch { return {}; } },
  _autoSave(st) { const f = this._autoFile(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, JSON.stringify(st, null, 2)); fs.renameSync(`${f}.tmp`, f); },
  _mergesToday(id) { return (this._autoState().merges ?? []).filter((m) => m.at.startsWith(day()) && (!id || m.project === id)).length; },
  _hostAdapter(p) { return this.f.hostAdapter?.(p) ?? buildHost(p, { stateDir: this.cfg.stateDir, env: this.env, fetchImpl: this.f.fetch, exec: this.f.exec }); },

  async _mergePr(p, pr) {
    const a = this._hostAdapter(p);
    if (a.forge) return a.merge(pr.number);
    if (typeof a.pr?.merge !== 'function') throw bad(`Merging is not supported for ${hostKind(p)} yet`);
    return a.pr.merge(pr);
  },

  // One pass for one project: merge every pull request that meets every condition, record why the rest are held.
  async autopilot(p) {
    const auto = p.autonomy; const results = [];
    if (auto?.mode !== 'merge' || !this.cfg.autonomy?.allow) return results;
    const d = this.deps(p); const st = this._autoState(); st.held ??= {}; st.merges ??= []; const held = [];
    const runs = readRuns(this.cfg.stateDir).filter((r) => r.project === p.id && r.status === 'ok' && r.pr);
    const byNumber = new Map(); for (const r of runs) { const n = /(\d+)$/.exec(String(r.pr))?.[1]; if (n) byNumber.set(Number(n), r); }
    const prState = (() => { try { return JSON.parse(fs.readFileSync(path.join(d.stateDir, 'prs.json'), 'utf8')); } catch { return {}; } })();
    for (const pr of await d.host.listAgentPrs()) {
      const fb = await d.host.getFeedback(pr);
      const todays = st.merges.filter((m) => m.at.startsWith(day())); const globalLimit = this.cfg.autonomy.maxMergesPerDay ?? 10;   // counted from the live list, so merges earlier in this same pass count
      let v = mergeVerdict({ global: this.cfg.autonomy, auto, run: byNumber.get(pr.number), feedback: fb, seenComments: prState[pr.number]?.seen ?? [], mergedToday: todays.filter((m) => m.project === p.id).length });
      // held for something a fix can cure (the reviewers asked for changes, or it conflicts)? Try a bounded round, then look at the gate again
      if (!v.ok) { const fresh = await this._autoFix(p, pr, byNumber.get(pr.number), v, st, d).catch((e) => { this._audit({ what: 'auto-fix-error', project: p.id, pr: pr.number, error: String(e.message ?? e).slice(0, 200) }); return null; });
        if (fresh) { byNumber.set(pr.number, fresh); const fb2 = await d.host.getFeedback(pr).catch(() => fb); v = mergeVerdict({ global: this.cfg.autonomy, auto, run: fresh, feedback: fb2, seenComments: prState[pr.number]?.seen ?? [], mergedToday: todays.filter((m) => m.project === p.id).length }); } }
      if (v.ok && todays.length >= globalLimit) v = { ok: false, blockers: [`the factory-wide limit of ${globalLimit} automatic merges today is reached`] };
      if (!v.ok) { held.push({ pr: pr.number, title: pr.title, blockers: v.blockers }); results.push({ pr: pr.number, status: 'held' }); continue; }
      try {
        await this._mergePr(p, pr); const rec = byNumber.get(pr.number);
        st.merges.push({ project: p.id, pr: pr.number, title: pr.title, ticket: rec?.ticket, at: new Date().toISOString(), review: rec?.review?.verdict ?? null });
        this._audit({ what: 'merge', auto: true, project: p.id, pr: pr.number, ticket: rec?.ticket, review: rec?.review?.verdict ?? null, checked: rec?.verifyCmd ?? null });
        if (rec?.ticket != null) { try { await d.tickets.comment(rec.ticket, `agent-factory merged ${pr.title ? `"${pr.title}"` : `#${pr.number}`} automatically (autonomous mode): checks passed${rec.review ? `, reviewer ${rec.review.verdict}` : ''}.`); await d.tickets.close?.(rec.ticket); } catch { /* the merge happened; closing the ticket is best effort */ } }
        this._notify({ event: 'merged', project: p.id, title: pr.title ?? `PR #${pr.number}`, detail: 'merged automatically', url: this._hostAdapter(p).prUrl?.(p.repo, pr.number) });
        this.cache.delete(`p:${p.id}`); this.cache.delete(`t:${p.id}`); results.push({ pr: pr.number, status: 'merged' });
      } catch (e) { held.push({ pr: pr.number, title: pr.title, blockers: [`merge refused: ${String(e.message ?? e).slice(0, 200)}`] }); results.push({ pr: pr.number, status: 'merge-failed' }); }
    }
    const before = new Set((st.held[p.id] ?? []).map((x) => x.pr)); for (const x of held) if (!before.has(x.pr)) this._notify({ event: 'held', project: p.id, title: x.title ?? `PR #${x.pr}`, detail: x.blockers[0] });
    st.held[p.id] = held; this._autoSave(st); return results;
  },

  // After merges: a pipeline that breaks becomes a fix ticket, a few attempts at most per workflow, never two for the same failing run.
  async autopilotFixes() {
    const out = []; const st = this._autoState(); st.fixCounts ??= {}; st.fixed ??= {};
    const failing = await this.deployFailures(false); const live = new Set(failing.map((f) => `${f.project}:${f.workflow}`));
    for (const k of Object.keys(st.fixCounts)) if (!live.has(k)) delete st.fixCounts[k];   // the workflow is green again: the count starts over
    for (const f of failing) {
      const p = this.cfg.projects.find((x) => x.id === f.project); const auto = p?.autonomy; if (!p || auto?.mode !== 'merge' || auto.fixFailures === false || !this.cfg.autonomy?.allow) continue;
      const key = `${f.project}:${f.workflow}`; const runKey = `${key}:${f.runId}`;
      if (st.fixed[runKey] || (st.fixCounts[key] ?? 0) >= (auto.fixAttemptsPerWorkflow ?? AUTONOMY_DEFAULTS.fixAttemptsPerWorkflow)) continue;
      try {
        const t = fixTicket(f, { verify: p.config?.verify ?? p.profile?.verify }); const r = await this.createTicket(p.id, t);
        if (r?.queued === false) continue;
        st.fixed[runKey] = new Date().toISOString(); st.fixCounts[key] = (st.fixCounts[key] ?? 0) + 1; this._audit({ what: 'fix-ticket', project: p.id, workflow: f.workflow, run: f.runId, pr: f.pr });
        out.push({ project: p.id, workflow: f.workflow, ticket: r?.id ?? null });
      } catch { /* try again next cycle */ }
    }
    this._autoSave(st); return out;
  },

  async autopilotAll() {
    if (!this.cfg.autonomy?.allow || this.paused()) return [];
    const out = [];
    for (const p of this._dueProjects().filter((x) => x.autonomy?.mode === 'merge')) { try { out.push(...(await this.autopilot(p)).map((r) => ({ project: p.id, ...r }))); } catch (e) { this._audit({ what: 'autopilot-error', project: p.id, error: String(e.message ?? e).slice(0, 200) }); } }
    try { out.push(...(await this.autopilotFixes()).map((r) => ({ kind: 'fix', ...r }))); } catch { /* next cycle */ }
    return out;
  },
};
