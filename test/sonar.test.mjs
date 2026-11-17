import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diskProblem, explainSonarLog, sonarApi, collect, scanProject, ensureManaged, projectKey, sonarSummary, SCANNER_IMAGE } from '../src/sonar.mjs';
import { profileSummary } from '../src/analyze.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';

// A tiny fake SonarQube: records every request.
function fakeSonar({ adminChange = true, tokenValid = true } = {}) {
  const calls = []; const created = new Set();
  const fetchImpl = async (url, o = {}) => {
    const u = new URL(url); const body = o.body ? Object.fromEntries(new URLSearchParams(o.body)) : {}; const auth = o.headers?.Authorization ? Buffer.from(o.headers.Authorization.replace('Basic ', ''), 'base64').toString() : '';
    calls.push({ method: o.method, path: u.pathname, q: Object.fromEntries(u.searchParams), body, auth });
    const ok = (j, s = 200) => ({ ok: s < 400, status: s, text: async () => (j === undefined ? '' : JSON.stringify(j)) });
    switch (u.pathname) {
      case '/api/system/status': return ok({ status: 'UP', version: '10.7' });
      case '/api/users/change_password': return adminChange && auth === 'admin:admin' ? ok(undefined, 204) : ok({ errors: [{ msg: 'unauthorized' }] }, 401);
      case '/api/user_tokens/generate': return ok({ token: 'squ_generated' });
      case '/api/authentication/validate': return ok({ valid: tokenValid && auth.startsWith('squ_') });
      case '/api/projects/create': if (created.has(body.project)) return ok({ errors: [{ msg: 'Could not create Project, key already exists' }] }, 400); created.add(body.project); return ok({ project: { key: body.project } });
      case '/api/ce/task': return ok({ task: { status: 'SUCCESS' } });
      case '/api/qualitygates/project_status': return ok({ projectStatus: { status: 'ERROR', conditions: [{ status: 'ERROR', metricKey: 'new_coverage', actualValue: '12', errorThreshold: '80' }, { status: 'OK', metricKey: 'x' }] } });
      case '/api/measures/component': return ok({ component: { measures: [{ metric: 'bugs', value: '3' }, { metric: 'code_smells', value: '40' }, { metric: 'vulnerabilities', value: '1' }, { metric: 'coverage', value: '55.5' }, { metric: 'reliability_rating', value: '3.0' }, { metric: 'security_rating', value: '1.0' }, { metric: 'sqale_rating', value: '2.0' }] } });
      case '/api/issues/search': return ok({ total: 44, issues: [{ key: 'AX1', severity: 'CRITICAL', type: 'VULNERABILITY', rule: 'js:S2068', message: 'Review this `hard-coded`\npassword', component: `${q(u)}:src/a.js`, line: 12 }, { key: 'AX2', severity: 'MINOR', type: 'CODE_SMELL', rule: 'js:S1481', message: 'Remove unused variable', component: `${q(u)}:b.js` }] });
      default: return ok({ errors: [{ msg: 'nope' }] }, 404);
    }
  };
  const q = (u) => u.searchParams.get('componentKeys') ?? u.searchParams.get('projectKey') ?? 'k';
  return { fetchImpl, calls };
}

test('sonarApi: basic token auth, form posts, SSRF-safe base url, readable errors', async () => {
  const f = fakeSonar(); const api = sonarApi({ url: 'http://127.0.0.1:9000', token: 'squ_x', fetchImpl: f.fetchImpl });
  await api.get('/api/system/status'); assert.equal(f.calls[0].auth, 'squ_x:');
  await assert.rejects(api.get('/api/nope'), /nope/);
  assert.throws(() => sonarApi({ url: 'http://169.254.169.254' }), /not allowed/); assert.throws(() => sonarApi({ url: 'http://example.com' }), /https/); assert.throws(() => sonarApi({ url: 'https://u:p@sonar.example.com' }), /credentials/);
});

