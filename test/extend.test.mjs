import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { OPS, callOp } from '../src/ops.mjs';
import { discover, enablePlugin, disablePlugin, readEnabled, loadPlugins, hashDir } from '../src/plugins.mjs';
import * as sc from '../src/scenarios.mjs';
import { scanText } from '../src/quality.mjs';
import { KINDS } from '../src/library.mjs';
import { getPrompt } from '../src/prompts.mjs';
import { buildPrompt } from '../src/factory.mjs';

const tmp = (p = 'ex-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const plugin = (root, name, { secrets = [], body, manifest = {} } = {}) => { const d = path.join(root, 'plugins', name); write(path.join(d, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: `${name} plugin`, secrets, ...manifest })); write(path.join(d, 'index.mjs'), body ?? 'export function register() {}'); return d; };
const REPO_PLUGINS = path.resolve('plugins');

function world() {
  const root = tmp(); const store = []; let n = 100;
  const tk = { create: async ({ title, body }) => { const id = ++n; store.push({ id, title, body, state: 'OPEN', labels: ['agent-ready'], url: `https://x/issues/${id}` }); return { url: `https://x/issues/${id}` }; }, listAgentTickets: async () => store.map(({ body, ...t }) => t), poll: async () => [] };
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { tickets: () => tk, hostAdapter: () => ({ cloneUrl: () => 'x', gitEnv: () => ({}), prUrl: () => '' }) } });
  e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  return { e, root, store };
}

test('plugins: found and hash-pinned; adds ops, step types, rules and part kinds; secrets are scoped; edits after approval are refused; bad ones are contained', async () => {
  const root = tmp(); const dirs = [path.join(root, 'plugins')];
  plugin(root, 'demo', { secrets: ['AF_DEMO_TOKEN'], body: `export function register(api) {
    api.registerOp({ name: 'ping', readOnly: true, description: 'pong', input: { properties: { who: { type: 'string' } } }, handler: async (_e, a) => ({ pong: a.who ?? 'you', token: api.secret('AF_DEMO_TOKEN') }) });
    api.registerStep('hello', { describe: (a) => 'hello ' + a.who, run: async (a) => ({ hi: a.who }) });
    api.registerRule({ id: 'no-foo', type: 'code_smell', severity: 'MAJOR', msg: 'foo is banned', langs: ['js'], re: /\\bfoo\\(/ });
    api.registerPartKind('recipe'); let denied = ''; try { api.secret('AF_OTHER'); } catch (e) { denied = e.message; } api.registerOp({ name: 'denied', readOnly: true, description: 'x', handler: async () => ({ denied }) });
  }` });
  plugin(root, 'tamper', { body: "export function register(api) { api.registerOp({ name: 'tp', readOnly: true, description: 'x', handler: async () => 1 }); }" });
  plugin(root, 'clash', { body: "export function register(api) { api.registerOp({ name: 'ping', readOnly: true, description: 'x', handler: async () => 1 }); api.registerOp({ name: 'ping', readOnly: true, description: 'dup', handler: async () => 1 }); }" });
  plugin(root, 'broken', { body: 'export const nope = 1;' }); plugin(root, 'badsecret', { secrets: ['lowercase_token'] }); write(path.join(root, 'plugins/Bad Name/plugin.json'), '{}');
  const found = discover(dirs); assert.deepEqual(found.filter((p) => !p.error).map((p) => p.manifest.name).sort(), ['broken', 'clash', 'demo', 'tamper']); assert.equal(found.filter((p) => p.error).length, 2);
  assert.equal(hashDir(path.join(dirs[0], 'demo')), hashDir(path.join(dirs[0], 'demo')));
  const before = await loadPlugins({ dirs, enabled: {}, env: {} }); assert.ok(before.every((r) => ['available', 'invalid'].includes(r.status)), 'nothing runs until you enable it'); assert.ok(!OPS.some((o) => o.name === 'demo_ping'));
  for (const n of ['demo', 'tamper', 'clash', 'broken']) enablePlugin(root, dirs, n); assert.deepEqual(Object.keys(readEnabled(root)).sort(), ['broken', 'clash', 'demo', 'tamper']); assert.throws(() => enablePlugin(root, dirs, 'nope'), /No plugin named/); assert.throws(() => enablePlugin(root, dirs, 'badsecret'), /AF_MY_TOKEN|must look like/);
  fs.appendFileSync(path.join(dirs[0], 'tamper', 'index.mjs'), '\n// edited after approval\n');
  const report = await loadPlugins({ dirs, enabled: readEnabled(root), env: { AF_DEMO_TOKEN: 's3cret' } }); const by = Object.fromEntries(report.map((r) => [r.name, r]));
  assert.equal(by.demo.status, 'loaded'); assert.deepEqual(by.demo.provides.sort(), ['op:demo_denied', 'op:demo_ping', 'part-kind:recipe', 'rule:demo.no-foo', 'step:demo.hello']); assert.equal(by.tamper.status, 'changed'); assert.match(by.tamper.error, /changed since you enabled/); assert.ok(!OPS.some((o) => o.name === 'tamper_tp'), 'a changed plugin is never executed');
  assert.equal(by.clash.status, 'error'); assert.match(by.clash.error, /already exists/); assert.equal(by.broken.status, 'error'); assert.match(by.broken.error, /export register/);
  assert.deepEqual(await callOp({}, 'demo_ping', { who: 'sam' }), { pong: 'sam', token: 's3cret' }); assert.match((await callOp({}, 'demo_denied', {})).denied, /did not declare the secret AF_OTHER/); await assert.rejects(callOp({}, 'demo_ping', { nope: 1 }), /unknown argument/);
  assert.ok(sc.stepTypes().includes('demo.hello')); assert.ok(KINDS.includes('recipe')); assert.deepEqual(scanText('a.js', 'foo(1)\nbar(2)\n').map((f) => f.rule), ['demo.no-foo']); assert.deepEqual(scanText('a.py', 'foo(1)\n'), []);
  disablePlugin(root, 'demo'); assert.ok(!readEnabled(root).demo); assert.throws(() => disablePlugin(root, 'demo'), /not enabled/);
  assert.ok(!OPS.some((o) => /(^|_)(enable|disable)/.test(o.name) && /plugin/.test(o.name)) && !OPS.some((o) => o.name === 'scenario_approve'), 'agents cannot enable plugins or approve gates through MCP');
});

