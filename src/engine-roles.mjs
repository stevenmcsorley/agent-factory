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
import { recordUsage } from './usage.mjs';
import { needsTests, testerPrompt, snapshot, restore, dropSnapshot, forbiddenChanges, hashes } from './tester.mjs';
import { run } from './util.mjs';
import { reviewPrompt, parseVerdict, changeDiff, copyWorkspace, combineReviews } from './review.mjs';
import * as sk from './skills.mjs';
import * as pk from './pack.mjs';
import { profileSummary } from './analyze.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
// Roles the operator can switch on or give a model. The builder is always on; the rest are optional.
export const ROLE_INFO = {
  builder: { label: 'Builder', blurb: 'Writes the change for each ticket. Always on.', toggle: false },
  reviewer: { label: 'Reviewer', blurb: 'A second agent reads each change before its pull request opens and asks for fixes. Costs one extra agent run per attempt.', toggle: true },
  security: { label: 'Security reviewer', blurb: 'A second reviewer that looks only for security problems (injection, missing access checks, secrets, insecure defaults). Runs with the reviewer or on its own.', toggle: true },
  tester: { label: 'Tester', blurb: 'When the builder changes source code but adds no tests, a second agent writes them. It may only add or change test files, the whole test command must still pass, and if not, everything it did is undone.', toggle: true },
  designer: { label: 'Designer', blurb: 'Drafts design mockups for you to review, edit and approve. Approved designs become what the builder follows.', toggle: false },
  fixer: { label: 'Fixer', blurb: 'Handles follow-up work: CI failures and review comments on an open pull request.', toggle: false },
  planner: { label: 'Planner', blurb: 'Turns a project brief into epics and tickets.', toggle: false },
  'spec-writer': { label: 'Spec writer', blurb: 'When a ticket is too vague to start, drafts acceptance criteria, scope and assumptions into the ticket instead of parking it. Once per ticket; clearly marked as drafted by an agent.', toggle: true },
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
  _agentFor(role, log, ctx = {}) {
    // OpenRouter is this role's first choice, or it stands in while the plan is limited (see engine-openrouter.mjs).
    const viaOr = !this.f.agent && (this._roleUsesOpenRouter(role) || (!!this.planLimit() && this._fallbackCovers(role)));
    let agent = this.f.agent; if (!agent) { if (viaOr) agent = this._orAgent(role, log, ctx); else { const a = { ...this.cfg.agent, ...(this.cfg.roles?.[role]?.agent ?? {}) }; agent = agents[a.kind]({ ...a, image: this.cfg.sandbox.agentImage, log }); } }
    // The one place every agent call passes through, whichever role: the first sign of the plan's usage limit pauses every agent (engine-limit.mjs), and the tokens used are logged (usage.mjs).
    return { ...agent, run: async (...args) => { const t0 = Date.now(); let r = await agent.run(...args); let lim = parseUsageLimit(r?.out); let swapped = false;
      // the plan ran out in the middle of this call: say so, and (when OpenRouter is set to stand in) do the same job again on a free model instead of failing it
      if (lim && agent.name !== 'openrouter' && !this.f.agent && this._fallbackCovers(role)) { this._noteLimit(lim); this._audit({ what: 'openrouter', action: 'fallback', role, project: ctx.project ?? null }); r = await this._orAgent(role, log, ctx).run(...args); lim = parseUsageLimit(r?.out); swapped = true; } if (lim) this._noteLimit(lim);
      const meta = args[3]?.meta ?? {}; recordUsage(this.cfg.stateDir, { role, project: ctx.project ?? meta.project ?? null, run: meta.run ?? null, ticket: meta.ticket ?? null, ref: meta.ref ?? null, model: r?.model ?? ((this.cfg.roles?.[role]?.agent?.model ?? this.cfg.agent.model) ?? null), via: r?.models || agent.name === 'openrouter' || swapped ? 'openrouter' : null, input: r?.tokens?.input ?? 0, cached: r?.tokens?.cached ?? 0, output: r?.tokens?.output ?? 0, steps: r?.tokens?.steps ?? 0, ms: Date.now() - t0, ...(lim ? { limited: true } : {}) }); return r; } };
  },
  _sandboxFor(log) { return this.f.sandbox ?? makeSandbox({ ...this.cfg.sandbox, ...(this.egress ? { network: this.egress.network, extraEnv: this.egress.env } : {}), log }); },
  _skillsText(role, projectId) { try { return sk.skillsFor(this.cfg.stateDir, { role, project: projectId }).text; } catch { return ''; } },

  // The hook the build loop calls with a finished change. Undefined when no review role is on, so the loop is exactly as it was.
  // The reviewer and the security reviewer are separate passes with their own prompt, skills and model; the verdicts are combined.
  _reviewer(p, sandbox, log) {
    const passes = [['reviewer', 'reviewer-rules'], ['security', 'security-rules']].filter(([role]) => this._roleOn(p, role)); if (!passes.length) return undefined;
    return async ({ ws, ticket, context: ctx0, role: announce, meta }) => {
      const context = [ctx0, this._designCheckText(p, ticket, ws.dir)].filter(Boolean).join('\n\n'); const diff = await changeDiff(ws.dir); const results = [];
      for (const [role, rules] of passes) {
        announce?.(role, role === 'security' ? 'checking for security problems' : 'reading the change'); const copy = copyWorkspace(ws);
        try {
          const prompt = reviewPrompt({ rules: getPrompt(rules, {}, this._promptDirs()), skills: this._skillsText(role, p.id), ticket, diff, context });
          const r = await this._agentFor(role, log, { project: p.id }).run(sandbox, copy, prompt, { timeoutMs: this.cfg.limits.timeoutMs ?? 900_000, meta });
          if (r.timedOut) results.push({ role, verdict: 'error', summary: `The ${role} pass timed out.`, findings: [] });
          else if (parseUsageLimit(r.out)) results.push({ role, verdict: 'error', summary: `The ${role} pass hit its usage limit.`, findings: [] });
          else results.push({ role, ...parseVerdict(r.out), ...(r.tokens ? { tokens: r.tokens } : {}) });
        } finally { copy.destroy(); }
      }
      return combineReviews(results);
    };
  },

  // The tester hook. Undefined when the role is off. Everything it does is measured against a snapshot of the builder's change, and undone on any breach.
  _tester(p, sandbox, log) {
    if (!this._roleOn(p, 'tester')) return undefined;
    return async ({ ws, ticket, files, rerun, meta }) => {
      const snap = await snapshot(ws); const before = await hashes(ws, snap.files);
      try {
        const diff = await changeDiff(ws.dir); const prompt = testerPrompt({ rules: getPrompt('tester-rules', {}, this._promptDirs()), skills: this._skillsText('tester', p.id), ticket, files, diff });
        const r = await this._agentFor('tester', log, { project: p.id }).run(sandbox, ws, prompt, { timeoutMs: this.cfg.limits.timeoutMs ?? 900_000, meta });
        const undo = async (summary) => { await restore(ws, snap); return { status: 'reverted', summary, files: [] }; };
        if (r.timedOut) return await undo('it timed out');
        if (parseUsageLimit(r.out)) return await undo('it hit its usage limit');
        const bad = await forbiddenChanges(ws, snap, before); if (bad.length) return await undo(`it changed non-test files: ${bad.slice(0, 3).join(', ')}`);
        const added = (await run('git', ['status', '--porcelain'], { cwd: ws.dir })).out.split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, '').trim()).filter((f) => !snap.files.has(f) || before.get(f) === undefined);
        if (!added.length) return await undo('it added no tests');
        if (!(await rerun())) return await undo('the test command failed with its tests');
        return { status: 'added', files: added, summary: String(r.out ?? '').trim().slice(0, 300) };
      } finally { dropSnapshot(snap); }
    };
  },

  // The spec-writer hook: returns Markdown to append to a vague ticket, or null. Runs in an empty folder (it needs the ticket and repo summary, not the code).
  _clarifier(p, sandbox, log) {
    if (!this._roleOn(p, 'spec-writer')) return undefined;
    return async (t, problems, meta) => {
      // A shallow checkout so it can name real files; if the clone fails it still works from the ticket and the repo summary.
      let ws; try { const a = this._hostAdapter(p); ws = await sandbox.create({ cloneUrl: a.cloneUrl(p.repo), branch: 'spec', base: p.base, newBranch: false, gitEnv: a.gitEnv?.() ?? {}, depth: 1 }); } catch { /* fall back below */ }
      if (!ws) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-spec-')); ws = { dir, destroy: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } }; }
      try {
        const ctx = (() => { try { const d = pk.packDir(this.cfg.stateDir, p.id); return pk.renderContext(pk.loadPack(d), d, t); } catch { return ''; } })();
        const prompt = [getPrompt('spec-writer-rules', {}, this._promptDirs()), this._skillsText('spec-writer', p.id) ? `\n${this._skillsText('spec-writer', p.id)}` : '', p.profile ? `\n## About the repository\n${profileSummary(p.profile)}` : '', ctx ? `\n## Project context (data)\n${ctx.slice(0, 5000)}` : '',
          `\n## The ticket (data)\nTitle: ${t.title}\n\n${String(t.body ?? '').slice(0, 3000)}`, `\n## Why it was not clear enough\n${(problems ?? []).join('; ')}`].join('\n');
        const r = await this._agentFor('spec-writer', log, { project: p.id }).run(sandbox, ws, prompt, { timeoutMs: Math.min(this.cfg.limits.timeoutMs ?? 900_000, 300_000), meta });
        const out = String(r.out ?? '').trim().replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, ''); if (r.timedOut || !/^## Acceptance criteria/m.test(out)) return null;
        return out.slice(out.search(/^## Acceptance criteria/m)).slice(0, 2500);
      } finally { try { ws.destroy(); } catch { /* best effort */ } }
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
    this.assertAgentAvailable(); this.skillJobs ??= new Map();
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
      const r = await this._agentFor('skill-writer', undefined, {}).run(this._sandboxFor(), ws, prompt, { timeoutMs: this.cfg.limits.timeoutMs ?? 900_000, meta: { ref: `skill ${name ?? ''}`.trim() } });
      let text = String(r.out ?? '').trim().replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '');
      const parsed = sk.parseSkillFile(text); if (!parsed.body) throw bad('The agent did not return a skill file');
      if (name) parsed.name = name; return sk.normalizeSkill({ ...parsed, roles: parsed.roles, projects: parsed.projects }, { name: parsed.name || name || 'new-skill' });
    } finally { ws.destroy(); }
  },
};
