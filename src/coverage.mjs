// Which of the changed files does the project's test command actually exercise? A project has one verify command, and in a
// monorepo it often runs in one folder only (for example `cd frontend && npm ci && npm test`). A change that also touches
// `backend/` passes that command without the backend being tested, and the PR looks "verified". This names those files so the
// PR can say so. It is deliberately a heuristic about the command text, not a coverage tool: it only speaks up when the command
// clearly runs inside specific folders, and says nothing when it runs from the repo root.
const DIR = String.raw`(?:\./)?([\w.@-][\w./@-]*)`;
const NOT_CODE = /(^|\/)(docs?|\.github|\.vscode|\.idea)\/|\.(md|mdx|txt|rst)$|(^|\/)(LICENSE|CHANGELOG|README|\.gitignore|\.editorconfig)[^/]*$/i;

// The folders a command runs in: `cd X`, `--prefix X`, `-C X`, `--workspace X`/`-w X` style folder arguments.
export function verifyScopes(cmd) {
  const scopes = new Set(); const text = String(cmd ?? '');
  // A command that walks back out of a folder (`cd ..`, `cd ../x`, `cd -`, `popd`) runs things in several places, including the repo root. We cannot
  // tell which later step runs where, so say nothing rather than claim the tests only cover one folder (seen on a real command: `cd frontend && ... && cd .. && python manage.py test`).
  if (/(?:^|[;&|(]\s*|&&\s*)(?:cd\s+(?:\.\.|-)(?:\/|\s|$|;|&)|popd\b)/.test(text)) return [];
  for (const re of [new RegExp(String.raw`(?:^|[;&|(]\s*|&&\s*)cd\s+${DIR}`, 'g'), new RegExp(String.raw`--prefix[= ]\s*${DIR}`, 'g'), new RegExp(String.raw`(?:^|\s)-C\s+${DIR}`, 'g')])
    for (const m of text.matchAll(re)) { const d = m[1].replace(/\/+$/, ''); if (d && d !== '.' && !d.startsWith('..') && !d.startsWith('/') && !d.startsWith('$')) scopes.add(d); }
  return [...scopes];
}

// Returns null when everything changed is covered (or the command runs from the root), else { scopes, uncovered }.
export function coverageGap(verifyCmd, changed) {
  const scopes = verifyScopes(verifyCmd); if (!scopes.length) return null;
  const uncovered = (changed ?? []).map(String).filter((f) => !NOT_CODE.test(f) && !scopes.some((s) => f === s || f.startsWith(`${s}/`)));
  return uncovered.length ? { scopes, uncovered: uncovered.slice(0, 20), total: uncovered.length } : null;
}