test('scenario files: validated strictly; templates resolve and refuse unknowns; secrets must be declared', () => {
  const ok = { id: 'x', name: 'X', params: { domain: { required: true } }, secrets: ['AF_T'], allowHosts: ['api.example.com'], steps: [{ id: 'a', type: 'note' }, { id: 'b', type: 'approve', requires: ['a'] }] };
  const v = sc.validateScenario(ok); assert.deepEqual(v.steps.map((s) => s.requires), [[], ['a']]);
  for (const [bad, re] of [[{ ...ok, id: 'Bad Id' }, /scenario id/], [{ ...ok, steps: [] }, /between 1 and 60/], [{ ...ok, steps: [{ id: 'a', type: 'note' }, { id: 'a', type: 'note' }] }, /unique/], [{ ...ok, steps: [{ id: 'a', type: 'nope' }] }, /unknown type/], [{ ...ok, steps: [{ id: 'a', type: 'plug.in' }] }, /is the plugin enabled/], [{ ...ok, steps: [{ id: 'a', type: 'note', requires: ['zz'] }] }, /requires unknown/], [{ ...ok, secrets: ['token'] }, /AF_MY_TOKEN/], [{ ...ok, allowHosts: ['10.0.0.1'] }, /public host/], [{ ...ok, params: { 'bad name': {} } }, /param name/]]) assert.throws(() => sc.validateScenario(bad), re);
  const scope = { params: { d: 'a.com' }, project: { id: 'p' }, steps: { s1: { output: { url: 'u' } } } };
  assert.equal(sc.render('x {{params.d}} {{project.id}} {{steps.s1.output.url}}', scope), 'x a.com p u'); assert.deepEqual(sc.render({ a: ['{{params.d}}'] }, scope), { a: ['a.com'] }); assert.throws(() => sc.render('{{params.nope}}', scope), /Unknown value/);
  assert.equal(sc.render('Bearer {{secret:AF_T}}', scope, { secrets: { AF_T: 'tok' }, allowed: ['AF_T'] }), 'Bearer tok'); assert.throws(() => sc.render('{{secret:AF_T}}', scope, { secrets: { AF_T: 'tok' }, allowed: [] }), /does not declare/); assert.throws(() => sc.render('{{secret:AF_T}}', scope, { secrets: {}, allowed: ['AF_T'] }), /not set/);
});

