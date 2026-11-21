// What is every agent doing right now? One list for the factory line: runs in flight (by the agent working inside them) plus the background jobs
// that are not runs at all (the designer, the planner, the skill writer, the visual check). Installed on Engine.prototype (see the bottom of engine.mjs).
import * as ds from './designs.mjs';

export const ROLE_LABEL = { 'spec-writer': 'Spec writer', builder: 'Builder', tester: 'Tester', reviewer: 'Reviewer', security: 'Security reviewer', designer: 'Designer', planner: 'Planner', fixer: 'Fixer', 'skill-writer': 'Skill writer', verify: 'Test command', visual: 'Visual check' };
const CHECKS = new Set(['verify', 'visual']);   // run by the factory, not by an agent
// The agent behind each phase of a run, unless something more precise was announced (a reviewer pass).
const phaseRole = (a) => ({ agent: a.feedback ? 'fixer' : 'builder', tests: 'tester', review: 'reviewer', visual: 'visual', verify: 'verify' })[a.phase] ?? null;
const WHAT = { builder: 'writing the change', fixer: 'answering review feedback', tester: 'adding tests', reviewer: 'reading the change', security: 'checking for security problems', 'spec-writer': 'drafting acceptance criteria', visual: 'loading the app at three widths', verify: 'running the test command' };
const iso = (ms) => new Date(ms).toISOString();

export const agentMethods = {
  _roleModel(role) { if (CHECKS.has(role)) return { model: null, effort: null }; const a = { ...this.cfg.agent, ...(this.cfg.roles?.[role]?.agent ?? {}) }; return { model: a.model ?? null, effort: a.reasoningEffort ?? null }; },
  agentsNow() {
    const out = [];
    for (const a of this.active.values()) {
      const role = a.role ?? phaseRole(a); if (!role) continue;   // claim, sandbox, push and pr are the factory's own plumbing: they show on the line, not as an agent
      out.push({ id: `run:${a.run}`, role, kind: CHECKS.has(role) ? 'check' : 'agent', project: a.project, ticket: a.ticket ?? null, title: a.title ?? null, run: a.run, what: a.roleDetail ?? WHAT[role] ?? a.phase, detail: role === 'builder' || role === 'fixer' ? a.detail ?? null : null, since: a.roleStarted ?? a.phaseStarted ?? a.started, ...this._roleModel(role) });
    }
    for (const [key, job] of this.designJobs ?? []) { const [project, did] = key.split(':'); let title = 'a design', kind = 'screen'; try { const d = ds.getDesign(this._designDir(project), did); title = d.title; kind = d.kind ?? 'screen'; } catch { /* deleted meanwhile */ }
      out.push({ id: `design:${key}`, role: 'designer', kind: 'agent', project, ticket: null, title, what: kind === 'assets' ? 'drawing the artwork' : 'designing the screen', since: iso(job.startedAt), ...this._roleModel('designer') }); }
    for (const [project, job] of this.planJobs ?? []) if (job.state === 'running') out.push({ id: `plan:${project}`, role: 'planner', kind: 'agent', project, ticket: null, title: 'the delivery plan', what: job.phase || 'planning from the brief', since: iso(job.startedAt), ...this._roleModel('planner') });
    for (const [id, job] of this.skillJobs ?? []) if (job.state === 'running') out.push({ id: `skill:${id}`, role: 'skill-writer', kind: 'agent', project: null, ticket: null, title: job.name ?? 'a skill', what: 'drafting the skill', since: iso(job.startedAt), ...this._roleModel('skill-writer') });
    for (const [project, job] of [...(this.visualJobs ?? []), ...(this.screenJobs ?? [])]) if (job.state === 'running') out.push({ id: `visual:${project}:${job.startedAt}`, role: 'visual', kind: 'check', project, ticket: null, title: 'the current app', what: job.phase || 'checking the app', since: iso(job.startedAt), model: null, effort: null });
    return out.sort((a, b) => String(a.since).localeCompare(String(b.since)));
  },
  // Which tiles to show, in pipeline order: the optional roles only when some project uses them.
  agentRoster() {
    const anyOn = (role) => !!(this.cfg.roles?.[role]?.enabled) || this.cfg.projects.some((p) => this._roleOn(p, role));
    const order = [['spec-writer', anyOn('spec-writer')], ['builder', true], ['verify', true], ['tester', anyOn('tester')], ['visual', this.cfg.projects.some((p) => p.preview && p.preview.enabled !== false)], ['reviewer', anyOn('reviewer')], ['security', anyOn('security')], ['designer', true], ['planner', true], ['fixer', true], ['skill-writer', false]];
    return order.map(([role, enabled]) => ({ role, label: ROLE_LABEL[role], kind: CHECKS.has(role) ? 'check' : 'agent', enabled, ...this._roleModel(role) }));
  },
};
