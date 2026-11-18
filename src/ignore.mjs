// Which files the analysis (and the quality gate on the agent's change) should skip. Lock files, minified or generated code, snapshots and build
// output are always long and never interesting, so they are ignored by default; you can add your own patterns (gitignore-style, simplified).
//   name.ext      any file or folder with that name, at any depth      (package-lock.json, *.min.js, fixtures)
//   dir/          a folder, at any depth                               (generated/)
//   a/b/c , /a    anchored to the repository root                      (docs/api/*.md, /legacy)
//   *  ?  **      any characters except / ; one character ; anything including /
// Anything ignored is skipped entirely: no lines counted, no findings, no copies, no secrets scan.
export const DEFAULT_IGNORE = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'uv.lock', 'flake.lock', '*.lock',
  '*.min.js', '*.min.css', '*.map', '*.bundle.js', '*.generated.*', '*.pb.go', '*_pb2.py', '*.snap', '__snapshots__/',
  'dist/', 'build/', 'out/', 'coverage/', '.next/', '.nuxt/', '.cache/', 'target/', 'vendor/', 'node_modules/', '.venv/', 'venv/', '__pycache__/',
  '*.svg', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.woff', '*.woff2', '*.ttf', '*.pdf', '*.zip',
];
const MAX_PATTERNS = 60, MAX_LEN = 120, SAFE = /^[\w .\/*?@+\-[\]]+$/;

// Returns only usable patterns (and says why others were dropped), so a typo can never break an analysis or smuggle in regex syntax.
export function cleanPatterns(list) {
  const out = [], dropped = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const p = String(raw ?? '').trim().replace(/^\.\//, '');
    if (!p || p.startsWith('#')) continue;
    if (p.length > MAX_LEN || !SAFE.test(p) || p.includes('..') || p.startsWith('!') || (p.match(/\*/g) ?? []).length > 6) { dropped.push(String(raw).slice(0, 60)); continue; }
    if (out.length < MAX_PATTERNS && !out.includes(p)) out.push(p);
  }
  return { patterns: out, dropped };
}

export function globToRegExp(pattern) {
  const dirOnly = pattern.endsWith('/'); let p = dirOnly ? pattern.slice(0, -1) : pattern;
  const anchored = p.startsWith('/') || p.includes('/'); p = p.replace(/^\//, '');
  const body = p.replace(/\*\*+/g, '\0').replace(/[.+^${}()|\\[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}(?:/|$)`, dirOnly ? 'i' : 'i');
}

// matcher.test(relPath) -> null | 'default' | 'yours'
export function makeIgnore({ patterns = [], useDefaults = true } = {}) {
  const compile = (list) => cleanPatterns(list).patterns.map((p) => ({ p, re: globToRegExp(p) }));
  const defaults = useDefaults ? compile(DEFAULT_IGNORE) : []; const yours = compile(patterns);
  return { yours: yours.map((x) => x.p), useDefaults, test(rel) { const r = String(rel).replace(/\\/g, '/'); for (const { re } of yours) if (re.test(r)) return 'yours'; for (const { re } of defaults) if (re.test(r)) return 'default'; return null; } };
}
