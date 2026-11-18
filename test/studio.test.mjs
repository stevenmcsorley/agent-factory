import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
import * as pk from '../src/pack.mjs';
import { ossiconeTickets } from '../src/adapters/tickets-ossicone.mjs';
import { jiraTickets } from '../src/adapters/tickets-jira.mjs';
import { doctor } from '../src/doctor.mjs';
import * as lb from '../src/library.mjs';
import { execFileSync } from 'node:child_process';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
const json = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });

test('Ossicone: a plan epic is an epic issue (never labelled agent-*), and its tickets link to it with epicId', async () => {
  const calls = []; const f = async (u, o) => { calls.push({ url: String(u), method: o?.method, body: o?.body ? JSON.parse(o.body) : null }); return String(u).endsWith('/api/auth/me') ? json({ id: 4 }) : json({ id: 900 + calls.length }); };
  const t = ossiconeTickets({ baseUrl: 'https://o.example.com', token: 'tok', projectId: 27, allowedReporterIds: [4], fetchImpl: f });
  const epic = await t.createEpic({ title: 'Core API', body: 'goal' }); const posted = calls.find((c) => c.method === 'POST'); assert.deepEqual([posted.body.type, posted.body.projectId, posted.body.reporterId, posted.body.labels], ['epic', 27, 4, ['factory-plan']]); assert.ok(!posted.body.labels.some((l) => l.startsWith('agent-')));
  assert.match(epic.url, /^https:\/\/o\.example\.com\/projects\/27\/issues\/\d+$/);
  await t.create({ title: 'Add endpoint', body: 'x', epic: epic.id }); const child = calls.filter((c) => c.method === 'POST').at(-1); assert.equal(child.body.epicId, epic.id); assert.ok(child.body.labels.includes('agent-ready')); assert.equal(child.body.type, 'task');
  await t.create({ title: 'No epic', body: 'x' }); assert.equal(calls.filter((c) => c.method === 'POST').at(-1).body.epicId, undefined);
});

test('Jira: a plan epic is a Jira Epic labelled factory-plan, and tickets use it as their parent', async () => {
  const bodies = []; const f = async (u, o) => { if (o?.body) bodies.push(JSON.parse(o.body)); return json({ key: `PRJ-${bodies.length}` }); };
  const t = jiraTickets({ baseUrl: 'https://x.atlassian.net', projectKey: 'prj', email: 'e', token: 't', allowedReporters: ['a'], fetchImpl: f });
  const epic = await t.createEpic({ title: 'Core API', body: 'goal' }); assert.equal(epic.url, 'https://x.atlassian.net/browse/PRJ-1'); assert.deepEqual([bodies[0].fields.issuetype.name, bodies[0].fields.labels, bodies[0].fields.project.key], ['Epic', ['factory-plan'], 'PRJ']);
  await t.create({ title: 'Add endpoint', body: 'x', epic: epic.id }); assert.deepEqual(bodies[1].fields.parent, { key: 'PRJ-1' }); assert.deepEqual(bodies[1].fields.labels, ['agent-ready']);
  await t.create({ title: 'Plain', body: 'x' }); assert.equal(bodies[2].fields.parent, undefined);
});