test('collect: gate, measures, ratings and findings are normalised, bounded, and flattened to plain text', async () => {
  const f = fakeSonar(); const r = await collect(sonarApi({ url: 'http://127.0.0.1:9000', token: 'squ_x', fetchImpl: f.fetchImpl }), 'af-demo');
  assert.equal(r.qualityGate, 'ERROR'); assert.deepEqual(r.failedConditions, [{ metric: 'new_coverage', actual: '12', threshold: '80' }]);
  assert.deepEqual(r.measures, { bugs: 3, vulnerabilities: 1, codeSmells: 40, hotspots: null, coverage: 55.5, duplication: null, lines: null }); assert.deepEqual(r.ratings, { reliability: 'C', security: 'A', maintainability: 'B' });
  assert.equal(r.issues[0].message, 'Review this hard-coded password'); assert.equal(r.issues[0].file, 'src/a.js'); assert.equal(r.issues[0].line, 12); assert.equal(r.totalIssues, 44);
  assert.match(sonarSummary(r), /gate: ERROR.*3 bugs, 1 vulnerabilities, 40 code smells; test coverage 55.5%/); assert.equal(sonarSummary({ error: 'x' }), ''); assert.match(profileSummary({ languages: ['JavaScript'], sonar: r }), /SonarQube quality gate/);
});

test('scanProject: read-only mount, token only via env (never argv), cap-drop, project registered once, cleans its work dir', async () => {
  const f = fakeSonar(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-')); let seen; const phases = [];
  const exec = async (cmd, args, o) => { seen = { cmd, args, env: o.env }; const work = args[args.indexOf('-v', args.indexOf('-v') + 1) + 1].split(':')[0]; fs.writeFileSync(path.join(work, 'report-task.txt'), 'ceTaskId=TASK1\n'); return { code: 0, out: 'ANALYSIS SUCCESSFUL' }; };
  const run = () => scanProject({ dir, id: 'demo', name: 'demo', url: 'http://127.0.0.1:9000', innerUrl: 'http://sonarqube:9000', token: 'squ_secret', network: 'af-sonar', exec, fetchImpl: f.fetchImpl, onPhase: (p) => phases.push(p) });
  const r = await run(); await run();
  assert.equal(r.key, 'af-demo'); assert.equal(seen.cmd, 'docker'); const a = seen.args.join(' ');
  assert.match(a, new RegExp(`-v ${dir}:/usr/src:ro`)); assert.match(a, /--cap-drop ALL/); assert.match(a, /--network af-sonar/); assert.ok(a.includes(SCANNER_IMAGE)); assert.match(a, /-Dsonar\.projectKey=af-demo/);
  assert.doesNotMatch(a, /squ_secret/); assert.equal(seen.env.SONAR_TOKEN, 'squ_secret'); assert.equal(seen.env.SONAR_HOST_URL, 'http://sonarqube:9000');
  assert.equal(f.calls.filter((c) => c.path === '/api/projects/create').length, 2); assert.ok(phases.includes('reading the results'));
  assert.equal(fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('af-sonar-')).length, 0);
  await assert.rejects(scanProject({ dir, id: 'demo', url: 'http://127.0.0.1:9000', token: 't', exec: async () => ({ code: 1, out: 'ERROR: Not authorized\nstack' }), fetchImpl: f.fetchImpl }), /scanner failed: ERROR: Not authorized/);
});

test('ensureManaged: pulls+starts the container once, secures admin, stores the token; reuse path needs no admin; unknown admin password is explained', async () => {
  const f = fakeSonar(); const saved = {}; const cmds = []; let exists = false;
  const exec = async (_c, args) => { cmds.push(args.join(' ')); if (args[0] === 'inspect') return exists ? { code: 0, out: 'true' } : { code: 1, out: '' }; if (args[0] === 'run') exists = true; return { code: 0, out: '' }; };
  const env = {}; const saveSecret = (n, v) => { saved[n] = v; env[n] = v; };
  const roomy = () => ({ bavail: 90, bsize: 1, blocks: 100 }); const r = await ensureManaged({ exec, fetchImpl: f.fetchImpl, env, saveSecret, timeoutMs: 5000, statfs: roomy });
  assert.equal(r.token, 'squ_generated'); assert.equal(saved.AF_SONAR_TOKEN, 'squ_generated'); assert.ok(saved.AF_SONAR_ADMIN_PASSWORD.length >= 20);
  const run = cmds.find((c) => c.startsWith('run ')); assert.match(run, /-p 127\.0\.0\.1:9000:9000/); assert.match(run, /--network af-sonar/); assert.match(run, /SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true/);
  const before = f.calls.length; await ensureManaged({ exec, fetchImpl: f.fetchImpl, env: { ...env, AF_SONAR_TOKEN: 'squ_generated' }, saveSecret, timeoutMs: 5000, statfs: roomy });
  assert.equal(f.calls.slice(before).filter((c) => c.path === '/api/users/change_password').length, 0); assert.equal(cmds.filter((c) => c.startsWith('run ')).length, 1);
  const locked = fakeSonar({ adminChange: false }); await assert.rejects(ensureManaged({ exec, fetchImpl: locked.fetchImpl, env: {}, saveSecret: () => {}, timeoutMs: 5000, statfs: roomy }), /already set up.*existing server/);
});