const SHIP = { id: 'gate-test', name: 'Gate test', params: { env: { default: 'production' } }, steps: [{ id: 'ready', type: 'check', check: 'brief-ready', title: 'Brief ready' }, { id: 'approve', type: 'approve', message: 'Go live in {{params.env}}?' }, { id: 'make', type: 'ticket', title: 'Announce the release in the changelog', body: 'Add a release note.\n\nAcceptance criteria:\n- changelog updated', waitFor: 'closed' }, { id: 'done', type: 'note', text: 'finished' }] };

test('scenario runs: dry run by default (checks real, side effects only described); live runs stop at the human gate; tickets are waited on; every state is persisted', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/app', id: 'app' }); write(path.join(w.root, 'scenarios/gate-test.json'), JSON.stringify(SHIP));
  assert.ok(w.e.scenarios().some((s) => s.id === 'ship') && w.e.scenarios().some((s) => s.id === 'prototype') && w.e.scenarios().some((s) => s.id === 'gate-test'), 'built-in and your own scenarios are listed');
  await assert.rejects(w.e.startScenario({ project: 'app', scenario: 'nope' }), /No such scenario/); await assert.rejects(w.e.startScenario({ project: 'app', scenario: 'gate-test', params: { bogus: 1 } }), /Unknown parameter/);
  let r = await w.e.startScenario({ project: 'app', scenario: 'gate-test' }); assert.equal(r.dryRun, true); assert.equal(r.status, 'waiting'); assert.equal(r.steps.ready.status, 'waiting'); assert.match(r.steps.ready.detail, /missing: Goal/);   // the check is real
  w.e.setPack('app', { brief: { goal: 'A booking app for gyms', scope: 'classes API and a list page' } });
  r = await w.e.scenarioRun('app', r.id); assert.equal(r.status, 'done'); assert.equal(r.steps.approve.output.would, 'ask a human: Go live in production?'); assert.match(r.steps.make.output.would, /queue the ticket "Announce the release/); assert.equal(w.store.length, 0, 'a dry run creates nothing');
  r = await w.e.startScenario({ project: 'app', scenario: 'gate-test', apply: true }); assert.equal(r.dryRun, false); assert.equal(r.status, 'waiting-approval'); assert.equal(r.steps.approve.status, 'waiting-approval'); assert.equal(r.steps.make.status, 'pending'); assert.equal(w.store.length, 0, 'nothing happens before approval');
  assert.throws(() => w.e.scenarioApprove('app', r.id, 'make'), /not waiting for approval/); assert.throws(() => w.e.scenarioApprove('app', r.id, 'zz'), /No such step/);
  w.e.scenarioApprove('app', r.id, 'approve', 'the UI user'); r = await w.e.scenarioRun('app', r.id); assert.equal(r.steps.approve.status, 'done'); assert.deepEqual(r.approvals.map((a) => [a.step, a.by]), [['approve', 'the UI user']]); assert.equal(r.steps.make.status, 'waiting'); assert.equal(w.store.length, 1); assert.match(w.store[0].title, /Announce the release/);
  await w.e.scenarioRun('app', r.id); assert.equal(w.store.length, 1, 'the ticket is created once'); w.store[0].state = 'CLOSED'; r = await w.e.scenarioRun('app', r.id); assert.equal(r.status, 'done'); assert.equal(r.steps.done.output.note, 'finished');
  assert.equal((await w.e.scenarioRuns('app')).length, 2); assert.ok(fs.existsSync(path.join(w.e.cfg.stateDir, 'projects/app/scenarios', `${r.id}.json`)));
  const c = await w.e.startScenario({ project: 'app', scenario: 'gate-test', apply: true }); assert.equal(w.e.scenarioCancel('app', c.id).status, 'cancelled'); assert.ok(Object.values(w.e.scenarioCancel('app', c.id).steps).every((s) => ['skipped', 'done'].includes(s.status)));
  assert.deepEqual(await callOp(w.e, 'scenario_list', {}).then((l) => l.map((x) => x.id).filter((i) => ['ship', 'prototype', 'gate-test'].includes(i)).sort()), ['gate-test', 'prototype', 'ship']); assert.equal((await callOp(w.e, 'scenario_run', { project: 'app', scenario: 'prototype' })).dryRun, true);
});