function world({ epics = true, parallel = 1 } = {}) {
  const root = tmp(); const store = []; let n = 100; const epicCalls = []; const made = [];
  const mk = () => ({ create: async ({ title, body, epic }) => { const id = ++n; store.push({ id, title, body, epic, state: 'OPEN', labels: ['agent-ready'], url: `https://t/${id}` }); made.push({ title, epic }); return { url: `https://t/${id}`, id }; }, listAgentTickets: async () => store.map(({ body, ...t }) => t), poll: async () => [], listWorking: async () => [],
    ...(epics ? { createEpic: async ({ title, body }) => { epicCalls.push({ title, body }); if (/BOOM/.test(title)) throw new Error('tracker said no'); return { id: `E${epicCalls.length}`, url: `https://t/epic/${epicCalls.length}` }; } } : {}) });
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [], limits: { parallelProjects: parallel, maxAttempts: 1 } }), { configPath: path.join(root, 'c.json'), env: {}, factories: { tickets: () => mk(), hostAdapter: () => ({ cloneUrl: () => 'x', gitEnv: () => ({}), prUrl: () => '' }) } });
  e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  return { e, store, epicCalls, made, root };
}
const PLAN = { summary: 'Build the booking API then the page', epics: [{ id: 'core', title: 'Core API', goal: 'The API', tickets: [{ id: 'schema', title: 'Add the schema', body: 'Create db/schema.sql.\n\nAcceptance criteria:\n- table exists', dependsOn: [] }, { id: 'api', title: 'Add the classes endpoint', body: 'GET /classes.\n\nAcceptance criteria:\n- lists classes', dependsOn: ['schema'] }] }, { id: 'ui', title: 'The page', goal: 'UI', tickets: [{ id: 'page', title: 'Add the classes page', body: 'A page.\n\nAcceptance criteria:\n- renders', dependsOn: ['api'] }] }] };
const withPlan = (w) => { const dir = pk.packDir(w.e.cfg.stateDir, 'app'); const pack = pk.loadPack(dir); pack.brief = { goal: 'A booking app for gyms', scope: 'classes API and page' }; pack.plan = pk.normalizePlan(PLAN); pk.savePack(dir, pack); return dir; };

test('launching a plan puts the epics in the tracker (when it supports them) and links tickets; a tracker that cannot do epics, or one that fails, never blocks the launch', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/app', id: 'app' }); withPlan(w); const r = await w.e.launchPlan('app');
  assert.deepEqual(w.epicCalls.map((c) => c.title), ['Core API', 'The page']); assert.match(w.epicCalls[0].body, /Tickets in this epic:\n- Add the schema\n- Add the classes endpoint/); assert.deepEqual(r.plan.epics.map((e) => [e.trackerId, e.trackerUrl]), [['E1', 'https://t/epic/1'], ['E2', 'https://t/epic/2']]);
  assert.deepEqual(w.made, [{ title: 'Add the schema', epic: 'E1' }], 'only ticket 1 is released, linked to its epic');
  w.store[0].state = 'CLOSED'; await w.e.releasePlan('app'); assert.deepEqual(w.made.at(-1), { title: 'Add the classes endpoint', epic: 'E1' });
  const plain = world({ epics: false }); await plain.e.addProject({ repo: 'o/app', id: 'app' }); withPlan(plain); const pr = await plain.e.launchPlan('app'); assert.equal(pr.plan.epics[0].trackerId, undefined); assert.equal(plain.made.length, 1);
  const bad = world(); await bad.e.addProject({ repo: 'o/app', id: 'app' }); const dir = withPlan(bad); const pack = pk.loadPack(dir); pack.plan.epics[0].title = 'BOOM epic'; pk.savePack(dir, pack); const br = await bad.e.launchPlan('app'); assert.match(br.plan.epics[0].trackerError, /tracker said no/); assert.equal(br.plan.epics[1].trackerId, 'E2'); assert.equal(bad.made.length, 1, 'tickets still flow');
});

test('the AI knows where it is: a plan ticket gets the plan, what is done, what is in flight and what depends on it; other tickets get nothing', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/app', id: 'app' }); withPlan(w); await w.e.launchPlan('app'); w.store[0].state = 'CLOSED'; await w.e.releasePlan('app');
  const ctx = w.e.deps(w.e.cfg.projects[0]).config.contextFor; const second = w.store[1];
  const text = ctx({ id: second.id, title: second.title, body: second.body }); assert.match(text, /### Where this fits in the project plan/); assert.match(text, /Plan: Build the booking API then the page/); assert.match(text, /You are on "Add the classes endpoint" \(api\), part of the epic "Core API" \(https:\/\/t\/epic\/1\)\. It builds on: schema, which are already merged\./); assert.match(text, /Already done: Add the schema \(schema\)/); assert.match(text, /Comes next and depends on your work, so keep your interfaces stable: Add the classes page \(page\)/);
  assert.doesNotMatch(ctx({ id: 99999, title: 'Unrelated', body: 'x' }), /Where this fits/);
  const dir = pk.packDir(w.e.cfg.stateDir, 'app'); const pack = pk.loadPack(dir); pack.plan.status = 'proposed'; pk.savePack(dir, pack); assert.doesNotMatch(ctx({ id: second.id, title: 'x', body: 'y' }), /Where this fits/);
});

