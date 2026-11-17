// Optional SonarQube integration: the real analyser (bugs, vulnerabilities, code smells, coverage, quality gate), on top of the fast built-in scan.
//   managed  : the factory runs the official Community container next to itself (127.0.0.1 only) and sets it up (admin password + token).
//   external : your own SonarQube server or SonarCloud, with a token you paste.
// The scanner itself runs in a throwaway container with the checkout mounted READ-ONLY; no repo code is executed by us.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from './util.mjs';
import { checkBaseUrl } from './sources.mjs';

export const SONAR_IMAGE = 'sonarqube:community';
export const SCANNER_IMAGE = 'sonarsource/sonar-scanner-cli:11';
export const MANAGED = { container: 'agent-factory-sonarqube', network: 'af-sonar', alias: 'sonarqube', hostUrl: 'http://127.0.0.1:9000', innerUrl: 'http://sonarqube:9000', port: 9000 };
export const SONAR_TOKEN_ENV = 'AF_SONAR_TOKEN';
export const projectKey = (id) => `af-${String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

const clean = (s, n = 200) => String(s ?? '').replace(/[\r\n\t`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATING = { '1.0': 'A', '2.0': 'B', '3.0': 'C', '4.0': 'D', '5.0': 'E' };

export function sonarApi({ url, token, fetchImpl = fetch, timeoutMs = 20000 }) {
  const base = checkBaseUrl(url);
  const auth = token ? { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` } : {};
  const call = async (method, p, params = {}, creds) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined)); const get = method === 'GET';
    const r = await fetchImpl(`${base}${p}${get && q.size ? `?${q}` : ''}`, { method, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      headers: { ...(creds ? { Authorization: `Basic ${Buffer.from(creds).toString('base64')}` } : auth), ...(get ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) }, ...(get ? {} : { body: q.toString() }) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw Object.assign(new Error(clean(json?.errors?.map((e) => e.msg).join('; ') || text || `HTTP ${r.status}`, 300)), { status: r.status });
    return json;
  };
  return { base, get: (p, q, creds) => call('GET', p, q, creds), post: (p, q, creds) => call('POST', p, q, creds) };
}

// SonarQube's search engine refuses to start unless ~10% of the disk is free; say so BEFORE a 1.4 GB download, not after minutes of waiting.
export function diskProblem(statfs = fs.statfsSync, dirs = ['/var/lib/docker', '/']) {
  for (const d of dirs) { try { const st = statfs(d); const free = st.bavail * st.bsize, total = st.blocks * st.bsize; const pct = (free / total) * 100;
    if (pct < 10) return `SonarQube needs at least 10% of the disk free and only ${pct.toFixed(1)}% (${(free / 1e9).toFixed(0)} GB of ${(total / 1e9).toFixed(0)} GB) is. Free up about ${Math.ceil(total * 0.1 / 1e9 - free / 1e9)} GB, or connect an existing SonarQube / SonarCloud instead.`; return null; } catch { /* try the next path */ } }
  return null;
}
// Turn a crash-looping container's log into a plain-English cause.
export function explainSonarLog(log) {
  const l = String(log ?? '');
  const disk = /Not enough free disk space[^\n]*?(\d+(?:\.\d+)? GB) available out of (\d+(?:\.\d+)? GB)[^\n]*?at least (\d+(?:\.\d+)? GB)/.exec(l); if (disk) return `SonarQube cannot start: the disk is too full (${disk[1]} free of ${disk[2]}; it needs at least ${disk[3]}). Free some space or connect an existing SonarQube / SonarCloud.`;
  if (/max virtual memory areas vm\.max_map_count/.test(l)) return 'SonarQube cannot start: run `sudo sysctl -w vm.max_map_count=262144` on this machine, then set it up again.';
  if (/OutOfMemoryError|Cannot allocate memory/.test(l)) return 'SonarQube ran out of memory: it needs about 2 GB free.';
  const e = /(?:ERROR|Exception)[^\n]{0,200}/.exec(l); return e ? `SonarQube keeps stopping: ${clean(e[0], 200)}` : null;
}

export async function waitUp(api, { timeoutMs = 300000, intervalMs = 3000, onTick, check } = {}) {
  const end = Date.now() + timeoutMs; let last = 'not reachable yet'; let n = 0;
  while (Date.now() < end) {
    if (check && ++n % 5 === 0) await check();                      // every ~15s: is the container itself crash-looping?
    try { const s = await api.get('/api/system/status'); last = s?.status; if (s?.status === 'UP') return s; onTick?.(last); } catch (e) { last = e.message; onTick?.('starting'); }
    await sleep(intervalMs);
  }
  throw new Error(`SonarQube did not become ready in time (last status: ${last}). Check \`docker logs ${MANAGED.container}\`.`);
}