test('http steps: https only, allow-listed hosts, no private addresses, no redirects, secrets resolved only when declared and never stored; failures stop the run, optional steps do not, waits can time out', async () => {
  const w = await world(); await w.e.addProject({ repo: 'o/app', id: 'app' }); w.e.env.AF_API_TOKEN = 'tok_live_123456'; const seen = [];
  const fakeFetch = async (u, o) => { seen.push({ url: String(u), method: o.method, auth: o.headers?.Authorization, redirect: o.redirect }); return { status: 201, ok: true, text: async () => JSON.stringify({ ok: true, echo: o.headers?.Authorization }) }; };
  const base = { id: 'h', name: 'H', secrets: ['AF_API_TOKEN'], allowHosts: ['api.example.com'] };
  const run = async (steps, scn = {}) => { const def = sc.validateScenario({ ...base, ...scn, steps }); const r = sc.startRun(w.e, { scenario: def, project: 'app', dryRun: false }); return sc.advance(w.e, 'app', r.id, { scenarios: [def], fetch: fakeFetch }); };
  let r = await run([{ id: 'call', type: 'http', method: 'POST', url: 'https://api.example.com/v1/deploy', headers: { Authorization: 'Bearer {{secret:AF_API_TOKEN}}' }, body: { a: 1 } }]);
  assert.equal(r.status, 'done'); assert.equal(seen[0].auth, 'Bearer tok_live_123456'); assert.equal(seen[0].redirect, 'error'); assert.doesNotMatch(JSON.stringify(r), /tok_live_123456/, 'the secret is redacted from the stored run'); assert.match(JSON.stringify(r.steps.call.output), /••••/);
  for (const [url, re] of [['http://api.example.com/x', /https:\/\//], ['https://evil.example.org/x', /allowHosts/], ['https://user:pw@api.example.com/x', /without credentials/]]) { r = await run([{ id: 'c', type: 'http', url }]); assert.equal(r.status, 'failed'); assert.match(r.steps.c.error, re); }
  r = await run([{ id: 'c', type: 'http', url: 'https://api.example.com/x', method: 'TRACE' }]); assert.match(r.steps.c.error, /not allowed/); r = await run([{ id: 'c', type: 'http', url: 'https://api.example.com/x', headers: { Authorization: '{{secret:AF_NOT_DECLARED}}' } }]); assert.match(r.steps.c.error, /does not declare/);
  r = await run([{ id: 'a', type: 'http', url: 'https://evil.example.org/x' }, { id: 'b', type: 'note', text: 'later' }]); assert.deepEqual([r.status, r.steps.a.status, r.steps.b.status], ['failed', 'failed', 'skipped']);
  r = await run([{ id: 'a', type: 'http', url: 'https://evil.example.org/x', optional: true }, { id: 'b', type: 'note', text: 'later', requires: [] }]); assert.deepEqual([r.status, r.steps.a.status, r.steps.b.status], ['done', 'skipped', 'done']);
  r = await run([{ id: 'w', type: 'check', check: 'brief-ready', timeoutMs: 1 }]); await new Promise((x) => setTimeout(x, 15)); r = await sc.advance(w.e, 'app', r.id, { scenarios: [sc.validateScenario({ ...base, steps: [{ id: 'w', type: 'check', check: 'brief-ready', timeoutMs: 1 }] })] }); assert.equal(r.steps.w.status, 'failed'); assert.match(r.steps.w.error, /timed out waiting/);
  await assert.rejects(sc.safeFetch({ allowHosts: ['localhost'] }, { url: 'https://localhost/x' }, fakeFetch), /not allowed/);
});

test('the Cloudflare plugin: a dry run only READS and shows the exact change; a real run creates/updates; a second run is a no-op; the token never lands on disk; the wrong host or missing token is refused', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/app', id: 'app' }); const root = w.root; w.e.env.AF_CLOUDFLARE_TOKEN = 'cf_super_secret_token'; enablePlugin(root, [REPO_PLUGINS], 'cloudflare'); const rep = await w.e.loadPlugins(); assert.equal(rep.find((r) => r.name === 'cloudflare').status, 'loaded'); assert.deepEqual(rep.find((r) => r.name === 'cloudflare').provides.sort(), ['step:cloudflare.dns', 'step:cloudflare.pages-deploy']);
  const db = { records: [] }; const calls = [];
  const fake = async (u, o) => { const url = new URL(u); const p = url.pathname.replace('/client/v4', ''); calls.push(`${o.method} ${p}${url.search}`); const reply = (result, status = 200) => ({ status, ok: status < 300, text: async () => JSON.stringify({ success: status < 300, result, errors: status < 300 ? [] : [{ message: 'nope' }] }) });
    if (o.headers.Authorization !== 'Bearer cf_super_secret_token') return reply(null, 403);
    if (p === '/zones' && o.method === 'GET') return reply(url.searchParams.get('name') === 'example.com' ? [{ id: 'z1' }] : []);
    if (p === '/zones/z1/dns_records' && o.method === 'GET') return reply(db.records.filter((r) => r.name === url.searchParams.get('name')));
    if (p === '/zones/z1/dns_records' && o.method === 'POST') { const rec = { id: 'r1', ...JSON.parse(o.body) }; db.records.push(rec); return reply(rec); }
    if (p === '/zones/z1/dns_records/r1' && o.method === 'PUT') { Object.assign(db.records[0], JSON.parse(o.body)); return reply(db.records[0]); }
    if (p === '/accounts/acc1/pages/projects/site/deployments' && o.method === 'POST') return reply({ id: 'dep1', url: 'https://abc.site.pages.dev', environment: 'production' });
    return reply(null, 404); };
  const scn = JSON.parse(fs.readFileSync('docs/examples/cloudflare-ship.json', 'utf8')); scn.steps = scn.steps.filter((s) => ['dns', 'deploy'].includes(s.id)).map((s, i) => ({ ...s, requires: i ? ['dns'] : [] })); const def = sc.validateScenario(scn);
  const params = { zone: 'example.com', hostname: 'app.example.com', pagesProject: 'site', accountId: 'acc1' }; const go = async (dryRun) => { const r = sc.startRun(w.e, { scenario: def, project: 'app', params, dryRun }); return sc.advance(w.e, 'app', r.id, { scenarios: [def], fetch: fake }); };
  let r = await go(true); assert.equal(r.status, 'done'); assert.deepEqual(r.steps.dns.output.plan, { change: 'create', to: { type: 'CNAME', name: 'app.example.com', content: 'site.pages.dev', ttl: 1, proxied: true } }); assert.match(r.steps.deploy.output.would, /trigger a Cloudflare Pages deployment of site/); assert.ok(calls.every((c) => c.startsWith('GET')), `dry run only reads: ${calls}`); assert.equal(db.records.length, 0);
  calls.length = 0; r = await go(false); assert.equal(r.status, 'done'); assert.equal(r.steps.dns.output.change, 'create'); assert.equal(r.steps.deploy.output.deploymentId, 'dep1'); assert.equal(db.records.length, 1); assert.ok(calls.some((c) => c.startsWith('POST /zones/z1/dns_records')) && calls.some((c) => c.startsWith('POST /accounts/acc1/pages')));
  calls.length = 0; r = await go(false); assert.equal(r.steps.dns.output.change, 'none'); assert.ok(!calls.some((c) => c.startsWith('POST /zones')));
  db.records[0].content = 'old.example.net'; r = await go(true); assert.deepEqual(r.steps.dns.output.plan.from, { content: 'old.example.net', proxied: true }); assert.equal(r.steps.dns.output.plan.change, 'update'); r = await go(false); assert.equal(r.steps.dns.output.change, 'update'); assert.equal(db.records[0].content, 'site.pages.dev');
  const files = fs.readdirSync(path.join(w.e.cfg.stateDir, 'projects/app/scenarios')).map((f) => fs.readFileSync(path.join(w.e.cfg.stateDir, 'projects/app/scenarios', f), 'utf8')).join(''); assert.doesNotMatch(files, /cf_super_secret_token/, 'the token is never persisted');
  const bad = await (async () => { const d2 = sc.validateScenario({ ...scn, allowHosts: ['api.example.com'] }); const run = sc.startRun(w.e, { scenario: d2, project: 'app', params, dryRun: false }); return sc.advance(w.e, 'app', run.id, { scenarios: [d2], fetch: fake }); })(); assert.equal(bad.status, 'failed'); assert.match(bad.steps.dns.error, /allowHosts/);
  delete w.e.env.AF_CLOUDFLARE_TOKEN; r = await go(false); assert.equal(r.status, 'failed'); assert.match(r.steps.dns.error, /AF_CLOUDFLARE_TOKEN is not set|does not declare|not set/);
});

test('prompts are overridable data: a file in the config folder changes what agents are told; oversized or missing files fall back to the built-in text', () => {
  const dir = tmp(); const builtin = getPrompt('task-rules'); assert.match(builtin, /make the smallest correct change/); assert.equal(getPrompt('task-rules', {}, [dir]), builtin);
  write(path.join(dir, 'task-rules.md'), 'Rules for {{team}}: write tests first.'); assert.equal(getPrompt('task-rules', { team: 'Acme' }, [dir]), 'Rules for Acme: write tests first.'); assert.equal(getPrompt('task-rules', {}, [dir]), 'Rules for {{team}}: write tests first.');
  const p = buildPrompt({ id: 1, title: 'T', body: 'B' }, '', '', '', getPrompt('task-rules', { team: 'Acme' }, [dir])); assert.match(p, /Rules for Acme: write tests first\./); assert.doesNotMatch(p, /smallest correct change/); assert.match(buildPrompt({ id: 1, title: 'T', body: 'B' }), /make the smallest correct change/);
  write(path.join(dir, 'task-rules.md'), 'x'.repeat(9000)); assert.equal(getPrompt('task-rules', {}, [dir]), builtin); assert.throws(() => getPrompt('nope'), /Unknown prompt/);
});

test('self-modification guardrails: the repository protects its security core, and the loader/engine files themselves', async () => {
  const { protectedViolations } = await import('../src/repoconfig.mjs'); const cfg = JSON.parse(fs.readFileSync('.agent-factory.json', 'utf8'));
  for (const f of ['src/gitguard.mjs', 'src/adapters/sandbox.mjs', 'src/egress-proxy.mjs', 'src/server.mjs', 'src/plugins.mjs', 'src/scenarios.mjs', '.github/workflows/ci.yml', '.agent-factory.json', 'LICENSE']) assert.deepEqual(protectedViolations(` M ${f}\n`, cfg.protectedPaths), [f], f);
  assert.deepEqual(protectedViolations(' M src/ui-only.mjs\n M docs/GUIDE.md\n M ui/library.js\n', cfg.protectedPaths), []);
});
