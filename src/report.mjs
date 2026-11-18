// A plain-text version of the project analysis, for `agent-factory analyze` (no config, no server, nothing is changed).
const bar = (v, max, w = 24) => '█'.repeat(Math.max(v > 0 ? 1 : 0, Math.round((v / Math.max(1, max)) * w)));
const pad = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, String(s).length));

export function textReport(p, name = '') {
  const L = []; const m = p.metrics; const q = p.quality;
  L.push(`Code inspection${name ? `: ${name}` : ''}`, '='.repeat(40));
  if (!m) { L.push('Nothing to analyse (empty repository).'); return L.join('\n'); }
  L.push(`${p.languages.join(', ') || 'no recognised language'}${p.packageManager ? ` · ${p.packageManager}` : ''}${p.framework ? ` · ${p.framework}` : ''}`);
  L.push(`${m.codeLines.toLocaleString()} lines of code in ${m.sourceFiles} files · ${m.testFiles} test files (${m.testRatioPct}% test code) · ${m.todoCount} TODO/FIXME`);
  L.push(`Ratings:  ${Object.entries(m.ratings).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  L.push('', `How changes are verified: ${p.verify ?? 'NOTHING (pull requests would be unverified)'}${p.verifyReason ? `  (${p.verifyReason})` : ''}`);
  if (p.structure?.dirs.length) {
    L.push('', 'Where the code lives (lines of code per folder)'); const max = p.structure.dirs[0].lines;
    for (const d of p.structure.dirs) L.push(`  ${pad(d.path, 26)} ${bar(d.lines, max)} ${d.lines}${d.testLines ? `  (${d.testLines === d.lines ? 'all test code' : `${d.testLines} of it test code`})` : ''}`);
  }
  L.push('', `Repeated code: ${p.duplicates?.pct ?? 0}% of the code is copied somewhere else`);
  if (p.duplicates?.blocks.length) for (const b of p.duplicates.blocks.slice(0, 8)) L.push(`  ${pad(`${b.lines} lines`, 9)} ${b.a.file}:${b.a.start}-${b.a.end}   ==   ${b.b.file}:${b.b.start}-${b.b.end}`);
  else L.push('  none found');
  if (p.structure) {
    L.push('', `Tests: ${p.structure.testedFiles} of ${p.structure.sourceFiles} source files have a test (matched by name or import)`);
    if (p.structure.untested.length) { L.push('  Biggest files with no test:'); for (const u of p.structure.untested.slice(0, 8)) L.push(`  ${pad(u.file, 40)} ${u.lines} lines`); }
  }
  if (m.hotspots?.length) { L.push('', 'Largest files'); for (const h of m.hotspots) L.push(`  ${pad(h.file, 40)} ${h.lines} lines`); }
  if (q) {
    L.push('', `Quality gate: ${q.gate.status === 'OK' ? 'PASSED' : 'FAILED'}${q.gate.failed.length ? `  (${q.gate.failed.join('; ')})` : ''}`);
    L.push(`  ${q.counts.secrets} secrets · ${q.counts.vulnerabilities} vulnerabilities · ${q.counts.bugs} bugs · ${q.counts.smells} code smells`);
    for (const f of q.findings.slice(0, 10)) L.push(`  ${pad(f.severity.toLowerCase(), 9)} ${pad(`${f.file}:${f.line}`, 36)} ${f.message}`);
  }
  for (const w of p.warnings) L.push('', `! ${w}`);
  for (const n of p.notes) L.push(`  note: ${n}`);
  L.push('', 'This is a fast, line-based scan: good for orientation, not a full static analyser.');
  return L.join('\n');
}
