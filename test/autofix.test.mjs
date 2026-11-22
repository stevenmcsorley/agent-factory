// Autonomous mode fixing what it holds: the reviewers asked for changes -> the builder addresses the findings, the checks and the reviewers run again, and the
// pass merges it only if they now approve; bounded rounds; and the one-switch "unattended" setup.
import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { tick } from '../src/factory.mjs';
import { forgeDir } from '../src/adapters/host-local.mjs';
import { callOp } from '../src/ops.mjs';
import { normalizeAutonomy } from '../src/autonomy.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'af-'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
const bare = (repo, ...a) => execFileSync('git', ['--git-dir', repo, ...a], { stdio: 'pipe' }).toString().trim();
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };

// An engine whose agent is scripted: a fix prompt makes the change the reviewers wanted (when `fixes`), a review prompt approves only a file that has the header.
function world({ fixes = true } = {}) {
  const root = tmp(); const calls = { fix: 0, review: 0 };
  const sandbox = { create: async ({ cloneUrl, branch, base, newBranch }) => { const dir = fs.mkdtempSync(path.join(root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', newBranch === false && branch !== 'design' ? branch : base, cloneUrl, dir]); if (newBranch !== false) git(dir, 'checkout', '-qb', branch); return { dir, cloneUrl, destroy() {} }; },
    exec: async (ws, cmd, args) => { try { return { code: 0, out: execFileSync(cmd, args, { cwd: ws.dir, stdio: 'pipe' }).toString() }; } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; } } };
  const agent = { run: async (_sb, ws, prompt) => {
    if (/## What to (design|draw)/.test(prompt)) { calls.design = (calls.design ?? 0) + 1; const out = path.join(ws.dir, '.factory-design'); if (/## What to draw/.test(prompt)) { write(path.join(out, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'); write(path.join(out, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>'); } else write(path.join(out, 'design.html'), `<!doctype html><html><body><main><h1>${/the (\S+\.html) page/.exec(prompt)?.[1] ?? 'page'}</h1></main></body></html>`); return { out: 'designed', costUsd: 0 }; }
    if (/Independent reviewers asked for changes/.test(prompt)) { calls.fix++; if (fixes) write(path.join(ws.dir, 'a.js'), '// header\nexport const a = 1;\n'); return { out: 'done', costUsd: 0 }; }
    calls.review++; const has = fs.readFileSync(path.join(ws.dir, 'a.js'), 'utf8').includes('// header');
    return { out: JSON.stringify(has ? { verdict: 'approve', summary: 'good', findings: [] } : { verdict: 'changes', summary: 'needs a header', findings: [{ severity: 'major', file: 'a.js', line: 1, issue: 'the file has no header comment', fix: 'add one' }] }), costUsd: 0 };
  } };
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { sandbox, agent } });
  return { e, root, calls, repo: () => path.join(forgeDir(e.cfg.stateDir, 'app'), 'repo.git') };
}
// The builder's first attempt has no header, and its (recorded) review says "changes": exactly what autonomous mode would hold.
async function heldPr(w) {
  await w.e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } }); w.e.setVerify('app', { verify: 'test -f a.js' }); w.e.setAutonomyAllowed({ allow: true });
  const p = w.e.project('app'); const d = w.e.deps(p); d.config.maxAttempts = 1; d.config.verify = 'test -f a.js';
  d.agent = { run: async (_sb, ws) => { write(path.join(ws.dir, 'a.js'), 'export const a = 1;\n'); return { out: 'done', costUsd: 0 }; } };
  d.config.review = async () => ({ verdict: 'changes', summary: 'needs a header', findings: [{ severity: 'major', file: 'a.js', line: 1, issue: 'the file has no header comment', fix: 'add one' }] });
  await w.e.createTicket('app', { title: 'Add a', body: 'Add a to a.js with a test that checks it works.' }); const [rec] = await tick(d); assert.equal(rec.status, 'ok'); return rec;
}

