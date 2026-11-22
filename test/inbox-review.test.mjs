import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { tick } from '../src/factory.mjs';
import { initForge, localHost, forgeDir } from '../src/adapters/host-local.mjs';
import * as pk from '../src/pack.mjs';
import { callOp } from '../src/ops.mjs';

const tmp = (p = 'fg-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
const bare = (repo, ...a) => execFileSync('git', ['--git-dir', repo, ...a], { stdio: 'pipe' }).toString().trim();
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };

function world() {
  const root = tmp(); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} });
  return { e, root, repo: () => path.join(forgeDir(e.cfg.stateDir, 'app'), 'repo.git') };
}
async function mkProject(w, host = { kind: 'local' }) { return w.e.addProject({ repo: 'app', id: 'app', host }); }
// One real factory run on the project: the agent (scripted) writes `files`; everything else (clone, commit, push, PR) is the real code.
async function build(w, title, files) {
  const p = w.e.project('app'); const d = w.e.deps(p); d.config.verify = false; d.config.maxAttempts = 1;
  d.sandbox = { create: async ({ cloneUrl, branch, base }) => { const dir = fs.mkdtempSync(path.join(w.root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); git(dir, 'checkout', '-qb', branch); return { dir, cloneUrl, destroy() {} }; }, exec: async () => ({ code: 0, out: '' }) };
  d.agent = { run: async (_sb, ws) => { for (const [f, c] of Object.entries(files)) write(path.join(ws.dir, f), c); return { out: 'done', costUsd: 0 }; } };
  await w.e.createTicket('app', { title, body: `${title}. Write it in a.js with a test that checks it works.` }); const [rec] = await tick(d); return rec;
}


// Like build(), but the reviewer hook says what it likes, so the Inbox has something to show.
async function buildReviewed(w, title, files, review) {
  const p = w.e.project('app'); const d = w.e.deps(p); d.config.verify = false; d.config.maxAttempts = 1; if (review) d.config.review = async () => review;
  d.sandbox = { create: async ({ cloneUrl, branch, base }) => { const dir = fs.mkdtempSync(path.join(w.root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); git(dir, 'checkout', '-qb', branch); return { dir, destroy() {} }; } };
  d.agent = { run: async (_sb, ws) => { for (const [f, c] of Object.entries(files)) write(path.join(ws.dir, f), c); return { out: 'done', costUsd: 0 }; } };
  const t = await w.e.createTicket('app', { title, body: `${title}. Write it in a.js with a test that checks it works.` }); const [rec] = await tick(d); return { rec, ticket: t.id ?? /(\d+)$/.exec(t.url ?? '')?.[1] };
}
const labelsOf = async (w, id) => (await w.e.listTickets('app')).find((t) => String(t.id) === String(id));

test('Inbox: a local pull request shows the reviewers\' findings so you can decide, and says it can be reviewed in the factory', async () => {
  const w = world(); await mkProject(w); const rv = { verdict: 'changes', summary: 'No input check', passes: [{ role: 'reviewer', verdict: 'changes' }, { role: 'security', verdict: 'approve' }], findings: [{ severity: 'major', source: 'reviewer', file: 'a.js', line: 3, issue: 'name is used without a check', fix: 'validate it' }, { severity: 'minor', issue: 'naming' }] };
  const { rec, ticket } = await buildReviewed(w, 'Add greeting', { 'a.js': 'export const a = 1;\n' }, rv); assert.equal(rec.status, 'ok');
  const inbox = await callOp(w.e, 'inbox', {}); const it = inbox.items.find((i) => String(i.id) === String(ticket)); assert.ok(it, 'the PR is in the inbox'); assert.equal(it.kind, 'review'); assert.equal(it.local, true, 'it can be reviewed inside the factory'); assert.ok(it.pr?.number);
  assert.equal(it.assess.reviewer.verdict, 'changes'); assert.equal(it.assess.reviewer.findings.length, 1, 'only blocking findings are listed'); assert.match(it.assess.reviewer.findings[0].issue, /without a check/); assert.equal(it.assess.reviewer.findings[0].file, 'a.js');
});

test('merging from the review page accepts the change AND closes its ticket; the plan moves on to what depended on it', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'First piece', { 'a.js': 'export const a = 1;\n' });
  const dir = pk.packDir(w.e.cfg.stateDir, 'app'); const pack = pk.loadPack(dir); pack.plan = { status: 'launched', epics: [{ id: 'e', title: 'E', goal: 'g', tickets: [{ id: 'one', title: 'First piece', body: 'First piece in a.js with a test that checks it works', size: 'S', dependsOn: [], status: 'queued', ticketId: String(ticket) }, { id: 'two', title: 'Second piece', body: 'Second piece in b.js with a test that checks it works', size: 'S', dependsOn: ['one'], status: 'planned' }] }] }; pk.savePack(dir, pack);
  assert.equal((await w.e.releasePlan('app')).released, 0, 'nothing is released while the first piece is only a pull request');
  const pr = (await w.e.listPrs('app'))[0]; const r = await w.e.prAction('app', pr.number, 'merge', {}); assert.equal(r.merged, true); assert.equal(r.ticketClosed, true);
  assert.equal((await labelsOf(w, ticket))?.state ?? 'CLOSED', 'CLOSED'); w.e.cache.clear(); assert.equal((await w.e.releasePlan('app')).released, 1, 'now the second piece is created');
  assert.ok(fs.readFileSync(path.join(w.repo(), 'HEAD'), 'utf8')); assert.match(bare(w.repo(), 'show', 'main:a.js'), /export const a/);
});

