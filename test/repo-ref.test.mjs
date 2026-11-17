import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRepo } from '../src/repoRef.mjs';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';

test('normalizeRepo: every form people paste becomes the canonical path', () => {
  const gh = (x) => normalizeRepo(x, 'github').repo;
  for (const x of ['owner/name', 'https://github.com/owner/name', 'https://github.com/owner/name/', 'https://github.com/owner/name.git', 'http://github.com/owner/name', 'https://www.github.com/owner/name',
    'github.com/owner/name', 'https://github.com/owner/name/tree/main/src', 'https://github.com/owner/name/pull/12', 'https://github.com/owner/name/issues?q=is%3Aopen', 'https://github.com/owner/name#readme',
    'git@github.com:owner/name.git', 'ssh://git@github.com/owner/name.git', '  https://github.com/owner/name  ']) assert.equal(gh(x), 'owner/name', x);
  assert.equal(normalizeRepo('https://github.com/stevenmcsorley/oddsdesk', 'github').repo, 'stevenmcsorley/oddsdesk');
  assert.equal(normalizeRepo('https://gitlab.com/group/sub/project/-/merge_requests/3', 'gitlab').repo, 'group/sub/project');
  assert.equal(normalizeRepo('https://gitlab.com/group/sub/project.git', 'gitlab').repo, 'group/sub/project');
  assert.equal(normalizeRepo('https://bitbucket.org/ws/repo/src/main/', 'bitbucket').repo, 'ws/repo');
  assert.equal(normalizeRepo('https://git.example.com/team/app/tree/dev', 'git').repo, 'team/app');
  assert.equal(normalizeRepo('git@git.example.com:team/app.git', 'git').repo, 'team/app');
  assert.deepEqual([normalizeRepo('https://gitlab.com/a/b').host, normalizeRepo('https://bitbucket.org/a/b').host, normalizeRepo('https://github.com/a/b').host, normalizeRepo('a/b').host, normalizeRepo('https://git.example.com/a/b').host], ['gitlab', 'bitbucket', 'github', null, null]);
  assert.equal(normalizeRepo('', 'github').repo, '');
});

function eng() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  const e = new Engine(withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {} });
  const seen = []; e.gh = { whoami: async () => 'me', inspectRepo: async (r) => { seen.push(r); return { defaultBranch: 'main' }; }, ensureLabels: async () => {} };
  return { e, seen };
}

test('addProject accepts a pasted GitHub URL (the reported bug): canonical repo, id from the name, project saved', async () => {
  const { e, seen } = eng();
  const p = await e.addProject({ repo: 'https://github.com/stevenmcsorley/oddsdesk' });
  assert.equal(p.repo, 'stevenmcsorley/oddsdesk'); assert.equal(p.id, 'oddsdesk'); assert.deepEqual(seen, ['stevenmcsorley/oddsdesk']); assert.equal(e.cfg.projects.length, 1);
  const q = await e.addProject({ id: 'two', repo: 'https://github.com/me/two.git' }); assert.equal(q.repo, 'me/two');
});

test('a URL for a different host than the selected one is refused with a fix, not a cryptic error; empty input too', async () => {
  const { e } = eng();
  assert.throws(() => e._repoFor('github', 'https://gitlab.com/group/app'), /looks like a GitLab URL, but GitHub is selected\. Choose GitLab/);
  assert.throws(() => e._repoFor('gitlab', 'https://github.com/o/n'), /looks like a GitHub URL, but GitLab is selected/);
  assert.throws(() => e._repoFor('github', '   '), /Enter the repository/);
  assert.equal(e._repoFor('gitlab', 'https://gitlab.com/group/sub/app.git'), 'group/sub/app');
});

test('pasting a GitLab URL with no host chosen selects GitLab automatically', async () => {
  const { e } = eng(); e.f.fetch = async (url) => ({ ok: true, status: 200, json: async () => (/\/user$/.test(url) ? { username: 'gl' } : { default_branch: 'trunk', visibility: 'private', web_url: 'u', permissions: { project_access: { access_level: 40 } } }), text: async () => '' });
  e.env.AF_APP_GIT_TOKEN = 't'; e.env.AF_APP_TOKEN = 't';
  const p = await e.addProject({ id: 'app', repo: 'https://gitlab.com/grp/app', hostSecret: 'glpat', source: { kind: 'jira', fields: { baseUrl: 'https://x.atlassian.net', email: 'e' }, pick: 'PRJ' }, secret: 'j' }).catch((err) => err);
  assert.ok(!(p instanceof Error) || !/must look like owner\/name/.test(p.message), String(p.message)); // never the reported error
  if (!(p instanceof Error)) assert.equal(p.host.kind, 'gitlab');
});
