import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.mjs';
import { AGENT_LABELS } from './config.mjs';

const gh = async (args, opts) => { const r = await run('gh', args, opts); if (r.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${r.out.trim().slice(0, 300)}`); return r.out; };

export const whoami = async () => (await gh(['api', 'user', '-q', '.login'])).trim();

// Verify the signed-in user can read AND write the repo, and learn its default branch.
export async function inspectRepo(repo) {
  const j = JSON.parse(await gh(['repo', 'view', repo, '--json', 'defaultBranchRef,viewerPermission,isPrivate,url']));
  if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(j.viewerPermission)) throw new Error(`gh user has ${j.viewerPermission} permission on ${repo}; WRITE is needed to push branches and open PRs`);
  return { defaultBranch: j.defaultBranchRef?.name ?? 'main', private: j.isPrivate, url: j.url };
}

export async function ensureLabels(repo) {
  for (const l of AGENT_LABELS) await gh(['label', 'create', l, '-R', repo, '--force']);
}

const TEMPLATES = {
  blank: { 'README.md': (n, d) => `# ${n}\n\n${d}\n` },
  node: {
    'README.md': (n, d) => `# ${n}\n\n${d}\n\n\`npm test\` runs the tests.\n`,
    'package.json': (n) => JSON.stringify({ name: n, version: '0.0.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    '.gitignore': () => 'node_modules/\n',
    'index.test.js': () => "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('placeholder', () => assert.equal(1 + 1, 2));\n",
  },
  python: {
    'README.md': (n, d) => `# ${n}\n\n${d}\n\n\`python -m pytest\` runs the tests.\n`,
    'pyproject.toml': (n) => `[project]\nname = "${n}"\nversion = "0.0.0"\n`,
    'tests/test_placeholder.py': () => 'def test_placeholder():\n    assert 1 + 1 == 2\n',
    '.gitignore': () => '__pycache__/\n.venv/\n',
  },
};
export const templateNames = () => Object.keys(TEMPLATES);

// Create a NEW GitHub repo from a starter template, wire it up for the factory, and queue the first ticket.
// Returns { repo, url, defaultBranch }. Nothing is deleted or overwritten; fails if the repo already exists.
export async function createProjectRepo({ owner, name, description = '', visibility = 'private', template = 'node', identity }) {
  if (!/^[\w.-]+$/.test(name)) throw new Error('Repository name may only contain letters, numbers, dots, dashes and underscores');
  if (!TEMPLATES[template]) throw new Error(`Unknown template "${template}"`);
  if (!['private', 'public'].includes(visibility)) throw new Error('visibility must be private or public');
  const repo = `${owner}/${name}`;
  await gh(['repo', 'create', repo, `--${visibility}`, '--description', description.slice(0, 200)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-new-'));
  try {
    await gh(['repo', 'clone', repo, dir]);
    for (const [file, make] of Object.entries(TEMPLATES[template])) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), make(name, description));
    }
    const g = (...a) => run('git', ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, ...a], { cwd: dir });
    await g('checkout', '-B', 'main'); await g('add', '-A');
    const c = await g('commit', '-m', 'Initial project scaffold (agent-factory)'); if (c.code !== 0) throw new Error(`commit failed: ${c.out}`);
    const p = await g('push', '-u', 'origin', 'main'); if (p.code !== 0) throw new Error(`push failed: ${p.out}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  await ensureLabels(repo);
  return { repo, url: `https://github.com/${repo}`, defaultBranch: 'main' };
}