test('rejecting a pull request closes it WITHOUT merging, marks its ticket failed (not done), and the plan does not move on', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'First piece', { 'a.js': 'export const a = 1;\n' });
  const dir = pk.packDir(w.e.cfg.stateDir, 'app'); const pack = pk.loadPack(dir); pack.plan = { status: 'launched', epics: [{ id: 'e', title: 'E', goal: 'g', tickets: [{ id: 'one', title: 'First piece', body: 'First piece in a.js with a test that checks it works', size: 'S', dependsOn: [], status: 'queued', ticketId: String(ticket) }, { id: 'two', title: 'Second piece', body: 'Second piece in b.js with a test that checks it works', size: 'S', dependsOn: ['one'], status: 'planned' }] }] }; pk.savePack(dir, pack);
  const pr = (await w.e.listPrs('app'))[0]; const r = await w.e.prAction('app', pr.number, 'close', { reason: 'wrong approach' }); assert.equal(r.ticketMarkedFailed, true);
  const t = await labelsOf(w, ticket); assert.notEqual(t.state, 'CLOSED', 'the ticket is not closed'); assert.ok(t.labels.includes('agent-failed') && !t.labels.includes('agent-review'));
  w.e.cache.clear(); assert.equal((await w.e.releasePlan('app')).released, 0, 'the second piece waits: the first is not done'); assert.throws(() => bare(w.repo(), 'show', 'main:a.js'), 'nothing was merged');
});

test('a ticket whose pull request is still open cannot be closed as done, from the Inbox button or the API', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'Add greeting', { 'a.js': 'export const a = 1;\n' });
  await assert.rejects(() => w.e.ticketAction('app', ticket, 'close', {}), /still open/); await assert.rejects(() => callOp(w.e, 'inbox', {}).then(() => w.e.ticketAction('app', ticket, 'close', {})), (e) => e.status === 409);
  const pr = (await w.e.listPrs('app'))[0]; await w.e.prAction('app', pr.number, 'merge', {}); await assert.doesNotReject(() => w.e.ticketAction('app', ticket, 'close', {}).catch((e) => { if (!/not found|closed/i.test(e.message)) throw e; }));
});

test('a ticket closed by hand while its pull request is still open is NOT done: the plan shows it in review and releases nothing that depends on it', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'First piece', { 'a.js': 'export const a = 1;\n' });
  const dir = pk.packDir(w.e.cfg.stateDir, 'app'); const pack = pk.loadPack(dir); pack.plan = { status: 'launched', epics: [{ id: 'e', title: 'E', goal: 'g', tickets: [{ id: 'one', title: 'First piece', body: 'First piece in a.js with a test that checks it works', size: 'S', dependsOn: [], status: 'queued', ticketId: String(ticket) }, { id: 'two', title: 'Second piece', body: 'Second piece in b.js with a test that checks it works', size: 'S', dependsOn: ['one'], status: 'planned' }] }] }; pk.savePack(dir, pack);
  const adapter = w.e.deps(w.e.project('app')).tickets; await adapter.close(ticket);   // closed behind the guard's back (an older version, or another tool)
  w.e.cache.clear(); const g = await w.e.getPlan('app'); assert.equal(g.progress.done, 0, 'not done'); assert.equal(g.progress.review, 1); assert.equal((await w.e.releasePlan('app')).released, 0, 'the dependent does not start');
  const pr = (await w.e.listPrs('app'))[0]; await w.e.prAction('app', pr.number, 'merge', {}); w.e.cache.clear(); assert.equal((await w.e.getPlan('app')).progress.done, 1, 'merged: now it is done'); assert.equal((await w.e.releasePlan('app')).released, 1);
});