function eng(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'es-')); const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esr-')); fs.writeFileSync(path.join(repoDir, 'a.js'), 'x\n');
  const e = new Engine(withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {} });
  e.f.sandbox = { create: async () => ({ dir: repoDir, destroy() {} }) }; e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  Object.assign(e.f, extra); return e;
}
const settle = async (e, id) => { for (let i = 0; i < 200 && e.analysisJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10)); return e.analysisJob(id); };

test('engine: external SonarQube validated before saving; token stored as a secret, never in the config; disable removes it', async () => {
  const f = fakeSonar(); const e = eng({ fetch: f.fetchImpl });
  await assert.rejects(e.sonarEnable({ mode: 'external', url: 'http://example.com', token: 't' }), /https/); await assert.rejects(e.sonarEnable({ mode: 'external', url: 'https://sonar.example.com', token: '' }), /Paste a SonarQube token/);
  await assert.rejects(e.sonarEnable({ mode: 'external', url: 'http://127.0.0.1:9000', token: 'bad' }), /rejected/);
  const st = await e.sonarEnable({ mode: 'external', url: 'http://127.0.0.1:9000', token: 'squ_mine' }); assert.equal(st.enabled, true); assert.equal(st.state, 'ready');
  assert.doesNotMatch(fs.readFileSync(e.configPath, 'utf8'), /squ_mine/); assert.match(fs.readFileSync(path.join(e.cfg.stateDir, 'secrets.env'), 'utf8'), /AF_SONAR_TOKEN=squ_mine/);
  assert.equal((await e.sonarDisable()).state, 'off'); assert.equal(e.cfg.sonar, undefined);
  await assert.rejects(e.sonarEnable({ mode: 'nonsense' }), /managed/);
});

test('engine: managed setup runs as a job with phases, flips to enabled when done, and reports failures', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const e = eng({ ensureManaged: async ({ onPhase }) => { onPhase('downloading'); await gate; } });
  const s = await e.sonarEnable({ mode: 'managed' }); assert.equal(s.state, 'starting'); assert.equal((await e.sonarStatus()).phase, 'downloading'); await assert.rejects(e.sonarEnable({ mode: 'managed' }), /already being set up/);
  release(); await new Promise((r) => setTimeout(r, 20)); assert.equal(e.cfg.sonar.mode, 'managed'); assert.equal(e.sonarJob, null);
  const bad = eng({ ensureManaged: async () => { throw new Error('docker pull failed'); } }); await bad.sonarEnable({ mode: 'managed' }); await new Promise((r) => setTimeout(r, 20));
  const st = await bad.sonarStatus(); assert.equal(st.state, 'error'); assert.match(st.error, /docker pull failed/); assert.equal(bad.cfg.sonar, undefined);
});

test('engine: re-analysis is a job; fast profile is saved first, SonarQube result added; a scan failure never loses the fast profile; re-running keeps the last good scan', async () => {
  let n = 0; const e = eng({ sonarScan: async ({ id }) => { n++; if (n === 2) throw new Error('scanner failed: boom'); return { key: `af-${id}`, qualityGate: 'OK', measures: { bugs: 0 }, ratings: {}, issues: [{ key: 'K1', severity: 'MAJOR', type: 'CODE_SMELL', rule: 'js:S1', message: 'Unused var', file: 'a.js', line: 3 }], totalIssues: 1, analyzedAt: 'now' }; } });
  e.cfg.sonar = { mode: 'external', url: 'http://127.0.0.1:9000' }; e.env.AF_SONAR_TOKEN = 'squ_t';
  const p = await e.addProject({ repo: 'o/app' }); assert.equal((await settle(e, 'app')).state, 'done');                // adding a project with SonarQube on scans it in the background
  assert.equal(e.cfg.projects[0].profile.sonar.qualityGate, 'OK'); assert.ok(e.cfg.projects[0].profile.metrics, 'built-in scan is there too');
  e.startAnalysis('app'); assert.equal((await settle(e, 'app')).state, 'done'); const after = e.cfg.projects[0].profile;
  assert.match(after.sonar.error, /boom/); assert.ok(after.metrics);                                                      // scan failed: reported, fast profile intact
  e.startAnalysis('app'); await settle(e, 'app'); assert.equal(e.cfg.projects[0].profile.sonar.qualityGate, 'OK');          // next success replaces the error
  assert.equal(e.startAnalysis('app').state, 'running'); assert.equal(e.startAnalysis('app').state, 'running');            // no duplicate jobs
  await settle(e, 'app'); assert.equal(e.analysisJob('app').state, 'done'); assert.throws(() => e.analysisJob('missing'), /No such project/); void p;
});

