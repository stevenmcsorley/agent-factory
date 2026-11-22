// Does what the agent says match what it did? A cheap, deterministic check on the diff (no model, no tokens), run before the project's tests. An older or smaller model more often "finishes" by
// switching a test off, or by saying it added tests it never wrote, so the harness looks at the evidence instead of the summary. Blocking problems go back to the builder like a failing test.
// (Removed or weakened assertions are the quality gate's job (quality.mjs): flagged on the PR by default, blocked if you ask. This check does not second-guess that policy.)
export const isTestFile = (p) => /(^|\/)(tests?|__tests__|spec|specs)\//i.test(p) || /\.(test|spec)\.[a-z0-9]+$/i.test(p) || /_test\.(py|go|rb)$/i.test(p) || /(^|\/)test_[^/]+\.py$/i.test(p);
const SKIP = /\b(it|test|describe|context)\.(skip|only|todo)\b|\bx(it|describe|test)\(|@pytest\.mark\.(skip|xfail)|\bt\.Skip(Now)?\(|@Disabled\b|\bpending\(/;
const CLAIM = /\b(added|adds|wrote|written|updated|extended|created|new)\b[^.\n]{0,40}\btests?\b|\btests?\b[^.\n]{0,25}\b(added|written|updated|extended)\b/i;

export function parseDiff(diff) {
  const files = []; let cur = null;
  for (const line of String(diff ?? '').split('\n')) {
    const h = /^diff --git a\/(.+?) b\/(.+)$/.exec(line); if (h) { cur = { path: h[2], deleted: false, added: [], removed: [] }; files.push(cur); continue; }
    if (!cur) continue; if (/^deleted file mode/.test(line)) cur.deleted = true;
    if (line.startsWith('+') && !line.startsWith('+++')) cur.added.push(line.slice(1)); else if (line.startsWith('-') && !line.startsWith('---')) cur.removed.push(line.slice(1));
  }
  return files;
}
// -> { ok, findings: [{ kind, blocking, detail }] }
export function checkClaims({ summary = '', diff = '', files = [], ticketText = '' } = {}) {
  const findings = []; const parsed = parseDiff(diff); const tests = parsed.filter((f) => isTestFile(f.path));
  for (const f of tests) {
    const off = f.added.filter((l) => SKIP.test(l)); if (off.length) findings.push({ kind: 'test-switched-off', blocking: true, detail: `${f.path}: ${off.length} test${off.length === 1 ? ' was' : 's were'} switched off or limited (skip, only or todo).` });
  }
  const touchedTests = files.some(isTestFile) || tests.some((f) => !f.deleted && (f.added.length || f.removed.length));
  if (CLAIM.test(String(summary)) && !touchedTests) findings.push({ kind: 'claimed-tests-missing', blocking: true, detail: 'The summary says tests were added or updated, but no test file changed.' });
  return { ok: !findings.some((f) => f.blocking), findings };
}
export const claimsFeedback = (c) => `Your change does not match what it should be doing. Fix this, do not just explain it:\n${c.findings.filter((f) => f.blocking).map((f) => `- ${f.detail}`).join('\n')}\nIf a test genuinely has to change, change it so it still checks the behaviour, and say why in your summary. Never switch a test off or delete it to make a run pass.`;
