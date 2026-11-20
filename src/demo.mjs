// `agent-factory demo` / `npm run demo`: look around a populated factory with NO Docker, NO accounts and NO agent. It builds a throwaway state folder holding two sample
// projects on the built-in tracker and local forge, then starts the web UI with the loop switched off (nothing will run). Everything is made with the real code: real git
// repositories with real branches and diffs, a real plan launched into real tracker tickets, the real code analysis, real PRs you can open, comment on and merge. Only the AGENT
// RUNS and their history are pre-recorded sample data (the header says "demo"). Edit nothing you care about here: it all lives in a temp folder and is deleted on exit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Engine } from './engine.mjs';
import { withDefaults } from './config.mjs';
import { createServer, hostsFor } from './server.mjs';
import { ensureToken } from './init.mjs';
import { recordRun } from './budget.mjs';
import * as pk from './pack.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@localhost', ...a], { cwd, stdio: 'pipe' }).toString().trim();
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const DAY = 24 * 60;

// ---- the sample projects' code: small, real, and their tests pass
const BOOKING = {
  'package.json': '{ "name": "booking-app", "version": "0.1.0", "type": "module", "scripts": { "test": "node --test" } }\n',
  'README.md': '# booking-app\n\nRoom bookings for a small gym. `npm test` runs the tests.\n',
  'src/store.js': "export function createStore() {\n  const bookings = [];\n  return { all: () => [...bookings], add: (b) => { bookings.push(b); return b; }, clear: () => { bookings.length = 0; } };\n}\n",
  'src/booking.js': "import { createStore } from './store.js';\n\nexport const store = createStore();\n\n// A booking is a room, a start and an end (ISO strings).\nexport function createBooking(b, target = store) {\n  return target.add({ room: b.room, start: b.start, end: b.end });\n}\n",
  'test/booking.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createBooking } from '../src/booking.js';\nimport { createStore } from '../src/store.js';\n\ntest('a booking is stored', () => {\n  const s = createStore();\n  createBooking({ room: 'Studio A', start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' }, s);\n  assert.equal(s.all().length, 1);\n});\n",
};
const VALIDATED = "import { createStore } from './store.js';\n\nexport const store = createStore();\n\n// A booking is a room, a start and an end (ISO strings).\nexport function validate(b) {\n  const errors = [];\n  if (!b || typeof b.room !== 'string' || !b.room.trim()) errors.push('room is required');\n  const s = Date.parse(b?.start), e = Date.parse(b?.end);\n  if (Number.isNaN(s)) errors.push('start must be a date');\n  if (Number.isNaN(e)) errors.push('end must be a date');\n  if (!Number.isNaN(s) && !Number.isNaN(e) && e <= s) errors.push('end must be after start');\n  return errors;\n}\n\nexport function createBooking(b, target = store) {\n  const errors = validate(b);\n  if (errors.length) throw new Error(errors.join('; '));\n  return target.add({ room: b.room.trim(), start: b.start, end: b.end });\n}\n";
const STATUS = {
  'README.md': '# status-page\n\nA tiny status page. No tests yet.\n',
  'server.js': "import http from 'node:http';\n\nconst checks = { api: 'up', database: 'up', queue: 'degraded' };\n\nexport function render() {\n  return Object.entries(checks).map(([name, state]) => `${name}: ${state}`).join('\\n');\n}\n\nhttp.createServer((_req, res) => { res.end(render()); }).listen(process.env.PORT || 3000);\n",
  'package.json': '{ "name": "status-page", "version": "0.1.0", "type": "module" }\n',
};

