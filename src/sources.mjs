import { githubTickets } from './adapters/tickets-github.mjs';
import { ossiconeTickets } from './adapters/tickets-ossicone.mjs';
import { jiraTickets } from './adapters/tickets-jira.mjs';
import { linearTickets } from './adapters/tickets-linear.mjs';
import { fileTickets } from './adapters/tickets-file.mjs';

// Where tickets live. Each source describes itself (fields for the setup wizard), validates its config, builds an adapter, and can
// `identify()` the connected account (the wizard's "Test connection": who am I, which projects can I pick). Tokens are NEVER stored
// in the config: it holds only `tokenEnv`, the NAME of an environment variable (kept in the owner-only secrets file).
// To add a tracker: implement the small adapter interface (poll, listWorking, listAgentTickets, label, comment, create, identify),
// add an entry here, and it appears in the UI, CLI validation and MCP automatically.

// Only AF_* names: a project may only ever read secrets the factory itself stored, never arbitrary process env (AWS keys, etc.).
export const TOKEN_ENV = /^AF_[A-Z0-9_]{1,60}$/;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/;

// Server-side requests go to user-supplied URLs, so refuse the dangerous ones: credentials in the URL, cloud metadata/link-local
// addresses, and plain http to anything that is not localhost or a private network.
export function checkBaseUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error('That does not look like a URL (include https://)'); }
  if (u.username || u.password) throw new Error('Do not put credentials in the URL; they are entered separately');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^169\.254\./.test(host) || /metadata/i.test(host) || host === '0.0.0.0') throw new Error('That address is not allowed');
  const local = host === 'localhost' || host === '::1' || PRIVATE_V4.test(host) || host.endsWith('.local') || host.endsWith('.internal');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('Use https:// (plain http is only allowed for localhost and private networks)');
  return u.origin + u.pathname.replace(/\/$/, '');
}

const need = (t, keys) => keys.filter((k) => t[k] === undefined || t[k] === '' || (Array.isArray(t[k]) && !t[k].length)).map((k) => `tickets.${k} is required`);
const tokenProblem = (t) => (TOKEN_ENV.test(t.tokenEnv ?? '') ? [] : ['tickets.tokenEnv must be an environment variable NAME like AF_MYPROJECT_TOKEN (the token itself is stored separately)']);
const urlProblem = (t) => { try { checkBaseUrl(t.baseUrl); return []; } catch (e) { return [`tickets.baseUrl: ${e.message}`]; } };

export const SOURCES = {
  github: {
    label: 'GitHub Issues', blurb: 'Label an issue agent-ready in the repository itself. No extra setup.', fields: [], pick: null,
    validate: (t) => need(t, ['allowedAuthors']).map((x) => `${x} (only these GitHub users can queue work)`),
    build: (t, c) => githubTickets({ repo: c.repo, allowedAuthors: t.allowedAuthors, exec: c.exec }),
    allow: (id) => ({ allowedAuthors: [id.user.id] }),
  },
  ossicone: {
    label: 'Ossicone', blurb: 'Self-hosted Jira-style tracker. Use your existing account, or sign up on any Ossicone server.', signup: true,
    fields: [{ key: 'baseUrl', label: 'Ossicone URL', placeholder: 'https://ossicone.example.com', required: true }, { key: 'token', label: 'API token', secret: true, required: true, help: 'In Ossicone: AI Agent page → Generate token (read + write).' }],
    pick: { key: 'projectId', label: 'Ossicone project', type: 'number' },
    validate: (t) => [...need(t, ['baseUrl', 'projectId', 'allowedReporterIds']), ...urlProblem(t), ...tokenProblem(t)],
    build: (t, c) => ossiconeTickets({ baseUrl: checkBaseUrl(t.baseUrl), token: c.env[t.tokenEnv], projectId: t.projectId, allowedReporterIds: t.allowedReporterIds, fetchImpl: c.fetchImpl }),
    allow: (id) => ({ allowedReporterIds: [id.user.id] }),
  },
  jira: {
    label: 'Jira', blurb: 'Jira Cloud or Data Center. Work is tracked with labels, so no workflow changes are needed.',
    fields: [{ key: 'baseUrl', label: 'Jira URL', placeholder: 'https://yourteam.atlassian.net', required: true },
      { key: 'flavor', label: 'Type', type: 'select', options: ['cloud', 'datacenter'], default: 'cloud' },
      { key: 'email', label: 'Account email (Cloud)', placeholder: 'you@company.com', showIf: { flavor: 'cloud' } },
      { key: 'token', label: 'API token', secret: true, required: true, help: 'Cloud: id.atlassian.com → Security → API tokens. Data Center: a personal access token.' }],
    pick: { key: 'projectKey', label: 'Jira project' },
    validate: (t) => [...need(t, ['baseUrl', 'projectKey', 'allowedReporters']), ...urlProblem(t), ...tokenProblem(t), ...(['cloud', 'datacenter'].includes(t.flavor ?? 'cloud') ? [] : ['tickets.flavor must be cloud or datacenter']), ...((t.flavor ?? 'cloud') === 'cloud' && !t.email ? ['tickets.email is required for Jira Cloud'] : [])],
    build: (t, c) => jiraTickets({ baseUrl: checkBaseUrl(t.baseUrl), projectKey: t.projectKey, flavor: t.flavor ?? 'cloud', email: t.email, token: c.env[t.tokenEnv], allowedReporters: t.allowedReporters, statuses: t.statuses, issueType: t.issueType, fetchImpl: c.fetchImpl }),
    allow: (id) => ({ allowedReporters: id.user.alsoMatches }),
  },
  linear: {
    label: 'Linear', blurb: 'Linear teams. Work is tracked with labels created automatically in the team.',
    fields: [{ key: 'token', label: 'Personal API key', secret: true, required: true, help: 'Linear → Settings → Security & access → Personal API keys.' }],
    pick: { key: 'teamId', label: 'Linear team' },
    validate: (t) => [...need(t, ['teamId', 'allowedCreatorIds']), ...tokenProblem(t)],
    build: (t, c) => linearTickets({ teamId: t.teamId, token: c.env[t.tokenEnv], allowedCreatorIds: t.allowedCreatorIds, fetchImpl: c.fetchImpl }),
    allow: (id) => ({ allowedCreatorIds: [id.user.id] }),
  },
  file: { hidden: true, label: 'JSON file (testing)', fields: [], validate: (t) => need(t, ['path']), build: (t) => fileTickets(t.path), allow: () => ({}) },
};