test('autonomy settings: the fix rounds and automatic conflict resolution are validated, with sensible defaults', () => {
  const a = normalizeAutonomy({ mode: 'merge' }, {}); assert.equal(a.fixReviewRounds, 2); assert.equal(a.autoResolveConflicts, true);
  assert.equal(normalizeAutonomy({ fixReviewRounds: 0 }, a).fixReviewRounds, 0, '0 turns the fixing off'); assert.throws(() => normalizeAutonomy({ fixReviewRounds: 9 }, a), /0 to 5/); assert.throws(() => normalizeAutonomy({ autoResolveConflicts: 'yes' }, a), /true or false/);
});

test('autonomous mode: a PR held because the reviewers asked for changes is fixed, re-checked, re-reviewed and then merged', async () => {
  const w = world(); await heldPr(w); w.e.setUnattended('app', { rounds: 2 }); const p = w.e.project('app');
  const res = await w.e.autopilot(p); assert.deepEqual(res.map((r) => r.status), ['merged']); assert.equal(w.calls.fix, 1); assert.equal(w.calls.review, 1, 'the reviewers looked again after the fix');
  assert.match(bare(w.repo(), 'show', 'main:a.js'), /\/\/ header/); const a = w.e._autoState(); assert.equal(a.fixRounds['app:1'], 1);
  assert.ok(fs.readFileSync(path.join(w.e.cfg.stateDir, 'audit.jsonl'), 'utf8').includes('"auto-fix"'), 'the round is in the audit trail');
});

test('autonomous mode: the rounds are bounded: when the builder cannot satisfy the reviewers the PR stays held and nothing is merged or looped on', async () => {
  const w = world({ fixes: false }); await heldPr(w); w.e.setUnattended('app', { rounds: 1 }); const p = w.e.project('app');
  assert.deepEqual((await w.e.autopilot(p)).map((r) => r.status), ['held']); const fixed = w.calls.fix; assert.ok(fixed >= 1);
  assert.deepEqual((await w.e.autopilot(p)).map((r) => r.status), ['held']); assert.equal(w.calls.fix, fixed, 'the second pass does not start another round: the project\'s rounds are used up');
  assert.throws(() => bare(w.repo(), 'show', 'main:a.js'), 'nothing was merged');
});

test('autonomous mode: with fixReviewRounds 0 (or for a PR with a problem a fix cannot cure) nothing is attempted', async () => {
  const w = world(); await heldPr(w); w.e.setUnattended('app', { rounds: 0 }); const p = w.e.project('app'); assert.deepEqual((await w.e.autopilot(p)).map((r) => r.status), ['held']); assert.equal(w.calls.fix, 0);
});

test('unattended: one switch sets the roles and autonomous mode together, says what is missing instead of half-applying, and can be turned off', async () => {
  const w = world(); await w.e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } });
  assert.throws(() => w.e.setUnattended('app', {}), /autonomous merging for the factory.*test command|test command.*autonomous merging/s); assert.equal(w.e.project('app').autonomy, undefined, 'nothing was half-applied');
  w.e.setAutonomyAllowed({ allow: true }); assert.throws(() => w.e.setUnattended('app', {}), /test command/); w.e.setVerify('app', { verify: 'npm test' });
  const s = w.e.setUnattended('app', { rounds: 3, security: false }); assert.equal(s.on, true); assert.equal(s.rounds, 3); assert.equal(s.autoResolveConflicts, true); assert.deepEqual(s.roles, { reviewer: true, security: false, tester: true, 'spec-writer': true }); assert.equal(s.maxMergesPerDay, 20); assert.equal(s.factorySwitch, true); assert.equal(typeof s.factoryMergesPerDay, 'number'); assert.deepEqual(s.needs, []); assert.equal(s.hasTestCommand, true);
  assert.equal(w.e.setUnattended('app', { on: false }).on, false); assert.equal(w.e.project('app').autonomy.mode, 'off');
});

test('unattended over MCP: set_unattended and unattended_status are operations', async () => {
  const w = world(); await w.e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } }); w.e.setVerify('app', { verify: 'npm test' }); w.e.setAutonomyAllowed({ allow: true });
  const r = await callOp(w.e, 'set_unattended', { project: 'app', rounds: 1, security: true }); assert.equal(r.on, true); assert.equal(r.roles.security, true); assert.equal((await callOp(w.e, 'unattended_status', { project: 'app' })).rounds, 1);
});