function seedRepo(dir, files) { fs.mkdirSync(dir, { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main', dir]); for (const [f, c] of Object.entries(files)) write(path.join(dir, f), c); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'Initial version'); return dir; }

export async function buildDemo({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-demo-')), log = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true }); const stateDir = path.join(dir, 'state'); const configPath = path.join(dir, 'agent-factory.json');
  const cfg = { stateDir, agent: { kind: 'shell' }, sandbox: { kind: 'local' }, ui: { host: '127.0.0.1', port: 7788 }, limits: { maxOpenReviews: 5, requireVerify: false }, projects: [] };
  fs.writeFileSync(configPath, JSON.stringify(cfg)); const e = new Engine(withDefaults(cfg), { configPath, env: {}, factories: {} }); e.demo = true;
  log('creating the sample projects');
  const bookingSeed = seedRepo(path.join(dir, 'seed', 'booking-app'), BOOKING), statusSeed = seedRepo(path.join(dir, 'seed', 'status-page'), STATUS);
  await e.addProject({ id: 'booking-app', repo: 'booking-app', host: { kind: 'local', importFrom: bookingSeed }, verify: 'npm test' }); await e.addProject({ id: 'status-page', repo: 'status-page', host: { kind: 'local', importFrom: statusSeed } });
  const p = e.project('booking-app'); const tk = e.deps(p).tickets; const host = e._forge(p); const forgeRepo = path.join(stateDir, 'forge', 'booking-app', 'repo.git');

  log('writing a brief and a plan');
  e.setPack('booking-app', { brief: { goal: 'Let members of a small gym book rooms and classes online, and cancel them, without calling the front desk.', users: 'Gym members (book, cancel) and front-desk staff (see the day at a glance).', scope: '- Create a booking for a room and a time\n- Refuse overlapping bookings\n- Cancel a booking up to 24 hours before it starts\n- Email a confirmation', nonGoals: 'Payments, recurring bookings, a mobile app.', success: 'A member can book and cancel without staff help; no double-booked rooms.', constraints: 'Times are stored as instants. Existing bookings keep the terms they were made under.' }, stack: 'Node 22, plain ES modules, node:test. No framework.', decisions: 'Cancellation cutoff is inclusive and uses 24 elapsed hours. Bookings are in-memory until storage is decided.' });
  const dirPack = pk.packDir(stateDir, 'booking-app'); const pack = pk.loadPack(dirPack);
  pack.plan = pk.normalizePlan({ summary: 'Four small steps: validation first, then the two rules that depend on it, then notifications.', epics: [
    { id: 'core', title: 'Core booking rules', goal: 'Bookings are valid, never overlap, and can be cancelled in time.', tickets: [
      { id: 'validate', title: 'Validate bookings before storing them', body: 'In src/booking.js, validate a booking (room, start, end) before it is stored.\n\nAcceptance criteria:\n- an invalid booking throws a clear error\n- a valid booking is stored\n- tests cover both' },
      { id: 'overlap', title: 'Reject overlapping bookings for the same room', body: 'Refuse a booking that overlaps an existing one for the same room. Touching end-to-start is allowed.\n\nAcceptance criteria:\n- overlapping bookings throw\n- back-to-back bookings are fine\n- tests cover both', dependsOn: ['validate'] },
      { id: 'cancel', title: 'Let a booking be cancelled up to 24 hours before it starts', body: 'Add cancelBooking(id, now) in src/cancel.js. The cutoff is inclusive and uses 24 elapsed hours.\n\nAcceptance criteria:\n- exactly 24h before: allowed\n- 23h59m before: refused\n- tests use a fixed clock', dependsOn: ['validate'] } ] },
    { id: 'notify', title: 'Notifications', goal: 'Members get a confirmation.', tickets: [ { id: 'email', title: 'Email a confirmation when a booking is made', body: 'After a booking is stored, send a confirmation email through a pluggable sender.\n\nAcceptance criteria:\n- a confirmation is sent once per booking\n- sender failures do not lose the booking', dependsOn: ['overlap'] } ] } ] });
  pk.savePack(dirPack, pack); await e.launchPlan('booking-app');
  const byTitle = async (t) => (await tk.listAgentTickets()).find((x) => x.title === t);

  log('building real branches and pull requests');
  const clone = (name, files, message) => { const wc = fs.mkdtempSync(path.join(dir, 'wc-')); execFileSync('git', ['clone', '-q', `file://${forgeRepo}`, wc]); git(wc, 'checkout', '-qb', name); for (const [f, c] of Object.entries(files)) write(path.join(wc, f), c); git(wc, 'add', '-A'); git(wc, 'commit', '-qm', message); git(wc, 'push', '-q', 'origin', name); return wc; };
  const body = (n, commit, extra = '') => `Automated change for #${n}.\n\nDraft — review required. Attempts: 1.\n\n### Provenance\n- Built from brief revision \`${crypto.createHash('sha1').update(JSON.stringify(pack.brief)).digest('hex').slice(0, 8)}\`\n- \`npm test\` passed on the working tree committed as \`${commit.slice(0, 10)}\`\n- If this branch changes after this point, the result above no longer applies to it.\n\n### Quality gate: passed\nChecked 2 changed file(s); no new secrets, vulnerabilities or bugs.${extra}`;
  const sha = (b) => execFileSync('git', ['--git-dir', forgeRepo, 'rev-parse', `refs/heads/${b}`]).toString().trim();
  const runRec = (ticket, title, status, minsAgo, extra = {}) => { const started = minutesAgo(minsAgo + 3); const rec = { id: crypto.randomBytes(4).toString('hex'), project: 'booking-app', ticket, title, repo: 'local/booking-app', started, finished: minutesAgo(minsAgo), status, attempts: 1, costUsd: 0, tokens: { input: 180_000 + (ticket * 7919) % 60_000, output: 2_000 + (ticket * 131) % 900 }, phases: [{ name: 'claim', ms: 1200, at: started }, { name: 'sandbox', detail: 'cloning the repository', ms: 2400, at: started }, { name: 'agent', detail: 'attempt 1', ms: 88_000, at: started }, { name: 'verify', detail: 'npm test', ms: 1300, at: started }, { name: 'push', detail: `agent/${ticket}`, ms: 900, at: started }, { name: 'pr', ms: 600, at: started }], phase: 'pr', ...extra }; recordRun(stateDir, rec); return rec; };
  const quality = { passed: true, blockers: [], warnings: [], status: 'OK', counts: { secrets: 0, vulnerabilities: 0, bugs: 0, smells: 0, total: 0 }, files: 2, findings: [] };

  // 1. validation: built, reviewed and MERGED (so the plan releases the next tickets)
  const tValidate = await byTitle('Validate bookings before storing them'); await tk.label(tValidate.id, ['agent-working'], ['agent-ready']);
  clone(`agent/${tValidate.id}-validate-bookings`, { 'src/booking.js': VALIDATED, 'test/validate.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createBooking } from '../src/booking.js';\nimport { createStore } from '../src/store.js';\n\ntest('an invalid booking is refused with a clear message', () => {\n  assert.throws(() => createBooking({ room: '', start: 'x', end: 'y' }, createStore()), /room is required/);\n});\n" }, 'Validate bookings before storing them');
  const prV = await host.openPr({ branch: `agent/${tValidate.id}-validate-bookings`, title: tValidate.title, body: body(tValidate.id, sha(`agent/${tValidate.id}-validate-bookings`)) }); await tk.comment(tValidate.id, `Opened ${prV} after 1 attempt(s).`); await tk.label(tValidate.id, ['agent-review'], ['agent-working']);
  await host.merge(Number(/pull\/(\d+)/.exec(prV)[1])); await tk.close(tValidate.id); await e.releasePlan('booking-app');
  runRec(Number(tValidate.id), tValidate.title, 'ok', 3 * DAY + 90, { pr: prV, commit: 'a'.repeat(40), verifyCmd: 'npm test', briefRev: 'c0ffee12', quality, changed: ['src/booking.js', 'test/validate.test.js'], assumptions: '- A booking with an empty room name is invalid.' });

  // 2. overlap: an open PR, verified, ready for you to review and merge
  const tOverlap = await byTitle('Reject overlapping bookings for the same room'); await tk.label(tOverlap.id, ['agent-working'], ['agent-ready']);
  const bO = `agent/${tOverlap.id}-reject-overlapping-bookings`;
  clone(bO, { 'src/booking.js': VALIDATED.replace("export function createBooking(b, target = store) {\n  const errors = validate(b);\n  if (errors.length) throw new Error(errors.join('; '));", "export function overlaps(a, b) {\n  return a.room === b.room && Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);\n}\n\nexport function createBooking(b, target = store) {\n  const errors = validate(b);\n  if (errors.length) throw new Error(errors.join('; '));\n  if (target.all().some((x) => overlaps(x, b))) throw new Error('that room is already booked at that time');"), 'test/overlap.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createBooking } from '../src/booking.js';\nimport { createStore } from '../src/store.js';\n\nconst at = (h1, h2) => ({ room: 'Studio A', start: `2026-12-01T${h1}:00:00Z`, end: `2026-12-01T${h2}:00:00Z` });\n\ntest('an overlapping booking for the same room is refused', () => {\n  const s = createStore(); createBooking(at('10', '11'), s);\n  assert.throws(() => createBooking(at('10', '12'), s), /already booked/);\n});\n\ntest('back-to-back bookings are fine', () => {\n  const s = createStore(); createBooking(at('10', '11'), s); createBooking(at('11', '12'), s);\n  assert.equal(s.all().length, 2);\n});\n" }, 'Reject overlapping bookings');
  const prO = await host.openPr({ branch: bO, title: tOverlap.title, body: body(tOverlap.id, sha(bO), '\n\n### Assumptions the agent made (please check)\n- Two bookings in different rooms never conflict.') }); await tk.comment(tOverlap.id, `Opened ${prO} after 1 attempt(s).`); await tk.label(tOverlap.id, ['agent-review'], ['agent-working']);
  runRec(Number(tOverlap.id), tOverlap.title, 'ok', 55, { pr: prO, commit: sha(bO), verifyCmd: 'npm test', briefRev: 'c0ffee12', quality, changed: ['src/booking.js', 'test/overlap.test.js'], assumptions: '- Two bookings in different rooms never conflict.' });

  // 3. cancellation: an open PR whose branch CHANGED after it was verified, so merge is blocked
  const tCancel = await byTitle('Let a booking be cancelled up to 24 hours before it starts'); await tk.label(tCancel.id, ['agent-working'], ['agent-ready']);
  const bC = `agent/${tCancel.id}-cancel-24h`;
  const wcC = clone(bC, { 'src/cancel.js': "// A booking can be cancelled up to 24 elapsed hours before it starts (inclusive).\nconst CUTOFF_MS = 24 * 60 * 60 * 1000;\n\nexport function canCancel(booking, now = Date.now()) {\n  return Date.parse(booking.start) - now >= CUTOFF_MS;\n}\n", 'test/cancel.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { canCancel } from '../src/cancel.js';\n\nconst start = '2026-12-02T10:00:00Z', t0 = Date.parse(start);\n\ntest('exactly 24 hours before: allowed', () => assert.equal(canCancel({ start }, t0 - 24 * 3600_000), true));\ntest('23 hours 59 minutes before: refused', () => assert.equal(canCancel({ start }, t0 - (24 * 3600_000 - 60_000)), false));\n" }, 'Cancel up to 24 hours before');
  const prC = await host.openPr({ branch: bC, title: tCancel.title, body: body(tCancel.id, sha(bC)) }); await tk.comment(tCancel.id, `Opened ${prC} after 1 attempt(s).`); await tk.label(tCancel.id, ['agent-review'], ['agent-working']);
  runRec(Number(tCancel.id), tCancel.title, 'ok', 20, { pr: prC, commit: sha(bC), verifyCmd: 'npm test', briefRev: 'c0ffee12', quality, changed: ['src/cancel.js', 'test/cancel.test.js'] });
  write(path.join(wcC, 'src/extra.js'), 'export const sneaky = true;\n'); git(wcC, 'add', '-A'); git(wcC, 'commit', '-qm', 'pushed by hand after review'); git(wcC, 'push', '-q', 'origin', bC);

  // 4. other tickets in other states: a question for you, a failure, and one waiting in the queue
  const nicer = await e.createTicket('booking-app', { title: 'Make bookings nicer', body: 'It should feel better to use.' }); await tk.label(nicer.id, ['agent-needs-info'], ['agent-ready']);
  await tk.comment(nicer.id, 'agent-factory needs a little more information before it can build this:\n\nWhat should feel better: the booking form, the confirmation, or the day view? Which of these matters most to members?\n\nAnswer in the Agent Factory inbox and press Requeue.'); runRec(Number(nicer.id), 'Make bookings nicer', 'needs-info', 130, { attempts: 1, question: 'What should feel better: the booking form, the confirmation, or the day view? Which of these matters most to members?' });
  const sms = await e.createTicket('booking-app', { title: 'Send SMS reminders the day before', body: 'Send an SMS reminder 24 hours before each booking using the existing sender interface.\n\nAcceptance criteria:\n- a reminder is sent once per booking' }); await tk.label(sms.id, ['agent-failed'], ['agent-ready']);
  await tk.comment(sms.id, 'agent-factory gave up: verify-failed after 2 attempt(s).'); runRec(Number(sms.id), 'Send SMS reminders the day before', 'verify-failed', 200, { attempts: 2, verifyCmd: 'npm test', error: 'npm test failed: 1 test failing (the sender interface does not exist yet)' });
  await e.createTicket('booking-app', { title: 'Show the week as a calendar grid', body: 'Add renderWeek(bookings, weekStart) in src/calendar.js returning a 7-day grid of bookings.\n\nAcceptance criteria:\n- renderWeek returns 7 days\n- each booking appears on its day' });
  await e.createTicket('status-page', { title: 'Add a /health endpoint', body: 'Add GET /health to server.js returning JSON { ok: true }.\n\nAcceptance criteria:\n- GET /health returns 200 and { "ok": true }' });

  log('recording sample history for the charts and the Flow card');
  // older accepted changes (their tickets are not in the demo tracker: they exist only as history)
  const history = [[101, 9, 6, 28, 110, 1], [102, 8, 4, 22, 95, 1], [103, 7, 12, 31, 300, 2], [104, 6, 5, 18, 75, 1], [105, 5, 7, 26, 160, 1], [106, 4, 3, 20, 55, 1], [107, 3, 9, 24, 205, 1]];   // ticket, days ago it closed, queue min, build min, review min, attempts
  for (const [t, daysAgo, q, b, r, att] of history) {
    const closed = daysAgo * DAY, pr = closed + r, claimed = pr + b, ready = claimed + q; const stamp = (m) => minutesAgo(m);
    e.recordEvent('booking-app', t, 'ready', stamp(ready)); e.recordEvent('booking-app', t, 'claimed', stamp(claimed)); if (att > 1) { e.recordEvent('booking-app', t, 'failed', stamp(claimed - 5)); e.recordEvent('booking-app', t, 'ready', stamp(claimed - 8)); e.recordEvent('booking-app', t, 'claimed', stamp(claimed - 9)); }
    e.recordEvent('booking-app', t, 'pr-opened', stamp(pr)); e.recordEvent('booking-app', t, 'closed', stamp(closed));
    runRec(t, ['Add a room field', 'Show bookings by day', 'Format times for display', 'Reject past bookings', 'Add a booking id', 'Sort bookings by start', 'Trim room names'][t - 101], 'ok', closed + r, { attempts: att, pr: `local-pr:booking-app/pull/${t - 90}`, commit: crypto.createHash('sha1').update(String(t)).digest('hex'), verifyCmd: 'npm test', briefRev: 'c0ffee12', quality });
  }
  e.recordEvent('booking-app', Number(tValidate.id), 'ready', minutesAgo(3 * DAY + 130)); e.recordEvent('booking-app', Number(tValidate.id), 'claimed', minutesAgo(3 * DAY + 120)); e.recordEvent('booking-app', Number(tValidate.id), 'pr-opened', minutesAgo(3 * DAY + 90)); e.recordEvent('booking-app', Number(tValidate.id), 'closed', minutesAgo(3 * DAY + 5));
  for (const [t, ready, claimed, pr] of [[tOverlap.id, 80, 62, 55], [tCancel.id, 40, 28, 20]]) { e.recordEvent('booking-app', Number(t), 'ready', minutesAgo(ready)); e.recordEvent('booking-app', Number(t), 'claimed', minutesAgo(claimed)); e.recordEvent('booking-app', Number(t), 'pr-opened', minutesAgo(pr)); }
  e.recordEvent('booking-app', Number(nicer.id), 'ready', minutesAgo(140)); e.recordEvent('booking-app', Number(nicer.id), 'claimed', minutesAgo(136)); e.recordEvent('booking-app', Number(nicer.id), 'parked', minutesAgo(130));

  log('analysing the sample code');
  for (const id of ['booking-app', 'status-page']) { e.startAnalysis(id); for (let i = 0; i < 60 && (e.analysisJob(id).state === 'running'); i++) await new Promise((r) => setTimeout(r, 250)); }
  e._persist(); return { dir, stateDir, configPath, engine: e };
}

export async function runDemo({ flags = {} } = {}) {
  const dir = typeof flags.dir === 'string' ? path.resolve(flags.dir) : undefined; const port = Number(flags.port) || 7788;
  console.log('Building the demo (about 10 seconds): sample projects, real git branches and pull requests, a plan, and history…');
  const { engine, stateDir, dir: root } = await buildDemo({ dir, log: (m) => !flags.quiet && console.log(`  · ${m}`) });
  const token = await ensureToken(stateDir); const server = createServer(engine, { token, allowedHosts: hostsFor('127.0.0.1', port) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`\nAgent Factory demo is running (no Docker, no agent, nothing will run)\n  UI:  http://127.0.0.1:${port}/#token=${token}\n\nTry: Portfolio (flow + an unverified project) · booking-app → Pull requests (open the diff; one PR is blocked because its branch changed after it was checked; merge another) · Tracker · Plan · Inbox · Code.\nCtrl-C to stop. Everything is in ${root} and is ${flags.keep ? 'kept' : 'deleted on exit'}.`);
  const bye = () => { server.closeAllConnections(); server.close(() => { if (!flags.keep) fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
