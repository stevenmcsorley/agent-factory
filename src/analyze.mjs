// Look at a checked-out repo and say what the factory needs to know: language, how to verify a change, and whether the repo is ready for unattended work.
// Pure over a directory (testable); everything it reports is derived from file names and manifests, never from executing repo code.
import fs from 'node:fs';
import path from 'node:path';
import { detectVerify, loadRepoConfig } from './repoconfig.mjs';
import { inspectCode, importedNames } from './inspect.mjs';
import { makeIgnore, cleanPatterns } from './ignore.mjs';
import { scanText, isTestPath, countFindings, topFindings, evaluateRepoGate } from './quality.mjs';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', 'vendor']);
const safePath = (s) => String(s).replace(/[^\w./@+-]/g, '').slice(0, 120);
const safeName = (s) => String(s).replace(/[^\w.@+-]/g, '').slice(0, 40);

const LANG = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby', php: 'PHP', cs: 'C#', c: 'C', h: 'C', cpp: 'C++', swift: 'Swift', sh: 'Shell', css: 'CSS', scss: 'CSS', html: 'HTML', sql: 'SQL', vue: 'Vue', svelte: 'Svelte' };
const TRIVIAL = /^(?:[)}\];,]+|import\b|from\b|export\s*(?:\*|\{)|#include|using\b|package\b|use\b|require\()/;
const LINE_COMMENT = /^\s*(\/\/|#|--|\*|\/\*)/;
const rate = (v, [a, b, c, d]) => (v <= a ? 'A' : v <= b ? 'B' : v <= c ? 'C' : v <= d ? 'D' : 'E');

// Code-health measures without a server: a bounded, dependency-free scan. It is a HEURISTIC (line-based, no parsing), good for "is this repo in shape to automate", not a substitute for a real analyser.
export function codeMetrics(dir, { maxFiles = 4000, maxBytes = 400_000, ignore } = {}) {
  const ignored = { yours: 0, default: 0, folders: 0, examples: [] }; const files = []; const walk = (d, depth) => { if (files.length >= maxFiles || depth > 8) return; let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (SKIP.has(e.name) || e.isSymbolicLink()) continue; const full = path.join(d, e.name); const why = ignore?.test(path.relative(dir, full)); if (why) { if (e.isDirectory()) ignored.folders++; else ignored[why]++; if (ignored.examples.length < 8) ignored.examples.push({ path: safePath(path.relative(dir, full)) + (e.isDirectory() ? '/' : ''), why }); continue; } if (e.isDirectory()) walk(full, depth + 1); else if (e.isFile()) files.push(full); if (files.length >= maxFiles) return; } };
  walk(dir, 0);
  const findings = []; const recs = []; const byLang = {}, big = [], todos = { n: 0 }, secrets = []; let code = 0, comment = 0, blank = 0, srcFiles = 0, testFiles = 0, testLines = 0, dupLines = 0, scanned = 0, longFiles = 0;
  for (const f of files) {
    const ext = path.extname(f).slice(1).toLowerCase(); const lang = LANG[ext]; const rel = path.relative(dir, f);
    let st; try { st = fs.statSync(f); } catch { continue; } if (st.size > maxBytes || st.size === 0) continue;
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; } if (txt.includes('\u0000')) continue; scanned++;
    const isTest = isTestPath(rel);
    for (const f of scanText(rel, txt, { isTest })) { if (findings.length < 600) findings.push({ ...f, file: safePath(f.file) }); if (f.rule === 'secret' && secrets.length < 10 && !secrets.some((x) => x.file === safePath(rel))) secrets.push({ file: safePath(rel), kind: f.message.replace('Possible hard-coded ', '') }); }
    if (!lang) continue;
    const lines = txt.split('\n'); let c = 0; const norm = [];
    lines.forEach((l, idx) => { const t = l.trim(); if (!t) blank++; else if (LINE_COMMENT.test(l)) { comment++; if (/\b(TODO|FIXME|HACK|XXX)\b/.test(l)) todos.n++; } else { c++; code++; if (t.length > 12 && t.length < 300 && !TRIVIAL.test(t)) norm.push({ t, n: idx + 1 }); } });
    byLang[lang] = (byLang[lang] ?? 0) + c; srcFiles++;
    recs.push({ rel: safePath(rel), lang, isTest, lines: c, norm: /\.(json|lock)$/.test(rel) ? [] : norm, refs: isTest ? importedNames(txt) : null });
    if (isTest) { testFiles++; testLines += c; } else { if (c > 500) longFiles++; if (big.length < 200) big.push({ file: safePath(rel), lines: c }); }
  }
  const insp = inspectCode(recs); dupLines = insp.duplicates.dupLines;
  const prod = Math.max(0, code - testLines); const dupPct = prod ? Math.min(100, Math.round((dupLines / prod) * 100)) : 0;
  const testRatio = prod ? Math.round((testLines / prod) * 100) : 0;
  const languages = Object.entries(byLang).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, lines]) => ({ name, lines }));
  const hotspots = big.sort((a, b) => b.lines - a.lines).slice(0, 5);
  const ratings = {
    size: rate(prod, [20_000, 60_000, 150_000, 400_000]),                       // smaller is easier for an agent to hold in its head
    tests: !srcFiles ? 'E' : testFiles === 0 ? 'E' : testRatio >= 30 ? 'A' : testRatio >= 15 ? 'B' : testRatio >= 7 ? 'C' : testRatio >= 3 ? 'D' : 'E',
    duplication: rate(dupPct, [3, 5, 10, 20]),
    maintainability: rate(longFiles + todos.n / 10, [1, 3, 6, 12]),
    security: secrets.length ? 'E' : 'A',
  };
  return { _findings: findings, _inspect: insp, _ignored: ignored, files: scanned, codeLines: code, commentLines: comment, blankLines: blank, sourceFiles: srcFiles, testFiles, testRatioPct: testRatio, duplicatedPct: dupPct, todoCount: todos.n, largeFiles: longFiles, languages, hotspots, secrets, ratings, heuristic: true, capped: files.length >= maxFiles };
}

