// Setups ("presets"): a named bundle of how agents are set up, so it can be applied in one go and is on by default for new projects.
// A preset says: the factory's default model and effort (agent), a model and effort per role (roles), and which OPTIONAL roles are switched on for a project (projectRoles).
// Built-in presets name no model, so they work on any login; a preset you save from your own setup (or build over MCP) can name models.
// Autonomous merging is deliberately NOT part of a preset: it overrides "the factory never merges" and stays an explicit, per-project choice.
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
export const OPTIONAL = ['reviewer', 'security', 'tester', 'spec-writer'];
export const ROLE_KEYS = ['builder', 'reviewer', 'security', 'tester', 'spec-writer', 'designer', 'planner', 'fixer', 'skill-writer'];
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const BUILTIN = {
  lean: { label: 'Lean', description: 'The builder plus a reviewer. Everything else off. Fewest agent calls per ticket.', evidence: 'A review is small next to the builder (about 35k tokens sent per review against roughly 500k for a builder run), and in a test the reviewer caught every planted defect and a repo-specific CI rule that cheaper models missed.',
    agent: { reasoningEffort: 'low' }, roles: {}, projectRoles: { reviewer: true, security: false, tester: false, 'spec-writer': false } },
  standard: { label: 'Standard (recommended)', description: 'Reviewer, security reviewer, tester and spec writer all on for each project, at low effort.', evidence: 'Low effort gave a good first result on artwork and builds in measurements; one concrete feedback round closed the gap to higher effort. The helpers add little next to the builder.',
    agent: { reasoningEffort: 'low' }, roles: {}, projectRoles: { reviewer: true, security: true, tester: true, 'spec-writer': true } },
  thorough: { label: 'Thorough', description: 'Standard, plus medium effort for the designer and planner, whose output everything else builds on.', evidence: 'Costs more per design and plan; measure with the Orders page before leaving it on.',
    agent: { reasoningEffort: 'low' }, roles: { designer: { reasoningEffort: 'medium' }, planner: { reasoningEffort: 'medium' } }, projectRoles: { reviewer: true, security: true, tester: true, 'spec-writer': true } },
};

const effortOk = (v) => v === null || v === undefined || ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(v);
const modelOk = (v) => v === null || v === undefined || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(String(v));
export function normalizePreset(input, { name } = {}) {
  const n = String(name ?? input?.name ?? '').trim().toLowerCase(); if (!NAME.test(n)) throw bad('A setup name is lowercase letters, digits and dashes (up to 31 characters)');
  if (!input || typeof input !== 'object') throw bad('A setup needs { agent, roles, projectRoles }');
  const unknown = Object.keys(input).filter((k) => !['name', 'label', 'description', 'agent', 'roles', 'projectRoles', 'evidence'].includes(k)); if (unknown.length) throw bad(`"${unknown[0]}" is not part of a setup. A setup has agent, roles and projectRoles`);
  const agent = (v, where) => { if (v === undefined) return undefined; if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${where} must be { model, reasoningEffort }`); const bads = Object.keys(v).filter((k) => !['model', 'reasoningEffort'].includes(k)); if (bads.length) throw bad(`${where}.${bads[0]} cannot be set by a setup`); if (!modelOk(v.model)) throw bad(`${where}.model is not a valid model id`); if (!effortOk(v.reasoningEffort)) throw bad(`${where}.reasoningEffort must be one of none, minimal, low, medium, high, xhigh`); return { ...(v.model !== undefined ? { model: v.model } : {}), ...(v.reasoningEffort !== undefined ? { reasoningEffort: v.reasoningEffort } : {}) }; };
  const roles = {}; for (const [r, v] of Object.entries(input.roles ?? {})) { if (!ROLE_KEYS.includes(r)) throw bad(`Unknown role "${r}". Roles: ${ROLE_KEYS.join(', ')}`); roles[r] = agent(v, `roles.${r}`); }
  const projectRoles = {}; for (const [r, v] of Object.entries(input.projectRoles ?? {})) { if (!OPTIONAL.includes(r)) throw bad(`projectRoles can switch on or off: ${OPTIONAL.join(', ')} (not "${r}")`); if (typeof v !== 'boolean') throw bad(`projectRoles.${r} must be true or false`); projectRoles[r] = v; }
  return { name: n, label: String(input.label ?? n).slice(0, 60), description: String(input.description ?? '').slice(0, 300), evidence: String(input.evidence ?? '').slice(0, 400), ...(input.agent !== undefined ? { agent: agent(input.agent, 'agent') } : {}), roles, projectRoles };
}