test('targets and readiness: prototype vs deploy decide which checks apply; readiness counts what passes; the portfolio and operations expose it; bad targets are refused', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/app', id: 'app' }); let r = await w.e.readiness('app'); assert.equal(r.target, 'prototype'); assert.deepEqual(r.checks.map((c) => c.id), ['brief-ready', 'plan-complete', 'gate-ok']); assert.equal(r.ready, false);
  assert.throws(() => w.e.setTarget('app', 'production'), /prototype/); assert.deepEqual(await callOp(w.e, 'set_target', { project: 'app', target: 'deploy' }), { id: 'app', target: 'deploy' }); r = await callOp(w.e, 'project_readiness', { project: 'app' }); assert.deepEqual([r.target, r.scenario, r.total], ['deploy', 'ship', 4]); assert.ok(r.checks.find((c) => c.id === 'plan-complete').ok, 'no plan means nothing to finish');
  w.e.setPack('app', { brief: { goal: 'A booking app for gyms', scope: 'classes and bookings API' } }); w.e.cfg.projects[0].profile = { quality: { gate: { status: 'OK', failed: [] } } }; r = await w.e.readiness('app'); assert.deepEqual([r.passed, r.total, r.ready], [4, 4, true]);
  const pf = await w.e.portfolio(); assert.deepEqual([pf[0].target, pf[0].readiness.ready, pf[0].readiness.passed], ['deploy', true, 4]);
});

test('parallel lanes: by default projects take turns; with parallelProjects they build at the same time (and never more than the cap); status shows what is running', async () => {
  const run = async (parallel) => {
    const w = world({ parallel }); for (const id of ['a', 'b', 'c']) await w.e.addProject({ repo: `o/${id}`, id }); let live = 0, peak = 0; const seen = [];
    const agent = { run: async () => { live++; peak = Math.max(peak, live); seen.push([...w.e.lanes.keys()].length); await new Promise((r) => setTimeout(r, 80)); live--; return { out: 'nothing to do', costUsd: 0 }; } };
    const sandbox = { kind: 'local', create: async () => ({ dir: tmp(), destroy() {} }), exec: async () => ({ code: 0, out: '' }) }; const vcs = { diffStat: async () => '', commitAndPush: async () => {}, openPr: async () => null };
    Object.assign(w.e.f, { agent, sandbox, vcs, tickets: (p) => ({ listWorking: async () => [], create: async () => ({}), listAgentTickets: async () => [], comment: async () => {}, label: async () => {}, poll: async () => [{ id: p.id === 'a' ? 1 : p.id === 'b' ? 2 : 3, title: `Ticket for ${p.id} project`, body: 'Do something small in a.js that returns one', labels: ['agent-ready'] }] }) });
    await w.e.tickAll(); return { peak, lanesSeen: Math.max(...seen), after: w.e.status().lanes };
  };
  const serial = await run(1); assert.equal(serial.peak, 1); assert.equal(serial.after.parallel, 1); assert.deepEqual(serial.after.running, []);
  const two = await run(2); assert.equal(two.peak, 2, 'two projects overlapped'); assert.ok(two.lanesSeen >= 2); assert.equal(two.after.parallel, 2);
  const many = await run(99); assert.equal(many.peak, 3); assert.equal(many.after.parallel, 8, 'the cap is 8');
});

test('doctor warns when the disk is nearly full, more strictly when projects build in parallel', async () => {
  const ok = async () => ({ code: 0, out: 'x' }); const cfg = withDefaults({ stateDir: os.tmpdir(), projects: [], sandbox: { kind: 'local' }, agent: { kind: 'shell' } });
  const d = (await doctor(cfg, { exec: ok, env: {} })).find((c) => c.id === 'disk'); assert.ok(d); assert.match(d.detail, /% of the disk is free/);
  const p = (await doctor({ ...cfg, limits: { ...cfg.limits, parallelProjects: 3 } }, { exec: ok, env: {} })).find((c) => c.id === 'disk'); assert.match(p.detail, /3 projects building in parallel/);
});