test('a plan that was marked complete reopens when a "done" ticket turns out to be unmerged, and completes again once it is merged', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'Only piece', { 'a.js': 'export const a = 1;\n' });
  const dir = pk.packDir(w.e.cfg.stateDir, 'app'); const pack = pk.loadPack(dir); pack.plan = { status: 'complete', epics: [{ id: 'e', title: 'E', goal: 'g', tickets: [{ id: 'one', title: 'Only piece', body: 'Only piece in a.js with a test that checks it works', size: 'S', dependsOn: [], status: 'done', ticketId: String(ticket) }] }] }; pk.savePack(dir, pack);
  await w.e.deps(w.e.project('app')).tickets.close(ticket); w.e.cache.clear(); const g = await w.e.getPlan('app'); assert.equal(g.plan.status, 'launched', 'reopened'); assert.equal(g.progress.review, 1);
  const pr = (await w.e.listPrs('app'))[0]; await w.e.prAction('app', pr.number, 'merge', {}); w.e.cache.clear(); const g2 = await w.e.getPlan('app'); assert.equal(g2.plan.status, 'complete'); assert.equal(g2.progress.done, 1);
});

// Two pull requests that each create the same file (the skerry-roast situation): the first merges, the second now conflicts.
async function twoCompeting(w) {
  const p = w.e.project('app'); const d = w.e.deps(p); d.config.verify = false; d.config.maxAttempts = 1;
  d.sandbox = { create: async ({ cloneUrl, branch, base }) => { const dir = fs.mkdtempSync(path.join(w.root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); git(dir, 'checkout', '-qb', branch); return { dir, destroy() {} }; } };
  const ids = []; for (const [title, extra] of [['First page', 'one.js'], ['Second page', 'two.js']]) {
    d.agent = { run: async (_sb, ws) => { write(path.join(ws.dir, 'index.html'), `<h1>${title}</h1>\n`); write(path.join(ws.dir, extra), 'export const x = 1;\n'); return { out: 'done', costUsd: 0 }; } };
    const t = await w.e.createTicket('app', { title, body: `${title} in ${extra} with a test that checks it works. Also index.html.` }); ids.push(t.id); await tick(d);
  }
  return ids;
}

test('Inbox: a pull request that would conflict with main says so, with the files, and lists the others that touch the same files', async () => {
  const w = world(); await mkProject(w); const [a, b] = await twoCompeting(w);
  const inbox1 = await callOp(w.e, 'inbox', {}); const ia = inbox1.items.find((i) => String(i.id) === String(a)); const ib = inbox1.items.find((i) => String(i.id) === String(b));
  assert.equal(ia.merge.clean, true); assert.ok(ib.overlaps.some((o) => o.files.includes('index.html')), 'they overlap on index.html');
  await w.e.prAction('app', ia.pr.number, 'merge', {}); w.e.cache.clear();
  const ib2 = (await callOp(w.e, 'inbox', {})).items.find((i) => String(i.id) === String(b)); assert.equal(ib2.merge.clean, false); assert.deepEqual(ib2.merge.conflicts, ['index.html']);
});

test('rebuild: the conflicting attempt is thrown away, its ticket goes back to the factory on the current main with the conflicting files and the findings in its instructions', async () => {
  const w = world(); await mkProject(w); const [a, b] = await twoCompeting(w);
  const prs = await w.e.listPrs('app'); await w.e.prAction('app', prs.find((x) => x.branch.startsWith(`agent/${a}-`)).number, 'merge', {}); w.e.cache.clear();
  const pb = (await w.e.listPrs('app')).find((x) => x.branch.startsWith(`agent/${b}-`)); const r = await w.e.prAction('app', pb.number, 'rebuild', {});
  assert.equal(r.requeued, true, r.requeueError ?? ''); const t = await labelsOf(w, b); assert.ok(t.labels.includes('agent-ready'), 'ready to be built again');
  const d = await w.e.deps(w.e.project('app')).tickets.get(b); assert.match(d.body, /index\.html/); assert.match(d.body, /already contains/); assert.equal((await w.e.listPrs('app')).some((x) => x.number === pb.number), false, 'the old PR is closed');
});

test('reject with requeue sends the ticket straight back, carrying the reason', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'Add greeting', { 'a.js': 'export const a = 1;\n' });
  const pr = (await w.e.listPrs('app'))[0]; const r = await callOp(w.e, 'reject_pr', { project: 'app', pr: pr.number, reason: 'use the shared helper', requeue: true }); assert.equal(r.requeued, true, r.requeueError ?? '');
  const t = await labelsOf(w, ticket); assert.ok(t.labels.includes('agent-ready')); assert.match((await w.e.deps(w.e.project('app')).tickets.get(ticket)).body, /use the shared helper/);
});