export function analyzeRepo(dir, { sub = false, gate: gateCfg, ignore: ignoreList, ignoreDefaults = true } = {}) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !SKIP.has(e.name)); } catch { /* unreadable dir: empty profile */ }
  const topLevel = entries.filter((e) => !e.name.startsWith('.') || ['.github', '.agent-factory.json'].includes(e.name)).map((e) => safeName(e.name) + (e.isDirectory() ? '/' : '')).filter((n) => n.replace('/', '')).sort().slice(0, 30);
  const languages = [], notes = [], warnings = [];
  let packageManager = null, framework = null, verify = null, image = null, verifyReason = null;

  if (has('package.json')) {
    let pkg = {}; try { pkg = JSON.parse(read('package.json')); } catch { warnings.push('package.json is not valid JSON'); }
    languages.push(has('tsconfig.json') ? 'TypeScript' : 'JavaScript');
    packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const dep = { ...pkg.dependencies, ...pkg.devDependencies };
    framework = ['next', 'react', 'vue', '@angular/core', 'svelte', 'express', 'fastify', '@nestjs/core'].find((d) => dep[d])?.replace('@angular/core', 'angular').replace('@nestjs/core', 'nestjs') ?? null;
    const scripts = pkg.scripts ?? {};
    const testScript = ['test', 'test:unit', 'test:ci'].find((s) => scripts[s] && !/no test specified/.test(scripts[s]));
    if (testScript) {
      const run = testScript === 'test' ? `${packageManager} test` : `${packageManager} run ${testScript}`;
      const install = { pnpm: 'corepack enable && pnpm install --frozen-lockfile', yarn: 'corepack enable && yarn install --frozen-lockfile', bun: 'bun install', npm: has('package-lock.json') ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund' }[packageManager];
      verify = `${install} && ${run}`; image = 'node:22-bookworm'; verifyReason = `package.json has a \`${testScript}\` script (${packageManager})`;
    } else notes.push('package.json has no test script');
    if (!verify && scripts.lint) notes.push('there is a lint script but no tests: it could be used as a weaker check');
  }
  if (!verify || !languages.length) {
    if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('pytest.ini')) languages.push('Python');
    if (has('go.mod')) languages.push('Go');
    if (has('Cargo.toml')) languages.push('Rust');
    if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) { languages.push('Java/Kotlin'); notes.push('Java/Kotlin builds are detected but not auto-verified: set a verify command (e.g. `./gradlew test`)'); }
    if (has('Gemfile')) { languages.push('Ruby'); notes.push('Ruby detected but not auto-verified: set a verify command (e.g. `bundle exec rspec`)'); }
    if (has('composer.json')) { languages.push('PHP'); notes.push('PHP detected but not auto-verified: set a verify command (e.g. `vendor/bin/phpunit`)'); }
    if (!verify) { const d = detectVerify(dir); if (d) { verify = d.verify; image = d.image ?? null; verifyReason = 'detected from the project files'; } }
  }
  const repoCfg = loadRepoConfig(dir);
  const hasRepoConfig = has('.agent-factory.json');
  if (hasRepoConfig) { if (repoCfg.verify) { verify = repoCfg.verify; image = repoCfg.image ?? image; verifyReason = 'set by .agent-factory.json in the repo'; } else if (!Object.keys(repoCfg).length) warnings.push('.agent-factory.json exists but is empty or invalid'); }
  // Monorepos / apps in a subfolder (e.g. engine/): look one level down and run the command from there.
  if (!verify && !sub) {
    for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.')).slice(0, 12)) {
      const q = analyzeRepo(path.join(dir, e.name), { sub: true });
      if (q.verify) { const d = safeName(e.name); verify = `cd ${d} && ${q.verify}`; image = q.image; verifyReason = `${q.verifyReason}, in the \`${d}/\` folder`; if (!languages.length) languages.push(...q.languages); packageManager ??= q.packageManager; framework ??= q.framework; break; }
    }
  }
  const files = entries.filter((e) => e.isFile()).length + entries.filter((e) => e.isDirectory()).length;
  const empty = files === 0;
  if (empty) warnings.push('the repository is empty: the factory needs at least one commit on the base branch to build on');
  if (!verify && !empty) warnings.push('no way to run tests was found: pull requests will be opened UNVERIFIED. Set a verify command below, or add tests');
  const tests = !!verify;
  const hasReadme = entries.some((e) => /^readme(\.|$)/i.test(e.name));
  const ci = has('.github/workflows') ? 'GitHub Actions' : has('.gitlab-ci.yml') ? 'GitLab CI' : has('bitbucket-pipelines.yml') ? 'Bitbucket Pipelines' : has('Jenkinsfile') ? 'Jenkins' : null;
  if (!ci) notes.push('no CI configuration found: the factory can only rely on its own verify step');
  const dedupe = [...new Set(languages)];
  const matcher = makeIgnore({ patterns: [...(Array.isArray(ignoreList) ? ignoreList : []), ...(Array.isArray(repoCfg.analysis?.ignore) ? repoCfg.analysis.ignore : [])], useDefaults: ignoreDefaults !== false && repoCfg.analysis?.ignoreDefaults !== false });
  const metrics = empty || sub ? null : codeMetrics(dir, { ignore: matcher }); const found = metrics?._findings ?? []; const insp = metrics?._inspect ?? null; const ign = metrics?._ignored ?? null; if (metrics) { delete metrics._findings; delete metrics._inspect; delete metrics._ignored; }
  if (metrics && !dedupe.length) dedupe.push(...metrics.languages.filter((l) => !['CSS', 'HTML'].includes(l.name)).slice(0, 3).map((l) => l.name));
  if (metrics?.secrets.length) warnings.push(`possible secrets committed in ${metrics.secrets.map((x) => x.file).slice(0, 3).join(', ')}: rotate them and remove them from history`);
  if (metrics && metrics.sourceFiles && metrics.testFiles === 0) notes.push('no test files found: the agent cannot prove its changes work here');
  if (metrics && metrics.duplicatedPct >= 10) notes.push(`about ${metrics.duplicatedPct}% duplicated code: changes may need to be repeated in several places`);
  const quality = metrics ? { counts: countFindings(found), findings: topFindings(found, 15), gate: evaluateRepoGate({ metrics, findings: found }, gateCfg) } : null;
  const ignored = ign ? { defaults: ign.default, yours: ign.yours, folders: ign.folders, examples: ign.examples, patterns: matcher.yours, useDefaults: matcher.useDefaults } : null;
  const profile = { ignored, metrics, quality, structure: insp?.structure ?? null, duplicates: insp ? { pct: metrics.duplicatedPct, blocks: insp.duplicates.blocks } : null, languages: dedupe, packageManager, framework, verify, image, verifyReason, tests, hasRepoConfig, hasReadme, ci, topLevel, notes, warnings, analyzedAt: new Date().toISOString() };
  return profile;
}

// A few trusted lines for the agent prompt. Built only from the fields above (names are sanitised), never copied verbatim from repo prose.
export function profileSummary(p) {
  if (!p) return '';
  const bits = [];
  if (p.languages?.length) bits.push(`Languages: ${p.languages.join(', ')}${p.framework ? ` (${safeName(p.framework)})` : ''}${p.packageManager ? `; package manager: ${p.packageManager}` : ''}.`);
  if (p.verify) bits.push(`Changes are verified with: ${String(p.verify).slice(0, 200)}. Make sure that passes.`); else bits.push('No automated tests are configured here; keep the change small and add tests only if a test setup obviously exists.');
  if (p.metrics?.hotspots?.length) bits.push(`Largest source files: ${p.metrics.hotspots.slice(0, 3).map((h) => `${safePath(h.file)} (${Number(h.lines) || 0} lines)`).join(', ')}.`);
  if (p.topLevel?.length) bits.push(`Top-level layout: ${p.topLevel.slice(0, 20).join(' ')}`);
  return bits.join('\n');
}
