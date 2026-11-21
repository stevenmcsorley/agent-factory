// Visual check: after a change passes its tests, start the project's app in the sandbox, load each route at phone, tablet and desktop width
// (light and dark), and look for what tests and typechecks cannot see: sideways scroll, text that cannot be read, tap targets too small to hit,
// console errors, pages that fail to load. Screenshots are kept with the run.
// It compares with a BASELINE (what was already wrong on the base branch), so a project with old problems is not blocked by them: only NEW ones count.
// The browser runs inside the agent-factory-visual image (Dockerfile.visual). Node-based dev servers and static sites are supported; others need a custom image.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'visual-runner.mjs');
export const VISUAL_IMAGE = 'agent-factory-visual:latest';

export function normalizePreview(input) {
  if (input === null || input === undefined || input === false) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('preview must be an object like { command, port, routes }');
  const known = ['command', 'port', 'routes', 'install', 'readyPath', 'startTimeoutSec', 'enabled']; const unknown = Object.keys(input).filter((k) => !known.includes(k)); if (unknown.length) throw bad(`"${unknown[0]}" is not a preview setting. Settings: ${known.join(', ')}`);
  const line = (v, name, max) => { const s = String(v ?? '').trim(); if (/[\r\n\0]/.test(s)) throw bad(`${name} must be one line (join steps with &&)`); if (s.length > max) throw bad(`${name} is too long (${max} characters at most)`); return s; };
  const command = line(input.command, 'command', 300); if (!command) throw bad('command is required: how to start the app, e.g. "npm run dev -- --port 4173 --host 127.0.0.1"');
  const port = Number(input.port); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw bad('port must be a whole number from 1024 to 65535: the port the app listens on');
  const routes = (Array.isArray(input.routes) ? input.routes : String(input.routes ?? '/').split(/[\n,]+/)).map((r) => String(r).trim()).filter(Boolean);
  if (!routes.length) routes.push('/'); if (routes.length > 12) throw bad('At most 12 routes');
  for (const r of routes) if (!/^\/[\w\-./~%@+=]*(\?[\w\-./~%@+=&]*)?$/.test(r) || r.startsWith('//') || r.length > 100) throw bad(`"${r}" is not a route (start with /, for example /settings)`);
  const out = { command, port, routes: [...new Set(routes)] };
  const install = line(input.install, 'install', 300); if (install) out.install = install;
  const ready = line(input.readyPath, 'readyPath', 100); if (ready) { if (!ready.startsWith('/')) throw bad('readyPath must start with /'); out.readyPath = ready; }
  if (input.startTimeoutSec !== undefined && input.startTimeoutSec !== '') { const t = Number(input.startTimeoutSec); if (!Number.isInteger(t) || t < 10 || t > 600) throw bad('startTimeoutSec must be 10 to 600'); out.startTimeoutSec = t; }
  if (input.enabled !== undefined) out.enabled = !!input.enabled;
  return out;
}

// ---- running it
// Copies the runner and its spec into the workspace (kept out of git), runs the app and the browser in one container, reads the report back and moves the screenshots out.
export async function runVisual({ sandbox, ws, preview, outDir, timeoutMs = 600_000, image = VISUAL_IMAGE }) {
  const dir = path.join(ws.dir, '.factory-visual'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.copyFileSync(RUNNER, path.join(dir, 'runner.mjs'));
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ port: preview.port, routes: preview.routes, readyPath: preview.readyPath, startTimeoutSec: preview.startTimeoutSec }));
  try { const ex = path.join(ws.dir, '.git', 'info', 'exclude'); fs.mkdirSync(path.dirname(ex), { recursive: true }); const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : ''; if (!cur.includes('.factory-visual')) fs.appendFileSync(ex, `${cur.endsWith('\n') || !cur ? '' : '\n'}.factory-visual/\n`); } catch { /* best effort */ }
  const server = '/work/.factory-visual/server.log';
  const script = [preview.install ? `(${preview.install}) || { echo "install failed" >&2; exit 41; }` : '', `(${preview.command}) > ${server} 2>&1 &`, 'SERVER=$!', 'node /work/.factory-visual/runner.mjs', 'CODE=$?', 'kill $SERVER 2>/dev/null', 'exit $CODE'].filter(Boolean).join('\n');
  const r = await sandbox.exec(ws, 'sh', ['-c', script], { timeoutMs, image, env: { CI: '1', BROWSER: 'none' } });
  const tail = (f, n = 600) => { try { return fs.readFileSync(f, 'utf8').slice(-n).trim(); } catch { return ''; } };
  if (r.timedOut) return { ok: false, error: 'The visual check timed out', serverLog: tail(path.join(dir, 'server.log')) };
  let report; try { report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'report.json'), 'utf8')); } catch { /* handled below */ }
  if (!report) return { ok: false, error: r.code === 41 ? 'The install command failed' : `The checker did not finish (exit ${r.code}). ${String(r.out ?? '').slice(-300)}`.trim(), serverLog: tail(path.join(dir, 'server.log')) };
  if (!report.ok) return { ...report, serverLog: tail(path.join(dir, 'server.log')) };
  fs.mkdirSync(outDir, { recursive: true }); const shots = [];
  for (const p of report.pages) if (p.shot) { try { fs.copyFileSync(path.join(dir, 'out', p.shot), path.join(outDir, p.shot)); shots.push(p.shot); } catch { p.shot = null; } }
  return { ...report, shots };
}

