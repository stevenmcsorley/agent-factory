import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as pk from '../src/pack.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { tick } from '../src/factory.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';
import { callOp, OPS } from '../src/ops.mjs';

const tmp = (p = 'pk-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('pack: brief fields are bounded, completeness tells you what is missing, sources are validated', () => {
  const dir = tmp(); assert.equal(pk.completeness(pk.loadPack(dir)).ready, false);
  pk.patchPack(dir, { brief: { goal: 'Build a booking app for small gyms', scope: '- classes\n- payments', junk: 'x', users: 'x'.repeat(20000) }, stack: 'TypeScript, Fastify', decisions: 'Use Postgres' });
  const p = pk.loadPack(dir); assert.equal(p.brief.junk, undefined); assert.equal(p.brief.users.length, 12000); assert.equal(pk.completeness(p).ready, true); assert.deepEqual(pk.completeness(p).missing.sort(), ['Constraints', 'Done means', 'Out of scope'].sort());
  assert.throws(() => pk.addSourceLink(dir, { url: 'javascript:alert(1)' }), /http/); assert.throws(() => pk.addSourceLink(dir, { url: 'https://u:p@x.com' }), /credentials/); assert.throws(() => pk.addSourceLink(dir, { url: 'nope' }), /valid URL/);
  assert.throws(() => pk.addSourceFile(dir, { filename: 'x.exe', data: Buffer.from('a') }), /not accepted/); assert.throws(() => pk.addSourceFile(dir, { filename: 'x.md', data: Buffer.alloc(0) }), /empty/); assert.throws(() => pk.addSourceFile(dir, { filename: 'x.pdf', data: Buffer.alloc(6 * 1024 * 1024) }), /at most 5 MB/);
  const f = pk.addSourceFile(dir, { title: '../../etc/passwd', kind: 'weird', filename: '../../evil name.MD', data: Buffer.from('# PRD\npayments via stripe') });
  assert.match(f.file, /^[a-f0-9]{8}-evil-name\.md$/); assert.equal(f.kind, 'other'); assert.ok(fs.existsSync(path.join(dir, 'sources', f.file))); assert.equal(fs.readdirSync(path.join(dir, 'sources')).length, 1);
  const l = pk.addSourceLink(dir, { title: 'Figma', kind: 'design', url: 'https://figma.com/file/abc' }); assert.equal(l.kind, 'design');
  pk.removeSource(dir, f.id); assert.equal(fs.readdirSync(path.join(dir, 'sources')).length, 0); assert.throws(() => pk.removeSource(dir, 'deadbeef'), /No such source/);
});

test('context for the agent: brief, conventions, decisions and an index always; excerpts only of the sources relevant to THIS ticket; bounded', () => {
  const dir = tmp(); pk.patchPack(dir, { brief: { goal: 'Gym booking app', scope: 'classes, payments, waitlists' }, stack: 'Use zod for validation', decisions: 'Stripe for payments' });
  pk.addSourceText(dir, { title: 'Payments research', kind: 'research', text: 'Stripe checkout sessions handle SCA. Use webhooks to confirm payment.' }); pk.addSourceText(dir, { title: 'Waitlist notes', kind: 'research', text: 'Members join a waitlist when a class is full.' });
  const pack = pk.loadPack(dir); const ctx = pk.renderContext(pack, dir, { title: 'Add Stripe payment webhooks', body: 'confirm payment' });
  assert.match(ctx, /Gym booking app/); assert.match(ctx, /Use zod for validation/); assert.match(ctx, /Stripe for payments/); assert.match(ctx, /Payments research/); assert.match(ctx, /Excerpt: Payments research[\s\S]*webhooks/); assert.doesNotMatch(ctx, /Excerpt: Waitlist/);
  pk.patchPack(dir, { stack: 'x'.repeat(12000) }); assert.ok(pk.renderContext(pk.loadPack(dir), dir, {}, { max: 2000 }).length < 2200); assert.equal(pk.renderContext(pk.loadPack(tmp()), tmp(), {}), '');
});