test('house-style profiles: theme, skill and form parts plus conventions; every ticket in a project using it gets them (even unrelated ones); unknown parts and profiles are refused; clearing works', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/app', id: 'app' }); const bare = path.join(w.root, 'lib.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]); await w.e.libraryConnect({ remote: bare });
  const code = Array.from({ length: 14 }, (_, i) => `export const field${i} = (label, value) => ({ label: label + '${i}', value, valid: String(value).length > ${i} });`).join('\n');
  const parts = [lb.buildPart({ name: 'Brand Theme', kind: 'theme', summary: 'Colours and spacing tokens', files: [{ rel: 'theme.css', content: ':root { --brand: #ff5a1f; --space: 8px; }\n'.repeat(12) }] }), lb.buildPart({ name: 'Form Standards', kind: 'skill', summary: 'How we build forms', files: [{ rel: 'forms.md', content: '# Forms\nAlways label every input and validate on blur.\n' }] }), lb.buildPart({ name: 'Signup Form', kind: 'form', summary: 'The signup form', files: [{ rel: 'signup.js', content: code }] })];
  for (const part of parts) await w.e._libPropose({ branch: 'x', files: part.files, message: 'add part', title: 't', body: 'b', direct: true });
  assert.deepEqual((await w.e.libraryList()).map((p) => p.kind).sort(), ['form', 'skill', 'theme']);
  await assert.rejects(w.e.saveProfile({ name: 'Acme SaaS', parts: ['brand-theme', 'nope'] }), /not in the library: nope/); await assert.rejects(w.e.saveProfile({ name: '' }), /needs a name/);
  const saved = await w.e.saveProfile({ name: 'Acme SaaS', description: 'Our look and feel', parts: ['brand-theme', 'form-standards', 'signup-form'], conventions: 'Use sentence case headings.\nButtons are orange.', stack: ['JavaScript'], direct: true }); assert.equal(saved.direct, true); assert.equal(saved.profile.slug, 'acme-saas');
  const list = await callOp(w.e, 'profile_list', {}); assert.equal(list.length, 1); assert.deepEqual(list[0].partsInfo.map((x) => [x.slug, x.kind]), [['brand-theme', 'theme'], ['form-standards', 'skill'], ['signup-form', 'form']]);
  assert.throws(() => w.e.setProjectProfile('app', 'nope'), /No such profile/); assert.deepEqual(await callOp(w.e, 'profile_set', { project: 'app', profile: 'Acme SaaS' }), { id: 'app', profile: 'acme-saas' }); assert.deepEqual((await w.e.libraryProfiles())[0].usedBy, ['app']);
  const d = w.e.deps(w.e.cfg.projects[0]); const text = d.config.contextFor({ id: 1, title: 'Write a contributing guide', body: 'Add CONTRIBUTING.md with how to run the tests' });
  assert.match(text, /### House style: Acme SaaS/); assert.match(text, /Follow these conventions:\nUse sentence case headings\.\nButtons are orange\./); assert.match(text, /#### Skill: Form Standards\n# Forms\nAlways label every input and validate on blur\./); assert.match(text, /brand-theme@0\.1\.0 \[theme[\s\S]*in your house style “Acme SaaS”/); assert.match(text, /signup-form@0\.1\.0 \[form/);
  const ws = tmp(); fs.mkdirSync(path.join(ws, '.git/info'), { recursive: true }); d.config.materializeContext(ws, { id: 1, title: 'Write a contributing guide', body: 'x' }); const css = path.join(ws, '.factory-context/library/brand-theme/src/theme.css'); assert.ok(fs.existsSync(css)); assert.match(fs.readFileSync(css, 'utf8'), /^\/\* factory-part: brand-theme@0\.1\.0/);
  assert.deepEqual(await callOp(w.e, 'profile_set', { project: 'app' }), { id: 'app', profile: null }); assert.doesNotMatch(d.config.contextFor({ id: 1, title: 'Write a contributing guide', body: 'Add CONTRIBUTING.md' }), /House style/);
});