// Start (or reuse) the managed container, wait for it, and make sure we hold a token. Idempotent.
export async function ensureManaged({ exec = run, fetchImpl, env = {}, saveSecret, onPhase = () => {}, timeoutMs, statfs }) {
  const d = (args, o) => exec('docker', args, o);
  const phase = onPhase;
  const noRoom = diskProblem(statfs); if (noRoom) throw new Error(noRoom);
  phase('creating the private network');
  await d(['network', 'create', MANAGED.network]);                                   // exists -> harmless error
  const ins = await d(['inspect', '-f', '{{.State.Running}}', MANAGED.container]);
  if (ins.code !== 0) {
    phase('downloading SonarQube (about 1 GB, first time only)');
    const pull = await d(['pull', SONAR_IMAGE], { timeoutMs: 7_200_000 }); if (pull.code === 124) throw new Error('Downloading SonarQube timed out after 2 hours. Run `docker pull sonarqube:community` yourself (it resumes), then set it up again.'); if (pull.code !== 0) throw new Error(`docker pull failed: ${clean(pull.out.trim().split('\n').slice(-2).join(' '), 300)}`);
    phase('starting SonarQube');
    const r = await d(['run', '-d', '--name', MANAGED.container, '--restart', 'unless-stopped', '--network', MANAGED.network, '--network-alias', MANAGED.alias, '-p', `127.0.0.1:${MANAGED.port}:9000`,
      '-e', 'SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true', '-v', 'af-sonar-data:/opt/sonarqube/data', '-v', 'af-sonar-ext:/opt/sonarqube/extensions', '-v', 'af-sonar-logs:/opt/sonarqube/logs', SONAR_IMAGE]);
    if (r.code !== 0) throw new Error(`could not start SonarQube: ${clean(r.out, 300)}`);
  } else if (!/true/.test(ins.out)) { phase('starting SonarQube'); const s = await d(['start', MANAGED.container]); if (s.code !== 0) throw new Error(`could not start SonarQube: ${clean(s.out, 300)}`); }
  const anon = sonarApi({ url: MANAGED.hostUrl, fetchImpl });
  const check = async () => { const st = await d(['inspect', '-f', '{{.State.Status}} {{.RestartCount}}', MANAGED.container]); const [status, restarts] = st.out.trim().split(' ');
    if (status === 'exited' || status === 'dead' || (status === 'restarting' && Number(restarts) >= 1) || Number(restarts) >= 2) {
      const lg = await d(['logs', '--tail', '200', MANAGED.container]); await d(['stop', MANAGED.container]);
      throw new Error(explainSonarLog(lg.out) ?? `SonarQube keeps stopping. See \`docker logs ${MANAGED.container}\`.`); } };
  phase('waiting for SonarQube to be ready (1 to 3 minutes)');
  const status = await waitUp(anon, { timeoutMs: timeoutMs ?? 300000, check });
  let token = env[SONAR_TOKEN_ENV];
  if (token) { try { const v = await sonarApi({ url: MANAGED.hostUrl, token, fetchImpl }).get('/api/authentication/validate'); if (!v?.valid) token = null; } catch { token = null; } }
  if (!token) {
    phase('securing it: new admin password and an access token');
    const adminPw = crypto.randomBytes(18).toString('base64url');
    try { await anon.post('/api/users/change_password', { login: 'admin', previousPassword: 'admin', password: adminPw }, 'admin:admin'); saveSecret('AF_SONAR_ADMIN_PASSWORD', adminPw); }
    catch (e) { if (e.status === 401 || e.status === 400) { if (!env.AF_SONAR_ADMIN_PASSWORD) throw new Error('This SonarQube was already set up and its admin password is not known here. Connect it as an existing server with a token instead.'); } else throw e; }
    const pw = env.AF_SONAR_ADMIN_PASSWORD ?? adminPw;
    const t = await anon.post('/api/user_tokens/generate', { name: `agent-factory-${Date.now().toString(36)}` }, `admin:${pw}`);
    if (!t?.token) throw new Error('SonarQube did not return a token'); saveSecret(SONAR_TOKEN_ENV, t.token); token = t.token;
  }
  return { version: status.version, url: MANAGED.hostUrl, token };
}

export async function stopManaged({ exec = run } = {}) { return exec('docker', ['stop', MANAGED.container]); }

