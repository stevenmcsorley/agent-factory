// The improvement loop on the engine: scores finished jobs, suggests fixes, applies the ones you approve (a skill the agents receive, or a change of who builds), and keeps what was decided so the
// effect of a fix can be measured later. State: state/improvements.json = { decisions: { id: { status, at, kind, tag, title, why, change, baseline } } }. Installed on Engine.prototype.
import fs from 'node:fs';
import path from 'node:path';
import { readRuns } from './budget.mjs';
import { readUsage } from './usage.mjs';
import * as sk from './skills.mjs';
import { scoreRuns, buildImprovements, TAGS } from './improve.mjs';
import { HARNESS_SINCE, costByModel, harnessVerdict } from './harness.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const ID = /^[a-f0-9]{10}$/;
export const improveMethods = {
  // Is the harness working? What it caught, how often it stepped a job up, and whether the cheaper models are holding up, all from the recorded runs, usage and audit log.
  harnessReport({ days = 30 } = {}) {
    const d = Math.min(90, Math.max(1, Number(days) || 30)); const since = this.cfg.harness?.since ?? HARNESS_SINCE; const cutoff = Date.now() - d * 86_400_000;
    const runs = readRuns(this.cfg.stateDir).filter((r) => Date.parse(r.started) >= cutoff); const usage = readUsage(this.cfg.stateDir).filter((u) => Date.parse(u.at) >= cutoff);
    const audit = (() => { try { return fs.readFileSync(path.join(this.cfg.stateDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-8000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((a) => a && a.what === 'harness' && Date.parse(a.at) >= cutoff); } catch { return []; } })();
    const claims = runs.filter((r) => r.claims && r.claims.findings?.length).map((r) => ({ run: r.id, project: r.project, title: r.title, at: r.started, findings: r.claims.findings.filter((f) => f.blocking).map((f) => f.detail) }));
    const imp = this.improvements({ days: d }); const usual = this.cfg.agent?.model ?? null; const cost = costByModel(usage);
    const cheaperJobs = imp.byModel.filter((m) => m.model !== usual).reduce((n, m) => n + m.jobs, 0);
    const steps = audit.filter((a) => a.action === 'step-up'); const byRole = {}; for (const a of steps) byRole[a.role] = (byRole[a.role] ?? 0) + 1;
    const half = (rs) => rs.length ? { jobs: rs.length, firstTry: rs.filter((r) => (r.attempts ?? 1) === 1).length / rs.length, reviewerChanges: rs.filter((r) => r.review?.verdict === 'changes').length / rs.length } : null;
    const primary = runs.filter((r) => !r.fixRound && !r.round && (r.status === 'ok' || r.status === 'verify-failed'));
    return { days: d, since, usual, claims: { caught: claims.length, recent: claims.slice(-5).reverse() }, stepUps: { count: steps.length, byRole, recent: steps.slice(-5).reverse().map((a) => ({ at: a.at, role: a.role, from: a.from, to: a.to, why: a.why, project: a.project })) },
      models: imp.byModel.map((m) => ({ ...m, ...(cost.find((c) => c.model === m.model) ?? {}) })), cheaperJobs, before: half(primary.filter((r) => r.started < since)), after: half(primary.filter((r) => r.started >= since)), verdict: harnessVerdict({ models: imp.byModel, cost, usual }) };
  },
  _impFile() { return path.join(this.cfg.stateDir, 'improvements.json'); },
  _impLoad() { try { const j = JSON.parse(fs.readFileSync(this._impFile(), 'utf8')); return j && typeof j.decisions === 'object' ? j : { decisions: {} }; } catch { return { decisions: {} }; } },
  _impSave(j) { fs.mkdirSync(this.cfg.stateDir, { recursive: true }); const f = this._impFile(); fs.writeFileSync(`${f}.tmp`, JSON.stringify(j)); fs.renameSync(`${f}.tmp`, f); },
  _scored(days) { return scoreRuns(readRuns(this.cfg.stateDir), readUsage(this.cfg.stateDir), { days: Math.min(90, Math.max(1, Number(days) || 14)) }); },
  improvements({ days = 14 } = {}) {
    const scored = this._scored(days); let names = []; try { names = sk.listSkills(this.cfg.stateDir).map((s) => s.name); } catch { /* none */ }
    const out = buildImprovements({ scored, decisions: this._impLoad().decisions, skillNames: names, policy: { ...this._policy(), tiers: this._tiers() } });
    return { days: Math.min(90, Math.max(1, Number(days) || 14)), ...out, tags: Object.fromEntries(Object.entries(TAGS).map(([k, v]) => [k, v.label])) };
  },
  runScores({ days = 14, limit = 100 } = {}) { return this._scored(days).slice(0, Math.min(500, Math.max(1, Number(limit) || 100))).map((s) => ({ ...s, tags: s.tags.map((t) => ({ ...t, label: TAGS[t.id]?.label ?? t.id })) })); },
  // Apply a suggestion: a skill is saved (you may edit its text first), a route change goes through the same checks as any policy change.
  applyImprovement(id, { text } = {}) {
    if (!ID.test(String(id))) throw bad('That is not a suggestion id'); const cur = this.improvements({ days: 30 }); const idea = cur.ideas.find((i) => i.id === id); if (!idea) throw bad('That suggestion is no longer there. Refresh the page.', 404);
    if (idea.status === 'applied') throw bad('That one is already applied.', 409); const j = this._impLoad();
    if (idea.kind === 'skill') { const c = idea.change.skill; const body = typeof text === 'string' && text.trim() ? text.trim() : c.text; if (body.length > 2000) throw bad('Keep the instruction under 2000 characters.'); this.saveSkill({ name: c.name, description: c.description, source: 'improvement loop', roles: c.roles, projects: c.projects, body }); }
    else if (idea.kind === 'route') this.setAgentPolicy({ routes: idea.change.routes }); else if (idea.kind === 'tier') this.setAgentPolicy({ tiers: idea.change.tiers }); else throw bad('Unknown kind of suggestion');
    j.decisions[id] = { status: 'applied', at: new Date().toISOString(), kind: idea.kind, tag: idea.tag, title: idea.title, why: idea.why, change: idea.change, baseline: { count: idea.count, share: idea.share } }; this._impSave(j);
    this._audit({ what: 'improvement', action: 'applied', id, kind: idea.kind, title: idea.title }); this.notify('improvements'); return this.improvements({ days: 30 }).ideas.find((i) => i.id === id);
  },
  dismissImprovement(id, note = '') {
    if (!ID.test(String(id))) throw bad('That is not a suggestion id'); const idea = this.improvements({ days: 30 }).ideas.find((i) => i.id === id); if (!idea) throw bad('That suggestion is no longer there.', 404);
    const j = this._impLoad(); j.decisions[id] = { status: 'dismissed', at: new Date().toISOString(), kind: idea.kind, tag: idea.tag, title: idea.title, why: idea.why, change: idea.change, note: String(note).slice(0, 200) }; this._impSave(j); this._audit({ what: 'improvement', action: 'dismissed', id, title: idea.title }); this.notify('improvements'); return { ok: true };
  },
  reopenImprovement(id) { if (!ID.test(String(id))) throw bad('That is not a suggestion id'); const j = this._impLoad(); if (j.decisions[id]?.status !== 'dismissed') throw bad('Only a dismissed suggestion can be reopened.', 409); delete j.decisions[id]; this._impSave(j); this.notify('improvements'); return { ok: true }; },
};
