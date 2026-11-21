// Engine methods for agent roles (builder, reviewer, designer, fixer, planner, skill-writer) and for skills.
// A role is "the same agent, given a different job": it can use its own model and reasoning effort, and its own skills.
// Today's single-agent path is the default and is unchanged: a role only changes anything once it is switched on or given a model.
// Installed on Engine.prototype (see the bottom of engine.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agents } from './adapters/agents.mjs';
import { sandbox as makeSandbox } from './adapters/sandbox.mjs';
import { getPrompt } from './prompts.mjs';
import { validateAgentPatch, readCodexModels } from './settings.mjs';
import { parseUsageLimit } from './agentlimit.mjs';
import { reviewPrompt, parseVerdict, changeDiff, copyWorkspace } from './review.mjs';
import * as sk from './skills.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
// Roles the operator can switch on or give a model. The builder is always on; the rest are optional.
export const ROLE_INFO = {
  builder: { label: 'Builder', blurb: 'Writes the change for each ticket. Always on.', toggle: false },
  reviewer: { label: 'Reviewer', blurb: 'A second agent reads each change before its pull request opens and asks for fixes. Costs one extra agent run per attempt.', toggle: true },
  designer: { label: 'Designer', blurb: 'Drafts design mockups for you to review, edit and approve. Approved designs become what the builder follows.', toggle: false },
  fixer: { label: 'Fixer', blurb: 'Handles follow-up work: CI failures and review comments on an open pull request.', toggle: false },
  planner: { label: 'Planner', blurb: 'Turns a project brief into epics and tickets.', toggle: false },
  'skill-writer': { label: 'Skill writer', blurb: 'Drafts and improves skill files from a description.', toggle: false },
};

