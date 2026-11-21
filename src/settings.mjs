// Settings the operator may change from the UI without editing the config file or restarting: which model the agent
// uses, how hard it reasons, and a short list of guardrail limits. Everything is validated here, so the server and the
// UI share one set of rules. Deliberately NOT editable: agent.kind, sandbox, egress, ui.host, projects (security boundaries
// or things with their own flows).
import fs from 'node:fs';
import path from 'node:path';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
// A model id is passed as one argv element (never through a shell), but it must not start with "-" or contain anything odd.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const MODEL_AGENTS = ['codexContainer', 'claudeContainer'];   // agent kinds that accept a model
export const EFFORT_AGENTS = ['codexContainer'];                      // agent kinds that accept a reasoning effort

// What each limit may be set to. The UI renders its inputs from this table, so it cannot drift from what the server accepts.
export const LIMIT_FIELDS = {
  maxRunsPerDay: { label: 'Runs per day', min: 1, max: 1000, int: true, hint: 'Hard stop for the whole factory; resets at midnight (UTC).' },
  maxAttempts: { label: 'Attempts per ticket', min: 1, max: 5, int: true, hint: 'How many times the agent may retry a ticket whose checks fail.' },
  timeoutMs: { label: 'Time limit per run', min: 60_000, max: 7_200_000, int: true, unit: 'ms', hint: 'The agent is stopped after this long.' },
  parallelProjects: { label: 'Projects in parallel', min: 1, max: 8, int: true, hint: 'Each lane clones a repository and starts a container: mind disk space and rate limits.' },
  dailyBudgetUsd: { label: 'Daily budget (USD)', min: 0, max: 10_000, nullable: true, hint: 'Only meaningful with an API key; empty means no cap. Subscriptions report no cost.' },
};

// What applies when a limit is not in the config file. Mirrors DEFAULTS.limits in config.mjs (a test keeps the two in step).
export const LIMIT_DEFAULTS = { maxAttempts: 2, timeoutMs: 900_000, maxRunsPerDay: 20, parallelProjects: 1, dailyBudgetUsd: null };

const clean = (v) => (v === '' || v === undefined ? null : v);

// Models this login can use, from Codex's own cache (refreshed by the CLI). Returns [] when it is missing or unreadable:
// the UI then falls back to a plain text box and the server still validates the shape.
export function readCodexModels(codexHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
    return (raw.models ?? [])
      .filter((m) => typeof m?.slug === 'string' && MODEL_RE.test(m.slug) && !['hide', 'hidden'].includes(String(m.visibility ?? '').toLowerCase()))
      .map((m) => ({
        slug: m.slug, name: String(m.display_name ?? m.slug), description: String(m.description ?? ''),
        defaultEffort: EFFORTS.includes(m.default_reasoning_level) ? m.default_reasoning_level : null,
        efforts: (m.supported_reasoning_levels ?? []).filter((x) => EFFORTS.includes(x?.effort)).map((x) => ({ effort: x.effort, description: String(x.description ?? '') })),
      }));
  } catch { return []; }
}

// patch: { model?: string|null, reasoningEffort?: string|null }. Returns { value, errors } where value holds only the fields present.
export function validateAgentPatch(patch, { kind, models = [], current = {} } = {}) {
  const value = {}; const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(patch ?? {}, k);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { value, errors: ['agent must be an object'] };
  for (const k of Object.keys(patch)) if (!['model', 'reasoningEffort'].includes(k)) errors.push(`agent.${k} cannot be changed here`);   // kind, codexHome and the rest stay in the config file
  if (errors.length) return { value, errors };
  if (has('model')) {
    const m = clean(typeof patch.model === 'string' ? patch.model.trim() : patch.model);
    if (m !== null && typeof m !== 'string') errors.push('model must be text or empty');
    else if (m !== null && !MODEL_RE.test(m)) errors.push('model must be letters, digits and . _ : - only (up to 64 characters)');
    else if (m !== null && !MODEL_AGENTS.includes(kind)) errors.push(`the ${kind} agent does not take a model`);
    else value.model = m;
  }
  if (has('reasoningEffort')) {
    const r = clean(typeof patch.reasoningEffort === 'string' ? patch.reasoningEffort.trim() : patch.reasoningEffort);
    if (r !== null && !EFFORTS.includes(r)) errors.push(`reasoningEffort must be one of ${EFFORTS.join(', ')} or empty`);
    else if (r !== null && !EFFORT_AGENTS.includes(kind)) errors.push(`the ${kind} agent does not take a reasoning effort`);
    else value.reasoningEffort = r;
  }
  // Cross-check the pair against what the login says the model supports. Only when we know the model: an unlisted (new) model is allowed.
  const effectiveModel = value.model !== undefined ? value.model : current.model ?? null;   // an effort-only change is checked against the model already set
  if (!errors.length && value.reasoningEffort && effectiveModel) {
    const known = models.find((m) => m.slug === effectiveModel);
    if (known?.efforts.length && !known.efforts.some((x) => x.effort === value.reasoningEffort))
      errors.push(`${known.name} supports reasoning effort ${known.efforts.map((x) => x.effort).join(', ')}, not "${value.reasoningEffort}"`);
  }
  return { value, errors };
}

export function validateLimitsPatch(patch) {
  const value = {}; const errors = [];
  for (const [k, raw] of Object.entries(patch ?? {})) {
    const f = LIMIT_FIELDS[k];
    if (!f) { errors.push(`"${k}" cannot be changed here`); continue; }
    const v = raw === '' || raw === undefined ? null : raw;
    if (v === null) { if (f.nullable) value[k] = null; else errors.push(`${f.label} is required`); continue; }
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    if (!Number.isFinite(n)) { errors.push(`${f.label} must be a number`); continue; }
    if (f.int && !Number.isInteger(n)) { errors.push(`${f.label} must be a whole number`); continue; }
    if (n < f.min || n > f.max) { errors.push(`${f.label} must be between ${f.min} and ${f.max}`); continue; }
    value[k] = n;
  }
  return { value, errors };
}

// Pull what a Codex run prints in its header out of a probe's output ("model: gpt-6.2-sol", "reasoning effort: low", "OpenAI Codex v0.169.0").
export function parseCodexHeader(out) {
  const text = String(out ?? '');
  const pick = (re) => re.exec(text)?.[1]?.trim() ?? null;
  return { model: pick(/^model:\s*(\S+)/mi), reasoningEffort: pick(/^reasoning effort:\s*(\S+)/mi), codexVersion: pick(/OpenAI Codex v([\w.+-]+)/i) };
}