export const publicSources = () => Object.entries(SOURCES).filter(([, s]) => !s.hidden).map(([kind, s]) => ({ kind, label: s.label, blurb: s.blurb, fields: s.fields, pick: s.pick ?? null, signup: !!s.signup }));

// Build the adapter for a project's ticket config. `ctx`: { repo, env, exec, fetchImpl }.
export function buildTickets(t, ctx) {
  const src = SOURCES[t?.kind]; if (!src) throw new Error(`Unsupported ticket source: ${t?.kind}`);
  return src.build(t, ctx);
}
export const validateSource = (t) => { const src = SOURCES[t?.kind]; return src ? src.validate(t) : [`tickets.kind "${t?.kind}" is not supported (use ${Object.keys(SOURCES).filter((k) => !SOURCES[k].hidden).join(', ')})`]; };

// The wizard's "Test connection": authenticate with the pasted token WITHOUT saving anything, and list what can be picked.
export async function identifySource({ kind, fields = {}, token, whoami, fetchImpl }) {
  const src = SOURCES[kind]; if (!src || src.hidden) throw Object.assign(new Error(`Unsupported ticket source: ${kind}`), { status: 400 });
  if (kind === 'github') { const login = await whoami(); return { user: { id: login, name: login, alsoMatches: [login] }, projects: [] }; }
  if (!token) throw Object.assign(new Error('Paste the API token first'), { status: 400 });
  const t = { ...fields, kind };
  if (t.baseUrl) try { t.baseUrl = checkBaseUrl(t.baseUrl); } catch (e) { throw Object.assign(e, { status: 400 }); }
  const probe = { ossicone: () => ossiconeTickets({ baseUrl: t.baseUrl, token, projectId: 0, allowedReporterIds: [], fetchImpl }),
    jira: () => jiraTickets({ baseUrl: t.baseUrl, projectKey: 'PROBE', flavor: t.flavor ?? 'cloud', email: t.email, token, fetchImpl }),
    linear: () => linearTickets({ teamId: 'probe', token, fetchImpl }) }[kind]();
  try { return await probe.identify(); } catch (e) { throw Object.assign(new Error(`Could not connect: ${String(e.message).replace(token, '***').slice(0, 220)}`), { status: 400 }); }
}

// "Do I need an account?": does this Ossicone server allow self-service sign-up, and where do I go?
export async function ossiconeSignupInfo(baseUrl, fetchImpl = fetch) {
  const base = checkBaseUrl(baseUrl);
  const out = { baseUrl: base, registerUrl: `${base}/register`, loginUrl: `${base}/login`, tokenUrl: `${base}/ai-agents`, openSignup: null, reachable: false };
  try { const r = await fetchImpl(`${base}/api/auth/config`, { signal: AbortSignal.timeout(10000) }); if (r.ok) { out.reachable = true; out.openSignup = !!(await r.json()).openSignup; } } catch { /* unreachable */ }
  return out;
}