test('set_plan: a plan you bring yourself becomes the proposed plan, with dependencies kept, and launches like any other', async () => {
  const w = world(); await w.e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } });
  const r = await callOp(w.e, 'set_plan', { project: 'app', summary: 'mine', epics: [{ id: 'site', title: 'Site', goal: 'g', tickets: [{ id: 'foundation', title: 'Shared foundation', body: 'Create index.html and styles.css with a test that checks they exist.', size: 'M', dependsOn: [] }, { id: 'shop', title: 'Shop page', body: 'Create shop.html and add one navigation item, with a test that checks the link.', size: 'M', dependsOn: ['foundation'] }] }] });
  assert.equal(r.plan.status, 'proposed'); assert.deepEqual(r.plan.epics[0].tickets.map((t) => [t.id, t.dependsOn]), [['foundation', []], ['shop', ['foundation']]]);
  await w.e.launchPlan('app'); const g = await w.e.getPlan('app'); assert.equal(g.progress.queued, 1, 'only the first ticket exists until it is merged'); assert.equal(g.progress.planned, 1);
});

test('autonomous mode: two passes at once on one project never run two fix rounds on the same PR (the second is skipped)', async () => {
  const w = world(); await heldPr(w); w.e.setUnattended('app', { rounds: 2 }); const p = w.e.project('app');
  const [a, b] = await Promise.all([w.e.autopilot(p), w.e.autopilot(p)]); const all = [...a, ...b].map((r) => r.status).sort();
  assert.deepEqual(all, ['merged', 'skipped-busy']); assert.equal(w.calls.fix, 1, 'one fix round, not two');
});

test('design pass: one screen per page named in the brief plus an artwork set, approved automatically, with tickets held back until it is done', async () => {
  const w = world(); await w.e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } });
  assert.throws(() => w.e.designProject('app', {}), /brief first/);
  w.e.setPack('app', { brief: { goal: 'A small shop site for tenement flats.', scope: '- `index.html` Home: the hero and cards.\n- `about.html` About: what the shop is for.\n- `index.html` is also the brand home.' } });
  const r = w.e.designProject('app', {}); assert.equal(r.started, true); assert.deepEqual(r.jobs, ['Index page', 'About page', 'Brand and artwork set']);
  assert.throws(() => w.e.designProject('app', {}), /already working/);
  for (let i = 0; i < 200 && w.e.designPassStatus('app').state === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
  const st = w.e.designPassStatus('app'); assert.equal(st.state, 'done', st.error ?? ''); assert.equal(st.done, 3); assert.equal(st.inUse, 3);
  const used = w.e.designsInUse?.('app') ?? null; void used; const pack = (await import('../src/designs.mjs')).inUse(w.e._packDir('app')); assert.deepEqual(pack.designs.map((d) => d.kind).sort(), ['assets', 'screen', 'screen']);
  assert.equal(w.e.designProject('app', {}).started, false, 'idempotent: everything already has a design');
  assert.match(w.e._designContext('app'), /index|About|page/i, 'the builder is told about the approved designs');
});

test('design pass: the unattended switch starts it (and says so), and tickets are not released while it runs', async () => {
  const w = world(); await w.e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } }); w.e.setVerify('app', { verify: 'npm test' }); w.e.setAutonomyAllowed({ allow: true });
  w.e.setPack('app', { brief: { goal: 'A small shop site for tenement flats.', scope: '- `index.html` Home.' } });
  const s = w.e.setUnattended('app', {}); assert.equal(s.design.started, true); assert.equal(s.design.approve, true);
  w.e._designPass.get('app').state = 'running'; assert.equal((await w.e.releasePlan('app')).waiting, 'designs');
  for (let i = 0; i < 200 && w.e.designJobs?.size; i++) await new Promise((r) => setTimeout(r, 50));
  w.e._designPass.get('app').state = 'done'; assert.equal(w.e.setUnattended('app', { designs: false }).design, null);
});