test('materialize puts the pack in the workspace and keeps it out of git', () => {
  const dir = tmp(); pk.patchPack(dir, { brief: { goal: 'G goal goal', scope: 'S scope scope' } }); pk.addSourceText(dir, { title: 'Notes', kind: 'prd', text: 'hello prd' });
  const ws = tmp('ws-'); execFileSync('git', ['init', '-q', ws]); pk.materialize(pk.loadPack(dir), dir, ws);
  for (const f of ['brief.md', 'INDEX.md']) assert.ok(fs.existsSync(path.join(ws, '.factory-context', f))); assert.equal(fs.readdirSync(path.join(ws, '.factory-context/sources')).length, 1);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: ws }).toString().trim(), '', 'context must not show up as a change');
});

test('plans: bounded, cleaned, dependencies repaired, JSON pulled out of chatty output', () => {
  const plan = pk.normalizePlan({ summary: 's', epics: [{ id: 'Core Stuff!', title: 'Core', tickets: [
    { id: 'a', title: 'A thing', body: 'x', dependsOn: ['b'] }, { id: 'b', title: 'B thing', dependsOn: ['a', 'ghost', 'b'], size: 'XL', sources: ['s1', 'zzz'] }, { id: 'a', title: 'Duplicate id' }, { title: '' }] }, { title: 'empty', tickets: [] }] }, { sourceIds: ['s1'] });
  const t = plan.epics[0].tickets; assert.equal(plan.epics.length, 1); assert.deepEqual(t.map((x) => x.id), ['a', 'b', 'a-2']); assert.deepEqual(t[0].dependsOn, ['b']); assert.deepEqual(t[1].dependsOn, []); assert.equal(t[1].size, 'M'); assert.deepEqual(t[1].sources, ['s1']); assert.ok(t.every((x) => x.status === 'planned'));
  assert.throws(() => pk.normalizePlan({ epics: [] }), /no tickets|expected format/); assert.throws(() => pk.normalizePlan('x'), /expected format/);
  const big = pk.normalizePlan({ epics: Array.from({ length: 20 }, (_, i) => ({ title: `E${i}`, tickets: Array.from({ length: 20 }, (_, j) => ({ title: `T ${i} ${j}` })) })) }); assert.ok(big.epics.length <= 8); assert.ok(pk.planTickets(big).length <= 40);
  assert.deepEqual(pk.extractJson('Here you go:\n```json\n{"epics":[{"id":"x"}]}\n```\nenjoy'), { epics: [{ id: 'x' }] }); assert.deepEqual(pk.extractJson('noise {"a":{"b":[1,2]}} trailing }'), { a: { b: [1, 2] } }); assert.equal(pk.extractJson('no json here'), null);
});

// ------------------------------------------------------------------ engine: planning, launching, releasing, publishing
function world({ agentOut, tickets } = {}) {
  const root = tmp('pw-'); const remote = path.join(root, 'remote.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(root, 'seed'); execFileSync('git', ['init', '-q', '-b', 'main', seed]); fs.writeFileSync(path.join(seed, 'README.md'), '# app\n'); execFileSync('git', ['add', '-A'], { cwd: seed }); execFileSync('git', ['commit', '-qm', 'i'], { cwd: seed }); execFileSync('git', ['push', '-q', remote, 'main'], { cwd: seed });
  const sandbox = { kind: 'local', create: async ({ cloneUrl, branch, base, newBranch = true }) => { const dir = fs.mkdtempSync(path.join(root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); if (newBranch) execFileSync('git', ['checkout', '-qb', branch], { cwd: dir }); return { dir, cloneUrl, destroy() {} }; }, exec: async () => ({ code: 0, out: '' }) };
  const seen = { prompts: [], ctx: [] }; const agent = { run: async (_sb, ws, prompt) => { seen.prompts.push(prompt); seen.ctx.push(fs.existsSync(path.join(ws.dir, '.factory-context/brief.md'))); return { out: typeof agentOut === 'function' ? agentOut(seen.prompts.length) : agentOut, costUsd: 0 }; } };
  const store = tickets ?? []; let n = 100; const prs = [];
  const tk = { create: async ({ title, body }) => { const id = ++n; store.push({ id, title, body, state: 'OPEN', labels: ['agent-ready'], url: `https://example.test/issues/${id}` }); return { url: `https://example.test/issues/${id}` }; }, listAgentTickets: async () => store.map(({ body, ...t }) => t), poll: async () => [] };
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { sandbox, agent, tickets: () => tk, vcs: gitVcs({ openPr: (a) => { prs.push(a); return 'https://example.test/pr/1'; } }), hostAdapter: () => ({ cloneUrl: () => remote, gitEnv: () => ({}), prUrl: () => '', openPr: async () => '' }) } });
  e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  return { e, store, seen, prs, remote, root };
}
const PLAN = JSON.stringify({ summary: 'Three steps', epics: [{ id: 'core', title: 'Core', goal: 'g', tickets: [
  { id: 'schema', title: 'Add the database schema', body: 'Create db/schema.sql with a classes table.\n\nAcceptance criteria:\n- table exists', size: 'S', dependsOn: [] },
  { id: 'api', title: 'Add the classes API endpoint', body: 'Add GET /classes in src/api.js.\n\nAcceptance criteria:\n- returns a list', dependsOn: ['schema'] },
  { id: 'ui', title: 'Add the classes list page', body: 'Add pages/classes.html that renders the API response.\n\nAcceptance criteria:\n- shows classes', dependsOn: ['api'] }] }] });