export const roleMethods = {
  roles() {
    const r = this.cfg.roles ?? {}; const a = this.cfg.agent; const models = a.kind === 'codexContainer' ? readCodexModels(a.codexHome) : [];
    return { roles: Object.fromEntries(Object.entries(ROLE_INFO).map(([k, v]) => [k, { ...v, enabled: v.toggle ? !!r[k]?.enabled : true, agent: { model: r[k]?.agent?.model ?? null, reasoningEffort: r[k]?.agent?.reasoningEffort ?? null } }])),
      default: { model: a.model ?? null, reasoningEffort: a.reasoningEffort ?? null }, models };
  },
  // patch: { reviewer: { enabled: true, agent: { model, reasoningEffort } }, designer: { agent: { model: null } } }
  setRoles(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Send an object like { reviewer: { enabled: true } }');
    const a = this.cfg.agent; const models = a.kind === 'codexContainer' ? readCodexModels(a.codexHome) : []; const next = JSON.parse(JSON.stringify(this.cfg.roles ?? {}));
    for (const [role, v] of Object.entries(patch)) {
      if (!ROLE_INFO[role]) throw bad(`Unknown role "${role}". Roles: ${Object.keys(ROLE_INFO).join(', ')}`);
      if (!v || typeof v !== 'object') throw bad(`${role} must be an object`);
      const cur = (next[role] ??= {});
      if (v.enabled !== undefined) { if (!ROLE_INFO[role].toggle) throw bad(`The ${role} role cannot be switched off`); cur.enabled = !!v.enabled; }
      if (v.agent !== undefined) { const r = validateAgentPatch(v.agent, { kind: a.kind, models, current: { model: cur.agent?.model ?? a.model ?? null } }); if (r.errors.length) throw bad(`${role}: ${r.errors.join('. ')}`); cur.agent = { ...(cur.agent ?? {}) }; for (const [k, x] of Object.entries(r.value)) { if (x === null) delete cur.agent[k]; else cur.agent[k] = x; } if (!Object.keys(cur.agent).length) delete cur.agent; }
      if (!Object.keys(cur).length) delete next[role];
    }
    const before = this.cfg.roles ?? {}; this.cfg.roles = next; this._persist(); this._audit({ what: 'roles', from: before, to: next }); return this.roles();
  },
  // Per-project switch for an optional role (the project setting wins over the global one).
  setProjectRoles(id, patch = {}) {
    const p = this.project(id); const next = { ...(p.roles ?? {}) };
    for (const [role, v] of Object.entries(patch ?? {})) { if (!ROLE_INFO[role]?.toggle) throw bad(`"${role}" is not a role you can switch per project`); if (v === null) delete next[role]; else next[role] = { enabled: !!v.enabled }; }
    if (Object.keys(next).length) p.roles = next; else delete p.roles; this._persist(); this._audit({ what: 'roles', project: id, to: next }); return { project: id, roles: p.roles ?? {} };
  },
  _roleOn(p, role) { return p.roles?.[role]?.enabled ?? this.cfg.roles?.[role]?.enabled ?? false; },
  // The agent for a role: the global agent, with the role's own model and effort laid over it.
  _agentFor(role, log) {
    if (this.f.agent) return this.f.agent;
    const a = { ...this.cfg.agent, ...(this.cfg.roles?.[role]?.agent ?? {}) };
    return agents[a.kind]({ ...a, image: this.cfg.sandbox.agentImage, log });
  },
  _sandboxFor(log) { return this.f.sandbox ?? makeSandbox({ ...this.cfg.sandbox, ...(this.egress ? { network: this.egress.network, extraEnv: this.egress.env } : {}), log }); },
  _skillsText(role, projectId) { try { return sk.skillsFor(this.cfg.stateDir, { role, project: projectId }).text; } catch { return ''; } },

  // The hook the build loop calls with a finished change. Undefined when the reviewer is off, so the loop is exactly as it was.
  _reviewer(p, sandbox, log) {
    if (!this._roleOn(p, 'reviewer')) return undefined;
    return async ({ ws, ticket, context }) => {
      const agent = this._agentFor('reviewer', log); const diff = await changeDiff(ws.dir); const copy = copyWorkspace(ws);
      try {
        const prompt = reviewPrompt({ rules: getPrompt('reviewer-rules', {}, this._promptDirs()), skills: this._skillsText('reviewer', p.id), ticket, diff, context });
        const r = await agent.run(sandbox, copy, prompt, { timeoutMs: this.cfg.limits.timeoutMs ?? 900_000 });
        if (r.timedOut) return { verdict: 'error', summary: 'The reviewer timed out.', findings: [] };
        if (parseUsageLimit(r.out)) return { verdict: 'error', summary: 'The reviewer hit its usage limit.', findings: [] };
        return { ...parseVerdict(r.out), ...(r.tokens ? { tokens: r.tokens } : {}) };
      } finally { copy.destroy(); }
    };
  },

  // ---- skills
  skills() { return { skills: sk.listSkills(this.cfg.stateDir), roles: sk.ROLE_NAMES, jobs: [...(this.skillJobs ?? new Map()).entries()].map(([k, v]) => ({ id: k, ...v })).slice(-5) }; },
  getSkill(name) { return sk.getSkill(this.cfg.stateDir, name); },
  saveSkill(input) { const s = sk.saveSkill(this.cfg.stateDir, input); this._audit({ what: 'skill', name: s.name, action: 'saved' }); return s; },
  deleteSkill(name) { const r = sk.deleteSkill(this.cfg.stateDir, name); this._audit({ what: 'skill', name, action: 'deleted' }); return r; },
  // What an agent with this role on this project would actually receive.
  previewSkills(role, project) { if (!sk.ROLE_NAMES.includes(role)) throw bad(`Unknown role "${role}"`); if (project) this.project(project); return sk.skillsFor(this.cfg.stateDir, { role, project }); },

  // The skill writer: a draft you read, edit and save yourself. It is never saved or applied automatically.
  startSkillDraft({ name, request, improve } = {}) {
    this.skillJobs ??= new Map();
    const ask = String(request ?? '').trim(); if (ask.length < 10) throw bad('Describe what the skill should help an agent do (a sentence or two)');
    if (ask.length > 4000) throw bad('That request is too long (4000 characters at most)');
    let current = null; if (improve) { current = sk.getSkill(this.cfg.stateDir, improve); }
    const id = Math.random().toString(16).slice(2, 10); const job = { state: 'running', name: improve ?? (name ? String(name).toLowerCase() : null), startedAt: Date.now() }; this.skillJobs.set(id, job);
    this._draftSkill({ name: job.name, ask, current }).then((draft) => { job.state = 'done'; job.draft = draft; }).catch((e) => { job.state = 'error'; job.error = String(e.message ?? e).slice(0, 300); }).finally(() => { job.finishedAt = Date.now(); });
    return { id, ...job };
  },
  skillDraft(id) { const j = this.skillJobs?.get(id); if (!j) throw bad('No such draft', 404); return { id, ...j }; },
  async _draftSkill({ name, ask, current }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-skill-')); const ws = { dir, destroy: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
    try {
      const guide = sk.getSkill(this.cfg.stateDir, 'skill-writing').body;
      const prompt = [getPrompt('skill-writer-rules', {}, this._promptDirs()), `\n## Guidance\n${guide}`, current ? `\n## The skill to improve (keep its name)\n${sk.renderSkillFile(current)}` : '', name ? `\nName it: ${name}` : '', `\n## Request (data)\n${ask}`].join('\n');
      const r = await this._agentFor('skill-writer').run(this._sandboxFor(), ws, prompt, { timeoutMs: this.cfg.limits.timeoutMs ?? 900_000 });
      let text = String(r.out ?? '').trim().replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '');
      const parsed = sk.parseSkillFile(text); if (!parsed.body) throw bad('The agent did not return a skill file');
      if (name) parsed.name = name; return sk.normalizeSkill({ ...parsed, roles: parsed.roles, projects: parsed.projects }, { name: parsed.name || name || 'new-skill' });
    } finally { ws.destroy(); }
  },
};