// The numbers and findings we show (and put in the agent prompt). Everything is bounded and flattened to plain text.
export async function collect(api, key, { issueLimit = 10 } = {}) {
  const [gate, ms, iss] = await Promise.all([
    api.get('/api/qualitygates/project_status', { projectKey: key }),
    api.get('/api/measures/component', { component: key, metricKeys: 'bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc,security_hotspots,reliability_rating,security_rating,sqale_rating' }),
    api.get('/api/issues/search', { componentKeys: key, resolved: 'false', ps: String(issueLimit), s: 'SEVERITY', asc: 'false' }),
  ]);
  const m = Object.fromEntries((ms?.component?.measures ?? []).map((x) => [x.metric, x.value]));
  const num = (v) => (v === undefined ? null : Number(v));
  return {
    key, analyzedAt: new Date().toISOString(),
    qualityGate: ['OK', 'WARN', 'ERROR'].includes(gate?.projectStatus?.status) ? gate.projectStatus.status : 'NONE',
    failedConditions: (gate?.projectStatus?.conditions ?? []).filter((c) => c.status === 'ERROR').slice(0, 6).map((c) => ({ metric: clean(c.metricKey, 40), actual: clean(c.actualValue, 20), threshold: clean(c.errorThreshold, 20) })),
    measures: { bugs: num(m.bugs), vulnerabilities: num(m.vulnerabilities), codeSmells: num(m.code_smells), hotspots: num(m.security_hotspots), coverage: num(m.coverage), duplication: num(m.duplicated_lines_density), lines: num(m.ncloc) },
    ratings: { reliability: RATING[m.reliability_rating] ?? null, security: RATING[m.security_rating] ?? null, maintainability: RATING[m.sqale_rating] ?? null },
    issues: (iss?.issues ?? []).slice(0, issueLimit).map((i) => ({ key: clean(i.key, 60), severity: clean(i.severity, 12), type: clean(i.type, 20), rule: clean(i.rule, 80), message: clean(i.message), file: clean((i.component ?? '').replace(`${key}:`, ''), 160).replace(/[^\w./@+ -]/g, ''), line: Number.isFinite(i.line) ? i.line : null })),
    totalIssues: Number(iss?.total) || 0,
  };
}

// Run one analysis. `dir` is a fresh checkout; it is mounted read-only. Returns the collected results.
export async function scanProject({ dir, id, name, url, innerUrl, token, network, exec = run, fetchImpl, timeoutMs = 600000, onPhase = () => {}, log }) {
  const key = projectKey(id); const api = sonarApi({ url, token, fetchImpl });
  onPhase('registering the project in SonarQube');
  try { await api.post('/api/projects/create', { name: clean(name || id, 100), project: key }); } catch (e) { if (!/already exist|key.*exist/i.test(e.message)) throw e; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'af-sonar-')); fs.chmodSync(work, 0o777);
  try {
    onPhase('scanning the code (a minute or two)');
    const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
    const args = ['run', '--rm', '--user', `${uid}:${gid}`, '--memory', '2g', '--cpus', '2', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...(network ? ['--network', network] : []),
      '-v', `${dir}:/usr/src:ro`, '-v', `${work}:/tmp/scannerwork`, '-e', 'SONAR_HOST_URL', '-e', 'SONAR_TOKEN', '-e', 'SONAR_USER_HOME=/tmp/.sonar', '-e', 'HOME=/tmp', '-e', 'SONAR_SCANNER_OPTS=-Xmx1g', SCANNER_IMAGE,
      `-Dsonar.projectKey=${key}`, `-Dsonar.projectName=${clean(name || id, 100)}`, '-Dsonar.sources=.', '-Dsonar.working.directory=/tmp/scannerwork', '-Dsonar.scm.disabled=true',
      '-Dsonar.exclusions=**/node_modules/**,**/dist/**,**/build/**,**/vendor/**,**/*.min.js,**/.git/**'];
    const r = await exec('docker', args, { timeoutMs, log, env: { ...process.env, SONAR_HOST_URL: innerUrl ?? url, SONAR_TOKEN: token } });
    if (r.code !== 0) throw new Error(`scanner failed: ${clean(r.out.split('\n').filter((l) => /ERROR|Exception/.test(l)).slice(-3).join(' ') || r.out.slice(-300), 400)}`);
    const task = /ceTaskId=([\w-]+)/.exec(fs.readFileSync(path.join(work, 'report-task.txt'), 'utf8'))?.[1];
    if (!task) throw new Error('the scanner finished but SonarQube gave no task to follow');
    onPhase('SonarQube is processing the results');
    const end = Date.now() + 300000;
    for (;;) {
      const t = (await api.get('/api/ce/task', { id: task }))?.task;
      if (t?.status === 'SUCCESS') break;
      if (['FAILED', 'CANCELED'].includes(t?.status)) throw new Error(`SonarQube could not process the analysis (${t.status}): ${clean(t.errorMessage, 200)}`);
      if (Date.now() > end) throw new Error('SonarQube took too long to process the analysis');
      await sleep(2000);
    }
    onPhase('reading the results');
    return await collect(api, key);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// A few trusted lines for the agent prompt.
export function sonarSummary(s) {
  if (!s || s.error || !s.measures) return '';
  const m = s.measures; const n = (v) => (v ?? '?');
  return `SonarQube quality gate: ${s.qualityGate}. Open findings: ${n(m.bugs)} bugs, ${n(m.vulnerabilities)} vulnerabilities, ${n(m.codeSmells)} code smells${m.coverage != null ? `; test coverage ${m.coverage}%` : ''}. Do not introduce new findings of these kinds.`;
}