const settle = async (e, id) => { for (let i = 0; i < 300 && e.planJobs.get(id)?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10)); return e.planJobs.get(id); };

test('engine: plan needs a goal and scope, runs as a job, agent sees the pack, retries once on bad JSON, and a bad answer is an error not a crash', async () => {
  const w = world({ agentOut: PLAN }); await w.e.addProject({ repo: 'o/app' });
  assert.throws(() => w.e.startPlanning('app'), /Fill in at least the Goal and In scope/);
  w.e.setPack('app', { brief: { goal: 'A booking app for gyms', scope: 'classes API and a list page' }, stack: 'Plain JS' });
  const job = w.e.startPlanning('app'); assert.equal(job.state, 'running'); assert.equal(w.e.startPlanning('app'), job, 'single flight'); assert.equal((await settle(w.e, 'app')).state, 'done');
  assert.ok(w.seen.ctx[0], 'pack was in the workspace'); assert.match(w.seen.prompts[0], /Produce a delivery PLAN as a single JSON object/);
  const pack = w.e.getPack('app'); assert.equal(pack.plan.status, 'proposed'); assert.equal(pk.planTickets(pack.plan).length, 3); assert.equal(w.store.length, 0, 'planning creates no tickets');
  const flaky = world({ agentOut: (n) => (n === 1 ? 'I think the plan is great!' : PLAN) }); await flaky.e.addProject({ repo: 'o/app' }); flaky.e.setPack('app', { brief: { goal: 'A booking app for gyms', scope: 'classes API' } }); flaky.e.startPlanning('app'); assert.equal((await settle(flaky.e, 'app')).state, 'done'); assert.equal(flaky.seen.prompts.length, 2); assert.match(flaky.seen.prompts[1], /ONLY the JSON/);
  const junk = world({ agentOut: 'no idea, sorry' }); await junk.e.addProject({ repo: 'o/app' }); junk.e.setPack('app', { brief: { goal: 'A booking app for gyms', scope: 'classes API' } }); junk.e.startPlanning('app'); const j = await settle(junk.e, 'app'); assert.equal(j.state, 'error'); assert.match(j.error, /expected format/);
});

