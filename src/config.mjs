import fs from 'node:fs';
import path from 'node:path';
import { validateSource } from './sources.mjs';
import { validateHost, hostKind } from './hosts.mjs';
import { MODEL_RE, EFFORTS } from './settings.mjs';
export { AGENT_LABELS } from './labels.mjs';


// Hosts an agent container legitimately needs. Everything else is blocked by the egress proxy.
export const EGRESS_DEFAULTS = {
  claudeContainer: ['api.anthropic.com'],
  codexContainer: ['chatgpt.com', 'auth.openai.com', 'api.openai.com'],
};
// Package registries the sandbox may reach so a project's test command can install its dependencies: npm for Node, PyPI (index + file host) for Python.
export const PACKAGE_HOSTS = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'];

export const DEFAULTS = {
  stateDir: 'state',
  ui: { host: '127.0.0.1', port: 7777 },
  agent: { kind: 'codexContainer' },
  sandbox: { kind: 'docker', image: 'node:22-bookworm', agentImage: 'agent-factory-agent:latest' },
  limits: { maxConcurrent: 1, maxAttempts: 2, timeoutMs: 900000, maxRunsPerDay: 20 },
  pollMs: 60000,
  projects: [],
};

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function withDefaults(cfg) {
  const c = { ...DEFAULTS, ...cfg, ui: { ...DEFAULTS.ui, ...cfg.ui }, sandbox: { ...DEFAULTS.sandbox, ...cfg.sandbox }, limits: { ...DEFAULTS.limits, ...cfg.limits } };
  c.agent = { ...DEFAULTS.agent, ...cfg.agent };
  if (c.sandbox.egress === undefined && EGRESS_DEFAULTS[c.agent.kind])
    c.sandbox.egress = { allow: [...EGRESS_DEFAULTS[c.agent.kind], ...PACKAGE_HOSTS] };
  return c;
}

// Returns a list of human-readable problems (empty = valid). Strict on the things that are security boundaries.
export function validateConfig(cfg) {
  const e = [];
  if (!['claude', 'claudeContainer', 'codex', 'codexContainer', 'shell'].includes(cfg.agent?.kind)) e.push(`agent.kind "${cfg.agent?.kind}" is not supported`);
  if (cfg.agent?.kind === 'codexContainer' && !cfg.agent.codexHome) e.push('agent.codexHome is required for codexContainer (a dedicated login directory, never ~/.codex)');
  if (['claude', 'codex'].includes(cfg.agent?.kind)) e.push(`agent.kind "${cfg.agent.kind}" runs on the host without isolation; use ${cfg.agent.kind}Container (set agent.allowHostAgent=true to override)`.replace(/.*/, (m) => (cfg.agent.allowHostAgent ? '' : m)));
  if (cfg.agent?.model != null && !MODEL_RE.test(String(cfg.agent.model))) e.push(`agent.model "${cfg.agent.model}" is not a valid model id`);
  if (cfg.agent?.reasoningEffort != null && !EFFORTS.includes(cfg.agent.reasoningEffort)) e.push(`agent.reasoningEffort must be one of ${EFFORTS.join(', ')}`);
  if (cfg.ui.host && !['127.0.0.1', 'localhost', '::1'].includes(cfg.ui.host) && !cfg.ui.allowRemote) e.push('ui.host must be loopback unless ui.allowRemote=true (put TLS in front and keep the UI token secret)');
  const seen = new Set();
  for (const p of cfg.projects ?? []) {
    if (!ID.test(p.id ?? '')) e.push(`project id "${p.id}" must match ${ID}`);
    if (seen.has(p.id)) e.push(`duplicate project id "${p.id}"`);
    seen.add(p.id);
    e.push(...validateHost(p));
    const t = p.tickets ?? {};
    e.push(...validateSource(t).map((x) => `project ${p.id}: ${x}`));
    if (t.kind === 'github' && hostKind(p) !== 'github') e.push(`project ${p.id}: GitHub Issues can only be used with a GitHub repository; pick another ticket source (Jira, Linear, Ossicone) for ${hostKind(p)}`);
    if (t.kind !== 'github' && t.kind !== 'file' && hostKind(p) !== 'git' && !p.feedbackAuthors?.length) e.push(`project ${p.id}: feedbackAuthors must list who may comment on pull requests (usernames on ${hostKind(p)})`);
    for (const r of p.allowedRepos ?? []) if (!/^[\w.-]+(\/[\w.-]+)+$/.test(r)) e.push(`project ${p.id}: allowedRepos entry "${r}" must look like owner/name`);
  }
  return e.filter(Boolean);
}

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = withDefaults(raw);
  cfg.stateDir = path.resolve(path.dirname(file), cfg.stateDir);
  return cfg;
}

// Atomic write, owner-only: the file names repos and (indirectly) what the factory may do.
export function saveConfig(file, cfg) {
  const out = { ...cfg, stateDir: path.relative(path.dirname(path.resolve(file)), cfg.stateDir) || '.' };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// KEY=VALUE secrets file (0600) loaded into process.env at startup; never logged, never mounted into containers wholesale.
export function loadSecrets(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
