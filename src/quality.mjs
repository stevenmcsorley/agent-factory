// Our own, light code-quality engine, with no server: a few rules, a quality gate, and a trend.
//  * a small set of line/structure rules (secrets, dangerous calls, empty error handlers, huge or deeply nested functions)
//  * "clean as you code": check only the lines the agent CHANGED, and gate the pull request on them
//  * a quality gate with configurable limits, and a history so you can see the trend
// Heuristic by design (regex + brace counting, no parsing): fast, dependency-free, and every rule is ours. It is not a replacement for a real analyser.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './util.mjs';
import { lockGit, SAFE_GIT } from './gitguard.mjs';
import { reinvented } from './library.mjs';

const JS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte']); const PY = new Set(['py']);
const MAX_LINE = 400, MAX_FILE = 400_000, MAX_PER_FILE = 200;
const SEVERITY_ORDER = { BLOCKER: 0, CRITICAL: 1, MAJOR: 2, MINOR: 3, INFO: 4 };

// Provider-shaped keys are always suspicious. The generic "password = '...'" form is skipped in test files and for obvious placeholders.
const KEYS = [[/AKIA[0-9A-Z]{16}/, 'AWS access key'], [/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, 'private key'], [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'], [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, 'API key'], [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token']];
const ASSIGN = /\b(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\w{0,12}\s{0,3}[:=]\s{0,3}["']([^"'\s]{8,})["']/i;
const PLACEHOLDER = /^(?:x{4,}|\*{4,}|your|example|changeme|change-me|placeholder|dummy|sample|test|<|\$\{|%\(|process\.env|os\.environ)|\$\{|process\.env|os\.environ|\{\{/i;

const RULES = [
  { skipTests: true, id: 'eval', type: 'vulnerability', severity: 'CRITICAL', msg: 'eval()/new Function() runs arbitrary code', langs: (e) => JS.has(e) || PY.has(e), re: /\beval\s*\(|\bnew\s+Function\s*\(/ },
  { skipTests: true, id: 'inner-html', type: 'vulnerability', severity: 'MAJOR', msg: 'Assigning HTML from a string can allow XSS; use textContent or build elements', langs: (e) => JS.has(e), re: /\.(?:innerHTML|outerHTML)\s*=[^=]/ },
  { skipTests: true, id: 'shell-true', type: 'vulnerability', severity: 'MAJOR', msg: 'shell=True with dynamic input allows command injection', langs: (e) => PY.has(e), re: /shell\s*=\s*True/ },
  { skipTests: true, id: 'tls-off', type: 'vulnerability', severity: 'MAJOR', msg: 'TLS certificate verification is switched off', langs: (e) => JS.has(e) || PY.has(e), re: /rejectUnauthorized\s*:\s*false|\bverify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/ },
  { keepComments: true, id: 'empty-catch', type: 'bug', severity: 'MAJOR', msg: 'Empty error handler hides failures; handle or log the error', langs: (e) => JS.has(e), re: /\bcatch\s*(?:\([^)]{0,80}\))?\s*\{\s*\}/ },
  { id: 'empty-except', type: 'bug', severity: 'MAJOR', msg: 'except/pass hides failures; handle or log the error', langs: (e) => PY.has(e), re: /^\s*except\b[^:]{0,80}:\s*pass\s*$/ },
  { id: 'debugger', type: 'code_smell', severity: 'MAJOR', msg: 'Leftover debugger statement', langs: (e) => JS.has(e), re: /^\s*debugger\s*;?\s*$/ },
  { id: 'py-debug', type: 'code_smell', severity: 'MAJOR', msg: 'Leftover debugger call', langs: (e) => PY.has(e), re: /^\s*(?:breakpoint\(\)|import pdb|pdb\.set_trace\(\))/ },
  { id: 'console', type: 'code_smell', severity: 'MINOR', msg: 'Leftover console.log/debug', langs: (e) => JS.has(e), re: /\bconsole\.(?:log|debug)\s*\(/, skipTests: true, skipPaths: /(^|\/)(bin|cli|scripts?|tools?)(\/|\.[a-z]+$)/ },
];

const STRINGS = /(["'`])(?:\\.|(?!\1).){0,200}?\1/g;
const stripLine = (l) => l.replace(STRINGS, '""').replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');

const MASK = '••••••••';
// The line a finding points at, for display. Anything that looks like a secret is masked, so a leaked key is never copied into state files, logs or the UI.
export function redact(line) {
  let t = String(line ?? '').trim(); if (t.length > 300) return '';
  for (const [re] of KEYS) t = t.replace(new RegExp(re.source, 'g'), MASK);
  t = t.replace(new RegExp(ASSIGN.source, 'ig'), (m, v) => m.replace(v, MASK));
  return t.replace(/\s+/g, ' ').slice(0, 160);
}

export function scanText(rel, text, { isTest = false } = {}) {
  const ext = path.extname(rel).slice(1).toLowerCase(); const out = []; const lines = text.split('\n'); const push = (f) => { if (out.length < MAX_PER_FILE) out.push({ file: rel, ...f }); };
  const rules = RULES.filter((r) => r.langs(ext) && !(r.skipTests && isTest) && !r.skipPaths?.test(rel));
  lines.forEach((raw, i) => {
    if (raw.length > MAX_LINE) return;                                    // minified or generated: skip (also bounds regex cost on hostile input)
    if (/quality-ignore\s*(?:\*\/|-->)?\s*$/.test(raw)) return;           // explicit, reviewable opt-out for a deliberate line (fixtures, examples)
    const line = i + 1;
    for (const [re, kind] of KEYS) if (re.test(raw)) push(isTest ? { rule: 'secret-in-test', type: 'code_smell', severity: 'MINOR', line, message: `Key-shaped ${kind} in a test file (fine if it is a fake)` } : { rule: 'secret', type: 'vulnerability', severity: 'BLOCKER', line, message: `Possible hard-coded ${kind}` });
    if (!isTest) { const m = ASSIGN.exec(raw); if (m && !PLACEHOLDER.test(m[1]) && !PLACEHOLDER.test(raw.slice(m.index + m[0].length - m[1].length - 1))) push({ rule: 'secret', type: 'vulnerability', severity: 'BLOCKER', line, message: 'Possible hard-coded credential' }); }
    const code = stripLine(raw); const noStrings = raw.replace(STRINGS, '""');   // rules look at code, not at text inside string literals or comments
    for (const r of rules) if (r.re.test(r.keepComments ? noStrings : code)) push({ rule: r.id, type: r.type, severity: r.severity, line, message: r.msg });
  });
  if (JS.has(ext)) structureJs(lines, push); else if (PY.has(ext)) structurePy(lines, push);
  const code = lines.filter((l) => l.trim()).length; if (code > 800 && !isTest) push({ rule: 'long-file', type: 'code_smell', severity: 'MINOR', line: 1, message: `File is ${code} lines long; consider splitting it` });
  for (const f of out) f.snippet = redact(lines[f.line - 1]);
  return out;
}

const FN_START = [/\bfunction\b[^{;]*\{\s*$/, /=>\s*\{\s*$/, /^\s*(?:(?:public|private|protected|static|async|get|set|readonly)\s+)*[#\w$]+\s*\([^()]*\)\s*(?::\s*[\w<>[\]|. ,]+)?\s*\{\s*$/];
const NOT_FN = /^\s*(?:if|for|while|switch|catch|with|else|try|do)\b/;
function structureJs(lines, push) {
  let depth = 0; const stack = [];
  lines.forEach((raw, i) => {
    if (raw.length > MAX_LINE) return;
    const s = stripLine(raw); const startsFn = !NOT_FN.test(s) && FN_START.some((re) => re.test(s));
    const d0 = depth; if (startsFn) stack.push({ line: i + 1, d0, max: d0 });
    for (const ch of s) { if (ch === '{') depth++; else if (ch === '}') depth = Math.max(0, depth - 1); for (const f of stack) if (depth > f.max) f.max = depth; }
    while (stack.length && depth <= stack.at(-1).d0 && i + 1 > stack.at(-1).line) {
      const f = stack.pop(); const len = i + 1 - f.line + 1; const nest = f.max - f.d0 - 1;
      if (len > 80) push({ rule: 'long-function', type: 'code_smell', severity: 'MAJOR', line: f.line, endLine: i + 1, message: `Function is ${len} lines long; split it into smaller pieces` });
      if (nest > 5) push({ rule: 'deep-nesting', type: 'code_smell', severity: 'MAJOR', line: f.line, endLine: i + 1, message: `Code is nested ${nest} levels deep; flatten it with early returns or helpers` });
    }
  });
}
function structurePy(lines, push) {
  lines.forEach((raw, i) => {
    const m = /^(\s*)(?:async\s+)?def\s+\w+/.exec(raw); if (!m) return; const indent = m[1].length; let end = i;
    for (let j = i + 1; j < lines.length; j++) { if (!lines[j].trim()) continue; if (lines[j].length - lines[j].trimStart().length <= indent) break; end = j; }
    const len = end - i + 1; if (len > 80) push({ rule: 'long-function', type: 'code_smell', severity: 'MAJOR', line: i + 1, endLine: end + 1, message: `Function is ${len} lines long; split it into smaller pieces` });
  });
}

export const bySeverity = (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || String(a.file).localeCompare(String(b.file)) || (a.line ?? 0) - (b.line ?? 0);
export const findingKey = (f) => `${f.rule}:${f.file}:${f.line}`;
export function countFindings(list) {
  const secrets = list.filter((f) => f.rule === 'secret').length;
  return { secrets, vulnerabilities: list.filter((f) => f.type === 'vulnerability' && f.rule !== 'secret').length, bugs: list.filter((f) => f.type === 'bug').length, smells: list.filter((f) => f.type === 'code_smell').length, total: list.length };
}
export const isTestPath = (rel) => /(^|\/)(tests?|__tests__|spec|e2e)\//i.test(rel) || /\.(test|spec)\.[a-z]+$/i.test(rel) || /_test\.(go|py)$/.test(rel) || /^test_.*\.py$/.test(path.basename(rel));
export const topFindings = (list, n = 12) => [...list].sort(bySeverity).slice(0, n).map((f) => ({ key: findingKey(f), rule: f.rule, type: f.type, severity: f.severity, file: f.file, line: f.line, message: f.message, snippet: f.snippet ?? '' }));
export function summarizeFindings(list) {
  const count = (k) => list.reduce((m, f) => { m[f[k]] = (m[f[k]] ?? 0) + 1; return m; }, {});
  return { byRule: count('rule'), bySeverity: count('severity') };
}

// ---- the gate. Limits for NEW code (the agent's change); `block` lists conditions that stop the pull request outright after the retry.
export const DEFAULT_GATE = { maxNewSecrets: 0, maxNewVulnerabilities: 0, maxNewBugs: 0, maxNewSmells: null, block: ['secrets'] };
export function evaluateGate(counts, gate = {}) {
  const g = { ...DEFAULT_GATE, ...(gate && typeof gate === 'object' ? gate : {}) }; const blockers = [], warnings = [];
  for (const [key, label, max] of [['secrets', 'hard-coded secrets', g.maxNewSecrets], ['vulnerabilities', 'new vulnerabilities', g.maxNewVulnerabilities], ['bugs', 'new bugs', g.maxNewBugs], ['smells', 'new code smells', g.maxNewSmells]]) {
    if (max == null || counts[key] <= max) continue; const msg = `${counts[key]} ${label} (limit ${max})`; (g.block?.includes(key) ? blockers : warnings).push(msg);
  }
  return { passed: !blockers.length && !warnings.length, blockers, warnings };
}

// ---- "clean as you code": which lines did the agent add or change?
export function parseAddedLines(diff) {
  const added = new Map(); let file = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { const p = l.slice(4).trim(); file = p === '/dev/null' ? null : p.replace(/^b\//, '').replace(/^"|"$/g, ''); if (file && !added.has(file)) added.set(file, new Set()); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l); if (m && file) { const start = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]); for (let i = 0; i < n; i++) added.get(file).add(start + i); }
  }
  return added;
}
async function changedLines(dir, log) {
  lockGit(dir);                                                                    // never trust .git hooks/config the agent could have written
  const g = (a) => run('git', [...SAFE_GIT, ...a], { cwd: dir, log });
  const diff = await g(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', 'HEAD']);
  const added = parseAddedLines(diff.out);
  for (const f of (await g(['ls-files', '--others', '--exclude-standard'])).out.split('\n').filter(Boolean)) added.set(f, 'all');   // brand-new file: every line is new
  return added;
}
export async function changeQuality(dir, gateCfg, { log, ignore, parts } = {}) {
  const added = await changedLines(dir, log); const found = []; let files = 0; const fresh = [];
  for (const [rel, lines] of added) {
    if (files >= 300 || /(^|\/)(node_modules|\.git|dist|build|vendor)\//.test(rel) || ignore?.test(rel)) continue;
    const full = path.join(dir, rel); let st; try { st = fs.lstatSync(full); } catch { continue; } if (!st.isFile() || st.size > MAX_FILE || st.size === 0) continue;
    let text; try { text = fs.readFileSync(full, 'utf8'); } catch { continue; } if (text.includes('\u0000')) continue; files++;
    if (parts?.length && !isTestPath(rel) && lines === 'all') fresh.push({ rel, content: text });          // only brand-new files are compared with the library
    for (const f of scanText(rel, text, { isTest: isTestPath(rel) })) { const touched = lines === 'all' || lines.has(f.line) || (f.endLine && [...lines].some((n) => n >= f.line && n <= f.endLine)); if (touched) found.push(f); }
  }
  if (parts?.length) for (const r of reinvented(fresh, parts)) found.push({ file: r.file, line: 1, rule: 'reinvented-part', type: 'code_smell', severity: 'MAJOR', message: `Looks like the library part ${r.slug}@${r.version} (${r.similarity}% similar): use or adapt the part instead of rewriting it`, snippet: '' });
  const counts = countFindings(found); const gate = evaluateGate(counts, gateCfg);
  const reuse = found.filter((f) => f.rule === 'reinvented-part').length;                      // rewriting a library part earns a retry, then a flag on the PR
  if (reuse > (gateCfg?.maxNewReuse ?? 0)) { gate.warnings.push(`${reuse} file${reuse > 1 ? 's' : ''} rewrite${reuse > 1 ? '' : 's'} a library part (use or adapt the part)`); gate.passed = false; }
  return { ...gate, status: gate.passed ? 'OK' : gate.blockers.length ? 'ERROR' : 'WARN', counts, files, findings: topFindings(found, 12) };
}
export function feedbackFor(q) {
  const lines = q.findings.filter((f) => f.severity !== 'INFO').map((f) => `- ${f.file}:${f.line} [${f.rule}] ${f.message}`).join('\n');
  return `The quality gate on your change failed: ${[...q.blockers, ...q.warnings].join('; ')}.\nFix these in the code you added (do not weaken or remove tests to do it):\n${lines}`;
}

// ---- whole-repo gate for the project card, and the history that makes the trend
export const DEFAULT_REPO_GATE = { maxDuplicatedPct: 10, maxSecrets: 0, maxCritical: 0 };
export function evaluateRepoGate({ metrics, findings }, gate = {}) {
  const g = { ...DEFAULT_REPO_GATE, ...(gate && typeof gate === 'object' ? gate : {}) }; const failed = [];
  const counts = countFindings(findings); const critical = findings.filter((f) => f.severity === 'CRITICAL' || (f.severity === 'BLOCKER' && f.rule !== 'secret')).length;
  if (counts.secrets > g.maxSecrets) failed.push(`${counts.secrets} possible secrets committed (limit ${g.maxSecrets})`);
  if (critical > g.maxCritical) failed.push(`${critical} critical findings (limit ${g.maxCritical})`);
  if (metrics && metrics.duplicatedPct > g.maxDuplicatedPct) failed.push(`${metrics.duplicatedPct}% duplicated code (limit ${g.maxDuplicatedPct}%)`);
  return { status: failed.length ? 'ERROR' : 'OK', failed };
}
export function addHistory(prev, profile, max = 30) {
  const q = profile.quality; if (!q) return prev ?? [];
  const point = { at: profile.analyzedAt ?? new Date().toISOString(), status: q.gate.status, findings: q.counts.total, secrets: q.counts.secrets, duplication: profile.metrics?.duplicatedPct ?? null, testRatio: profile.metrics?.testRatioPct ?? null, lines: profile.metrics?.codeLines ?? null };
  return [...(prev ?? []), point].slice(-max);
}
