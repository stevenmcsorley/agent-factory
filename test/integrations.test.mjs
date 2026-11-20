import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBaseUrl, TOKEN_ENV, ossiconeSignupInfo } from '../src/sources.mjs';
import { jiraTickets, adfToText } from '../src/adapters/tickets-jira.mjs';
import { linearTickets } from '../src/adapters/tickets-linear.mjs';
import { gitlabHost } from '../src/adapters/host-gitlab.mjs';
import { bitbucketHost } from '../src/adapters/host-bitbucket.mjs';
import { gitHost } from '../src/adapters/host-git.mjs';
import { gitAuthEnv } from '../src/gitauth.mjs';
import { validateConfig, withDefaults } from '../src/config.mjs';
import { Engine } from '../src/engine.mjs';
import { createServer, hostsFor } from '../src/server.mjs';

const res = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
// Fake HTTP: routes = [[ 'METHOD /path-regex', (req) => response ]]; every request is logged.
function fake(routes) {
  const log = [];
  const f = async (url, init = {}) => {
    const u = new URL(url); const method = init.method ?? 'GET'; const req = { method, path: u.pathname, search: u.search, headers: init.headers ?? {}, body: init.body && typeof init.body === 'string' ? (init.body.startsWith('{') ? JSON.parse(init.body) : init.body) : undefined };
    log.push(req);
    for (const [pat, fn] of routes) { const [m, re] = pat.split(' '); if (m === method && new RegExp(`^${re}$`).test(u.pathname)) return fn(req) ?? res(200, {}); }
    return res(404, { error: `no route ${method} ${u.pathname}` });
  };
  f.log = log; return f;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'it-'));

test('checkBaseUrl: https only (http for localhost/private), no creds, no metadata/link-local', () => {
  assert.equal(checkBaseUrl('https://team.atlassian.net/'), 'https://team.atlassian.net');
  assert.equal(checkBaseUrl('http://localhost:4000'), 'http://localhost:4000'); assert.equal(checkBaseUrl('http://192.168.1.5:8080/jira'), 'http://192.168.1.5:8080/jira');
  for (const bad of ['http://jira.example.com', 'https://u:p@x.com', 'https://169.254.169.254/latest', 'http://metadata.google.internal', 'ftp://x.com', 'not a url']) assert.throws(() => checkBaseUrl(bad), undefined, bad);
});

test('token env names are confined to AF_* so a project can never read arbitrary process env', () => {
  assert.ok(TOKEN_ENV.test('AF_MYAPP_TOKEN')); for (const bad of ['AWS_SECRET_ACCESS_KEY', 'PATH', 'af_lower', 'AF_', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.ok(!TOKEN_ENV.test(bad), bad);
});

test('adfToText flattens Atlassian Document Format', () => {
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'hardBreak' }, { type: 'text', text: 'world' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }] }).trim(), 'Hello\nworld\nSecond');
  assert.equal(adfToText('plain'), 'plain'); assert.equal(adfToText(null), '');
});

const jiraIssue = (key, o = {}) => ({ key, fields: { summary: `T ${key}`, description: o.description ?? 'Do the thing', labels: o.labels ?? ['agent-ready'], reporter: o.reporter ?? { accountId: 'acc1', displayName: 'Me' }, status: { statusCategory: { key: o.done ? 'done' : 'new' } }, updated: '2026-01-01T00:00:00Z' } });