test('Inbox: a ticket closed by hand while its pull request is open still appears, flagged as unmerged, with its assessment', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'Add greeting', { 'a.js': 'export const a = 1;\n' }, { verdict: 'changes', summary: 'x', passes: [], findings: [{ severity: 'major', issue: 'no check', file: 'a.js', line: 1 }] });
  await w.e.deps(w.e.project('app')).tickets.close(ticket); w.e.cache.clear();
  const it = (await callOp(w.e, 'inbox', {})).items.find((i) => i.kind === 'review'); assert.ok(it, 'listed'); assert.equal(it.ticketClosed, true); assert.equal(it.local, true); assert.match(it.assess.reviewer.findings[0].issue, /no check/);
});

test('plan health: a plan with nothing running and work waiting on you says so, and once with a notification', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'First piece', { 'a.js': 'export const a = 1;\n' });
  const dir = pk.packDir(w.e.cfg.stateDir, 'app'); const pack = pk.loadPack(dir); pack.plan = { status: 'launched', epics: [{ id: 'e', title: 'E', goal: 'g', tickets: [{ id: 'one', title: 'First piece', body: 'First piece in a.js with a test that checks it works', size: 'S', dependsOn: [], status: 'review', ticketId: String(ticket) }, { id: 'two', title: 'Second piece', body: 'Second piece in b.js with a test that checks it works', size: 'S', dependsOn: ['one'], status: 'planned' }] }] }; pk.savePack(dir, pack);
  const h = w.e.planHealth('app'); assert.equal(h.stuck, true); assert.match(h.reasons.join(' '), /waiting for you to merge or reject/); assert.match(h.reasons.join(' '), /cannot start until/);
  const g = await w.e.getPlan('app'); assert.equal(g.health.stuck, true); const it = (await callOp(w.e, 'inbox', {})).items.find((i) => i.kind === 'plan'); assert.ok(it); assert.equal(it.project, 'app');
  const sent = []; w.e._notify = (e) => { sent.push(e); return Promise.resolve({ sent: true }); }; w.e.cfg.notify = { url: 'https://example.com/x', events: ['plan-stuck'], enabled: true };
  await w.e.notifyScan(); await w.e.notifyScan(); assert.equal(sent.filter((e) => e.event === 'plan-stuck').length, 1, 'announced once, not on every scan');
});

test('every host: a ticket closed after its pull request was closed WITHOUT merging is failed, not done; merged is done and remembered', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'First piece', { 'a.js': 'export const a = 1;\n' });
  const dir = pk.packDir(w.e.cfg.stateDir, 'app'); const mk = () => { const pack = pk.loadPack(dir); pack.plan = { status: 'launched', epics: [{ id: 'e', title: 'E', goal: 'g', tickets: [{ id: 'one', title: 'First piece', body: 'First piece in a.js with a test that checks it works', size: 'S', dependsOn: [], status: 'queued', ticketId: String(ticket) }] }] }; pk.savePack(dir, pack); };
  mk(); const pr = (await w.e.listPrs('app'))[0]; w.e._forge(w.e.project('app')).close(pr.number); await w.e.deps(w.e.project('app')).tickets.close(ticket); w.e.cache.clear();   // PR closed directly on the forge, then the ticket closed by hand
  assert.equal((await w.e.getPlan('app')).progress.failed, 1, 'closed without merging = failed'); assert.equal((await w.e.getPlan('app')).progress.done, 0);
});

test('requeueing a ticket that was closed reopens it, so the factory actually picks it up again', async () => {
  const w = world(); await mkProject(w); const { ticket } = await buildReviewed(w, 'Add greeting', { 'a.js': 'export const a = 1;\n' });
  await w.e.deps(w.e.project('app')).tickets.close(ticket); w.e.cache.clear(); assert.equal((await labelsOf(w, ticket)).state, 'CLOSED');
  const pr = (await w.e.listPrs('app'))[0]; const r = await w.e.prAction('app', pr.number, 'rebuild', {}); assert.equal(r.requeued, true, r.requeueError ?? ''); w.e.cache.clear();
  const t = await labelsOf(w, ticket); assert.notEqual(t.state, 'CLOSED', 'reopened'); assert.ok(t.labels.includes('agent-ready'));
});
