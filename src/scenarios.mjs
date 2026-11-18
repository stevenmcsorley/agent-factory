// Scenarios: custom, repeatable workflows described as DATA, so anyone can define how a project goes from idea to live (or just stays a prototype)
// without touching the app. A scenario is a JSON file; a run walks its steps, waits at human approval gates, and records everything.
//
//   { "id": "ship", "name": "Ship to production", "params": { "domain": { "label": "Domain", "required": true } },
//     "secrets": ["AF_CLOUDFLARE_TOKEN"], "allowHosts": ["api.cloudflare.com"],
//     "steps": [ { "id": "ready", "type": "check", "check": "plan-complete" },
//                { "id": "ok", "type": "approve", "message": "Deploy {{params.domain}}?" },
//                { "id": "dns", "type": "cloudflare.dns", "domain": "{{params.domain}}" } ] }
//
// Built-in step types: ticket (queue work for the agent), check (is the project ready?), approve (a human says yes), http (call an allow-listed
// HTTPS API), note. Plugins add more ("<plugin>.<type>"): deploy targets, notifiers, anything. A run is a DRY RUN unless you say apply: dry runs
// evaluate checks for real but only DESCRIBE what everything else would do.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/, SECRET = /^AF_[A-Z0-9_]{1,60}$/;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const clip = (v, n) => String(v ?? '').slice(0, n);
const STEP_TYPES = new Map();
export const registerStepType = (type, def) => { if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)?$/.test(type)) throw new Error(`bad step type ${type}`); if (STEP_TYPES.has(type)) throw new Error(`step type ${type} already exists`); if (typeof def?.run !== 'function' || typeof def?.describe !== 'function') throw new Error('a step type needs describe(args, ctx) and run(args, ctx)'); STEP_TYPES.set(type, def); };
export const stepTypes = () => [...STEP_TYPES.keys()].sort();

// ---------------------------------------------------------------- templates
const lookup = (scope, p) => p.split('.').reduce((o, k) => (o != null && typeof o === 'object' ? o[k] : undefined), scope);
// {{params.domain}}, {{project.id}}, {{steps.ticket1.output.url}}, {{secret:AF_NAME}} (only secrets the scenario declares).
export function render(value, scope, { secrets = {}, allowed = [] } = {}) {
  if (typeof value === 'string') return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    if (expr.startsWith('secret:')) { const n = expr.slice(7); if (!allowed.includes(n)) throw bad(`The scenario does not declare the secret ${n}`); if (!secrets[n]) throw bad(`The secret ${n} is not set (add it to the secrets file)`); return secrets[n]; }
    const v = lookup(scope, expr); if (v === undefined) throw bad(`Unknown value {{${expr}}}`); return typeof v === 'object' ? JSON.stringify(v) : String(v); });
  if (Array.isArray(value)) return value.map((x) => render(x, scope, { secrets, allowed }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, scope, { secrets, allowed })]));
  return value;
}
const redact = (v, secrets) => { let s = JSON.stringify(v ?? null); for (const x of Object.values(secrets)) if (x && x.length >= 6) s = s.split(x).join('••••'); return JSON.parse(s); };

// ---------------------------------------------------------------- scenario files
export function validateScenario(raw) {
  const id = String(raw?.id ?? ''); if (!ID.test(id)) throw bad('scenario id must be lowercase letters, digits and dashes');
  const steps = Array.isArray(raw.steps) ? raw.steps : []; if (!steps.length || steps.length > 60) throw bad('a scenario needs between 1 and 60 steps');
  const seen = new Set(); const out = steps.map((s, i) => { const sid = String(s?.id ?? ''); if (!ID.test(sid) || seen.has(sid)) throw bad(`step ${i + 1}: id must be unique lowercase letters, digits and dashes`); seen.add(sid);
    if (!s.type || !(STEP_TYPES.has(s.type) || ['ticket', 'check', 'approve', 'http', 'note'].includes(s.type))) throw bad(`step "${sid}": unknown type "${s.type}"${s.type?.includes('.') ? ' (is the plugin enabled?)' : ''}`);
    return { ...s, id: sid, title: clip(s.title ?? sid, 120), requires: Array.isArray(s.requires) ? s.requires.map(String) : i ? [steps[i - 1].id] : [] }; });
  for (const s of out) for (const r of s.requires) if (!seen.has(r) || r === s.id) throw bad(`step "${s.id}" requires unknown step "${r}"`);
  const secrets = (Array.isArray(raw.secrets) ? raw.secrets : []).map(String); for (const x of secrets) if (!SECRET.test(x)) throw bad(`secret "${x}" must look like AF_MY_TOKEN`);
  const allowHosts = (Array.isArray(raw.allowHosts) ? raw.allowHosts : []).map((h) => String(h).toLowerCase()); for (const h of allowHosts) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h)) throw bad(`allowHosts entry "${h}" must be a public host name`);
  const params = Object.fromEntries(Object.entries(raw.params ?? {}).slice(0, 20).map(([k, v]) => { if (!/^[a-zA-Z][\w]{0,30}$/.test(k)) throw bad(`param name "${k}" is not allowed`); return [k, { label: clip(v?.label ?? k, 60), required: !!v?.required, default: v?.default === undefined ? undefined : clip(v.default, 200), help: clip(v?.help, 200) }]; }));
  return { id, name: clip(raw.name ?? id, 80), description: clip(raw.description, 400), params, secrets, allowHosts, steps: out };
}
export function loadScenarios(dirs) {
  const byId = new Map();
  for (const dir of dirs) { let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files.sort()) { try { const s = validateScenario(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); byId.set(s.id, { ...s, file: path.join(dir, f) }); } catch (e) { byId.set(`invalid:${f}`, { id: f, name: f, error: String(e.message).slice(0, 200), file: path.join(dir, f), steps: [], params: {} }); } } }
  return [...byId.values()];
}