test('Jira Cloud: queries the enhanced-search endpoint, trusts only allowed reporters, handles ADF, uses Basic auth', async () => {
  const f = fake([['POST /rest/api/2/search/jql', () => res(200, { issues: [jiraIssue('PRJ-1'), jiraIssue('PRJ-2', { reporter: { accountId: 'stranger' } }), jiraIssue('PRJ-3', { labels: ['agent-ready', 'agent-working'] }), jiraIssue('PRJ-4', { description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ADF body' }] }] } })] })]]);
  const t = jiraTickets({ baseUrl: 'https://x.atlassian.net', projectKey: 'PRJ', email: 'me@x.com', token: 'tok', allowedReporters: ['acc1'], fetchImpl: f });
  const got = await t.poll();
  assert.deepEqual(got.map((x) => x.id), ['PRJ-1', 'PRJ-4']); assert.equal(got[1].body, 'ADF body'); assert.equal(got[0].url, 'https://x.atlassian.net/browse/PRJ-1');
  assert.match(f.log[0].body.jql, /project = "PRJ" AND labels = "agent-ready" AND statusCategory != Done/);
  assert.equal(f.log[0].headers.Authorization, `Basic ${Buffer.from('me@x.com:tok').toString('base64')}`);
});

test('Jira Cloud falls back to v3 search when v2 enhanced search 404s; Data Center uses /search with a bearer token', async () => {
  const f = fake([['POST /rest/api/2/search/jql', () => res(404, 'nope')], ['POST /rest/api/3/search/jql', () => res(200, { issues: [jiraIssue('PRJ-1')] })]]);
  assert.equal((await jiraTickets({ baseUrl: 'https://x.atlassian.net', projectKey: 'PRJ', email: 'e', token: 't', allowedReporters: ['acc1'], fetchImpl: f }).poll()).length, 1);
  const dc = fake([['POST /rest/api/2/search', () => res(200, { issues: [jiraIssue('PRJ-9', { reporter: { name: 'jdoe' } })] })]]);
  const t = jiraTickets({ baseUrl: 'https://jira.corp.example', projectKey: 'PRJ', flavor: 'datacenter', token: 'pat', allowedReporters: ['jdoe'], fetchImpl: dc });
  assert.deepEqual((await t.poll()).map((x) => x.id), ['PRJ-9']); assert.equal(dc.log[0].headers.Authorization, 'Bearer pat');
});

test('Jira writes: label add/remove in one atomic update, optional status transition, comment, create; keys are validated', async () => {
  const f = fake([['PUT /rest/api/2/issue/PRJ-1', () => res(204, '')], ['GET /rest/api/2/issue/PRJ-1/transitions', () => res(200, { transitions: [{ id: '31', name: 'Start', to: { name: 'In Progress' } }] })],
    ['POST /rest/api/2/issue/PRJ-1/transitions', () => res(204, '')], ['POST /rest/api/2/issue/PRJ-1/comment', () => res(201, {})], ['POST /rest/api/2/issue', () => res(201, { key: 'PRJ-7' })]]);
  const t = jiraTickets({ baseUrl: 'https://x.atlassian.net', projectKey: 'PRJ', email: 'e', token: 't', allowedReporters: ['a'], statuses: { working: 'In Progress' }, fetchImpl: f });
  await t.label('PRJ-1', ['agent-working'], ['agent-ready']);
  assert.deepEqual(f.log[0].body, { update: { labels: [{ remove: 'agent-ready' }, { add: 'agent-working' }] } });
  assert.deepEqual(f.log.at(-1).body, { transition: { id: '31' } });
  await t.comment('PRJ-1', 'hello'); assert.equal(f.log.at(-1).body.body, 'hello');
  const made = await t.create({ title: 'New', body: 'B' }); assert.equal(made.id, 'PRJ-7');
  assert.deepEqual(f.log.at(-1).body.fields, { project: { key: 'PRJ' }, summary: 'New', description: 'B', issuetype: { name: 'Task' }, labels: ['agent-ready'] });
  await assert.rejects(t.label('PRJ-1/../../secret', ['x']), /Invalid Jira issue key/);
  assert.throws(() => jiraTickets({ baseUrl: 'https://x', projectKey: 'bad key"', token: 't' }), /projectKey/);
});

test('Jira identify lists the user and projects (Cloud paginated endpoint)', async () => {
  const f = fake([['GET /rest/api/2/myself', () => res(200, { accountId: 'acc1', displayName: 'Me', emailAddress: 'me@x.com' })], ['GET /rest/api/2/project/search', () => res(200, { values: [{ key: 'PRJ', name: 'Proj' }] })]]);
  const id = await jiraTickets({ baseUrl: 'https://x.atlassian.net', projectKey: 'PRJ', email: 'e', token: 't', fetchImpl: f }).identify();
  assert.deepEqual(id.projects, [{ id: 'PRJ', name: 'Proj (PRJ)' }]); assert.deepEqual(id.user.alsoMatches, ['acc1', 'me@x.com']);
});

const lin = (id, o = {}) => ({ id: `uuid-${id}`, identifier: id, title: `T ${id}`, description: 'd', url: `https://linear.app/x/issue/${id}`, updatedAt: 'T', creator: { id: o.creator ?? 'u1' }, labels: { nodes: (o.labels ?? ['agent-ready']).map((n) => ({ id: `l-${n}`, name: n })) }, state: { name: 'Todo', type: o.type ?? 'unstarted' } });
function linearFake(extra = {}) {
  const calls = [];
  const f = async (url, init) => { const { query, variables } = JSON.parse(init.body); calls.push({ query, variables, auth: init.headers.Authorization });
    const data = query.includes('issues(filter') ? { issues: { nodes: [lin('E-1'), lin('E-2', { creator: 'stranger' }), lin('E-3', { type: 'completed' }), lin('E-4', { labels: ['agent-ready', 'agent-working'] })] } }
      : query.includes('issueLabels(') ? { issueLabels: { nodes: [{ id: 'l-agent-ready', name: 'agent-ready' }] } }
      : query.includes('issueLabelCreate') ? { issueLabelCreate: { success: true, issueLabel: { id: `new-${variables.i.name}`, name: variables.i.name } } }
      : query.includes('issue(id') ? { issue: { id: 'uuid-E-1', identifier: 'E-1', labels: { nodes: [{ id: 'l-agent-ready', name: 'agent-ready' }, { id: 'l-bug', name: 'bug' }] } } }
      : query.includes('issueUpdate') ? { issueUpdate: { success: true } } : query.includes('commentCreate') ? { commentCreate: { success: true } }
      : query.includes('issueCreate') ? { issueCreate: { success: true, issue: { identifier: 'E-9', url: 'https://linear.app/x/issue/E-9' } } }
      : query.includes('viewer') ? { viewer: { id: 'u1', name: 'Me', email: 'me@x.com' }, teams: { nodes: [{ id: 'team1', key: 'E', name: 'Eng' }] } } : null;
    return data ? res(200, { data }) : res(200, { errors: [{ message: 'boom' }] }); };
  f.calls = calls; return f;
}

test('Linear: raw API key header, team filter, only trusted creators, open + labelled issues', async () => {
  const f = linearFake(); const t = linearTickets({ teamId: 'team1', token: 'lin_key', allowedCreatorIds: ['u1'], fetchImpl: f });
  assert.deepEqual((await t.poll()).map((x) => x.id), ['E-1']);
  assert.equal(f.calls[0].auth, 'lin_key'); assert.equal(f.calls[0].variables.t, 'team1');
  assert.deepEqual((await t.listWorking()).map((x) => x.id), ['E-4']);
  assert.deepEqual((await t.listAgentTickets()).map((x) => [x.id, x.state]), [['E-1', 'OPEN'], ['E-3', 'CLOSED'], ['E-4', 'OPEN']]);
});

test('Linear label update keeps other labels, creates missing agent-* labels, comments by uuid, creates issues', async () => {
  const f = linearFake(); const t = linearTickets({ teamId: 'team1', token: 'k', allowedCreatorIds: ['u1'], fetchImpl: f });
  await t.label('E-1', ['agent-working'], ['agent-ready']);
  const upd = f.calls.find((c) => c.query.includes('issueUpdate')); assert.deepEqual(upd.variables.l.sort(), ['l-bug', 'new-agent-working']); assert.equal(upd.variables.id, 'uuid-E-1');
  await t.comment('E-1', 'hi'); assert.equal(f.calls.at(-1).variables.i.issueId, 'uuid-E-1');
  assert.deepEqual(await t.create({ title: 'x', body: 'y' }), { id: 'E-9', url: 'https://linear.app/x/issue/E-9' });
  const id = await t.identify(); assert.deepEqual(id.projects, [{ id: 'team1', name: 'Eng (E)' }]); assert.equal(id.user.id, 'u1');
  await assert.rejects(linearTickets({ teamId: 't', token: 'k', fetchImpl: async () => res(200, { errors: [{ message: 'Bad token' }] }) }).poll(), /Bad token/);
});

test('gitAuthEnv scopes the credential to one origin and keeps it out of argv', () => {
  const e = gitAuthEnv('https://gitlab.com', 'oauth2', 's3cret');
  assert.equal(e.GIT_CONFIG_KEY_0, 'http.https://gitlab.com/.extraHeader'); assert.equal(e.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from('oauth2:s3cret').toString('base64')}`);
  assert.deepEqual(gitAuthEnv('https://x', 'u', ''), {});
});

test('GitLab host: permission check, draft MR, agent MR listing, CI logs + trusted comments only', async () => {
  const f = fake([
    ['GET /api/v4/projects/grp%2Fsub%2Fapp', (r) => res(200, { default_branch: 'main', visibility: 'private', web_url: 'u', permissions: { project_access: { access_level: r.headers['PRIVATE-TOKEN'] === 'low' ? 20 : 40 } } })],
    ['GET /api/v4/user', () => res(200, { username: 'me' })],
    ['POST /api/v4/projects/grp%2Fsub%2Fapp/merge_requests', () => res(201, { web_url: 'https://gitlab.com/grp/sub/app/-/merge_requests/5' })],
    ['GET /api/v4/projects/grp%2Fsub%2Fapp/merge_requests', () => res(200, [{ iid: 5, title: 'Draft: T', source_branch: 'agent/1-x', sha: 'abc' }, { iid: 6, title: 'human', source_branch: 'feat', sha: 'z' }])],
    ['GET /api/v4/projects/grp%2Fsub%2Fapp/merge_requests/5/pipelines', () => res(200, [{ id: 77, status: 'failed' }])],
    ['GET /api/v4/projects/grp%2Fsub%2Fapp/pipelines/77/jobs', () => res(200, [{ id: 900, name: 'test' }])],
    ['GET /api/v4/projects/grp%2Fsub%2Fapp/jobs/900/trace', () => res(200, 'FAIL: expected 2 got 3')],
    ['GET /api/v4/projects/grp%2Fsub%2Fapp/merge_requests/5/notes', () => res(200, [{ id: 1, body: 'fix this', system: false, author: { username: 'me' } }, { id: 2, body: 'x', system: false, author: { username: 'stranger' } }, { id: 3, body: 'added label', system: true, author: { username: 'me' } }, { id: 4, body: 'bot <!-- agent-factory -->', system: false, author: { username: 'me' } }])],
    ['POST /api/v4/projects/grp%2Fsub%2Fapp/merge_requests/5/notes', () => res(201, {})], ['PUT /api/v4/projects/grp%2Fsub%2Fapp/merge_requests/5', () => res(200, {})],
  ]);
  const h = gitlabHost({ repo: 'grp/sub/app', token: 'tok', allowedAuthors: ['me'], fetchImpl: f });
  assert.equal(h.cloneUrl(), 'https://gitlab.com/grp/sub/app.git'); assert.equal((await h.inspectRepo()).defaultBranch, 'main');
  await assert.rejects(gitlabHost({ repo: 'grp/sub/app', token: 'low', fetchImpl: f }).inspectRepo(), /Developer/);
  assert.equal(await h.openPr({ branch: 'agent/1-x', base: 'main', title: 'T', body: 'b' }), 'https://gitlab.com/grp/sub/app/-/merge_requests/5');
  assert.deepEqual(f.log.find((r) => r.method === 'POST' && /merge_requests$/.test(r.path)).body, { source_branch: 'agent/1-x', target_branch: 'main', title: 'Draft: T', description: 'b' });
  assert.deepEqual(await h.pr.listAgentPrs(), [{ number: 5, branch: 'agent/1-x', sha: 'abc', title: 'T' }]);
  const fb = await h.pr.getFeedback({ number: 5 });
  assert.deepEqual(fb.failedChecks, [{ name: 'test', log: 'FAIL: expected 2 got 3' }]); assert.equal(fb.pending, false); assert.deepEqual(fb.comments.map((c) => c.id), ['n1']);
  await h.pr.comment({ number: 5 }, 'hi'); assert.match(f.log.at(-1).body.body, /agent-factory/); await h.pr.label({ number: 5 }, 'agent-needs-human'); assert.equal(f.log.at(-1).body.add_labels, 'agent-needs-human');
  assert.equal(f.log[0].headers['PRIVATE-TOKEN'], 'tok');
});

test('Bitbucket host: write permission check, [Draft] PR, statuses, trusted comments, label is a safe no-op', async () => {
  const f = fake([
    ['GET /2.0/repositories/ws/app', () => res(200, { mainbranch: { name: 'develop' }, is_private: true, links: { html: { href: 'u' } } })],
    ['GET /2.0/user/permissions/repositories', (r) => res(200, { values: [{ permission: decodeURIComponent(r.search).includes('ws/app') ? 'write' : 'read' }] })],
    ['GET /2.0/user', () => res(200, { nickname: 'me' })],
    ['POST /2.0/repositories/ws/app/pullrequests', () => res(201, { links: { html: { href: 'https://bitbucket.org/ws/app/pull-requests/3' } } })],
    ['GET /2.0/repositories/ws/app/pullrequests', () => res(200, { values: [{ id: 3, title: '[Draft] T', source: { branch: { name: 'agent/2-y' }, commit: { hash: 'h' } } }, { id: 4, title: 'x', source: { branch: { name: 'main2' } } }] })],
    ['GET /2.0/repositories/ws/app/pullrequests/3/statuses', () => res(200, { values: [{ state: 'FAILED', name: 'build', description: 'tests failed', url: 'https://b/1' }, { state: 'SUCCESSFUL', name: 'lint' }] })],
    ['GET /2.0/repositories/ws/app/pullrequests/3/comments', () => res(200, { values: [{ id: 1, content: { raw: 'please fix' }, user: { nickname: 'me' } }, { id: 2, content: { raw: 'spam' }, user: { nickname: 'other' } }, { id: 3, content: { raw: 'gone' }, deleted: true, user: { nickname: 'me' } }, { id: 4, content: { raw: 'inline' }, inline: { path: 'a.js', to: 4 }, user: { nickname: 'me' } }] })],
    ['POST /2.0/repositories/ws/app/pullrequests/3/comments', () => res(201, {})],
  ]);
  const h = bitbucketHost({ repo: 'ws/app', username: 'me', token: 'apw', allowedAuthors: ['me'], fetchImpl: f });
  assert.equal((await h.inspectRepo()).defaultBranch, 'develop'); assert.equal(f.log[0].headers.Authorization, `Basic ${Buffer.from('me:apw').toString('base64')}`);
  assert.equal(await h.openPr({ branch: 'agent/2-y', base: 'develop', title: 'T', body: 'b' }), 'https://bitbucket.org/ws/app/pull-requests/3');
  assert.equal(f.log.find((r) => r.method === 'POST').body.title, '[Draft] T');
  assert.deepEqual(await h.pr.listAgentPrs(), [{ number: 3, branch: 'agent/2-y', sha: 'h', title: 'T' }]);
  const fb = await h.pr.getFeedback({ number: 3 });
  assert.equal(fb.failedChecks.length, 1); assert.match(fb.failedChecks[0].log, /tests failed/); assert.deepEqual(fb.comments.map((c) => c.id), ['c1', 'c4']); assert.match(fb.comments[1].body, /a\.js:4/);
  const before = f.log.length; await h.pr.label({ number: 3 }, 'x'); assert.equal(f.log.length, before);
});

test('plain git host: URL template, read-access check parses the default branch, auth only for https+token, no PR loop', async () => {
  const exec = async (cmd, args) => (args[0] === 'ls-remote' ? { code: 0, out: 'ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n' } : { code: 1, out: '' });
  const h = gitHost({ remoteTemplate: 'https://git.example.com/{repo}.git', repo: 'team/app', username: 'bot', token: 'pw', exec });
  assert.equal(h.cloneUrl(), 'https://git.example.com/team/app.git'); assert.equal((await h.inspectRepo()).defaultBranch, 'trunk');
  assert.match(h.gitEnv().GIT_CONFIG_KEY_0, /git\.example\.com/); assert.deepEqual(gitHost({ remoteTemplate: 'git@git.example.com:{repo}.git', repo: 'a/b', token: 'x', exec }).gitEnv(), {});
  assert.equal(await h.openPr({}), null); assert.deepEqual(await h.pr.listAgentPrs(), []);
  await assert.rejects(gitHost({ remoteTemplate: 'https://x/{repo}.git', repo: 'a/b', exec: async () => ({ code: 128, out: 'fatal: not found' }) }).inspectRepo(), /Cannot read/);
});

const project = (o = {}) => ({ id: 'app', repo: 'me/app', base: 'main', tickets: { kind: 'github', allowedAuthors: ['me'] }, ...o });
const cfgWith = (p) => withDefaults({ agent: { kind: 'codexContainer', codexHome: '/x' }, projects: [p] });

test('config validation across the ticket-source × code-host matrix', () => {
  const v = (p) => validateConfig(cfgWith(p)).join(' | ');
  assert.equal(v(project()), '');
  assert.match(v(project({ host: { kind: 'gitlab', tokenEnv: 'AF_APP_GIT_TOKEN' } })), /GitHub Issues can only be used with a GitHub repository/);
  const jiraOnGitlab = project({ repo: 'grp/sub/app', host: { kind: 'gitlab', tokenEnv: 'AF_APP_GIT_TOKEN' }, feedbackAuthors: ['me'], tickets: { kind: 'jira', baseUrl: 'https://x.atlassian.net', projectKey: 'PRJ', email: 'e@x.com', tokenEnv: 'AF_APP_TOKEN', allowedReporters: ['a'] } });
  assert.equal(v(jiraOnGitlab), '');
  assert.match(v({ ...jiraOnGitlab, tickets: { ...jiraOnGitlab.tickets, email: undefined } }), /email is required/);
  assert.match(v({ ...jiraOnGitlab, tickets: { ...jiraOnGitlab.tickets, tokenEnv: 'AWS_SECRET_ACCESS_KEY' } }), /tokenEnv must be an environment variable NAME/);
  assert.match(v({ ...jiraOnGitlab, feedbackAuthors: [] }), /feedbackAuthors/);
  assert.match(v(project({ repo: 'a/b/c' })), /must look like owner\/name/);
  assert.match(v({ ...jiraOnGitlab, host: { kind: 'bitbucket', tokenEnv: 'AF_APP_GIT_TOKEN' }, repo: 'ws/app' }), /username is required/);
  assert.match(v({ ...jiraOnGitlab, host: { kind: 'git', remoteTemplate: 'https://user:pw@git.example.com/{repo}.git' }, feedbackAuthors: undefined }), /no credentials/);
  assert.equal(v({ ...jiraOnGitlab, repo: 'team/app', host: { kind: 'git', remoteTemplate: 'git@git.example.com:{repo}.git' }, feedbackAuthors: undefined }), '');
  assert.match(v(project({ tickets: { kind: 'trello' } })), /not supported/); assert.match(v(project({ host: { kind: 'svn' } })), /not supported/);
});

function engineWith(f) {
  const root = tmp();
  const e = new Engine(withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { fetch: f } });
  e.gh = { whoami: async () => 'ghuser', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  return { e, root };
}
const jiraGitlabRoutes = (over = {}) => fake([
  ['GET /rest/api/2/myself', over.myself ?? (() => res(200, { accountId: 'acc1', displayName: 'Me', emailAddress: 'me@x.com' }))], ['GET /rest/api/2/project/search', () => res(200, { values: [{ key: 'PROJ', name: 'P' }] })],
  ['GET /api/v4/projects/grp%2Fapp', () => res(200, { default_branch: 'trunk', visibility: 'private', web_url: 'u', permissions: { project_access: { access_level: 40 } } })], ['GET /api/v4/user', () => res(200, { username: 'gluser' })]]);

test('addProject: Jira tickets + GitLab code, tokens verified first, stored only in the 0600 secrets file, never in the config', async () => {
  const { e, root } = engineWith(jiraGitlabRoutes());
  const p = await e.addProject({ id: 'shop', repo: 'grp/app', host: { kind: 'gitlab' }, hostSecret: 'GL-SECRET-123', source: { kind: 'jira', fields: { baseUrl: 'https://x.atlassian.net', flavor: 'cloud', email: 'me@x.com' }, pick: 'PROJ' }, secret: 'JIRA-SECRET-456' });
  assert.equal(p.base, 'trunk'); assert.deepEqual(p.feedbackAuthors, ['gluser']); assert.deepEqual(p.tickets.allowedReporters, ['acc1', 'me@x.com']);
  assert.equal(p.tickets.tokenEnv, 'AF_SHOP_TOKEN'); assert.equal(p.host.tokenEnv, 'AF_SHOP_GIT_TOKEN');
  const sec = path.join(root, 'state', 'secrets.env'); assert.equal(fs.statSync(sec).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(sec, 'utf8'), /AF_SHOP_TOKEN=JIRA-SECRET-456/); assert.match(fs.readFileSync(sec, 'utf8'), /AF_SHOP_GIT_TOKEN=GL-SECRET-123/);
  const saved = fs.readFileSync(path.join(root, 'c.json'), 'utf8'); assert.ok(!saved.includes('SECRET')); assert.equal(e.env.AF_SHOP_TOKEN, 'JIRA-SECRET-456');
  const d = e.deps(e.cfg.projects[0]); assert.equal(d.config.cloneUrl, 'https://gitlab.com/grp/app.git'); assert.match(d.config.gitEnv.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
});

test('addProject: a bad token fails BEFORE anything is saved; mismatched source/host is refused with a clear reason', async () => {
  const { e, root } = engineWith(jiraGitlabRoutes({ myself: () => res(401, 'Unauthorized') }));
  await assert.rejects(e.addProject({ id: 'shop', repo: 'grp/app', host: { kind: 'gitlab' }, hostSecret: 'g', source: { kind: 'jira', fields: { baseUrl: 'https://x.atlassian.net', email: 'e' }, pick: 'PROJ' }, secret: 'jiratoken' }), /Could not connect/);
  assert.equal(e.cfg.projects.length, 0); assert.ok(!fs.existsSync(path.join(root, 'state', 'secrets.env')));
  await assert.rejects(e.addProject({ id: 'shop', repo: 'grp/app', host: { kind: 'gitlab' }, hostSecret: 'g' }), /Choose where tickets live/);
  await assert.rejects(e.addProject({ id: 'shop', repo: 'grp/app', host: { kind: 'gitlab' }, hostSecret: 'g', source: { kind: 'github', fields: {} } }), /GitHub Issues can only be used with a GitHub repository/);
  await assert.rejects(e.addProject({ id: 'x', repo: 'grp/app', host: { kind: 'gitlab' } }), /Paste the access token/);
});

test('saveSecret refuses names outside AF_* and multi-line or oversized values', () => {
  const { e } = engineWith(jiraGitlabRoutes());
  for (const [n, v] of [['AWS_SECRET', 'x'], ['AF_OK', 'a\nb'], ['AF_OK', ''], ['AF_OK', 'x'.repeat(5000)], ['af_ok', 'x']]) assert.throws(() => e.saveSecret(n, v), /Secret names|looks invalid/);
  e.saveSecret('AF_OK', 'good'); e.saveSecret('AF_OK', 'rotated'); assert.equal(fs.readFileSync(path.join(e.cfg.stateDir, 'secrets.env'), 'utf8'), 'AF_OK=rotated\n');
});

test('Ossicone sign-up probe: reports whether registration is open and where to go; refuses unsafe URLs', async () => {
  const f = fake([['GET /api/auth/config', () => res(200, { openSignup: true })]]);
  const i = await ossiconeSignupInfo('https://ossicone.example.com/', f); assert.deepEqual([i.reachable, i.openSignup, i.registerUrl, i.tokenUrl], [true, true, 'https://ossicone.example.com/register', 'https://ossicone.example.com/ai-agents']);
  assert.equal((await ossiconeSignupInfo('https://down.example.com', async () => { throw new Error('ECONNREFUSED'); })).reachable, false);
  await assert.rejects(ossiconeSignupInfo('http://169.254.169.254', f), /not allowed/);
});

test('API: catalog lists every tracker and host without leaking functions; source test and signup-info endpoints', async () => {
  const { e } = engineWith(fake([['GET /rest/api/2/myself', () => res(200, { accountId: 'a1', displayName: 'Me' })], ['GET /rest/api/2/project/search', () => res(200, { values: [{ key: 'PRJ', name: 'Proj' }] })], ['GET /api/auth/config', () => res(200, { openSignup: false })]]));
  const TOKEN = 'integration-token-0123456789-abcdef';
  const srv = createServer(e, { token: TOKEN, allowedHosts: [] }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; srv.close();
  const s2 = createServer(e, { token: TOKEN, allowedHosts: hostsFor('127.0.0.1', port) }); await new Promise((r) => s2.listen(port, '127.0.0.1', r));
  const call = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const cat = await (await call('/api/catalog')).json();
  assert.deepEqual(cat.sources.map((s) => s.kind), ['github', 'local', 'ossicone', 'jira', 'linear']); assert.deepEqual(cat.hosts.map((h) => h.kind), ['github', 'local', 'gitlab', 'bitbucket', 'git']);
  assert.ok(cat.sources.every((s) => !('build' in s) && !('validate' in s)) && cat.sources.find((s) => s.kind === 'jira').fields.some((f) => f.secret));
  const t = await call('/api/sources/test', { kind: 'jira', fields: { baseUrl: 'https://x.atlassian.net' }, token: 'tok' }); assert.equal(t.status, 200); assert.deepEqual((await t.json()).projects, [{ id: 'PRJ', name: 'Proj (PRJ)' }]);
  const bad = await call('/api/sources/test', { kind: 'jira', fields: { baseUrl: 'http://evil.example.com' }, token: 'tok' }); assert.equal(bad.status, 400);
  assert.equal((await (await call('/api/sources/signup-info', { baseUrl: 'https://o.example.com' })).json()).openSignup, false);
  assert.equal((await call('/api/sources/signup-info', { baseUrl: 'http://169.254.169.254' })).status, 400);
  s2.closeAllConnections(); s2.close();
});