test('engine: edit the proposed plan, then launch: only ticket 1 is created; the next appears when the first is closed (merged), not before', async () => {
  const w = world({ agentOut: PLAN }); await w.e.addProject({ repo: 'o/app' }); w.e.setPack('app', { brief: { goal: 'A booking app for gyms', scope: 'classes API' } }); w.e.startPlanning('app'); await settle(w.e, 'app');
  const plan = w.e.getPack('app').plan; const edited = structuredClone(plan.epics); edited[0].tickets[0].title = 'Add the database schema for classes'; edited[0].tickets.pop();
  w.e.editPlan('app', { epics: edited }); assert.equal(pk.planTickets(w.e.getPack('app').plan).length, 2);
  await assert.rejects(w.e.launchPlan('nope'), /No such project/); const launched = await w.e.launchPlan('app'); assert.equal(launched.plan.status, 'launched'); assert.equal(w.store.length, 1); assert.equal(w.store[0].title, 'Add the database schema for classes'); assert.match(w.store[0].body, /Acceptance criteria/); assert.match(w.store[0].body, /Part of the project plan/);
  assert.throws(() => w.e.editPlan('app', { epics: edited }), /launched plan cannot be edited/); assert.throws(() => w.e.startPlanning('app'), /already launched/); await assert.rejects(w.e.launchPlan('app'), /already launched/);
  await w.e.releasePlan('app'); assert.equal(w.store.length, 1, 'dependency not done: nothing more released');
  w.store[0].labels = ['agent-review']; assert.equal((await w.e.getPlan('app')).progress.review, 1); await w.e.releasePlan('app'); assert.equal(w.store.length, 1, 'in review is not done');
  w.store[0].state = 'CLOSED'; const r = await w.e.releasePlan('app'); assert.equal(r.released, 1); assert.equal(w.store.length, 2); assert.match(w.store[1].title, /classes API endpoint/);
  w.store[1].state = 'CLOSED'; const g = await w.e.getPlan('app'); assert.equal(g.plan.status, 'complete'); assert.deepEqual(g.progress, { total: 2, planned: 0, queued: 0, working: 0, review: 0, done: 2, failed: 0 });
});

test('engine: publishing opens a PR adding .factory/ to the repo; publishing again with no changes says so; discarding a proposed plan works', async () => {
  const w = world({ agentOut: PLAN }); await w.e.addProject({ repo: 'o/app' }); w.e.setPack('app', { brief: { goal: 'A booking app for gyms', scope: 'classes API' }, stack: 'Plain JS', decisions: 'No ORM' }); w.e.addSource('app', { kind: 'prd', title: 'PRD', text: '# PRD\nclasses' }); w.e.addSource('app', { kind: 'design', title: 'Figma', url: 'https://figma.com/file/x' });
  const r = await w.e.publishPack('app'); assert.equal(r.published, true); assert.equal(w.prs.length, 1); assert.match(w.prs[0].branch, /^factory\/project-pack-/);
  const files = execFileSync('git', ['--git-dir', w.remote, 'ls-tree', '-r', '--name-only', w.prs[0].branch]).toString().split('\n').filter(Boolean);
  for (const f of ['.factory/README.md', '.factory/brief.md', '.factory/stack.md', '.factory/decisions.md', '.factory/sources.json']) assert.ok(files.includes(f), `${f} in ${files}`); assert.ok(files.some((f) => /^\.factory\/sources\/[a-f0-9]{8}-prd\.md$/.test(f)));
  assert.match(execFileSync('git', ['--git-dir', w.remote, 'show', `${w.prs[0].branch}:.factory/brief.md`]).toString(), /A booking app for gyms/); assert.ok(w.e.getPack('app').publishedAt);
  w.e.startPlanning('app'); await settle(w.e, 'app'); assert.equal(w.e.discardPlan('app').plan, null);
});

