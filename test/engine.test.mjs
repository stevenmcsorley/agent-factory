import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.mjs';
import { withDefaults, loadConfig } from '../src/config.mjs';
import { fileTickets } from '../src/adapters/tickets-file.mjs';
import { sandbox } from '../src/adapters/sandbox.mjs';
import { agents } from '../src/adapters/agents.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'en-'));
function remote(root, name) {
  const r = path.join(root, `${name}.git`), seed = path.join(root, `seed-${name}`);
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  g(root, 'init', '--bare', '-b', 'main', r); fs.mkdirSync(seed); g(seed, 'init', '-b', 'main'); g(seed, 'config', 'user.email', 't@t'); g(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'x\n'); g(seed, 'add', '-A'); g(seed, 'commit', '-m', 'i'); g(seed, 'remote', 'add', 'origin', r); g(seed, 'push', 'origin', 'main');
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_COMMITTER_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_EMAIL: 't@t' });
  return r;
}
const ticket = { id: 1, title: 'Add b file please', body: 'Create `b.txt` containing hi, and it should pass when the file exists.', labels: ['agent-ready'] };

function engine(extra = {}) {
  const root = tmp();
  const projects = ['one', 'two'].map((id) => { const t = path.join(root, `${id}.json`); fs.writeFileSync(t, JSON.stringify([{ ...ticket }])); return { id, repo: `me/${id}`, base: 'main', tickets: { kind: 'file', path: t }, config: { verify: 'test -f b.txt' } }; });
  const remotes = { one: remote(root, 'one'), two: remote(root, 'two') };
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, limits: { maxRunsPerDay: 20 }, projects });
  const e = new Engine(cfg, { configPath: path.join(root, 'cfg.json'), factories: {
    sandbox: sandbox({ kind: 'local' }), agent: agents.shell({ command: 'echo hi > b.txt' }), vcs: gitVcs({ openPr: false }),
    tickets: (p) => fileTickets(p.tickets.path), host: () => ({ listAgentPrs: async () => [], getFeedback: async () => ({ failedChecks: [], pending: false, comments: [] }) }), ...extra } });
  // redirect each project's clone URL to its local bare remote
  const orig = e.deps.bind(e); e.deps = (p) => { const d = orig(p); d.config.cloneUrl = remotes[p.id]; return d; };
  return { e, root, remotes };
}

test('engine runs every project, tags runs with the project and keeps per-project state', async () => {
  const { e, remotes } = engine({ });
  e.cfg.limits.maxConcurrent = 1;
  const out = await e.tickAll();
  assert.deepEqual(out.map((r) => [r.project, r.status]), [['one', 'ok'], ['two', 'ok']]);
  for (const k of ['one', 'two']) assert.match(execFileSync('git', ['branch', '-a'], { cwd: remotes[k] }).toString(), /agent\/1-add-b-file-please/);
  const runs = e.runs(); assert.deepEqual(runs.map((r) => r.project).sort(), ['one', 'two']);
  const s = e.status(); assert.equal(s.today.runs, 2); assert.deepEqual(s.projects.map((p) => p.ok), [1, 1]);
  assert.ok(fs.existsSync(path.join(e.cfg.stateDir, 'projects', 'one')) && fs.existsSync(path.join(e.cfg.stateDir, 'projects', 'two')));
});

test('daily run cap is shared across projects', async () => {
  const { e } = engine(); e.cfg.limits.maxRunsPerDay = 1;
  const out = await e.tickAll();
  assert.deepEqual(out.map((r) => r.status), ['ok', 'budget-exhausted']);
});

test('pause/resume via STOP file, per-project pause, and busy guard', async () => {
  const { e } = engine();
  e.pause(); assert.equal(e.status().paused, true); assert.deepEqual((await e.tickAll()).map((r) => r.status), ['stopped', 'stopped']);
  e.resume(); e.setProjectPaused('two', true);
  assert.deepEqual((await e.tickAll()).map((r) => r.project), ['one']);
  e.busy = true; assert.deepEqual(await e.tickAll(), { skipped: 'busy' }); e.busy = false;
});

test('createTicket queues work through the adapter; validates title', async () => {
  const { e } = engine();
  const r = await e.createTicket('one', { title: 'New thing', body: 'details' });
  assert.equal(r.id, 2); assert.equal((await e.listTickets('one')).length, 2);
  await assert.rejects(e.createTicket('one', { title: '' }), /title is required/);
  await assert.rejects(e.createTicket('nope', { title: 'x' }), /No such project/);
});

test('addProject validates via GitHub, creates labels, persists; rejects bad config; removeProject persists', async () => {
  const { e, root } = engine(); const calls = [];
  e.gh = { whoami: async () => 'me', inspectRepo: async (r) => { calls.push(`inspect ${r}`); return { defaultBranch: 'trunk' }; }, ensureLabels: async (r) => calls.push(`labels ${r}`) };
  const p = await e.addProject({ id: 'three', repo: 'me/three' });
  assert.equal(p.base, 'trunk'); assert.deepEqual(p.tickets, { kind: 'github', allowedAuthors: ['me'] }); assert.deepEqual(calls, ['inspect me/three', 'labels me/three']);
  assert.equal(loadConfig(path.join(root, 'cfg.json')).projects.length, 3);
  await assert.rejects(e.addProject({ id: 'three', repo: 'me/dup' }), /duplicate/);
  await assert.rejects(e.addProject({ id: 'Bad Id', repo: 'me/x' }), /must match/);
  e.removeProject('three'); assert.equal(loadConfig(path.join(root, 'cfg.json')).projects.length, 2);
});

test('createProject scaffolds a repo, registers it and queues the spec as the first ticket', async () => {
  const { e } = engine(); let made;
  e.gh = { whoami: async () => 'me', createProjectRepo: async (o) => { made = o; return { repo: `me/${o.name}`, url: 'u', defaultBranch: 'main' }; },
    inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  // the new project uses the file source here so the queued ticket is observable
  const orig = e.addProject.bind(e); e.addProject = (a) => orig({ ...a, tickets: { kind: 'file', path: e.cfg.projects[0].tickets.path } });
  const r = await e.createProject({ id: 'shop', name: 'shop', description: 'd', visibility: 'private', template: 'node', spec: 'Build a shop with a cart and tests.' });
  assert.equal(made.owner, 'me'); assert.equal(made.identity.email, 'me@users.noreply.github.com'); assert.equal(r.project.repo, 'me/shop');
  assert.ok((await e.listTickets('shop')).some((t) => t.title === 'Build shop'));
});