// ---- judging it (pure)
const norm = (s) => String(s).replace(/\d+(\.\d+)?/g, '#').slice(0, 100);
export function findingsOf(report) {
  const f = []; const add = (sev, kind, p, detail, key) => f.push({ severity: sev, kind, route: p.route, width: p.width, scheme: p.scheme, detail, key: `${kind}|${p.route}|${key ?? norm(detail)}` });
  for (const p of report.pages ?? []) {
    if (p.error) { add('fail', 'load', p, p.error); continue; }
    if (p.status >= 400) add('fail', 'load', p, `The page answered ${p.status}`);
    for (const e of p.consoleErrors ?? []) add('fail', 'console', p, `Console error: ${e}`);
    for (const e of p.failedRequests ?? []) add('warn', 'request', p, `Request failed: ${e}`);
    if (p.overflow) add('fail', 'overflow', p, `Scrolls sideways (${p.overflow.scrollWidth}px wide in a ${p.overflow.innerWidth}px window)${p.overflow.elements?.length ? `; widest: ${p.overflow.elements.slice(0, 3).join(', ')}` : ''}`, p.overflow.elements?.[0] ?? 'page');
    for (const c of p.contrast ?? []) add(c.ratio < 3 ? 'fail' : 'warn', 'contrast', p, `Text "${c.text}" has contrast ${c.ratio}:1 (needs ${c.need}:1) in ${c.el}`, c.el);
    for (const t of p.tapTargets ?? []) add('warn', 'tap', p, `${t.el} "${t.text}" is ${t.w}×${t.h}px (44×44 needed to tap)`, t.el);
  }
  const merged = new Map(); for (const x of f) { const m = merged.get(x.key); if (!m) merged.set(x.key, { ...x, widths: [x.width], schemes: [x.scheme] }); else { if (!m.widths.includes(x.width)) m.widths.push(x.width); if (!m.schemes.includes(x.scheme)) m.schemes.push(x.scheme); } }
  return [...merged.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'fail' ? -1 : 1));
}
// baseline: array of finding keys that were already present on the base branch.
export function evaluate(report, baseline = null) {
  if (!report?.ok) return { status: 'error', summary: report?.error ?? 'The visual check could not run', findings: [], counts: { fail: 0, warn: 0, existing: 0 }, pages: 0 };
  const all = findingsOf(report); const known = new Set(baseline ?? []); const now = new Set(all.map((x) => x.key)); const resolved = baseline ? baseline.filter((k) => !now.has(k)).length : 0; /* on the base branch, gone with this change */ const fresh = all.filter((x) => !known.has(x.key)); const existing = all.length - fresh.length;
  const fail = fresh.filter((x) => x.severity === 'fail').length, warn = fresh.length - fail; const status = fail ? 'fail' : warn ? 'warn' : 'pass';
  return { status, summary: status === 'pass' ? `No new visual problems${existing || resolved ? ` (${[existing ? `${existing} already on the base branch` : '', resolved ? `${resolved} fixed by this change` : ''].filter(Boolean).join(', ')})` : ''}` : `${fail} new problem${fail === 1 ? '' : 's'}${warn ? `, ${warn} to look at` : ''}${existing ? `; ${existing} already on the base branch` : ''}`,
    findings: fresh.slice(0, 25).map(({ key, ...rest }) => rest), keys: all.map((x) => x.key), counts: { fail, warn, existing, resolved }, pages: report.pages.length, shots: report.shots ?? [] };
}
export const visualFeedback = (v) => `The visual check (the app loaded at phone, tablet and desktop width) found problems your change introduced:\n${v.findings.filter((f) => f.severity === 'fail').slice(0, 8).map((f) => `- ${f.route} at ${f.widths.join('/')}px: ${f.detail}`).join('\n')}\nFix these without changing what the ticket asked for.`;