// ---------------------------------------------------------------- safe outbound HTTP (used by the http step and the http-ok check)
export async function safeFetch(scenario, { method = 'GET', url, headers = {}, body, timeoutMs = 15000 }, fetchImpl = fetch) {
  let u; try { u = new URL(url); } catch { throw bad(`Not a valid URL: ${clip(url, 80)}`); }
  if (u.protocol !== 'https:' || u.username || u.password) throw bad('Scenario HTTP calls must be https:// without credentials in the URL');
  if (!scenario.allowHosts.includes(u.hostname.toLowerCase())) throw bad(`${u.hostname} is not in this scenario's allowHosts`);
  if (/^(\d+\.){3}\d+$/.test(u.hostname) || u.hostname === 'localhost' || /\.(local|internal)$/.test(u.hostname)) throw bad('That host is not allowed');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw bad(`Method ${method} is not allowed`);
  const b = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body); if (b && b.length > 20_000) throw bad('Request body is too large');
  for (const k of Object.keys(headers)) if (!/^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(k)) throw bad(`Header name "${k}" is not allowed`);
  const r = await fetchImpl(u, { method, headers: { ...(b && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: b, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text().catch(() => ''); let json; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: r.status, ok: r.ok, body: json ?? clip(text, 2000) };
}

// ---------------------------------------------------------------- built-in step types
const CHECKS = {
  'plan-complete': async ({ engine, project }) => { const pack = await engine.getPlan(project); return pack.plan ? { ok: pack.plan.status === 'complete', detail: `${pack.progress.done} of ${pack.progress.total} planned tickets are done` } : { ok: true, detail: 'there is no plan, so nothing to finish' }; },
  'queue-empty': async ({ engine, project }) => { const t = (await engine.freshTickets(project)).filter((x) => x.state !== 'CLOSED' && /agent-(ready|working|review)/.test((x.labels ?? []).join(' '))); return { ok: !t.length, detail: t.length ? `${t.length} ticket${t.length > 1 ? 's are' : ' is'} still in the queue or in review` : 'no tickets waiting' }; },
  'gate-ok': async ({ engine, project }) => { const p = engine.project(project).profile; if (!p?.quality) return { ok: false, detail: 'the project has not been analyzed yet' }; return { ok: p.quality.gate.status === 'OK', detail: p.quality.gate.status === 'OK' ? 'quality gate passed' : p.quality.gate.failed.join('; ') }; },
  'brief-ready': async ({ engine, project }) => { const c = engine.getPack(project).completeness; return { ok: c.ready, detail: c.ready ? 'brief has a goal and scope' : `missing: ${c.missing.join(', ')}` }; },
  'http-ok': async ({ scenario, args, fetch: f }) => { const r = await safeFetch(scenario, { url: args.url }, f); const want = args.expect ?? [200]; return { ok: want.includes(r.status), detail: `${args.url} answered ${r.status}` }; },
};
export const CHECK_NAMES = Object.keys(CHECKS);
// Run one named check against a project (used for lifecycle readiness as well as scenario steps).
export const runCheck = async (engine, project, name, args = {}) => { const fn = CHECKS[name]; if (!fn) throw bad(`Unknown check "${name}"`); return fn({ engine, project, args, scenario: { allowHosts: [] } }); };
const BUILTIN = {
  note: { describe: (a) => String(a.text ?? a.title ?? ''), run: async (a) => ({ note: String(a.text ?? '') }) },
  ticket: {
    describe: (a) => `queue the ticket "${a.title}"${a.waitFor === 'closed' ? ' and wait until it is merged and closed' : ''}`,
    run: async (a, ctx) => { const o = ctx.step.output ?? {}; if (!o.ticketId) { const r = await ctx.engine.createTicket(ctx.project, { title: a.title, body: a.body ?? '' }); Object.assign(o, { url: r?.url, ticketId: r?.id ?? (r?.url ? /([\w-]+)$/.exec(r.url)?.[1] : undefined) }); ctx.step.output = o; }
      if (a.waitFor !== 'closed') return o; const t = (await ctx.engine.freshTickets(ctx.project)).find((x) => String(x.id) === String(o.ticketId)); return t?.state === 'CLOSED' ? o : { wait: true, detail: `waiting for ${o.url ?? `#${o.ticketId}`} to be merged and closed`, output: o }; },
  },
  check: {
    describe: (a) => `check: ${a.check}${a.url ? ` ${a.url}` : ''}`,
    run: async (a, ctx) => { const fn = CHECKS[a.check]; if (!fn) throw bad(`Unknown check "${a.check}" (${Object.keys(CHECKS).join(', ')})`); const r = await fn({ ...ctx, args: a }); return r.ok ? { detail: r.detail } : { wait: true, detail: r.detail }; },
  },
  approve: { describe: (a) => `ask a human: ${a.message ?? 'Continue?'}`, run: async () => ({ wait: true, detail: 'waiting for a human to approve' }) },
  http: {
    describe: (a) => `${a.method ?? 'GET'} ${a.url}`,
    run: async (a, ctx) => { const r = await safeFetch(ctx.scenario, { method: a.method ?? 'GET', url: a.url, headers: a.headers ?? {}, body: a.body }, ctx.fetch); const want = a.expect ?? [200, 201, 202, 204]; if (!want.includes(r.status)) throw bad(`${a.method ?? 'GET'} ${a.url} answered ${r.status}`); return { status: r.status, body: r.body }; },
  },
};
const typeDef = (t) => BUILTIN[t] ?? STEP_TYPES.get(t);

// ---------------------------------------------------------------- runs
const runsDir = (engine, project) => path.join(engine.cfg.stateDir, 'projects', project, 'scenarios');
const save = (engine, run) => { run.updatedAt = new Date().toISOString(); const d = runsDir(engine, run.project); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${run.id}.tmp`), JSON.stringify(run, null, 2)); fs.renameSync(path.join(d, `${run.id}.tmp`), path.join(d, `${run.id}.json`)); };
export const getRun = (engine, project, id) => { if (!/^[a-f0-9]{8}$/.test(id)) throw bad('Invalid run id'); try { return JSON.parse(fs.readFileSync(path.join(runsDir(engine, project), `${id}.json`), 'utf8')); } catch { throw bad('No such scenario run', 404); } };
export function listRuns(engine, project) { let f = []; try { f = fs.readdirSync(runsDir(engine, project)).filter((x) => x.endsWith('.json')); } catch { return []; } return f.map((x) => { try { return JSON.parse(fs.readFileSync(path.join(runsDir(engine, project), x), 'utf8')); } catch { return null; } }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

export function startRun(engine, { scenario, project, params = {}, dryRun = true }) {
  engine.project(project); const clean = {};
  for (const [k, def] of Object.entries(scenario.params)) { const v = params[k] ?? def.default; if (def.required && (v === undefined || v === '')) throw bad(`Parameter "${def.label}" (${k}) is required`); if (v !== undefined) clean[k] = clip(v, 200); }
  for (const k of Object.keys(params)) if (!scenario.params[k]) throw bad(`Unknown parameter "${k}"`);
  const run = { id: crypto.randomBytes(4).toString('hex'), scenario: scenario.id, scenarioName: scenario.name, project, params: clean, dryRun: dryRun !== false, status: 'running', createdAt: new Date().toISOString(), steps: Object.fromEntries(scenario.steps.map((s) => [s.id, { status: 'pending', title: s.title, type: s.type }])), approvals: [] };
  save(engine, run); return run;
}
export function approveStep(engine, project, id, stepId, by = 'a human') { const run = getRun(engine, project, id); const s = run.steps[stepId]; if (!s) throw bad('No such step'); if (s.status !== 'waiting-approval') throw bad('That step is not waiting for approval'); s.status = 'approved'; run.approvals.push({ step: stepId, by: clip(by, 60), at: new Date().toISOString() }); run.status = 'running'; save(engine, run); return run; }
export function cancelRun(engine, project, id) { const run = getRun(engine, project, id); if (['done', 'failed', 'cancelled'].includes(run.status)) return run; run.status = 'cancelled'; for (const s of Object.values(run.steps)) if (['pending', 'running', 'waiting', 'waiting-approval'].includes(s.status)) s.status = 'skipped'; save(engine, run); return run; }

// Run every step whose requirements are met. Safe to call repeatedly: waiting steps are re-checked, finished steps are left alone.
export async function advance(engine, project, id, { scenarios, fetch: fetchImpl = fetch } = {}) {
  const run = getRun(engine, project, id); if (['done', 'failed', 'cancelled'].includes(run.status)) return run;
  const scenario = scenarios.find((s) => s.id === run.scenario); if (!scenario) { run.status = 'failed'; run.error = `Scenario ${run.scenario} no longer exists`; save(engine, run); return run; }
  const secrets = Object.fromEntries(scenario.secrets.map((n) => [n, engine.env[n]]).filter(([, v]) => v)); const p = engine.project(project);
  const scope = () => ({ project: { id: p.id, repo: p.repo, base: p.base }, params: run.params, brief: engine.getPack(project).brief, steps: Object.fromEntries(Object.entries(run.steps).map(([k, v]) => [k, { output: v.output, status: v.status }])) });
  for (const step of scenario.steps) {
    const st = run.steps[step.id]; if (['done', 'failed', 'skipped'].includes(st.status)) continue;
    if (!step.requires.every((r) => ['done', 'skipped'].includes(run.steps[r].status))) { if (step.requires.some((r) => run.steps[r].status === 'failed')) st.status = 'skipped'; continue; }
    const def = typeDef(step.type); if (!def) { st.status = 'failed'; st.error = `unknown step type ${step.type}`; continue; }
    st.startedAt ??= new Date().toISOString();
    try {
      const sc = scope(); const { id: _i, title: _t, requires: _r, type: _ty, optional: _o, timeoutMs: _to, ...rawArgs } = step; if (step.type === 'ticket') rawArgs.title = step.title;   // a ticket step's title is the ticket's title too
      const args = render(rawArgs, sc, { secrets, allowed: scenario.secrets });
      const ctx = { engine, project, scenario, step: st, params: run.params, secrets, fetch: fetchImpl, dryRun: run.dryRun, log: (m) => (st.log ??= []).push(String(m).slice(0, 300)) };
      if (typeof def.validate === 'function') def.validate(args);
      if (step.type === 'approve') { if (run.dryRun) { st.status = 'done'; st.output = { dryRun: true, would: def.describe(args, ctx) }; } else if (st.status === 'approved') { st.status = 'done'; st.output = { approvedBy: run.approvals.at(-1)?.by }; } else { st.status = 'waiting-approval'; st.detail = args.message ?? 'Continue?'; } continue; }
      const real = !run.dryRun || step.type === 'check' || step.type === 'note';
      if (!real) { const plan = typeof def.plan === 'function' ? await def.plan(args, ctx) : undefined; st.status = 'done'; st.output = redact({ dryRun: true, would: def.describe(args, ctx), ...(plan ? { plan } : {}) }, secrets); continue; }
      const out = await def.run(args, ctx);
      if (out?.wait) { st.status = 'waiting'; st.detail = out.detail; if (out.output) st.output = out.output; const limit = step.timeoutMs ?? 6 * 3600_000; if (Date.now() - new Date(st.startedAt).getTime() > limit) { if (step.optional) { st.status = 'skipped'; st.error = 'timed out (optional)'; } else { st.status = 'failed'; st.error = `timed out waiting: ${out.detail}`; } } }
      else { st.status = 'done'; st.output = redact(out, secrets); st.finishedAt = new Date().toISOString(); }
    } catch (e) { st.status = step.optional ? 'skipped' : 'failed'; st.error = redact(String(e.message ?? e), secrets); st.finishedAt = new Date().toISOString(); }
  }
  const vals = Object.values(run.steps).map((s) => s.status);
  run.status = vals.includes('failed') ? 'failed' : vals.every((s) => ['done', 'skipped'].includes(s)) ? 'done' : vals.includes('waiting-approval') ? 'waiting-approval' : vals.includes('waiting') ? 'waiting' : 'running';
  save(engine, run); return run;
}
export async function advanceAll(engine, scenarios) {
  for (const p of engine.cfg.projects) for (const r of listRuns(engine, p.id)) if (['running', 'waiting'].includes(r.status)) await advance(engine, p.id, r.id, { scenarios }).catch(() => {});
}
