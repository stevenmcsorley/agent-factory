import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PROTECTED = ['.github/', '.agent-factory.json', '.gitlab-ci.yml', 'Jenkinsfile'];

// Repo-level overrides live in the repo itself (.agent-factory.json): { verify, image, maxAttempts, timeoutMs, protectedPaths }.
// IMPORTANT: it is read from the freshly cloned default branch BEFORE the agent runs, so an agent/ticket cannot rewrite its own rules.
export function loadRepoConfig(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.agent-factory.json'), 'utf8')); } catch { return {}; }
}

// Best-effort guess of how to run a repo's tests. Returns { verify, image? } or null. An explicit config always wins.
export function detectVerify(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  if (has('package.json')) {
    let scripts = {}; try { scripts = JSON.parse(read('package.json')).scripts ?? {}; } catch { /* ignore */ }
    if (scripts.test && !/no test specified/.test(scripts.test))
      return { verify: has('package-lock.json') ? 'npm ci --no-audit --no-fund && npm test' : 'npm test', image: 'node:22-bookworm' };
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('requirements.txt') || has('setup.py'))
    return { verify: `${has('requirements.txt') ? 'pip install -q -r requirements.txt && ' : ''}python -m pytest -q`, image: 'python:3.12-bookworm' };
  if (has('go.mod')) return { verify: 'go test ./...', image: 'golang:1.23-bookworm' };
  if (has('Cargo.toml')) return { verify: 'cargo test', image: 'rust:1-bookworm' };
  if (/^test:/m.test(read('Makefile'))) return { verify: 'make test' };
  return null;
}

// Paths changed in the working tree (from `git status --porcelain` output) that fall under a protected prefix.
export function protectedViolations(porcelain, protectedPaths = DEFAULT_PROTECTED) {
  return porcelain.split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, '').trim().replace(/^"|"$/g, '').split(' -> ').pop())
    .filter((f) => protectedPaths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}