test('loop: every ticket run gets the project context in the prompt and in the workspace, but it is never committed', async () => {
  const w = world({ agentOut: 'ok' }); await w.e.addProject({ repo: 'o/app' }); w.e.setPack('app', { brief: { goal: 'A booking app for gyms', scope: 'classes' }, stack: 'Use zod', decisions: 'Stripe' }); w.e.addSource('app', { kind: 'research', title: 'Payments', text: 'stripe payment webhooks confirm payment' });
  const d = w.e.deps(w.e.cfg.projects[0]); let prompt = '', sawFile = false;
  d.agent = { run: async (_sb, ws, p) => { prompt = p; sawFile = fs.existsSync(path.join(ws.dir, '.factory-context/brief.md')); fs.writeFileSync(path.join(ws.dir, 'x.js'), 'export const x = 1;\n'); return { out: 'done', costUsd: 0 }; } };
  d.tickets = { listWorking: async () => [], poll: async () => [{ id: 7, title: 'Add Stripe payment webhooks', body: 'Add src/pay.js that confirms payment from stripe webhooks, with tests', labels: ['agent-ready'] }], comment: async () => {}, label: async () => {} }; d.config.verify = false;
  const [rec] = await tick(d); assert.equal(rec.status, 'ok'); assert.ok(sawFile); assert.match(prompt, /Project context \(reference data/); assert.match(prompt, /A booking app for gyms/); assert.match(prompt, /Use zod/); assert.match(prompt, /Excerpt: Payments/);
  const pushed = execFileSync('git', ['--git-dir', w.remote, 'ls-tree', '-r', '--name-only', 'agent/7-add-stripe-payment-webhooks']).toString(); assert.match(pushed, /x\.js/); assert.doesNotMatch(pushed, /factory-context/);
});

test('MCP/CLI operations: brief, sources, plan, portfolio and analysis are exposed, validated and work end to end', async () => {
  const names = OPS.map((o) => o.name); for (const n of ['portfolio', 'get_brief', 'set_brief', 'add_source', 'remove_source', 'plan_project', 'get_plan', 'launch_plan', 'publish_pack', 'analyze_project', 'get_analysis']) assert.ok(names.includes(n), n);
  const w = world({ agentOut: PLAN }); await w.e.addProject({ repo: 'o/app' });
  assert.equal((await callOp(w.e, 'set_brief', { project: 'app', brief: { goal: 'A booking app for gyms', scope: 'classes API', evil: 'x' }, stack: 'Plain JS' })).completeness.ready, true);
  await assert.rejects(callOp(w.e, 'set_brief', { project: 'app', brief: 'nope' }), /must be an object/); await assert.rejects(callOp(w.e, 'add_source', { project: 'app', kind: 'banana', title: 't', text: 'x' }), /one of/); await assert.rejects(callOp(w.e, 'add_source', { project: 'app', kind: 'prd', title: 't' }), /url, some text, or a file/);
  await callOp(w.e, 'add_source', { project: 'app', kind: 'prd', title: 'PRD', text: 'classes need a list page' }); const gb = await callOp(w.e, 'get_brief', { project: 'app' }); assert.equal(gb.sources.length, 1); assert.equal(gb.brief.evil, undefined);
  assert.equal((await callOp(w.e, 'plan_project', { project: 'app' })).started, true); await settle(w.e, 'app'); assert.equal((await callOp(w.e, 'get_plan', { project: 'app' })).progress.planned, 3);
  assert.equal((await callOp(w.e, 'launch_plan', { project: 'app' })).launched, true); assert.equal(w.store.length, 1);
  const pf = await callOp(w.e, 'portfolio', {}); assert.equal(pf[0].id, 'app'); assert.equal(pf[0].brief.ready, true); assert.equal(pf[0].plan.total, 3); assert.equal(pf[0].plan.queued, 1);
  assert.deepEqual(await callOp(w.e, 'get_analysis', { project: 'app' }), { analyzed: false, hint: 'Run analyze_project first' });
});

test('agents can create a project WITH a brief and ask for a plan in one call (create_project / add_project), and a bare call is refused with advice', async () => {
  const w = world({ agentOut: PLAN }); w.e.gh.createProjectRepo = async () => ({ repo: 'me/newapp', defaultBranch: 'main', url: 'https://github.com/me/newapp' });
  const r = await callOp(w.e, 'create_project', { name: 'newapp', brief: { goal: 'A booking app for gyms', scope: 'classes API and list page' }, stack: 'Plain JS', plan: true });
  assert.equal(r.project.id, 'newapp'); assert.equal(r.pack.ready, true); assert.equal(r.planning.state, 'running'); assert.equal(w.store.length, 0, 'no ticket until the plan is approved'); await settle(w.e, 'newapp'); assert.equal(w.e.getPack('newapp').plan.epics[0].tickets.length, 3);
  assert.equal((await callOp(w.e, 'create_project', { name: 'bare' })).created, false); assert.match((await callOp(w.e, 'create_project', { name: 'bare' })).hint, /brief/);
  const q = await callOp(w.e, 'add_project', { repo: 'o/existing', brief: { goal: 'Improve the existing app', scope: 'tidy the settings page' } }); assert.equal(q.pack.ready, true); assert.equal(q.planning, undefined);
});

// ---- the CLI client against a real server
import net from 'node:net';
import { createServer, hostsFor } from '../src/server.mjs';
import { clientCommand } from '../src/cli-client.mjs';
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
test('CLI client: talks to a running factory, finds the token itself, explains when it is not running, and reads brief fields from files', async () => {
  const w = world({ agentOut: PLAN }); await w.e.addProject({ repo: 'o/app' }); const token = 'T'.repeat(32); fs.writeFileSync(path.join(w.e.cfg.stateDir, 'ui-token'), token);
  const port = await freePort(); const ui = { host: '127.0.0.1', port }; const server = createServer(w.e, { token, allowedHosts: hostsFor(ui.host, ui.port) }); await new Promise((r) => server.listen(port, '127.0.0.1', r)); const cfg = { ui, stateDir: w.e.cfg.stateDir };
  const run = async (cmd, ...a) => { const flags = Object.fromEntries(a.filter((x) => x.startsWith('--')).map((x) => { const i = x.indexOf('='); return i < 0 ? [x.slice(2), true] : [x.slice(2, i), x.slice(i + 1)]; })); const lines = []; const log = console.log; console.log = (...x) => lines.push(x.join(' ')); try { await clientCommand(cmd, [cmd, ...a], flags, cfg, path.resolve('.')); } finally { console.log = log; } return lines.join('\n'); };
  try {
    assert.match(await run('ops'), /portfolio\s+.*\n[\s\S]*set_brief\s+W\s/); assert.match(await run('portfolio'), /app\s+brief 0\/6\s+no plan/);
    const scope = path.join(w.root, 'scope.md'); fs.writeFileSync(scope, '- classes API\n- list page = with equals');
    assert.match(await run('brief', 'app', '--goal=A booking app for gyms', `--scope=@${scope}`, '--stack=Plain JS'), /Saved\. Brief 2\/6 complete; still missing: Users/); assert.match(await run('brief', 'app'), /## In scope\n- classes API\n- list page = with equals/);
    const prd = path.join(w.root, 'PRD.md'); fs.writeFileSync(prd, '# PRD\nlist classes'); assert.match(await run('source', 'app', prd, '--kind=prd'), /Added\. 1 source/); assert.match(await run('source', 'app', 'https://figma.com/file/x', '--kind=design', '--title=Flow'), /Added\. 2 sources/);
    assert.match(await run('plan', 'app', '--wait'), /Plan \(proposed\): Three steps[\s\S]*planned\s+S schema: Add the database schema[\s\S]*api: .*\(after schema\)/);
    assert.match(await run('plan', 'app', '--launch'), /Plan launched[\s\S]*queued\s+S schema/); assert.equal(w.store.length, 1);
    assert.equal(JSON.parse(await run('op', 'get_brief', '--project=app')).completeness.filled, 2); assert.equal(JSON.parse(await run('op', 'portfolio')).length, 1);
    await assert.rejects(run('op', 'nope_op'), /Unknown operation/); await assert.rejects(run('brief'), /Usage/);
  } finally { await new Promise((r) => server.close(r)); }
  await assert.rejects(clientCommand('ops', ['ops'], {}, { ui: { host: '127.0.0.1', port: 1 }, stateDir: w.e.cfg.stateDir }, '.'), /not running at http:\/\/127\.0\.0\.1:1/);
  await assert.rejects(clientCommand('ops', ['ops'], {}, { ui: { host: '127.0.0.1', port: 1 }, stateDir: tmp() }, '.'), /No UI token/);
  assert.match(fs.readFileSync('docs/AGENT-GUIDE.md', 'utf8'), /agent-factory portfolio/);
});