test('engine: "Queue fix" turns a stored finding into a ticket (and only stored findings)', async () => {
  const e = eng(); await e.addProject({ repo: 'o/app' }); const made = []; e.createTicket = async (id, t) => { made.push([id, t]); return { url: 'u' }; };
  e.cfg.projects[0].profile = { sonar: { issues: [{ key: 'K1', severity: 'MAJOR', type: 'CODE_SMELL', rule: 'js:S1', message: 'Unused variable x', file: 'src/a.js', line: 3 }] } };
  await e.sonarIssueTicket('app', 'K1'); assert.match(made[0][1].title, /^Fix SonarQube code smell: Unused variable x/); assert.match(made[0][1].body, /js:S1 \(MAJOR\) reports at src\/a\.js:3/);
  await assert.rejects(e.sonarIssueTicket('app', 'nope'), /re-analyze first/);
});

test('projectKey is safe for the SonarQube key format', () => { assert.equal(projectKey('My_App.1'), 'af-my-app-1'); });

test('diskProblem / explainSonarLog: a nearly full disk is reported up front, and a crash-looping container is explained in plain English', () => {
  const fs2 = (free, total) => () => ({ bavail: free, bsize: 1, blocks: total }); assert.equal(diskProblem(fs2(50, 100)), null);
  assert.match(diskProblem(fs2(2.4e9, 100e9), ['/']), /at least 10% of the disk free and only 2\.4%.*Free up about 8 GB/); assert.equal(diskProblem(() => { throw new Error('x'); }), null);
  assert.match(explainSonarLog('ERROR ... Not enough free disk space for Elasticsearch data directory [/opt/sonarqube/data]: 10.8 GB available out of 438.0 GB (2.4%), at least 43.9 GB is required. blah'), /disk is too full \(10\.8 GB free of 438\.0 GB; it needs at least 43\.9 GB\)/);
  assert.match(explainSonarLog('max virtual memory areas vm.max_map_count [65530] is too low'), /sysctl/); assert.match(explainSonarLog('java.lang.OutOfMemoryError'), /memory/); assert.equal(explainSonarLog('all fine'), null);
});

test('ensureManaged refuses before downloading anything when the disk is too full; and surfaces the container log when it crash-loops', async () => {
  const cmds = []; const exec = async (_c, args) => { cmds.push(args[0]); if (args[0] === 'inspect' && args[1] === '-f' && /State\.Status/.test(args[2])) return { code: 0, out: 'restarting 3' }; if (args[0] === 'inspect') return { code: 0, out: 'true' }; if (args[0] === 'logs') return { code: 0, out: 'Not enough free disk space for Elasticsearch data directory: 10.8 GB available out of 438.0 GB (2.4%), at least 43.9 GB is required.' }; return { code: 0, out: '' }; };
  const f = { fetchImpl: async () => { throw new Error('fetch failed'); } };
  const roomy = () => ({ bavail: 90, bsize: 1, blocks: 100 });
  await assert.rejects(ensureManaged({ exec, ...f, env: {}, saveSecret() {}, timeoutMs: 60000, statfs: roomy }), /disk is too full/); assert.ok(cmds.includes('stop'));
  const before = cmds.length; await assert.rejects(ensureManaged({ exec, ...f, env: {}, saveSecret() {}, statfs: () => ({ bavail: 2, bsize: 1, blocks: 100 }) }), /at least 10% of the disk/); assert.equal(cmds.length, before, 'nothing was downloaded or started');                // diagnosed from the log, container stopped (no restart loop)
});
