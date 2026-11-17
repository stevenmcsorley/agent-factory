import { assessTicket } from './gate.mjs';
import { doctor } from './doctor.mjs';
import { templateNames } from './github.mjs';

// The factory's operations, defined once and served three ways: REST (ui), MCP tools (/mcp) and MCP Code Mode (/mcp-code).
// Each: name, description, input (JSON Schema), readOnly, handler(engine, args).
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PROJECT = str('Project id (see list_projects)');
export const stateOf = (labels = []) => ['agent-needs-human', 'agent-failed', 'agent-needs-info', 'agent-review', 'agent-working', 'agent-ready'].find((l) => labels.includes(l))?.replace('agent-', '') ?? 'other';
const slimTicket = (t) => ({ id: t.id, title: t.title, state: stateOf(t.labels), url: t.url, updatedAt: t.updatedAt });

export const OPS = [
  { name: 'status', readOnly: true, description: 'Overview: paused/busy, runs in flight, today\'s usage vs caps, per-project run counts.', input: obj(), handler: (e) => e.status() },
  { name: 'list_projects', readOnly: true, description: 'Projects the factory works on (id, repo, base branch, ticket source).', input: obj(), handler: (e) => e.cfg.projects.map((p) => ({ id: p.id, repo: p.repo, base: p.base, tickets: p.tickets.kind, paused: !!p.paused })) },
  { name: 'project', readOnly: true, description: 'One project in depth: queue by state, recent tickets, open agent PRs, success metrics.', input: obj({ id: PROJECT }, ['id']),
    handler: async (e, { id }) => { const [tickets, prs] = await Promise.all([e.listTickets(id), e.listPrs(id).catch(() => [])]); const queue = {}; tickets.forEach((t) => { const s = stateOf(t.labels); queue[s] = (queue[s] ?? 0) + 1; });
      return { ...e.project(id), queue, tickets: tickets.slice(0, 25).map(slimTicket), prs, metrics: e.metrics().projects[id] ?? null }; } },
  { name: 'list_tickets', readOnly: true, description: 'Tickets the factory has touched in a project, with their state (ready, working, review, failed, needs-info).', input: obj({ project: PROJECT }, ['project']), handler: async (e, { project }) => (await e.listTickets(project)).map(slimTicket) },
  { name: 'check_ticket', readOnly: true, description: 'Check whether a ticket is clear enough for the factory to start (no side effects). Use before create_ticket.', input: obj({ title: str('Ticket title'), body: str('Ticket details') }, ['title']), handler: (e, a) => assessTicket({ title: a.title, body: a.body ?? '' }, e.cfg.limits.gate) },
  { name: 'create_ticket', readOnly: false, description: 'Queue work: creates an agent-ready ticket the factory will build into a draft PR. Vague tickets are refused with advice; name the files/functions and how to tell it is done.', input: obj({ project: PROJECT, title: str('Short title', { maxLength: 200 }), body: str('What should change and how we know it is done') }, ['project', 'title', 'body']),
    handler: async (e, a) => { const g = assessTicket({ title: a.title, body: a.body }, e.cfg.limits.gate); if (!g.ok) return { queued: false, problems: g.problems, hint: 'Add concrete details (function/file names, expected behaviour, acceptance criteria) and call create_ticket again.' }; return { queued: true, ...(await e.createTicket(a.project, { title: a.title, body: a.body })) }; } },
  { name: 'inbox', readOnly: true, description: 'Everything waiting on a human: tickets that need more detail or failed (with the factory\'s reason and the run behind it) and PRs ready to review.', input: obj(), handler: (e) => e.inbox() },
  { name: 'requeue_ticket', readOnly: false, description: 'Put a stuck ticket back on the line, optionally adding the missing detail first. Re-runs the clarity check, so vague tickets are refused with advice.', input: obj({ project: PROJECT, ticket: str('Ticket id from the inbox'), details: str('Extra detail to append (what to change, expected behaviour, how to tell it is done)') }, ['project', 'ticket']), handler: (e, a) => e.ticketAction(a.project, a.ticket, 'requeue', { details: a.details }) },
  { name: 'comment_ticket', readOnly: false, description: 'Add a comment to a ticket in the tracker.', input: obj({ project: PROJECT, ticket: str('Ticket id'), text: str('Comment text') }, ['project', 'ticket', 'text']), handler: (e, a) => e.ticketAction(a.project, a.ticket, 'comment', { text: a.text }) },
  { name: 'list_prs', readOnly: true, description: 'Open pull requests the factory created for a project.', input: obj({ project: PROJECT }, ['project']), handler: (e, { project }) => e.listPrs(project) },
  { name: 'list_runs', readOnly: true, description: 'Recent agent runs and feedback rounds (newest first).', input: obj({ project: str('Optional project id'), limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }),
    handler: (e, a) => e.runs({ project: a.project, limit: a.limit ?? 20 }).map(({ phases, agentSummary, verifyTail, ...r }) => r) },
  { name: 'get_run', readOnly: true, description: 'Full detail of one run: timed phases, agent summary, verification output, changed files, PR.', input: obj({ id: str('Run id (8 hex chars)') }, ['id']), handler: (e, { id }) => e.getRun(id) },
  { name: 'activity', readOnly: true, description: 'What the factory is doing right now: runs in flight and the latest events.', input: obj(), handler: (e) => e.activity() },
  { name: 'metrics', readOnly: true, description: 'Success rate, durations, cost/tokens and a per-day series.', input: obj({ days: { type: 'integer', minimum: 1, maximum: 90, default: 14 } }), handler: (e, a) => e.metrics({ days: a.days ?? 14 }) },
  { name: 'health', readOnly: true, description: 'Prerequisite checks (Docker, GitHub, agent login, config) with fixes.', input: obj(), handler: (e) => doctor(e.cfg, { env: e.env }) },
  { name: 'run_now', readOnly: false, description: 'Start a cycle immediately instead of waiting: "tick" claims queued tickets, "feedback" answers CI/review comments. Returns at once; poll activity.', input: obj({ what: str('tick or feedback', { enum: ['tick', 'feedback'] }) }, ['what']),
    handler: (e, { what }) => { if (e.busy) throw Object.assign(new Error('The factory is already running'), { status: 409 }); (what === 'tick' ? e.tickAll() : e.feedbackAll()).catch(() => {}); return { started: what }; } },
  { name: 'set_paused', readOnly: false, description: 'Pause or resume the whole factory, or just one project.', input: obj({ paused: { type: 'boolean' }, project: str('Optional: pause only this project') }, ['paused']),
    handler: (e, a) => { if (a.project) return e.setProjectPaused(a.project, a.paused); a.paused ? e.pause() : e.resume(); return e.status(); } },
  { name: 'list_integrations', readOnly: true, description: 'The ticket trackers (GitHub Issues, Ossicone, Jira, Linear) and code hosts (GitHub, GitLab, Bitbucket, any git remote) the factory can connect to, with the fields each needs.', input: obj(), handler: (e) => e.catalog() },
  { name: 'add_project', readOnly: false, description: 'Add an existing repository. `host` = where the code lives, e.g. {kind:"gitlab"} or {kind:"bitbucket",username:"me"}; `source` = where tickets live, e.g. {kind:"jira",fields:{baseUrl,flavor,email},pick:"PROJ"}. Defaults to GitHub + GitHub Issues. NEVER pass tokens here: they must already be stored (add the project in the UI once to enter them).', input: obj({ repo: str('Repository path, e.g. owner/name'), id: str('Short id (default: repo name)'), base: str('Base branch (default: detected)'), host: { type: 'object', description: 'Code host config (no secrets)' }, source: { type: 'object', description: 'Ticket source config (no secrets)' } }, ['repo']),
    handler: (e, a) => e.addProject({ id: a.id ?? a.repo.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-'), repo: a.repo, base: a.base, host: a.host, source: a.source }) },
  { name: 'create_project', readOnly: false, openWorld: true, description: 'Create a NEW GitHub repo from a template, register it, and queue your description as the first ticket so the factory starts building it.', input: obj({ name: str('Repository name'), description: str('One line'), template: str('Starter template', { enum: templateNames() }), visibility: str('private or public', { enum: ['private', 'public'], default: 'private' }), spec: str('What to build: features, behaviour, what done looks like') }, ['name', 'spec']),
    handler: (e, a) => { const g = assessTicket({ title: `Build ${a.name}`, body: a.spec }, e.cfg.limits.gate); if (!g.ok) return { created: false, problems: g.problems, hint: 'Describe the features and acceptance criteria in more detail.' };
      return e.createProject({ id: a.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'), name: a.name, description: a.description ?? '', template: a.template ?? 'node', visibility: a.visibility ?? 'private', spec: a.spec }); } },
];
export const OP = Object.fromEntries(OPS.map((o) => [o.name, o]));

// Validate args against the (small, flat) JSON Schema subset the ops use. Rejects unknown keys.
export function validateArgs(schema, args) {
  const a = args ?? {}; if (typeof a !== 'object' || Array.isArray(a)) throw Object.assign(new Error('arguments must be an object'), { status: 400 });
  for (const k of Object.keys(a)) if (!schema.properties[k]) throw Object.assign(new Error(`unknown argument "${k}"`), { status: 400 });
  for (const k of schema.required) if (a[k] === undefined || a[k] === '') throw Object.assign(new Error(`"${k}" is required`), { status: 400 });
  for (const [k, v] of Object.entries(a)) { const p = schema.properties[k];
    if (p.type === 'string' && typeof v !== 'string') throw Object.assign(new Error(`"${k}" must be a string`), { status: 400 });
    if (p.type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) throw Object.assign(new Error(`"${k}" must be an object`), { status: 400 });
    if (p.type === 'boolean' && typeof v !== 'boolean') throw Object.assign(new Error(`"${k}" must be true or false`), { status: 400 });
    if (p.type === 'integer' && !(Number.isInteger(v) && v >= (p.minimum ?? -Infinity) && v <= (p.maximum ?? Infinity))) throw Object.assign(new Error(`"${k}" must be an integer in range`), { status: 400 });
    if (p.enum && !p.enum.includes(v)) throw Object.assign(new Error(`"${k}" must be one of ${p.enum.join(', ')}`), { status: 400 });
    if (p.maxLength && String(v).length > p.maxLength) throw Object.assign(new Error(`"${k}" is too long`), { status: 400 }); }
  return a;
}
export const callOp = async (engine, name, args) => { const op = OP[name]; if (!op) throw Object.assign(new Error(`Unknown operation: ${name}`), { status: 404 }); return op.handler(engine, validateArgs(op.input, args)); };
