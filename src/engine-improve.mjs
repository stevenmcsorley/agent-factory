// The improvement loop on the engine: scores finished jobs, suggests fixes, applies the ones you approve (a skill the agents receive, or a change of who builds), and keeps what was decided so the
// effect of a fix can be measured later. State: state/improvements.json = { decisions: { id: { status, at, kind, tag, title, why, change, baseline } } }. Installed on Engine.prototype.
import fs from 'node:fs';
import path from 'node:path';
import { readRuns } from './budget.mjs';
import { readUsage } from './usage.mjs';
import * as sk from './skills.mjs';
import { scoreRuns, buildImprovements, TAGS } from './improve.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const ID = /^[a-f0-9]{10}$/;
export const improveMethods = {
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
