import { run } from './util.mjs';
import { githubHost } from './adapters/githost-github.mjs';
import { gitlabHost } from './adapters/host-gitlab.mjs';
import { bitbucketHost } from './adapters/host-bitbucket.mjs';
import { gitHost } from './adapters/host-git.mjs';
import { inspectRepo as ghInspect, whoami as ghWhoami } from './github.mjs';
import { checkBaseUrl, TOKEN_ENV } from './sources.mjs';

// Where the CODE lives. Independent of where TICKETS live (e.g. Jira tickets + a Bitbucket repo). A host provides: clone URL, git
// authentication (env vars, never argv), repo access check, opening a draft PR/MR, and the PR feedback loop (CI + comments).
// Add a host by implementing the adapter shape in src/adapters/host-*.mjs and registering it here.
const R_FLAT = /^[\w.-]+\/[\w.-]+$/, R_NESTED = /^[\w.-]+(\/[\w.-]+)+$/;
const tokenProblem = (h) => (TOKEN_ENV.test(h.tokenEnv ?? '') ? [] : ['host.tokenEnv must be an environment variable NAME like AF_MYAPP_GIT_TOKEN (the token itself is stored separately)']);

export const HOSTS = {
  github: {
    label: 'GitHub', blurb: 'Uses the GitHub CLI you are already signed into (gh auth login). No token to paste.', fields: [], repoPattern: R_FLAT, repoHint: 'owner/name', pr: true,
    validate: () => [],
    build: (p, c) => { const repo = p.repo; return { kind: 'github', supportsPrs: true, cloneUrl: (r = repo) => `https://github.com/${r}.git`, gitEnv: () => ({}), prUrl: (_r, n) => `https://github.com/${repo}/pull/${n}`,
      whoami: ghWhoami, inspectRepo: () => ghInspect(repo),
      async openPr({ repo: r = repo, branch, base, title, body }) { const x = await (c.exec ?? run)('gh', ['pr', 'create', '-R', r, '--head', branch, '--base', base, '--title', title, '--body', body, '--draft']); if (x.code !== 0) throw new Error(`gh pr create failed: ${x.out.trim().slice(0, 300)}`); return x.out.trim().split('\n').pop(); },
      pr: githubHost({ repo, allowedAuthors: c.allowedAuthors }) }; },
  },
  gitlab: {
    label: 'GitLab', blurb: 'gitlab.com or self-managed. Opens merge requests ("Draft:") and reads pipeline logs and comments.',
    fields: [{ key: 'baseUrl', label: 'GitLab URL', placeholder: 'https://gitlab.com', default: 'https://gitlab.com' }, { key: 'token', label: 'Access token', secret: true, required: true, help: 'Personal or project access token with api scope and Developer role or higher.' }],
    repoPattern: R_NESTED, repoHint: 'group/project (subgroups allowed)', pr: true,
    validate: (h) => [...tokenProblem(h), ...(() => { try { checkBaseUrl(h.baseUrl ?? 'https://gitlab.com'); return []; } catch (e) { return [`host.baseUrl: ${e.message}`]; } })()],
    build: (p, c) => gitlabHost({ baseUrl: checkBaseUrl(p.host.baseUrl ?? 'https://gitlab.com'), repo: p.repo, token: c.env[p.host.tokenEnv], allowedAuthors: c.allowedAuthors, fetchImpl: c.fetchImpl }),
  },
  bitbucket: {
    label: 'Bitbucket', blurb: 'Bitbucket Cloud. Opens pull requests ("[Draft]"); CI status is read, build logs are not available through the API.',
    fields: [{ key: 'username', label: 'Bitbucket username', required: true, placeholder: 'your-username' }, { key: 'token', label: 'App password', secret: true, required: true, help: 'Bitbucket → Personal settings → App passwords (repositories: read + write, pull requests: read + write).' }],
    repoPattern: R_FLAT, repoHint: 'workspace/repo', pr: true,
    validate: (h) => [...tokenProblem(h), ...(h.username ? [] : ['host.username is required for Bitbucket'])],
    build: (p, c) => bitbucketHost({ repo: p.repo, username: p.host.username, token: c.env[p.host.tokenEnv], allowedAuthors: c.allowedAuthors, fetchImpl: c.fetchImpl }),
  },
  git: {
    label: 'Any git remote', blurb: 'Gitea, Forgejo, Azure DevOps, a plain server… The factory pushes a branch; you open the pull request yourself. No CI feedback loop.',
    fields: [{ key: 'remoteTemplate', label: 'Remote URL template', required: true, placeholder: 'https://git.example.com/{repo}.git  or  git@git.example.com:{repo}.git', help: '{repo} is replaced by the project repo path. ssh uses this machine’s ssh keys.' },
      { key: 'username', label: 'Username (https only)', placeholder: 'git' }, { key: 'token', label: 'Token / password (https only, optional)', secret: true }],
    repoPattern: R_NESTED, repoHint: 'path/to/repo', pr: false, optionalToken: true,
    validate: (h) => [...(/\{repo\}/.test(h.remoteTemplate ?? '') ? [] : ['host.remoteTemplate must contain {repo}']), ...(/^(https:\/\/|ssh:\/\/|git@)/.test(h.remoteTemplate ?? '') && !/^https:\/\/[^/]*@/.test(h.remoteTemplate ?? '') ? [] : ['host.remoteTemplate must start with https://, ssh:// or git@ and contain no credentials']), ...(h.tokenEnv ? tokenProblem(h) : [])],
    build: (p, c) => gitHost({ remoteTemplate: p.host.remoteTemplate, repo: p.repo, username: p.host.username || 'git', token: p.host.tokenEnv ? c.env[p.host.tokenEnv] : undefined, exec: c.exec }),
  },
};

export const hostKind = (p) => p.host?.kind ?? 'github';
export const publicHosts = () => Object.entries(HOSTS).map(([kind, h]) => ({ kind, label: h.label, blurb: h.blurb, fields: h.fields, repoHint: h.repoHint, pr: h.pr }));
export function validateHost(p) {
  const h = HOSTS[hostKind(p)]; if (!h) return [`host.kind "${p.host?.kind}" is not supported (use ${Object.keys(HOSTS).join(', ')})`];
  return [...(h.repoPattern.test(p.repo ?? '') ? [] : [`project ${p.id}: repo "${p.repo}" must look like ${h.repoHint}`]), ...h.validate(p.host ?? {}).map((x) => `project ${p.id}: ${x}`)];
}
export const buildHost = (p, ctx) => HOSTS[hostKind(p)].build({ ...p, host: p.host ?? { kind: 'github' } }, { ...ctx, allowedAuthors: p.feedbackAuthors ?? p.tickets?.allowedAuthors ?? [] });

// Wizard "Test connection" for a code host: authenticate with the pasted token, check access to the repo, WITHOUT saving anything.
export async function identifyHost({ kind, fields = {}, token, repo, fetchImpl, exec }) {
  const h = HOSTS[kind]; if (!h) throw Object.assign(new Error(`Unsupported code host: ${kind}`), { status: 400 });
  if (!h.repoPattern.test(repo ?? '')) throw Object.assign(new Error(`Repository must look like ${h.repoHint}`), { status: 400 });
  if (h.fields.some((f) => f.secret && f.required) && !token) throw Object.assign(new Error('Paste the access token first'), { status: 400 });
  const env = { AF_PROBE: token }; const host = { kind, ...fields, tokenEnv: kind === 'github' ? undefined : 'AF_PROBE' };
  try {
    const a = h.build({ id: 'probe', repo, host, tickets: {}, feedbackAuthors: [] }, { env, fetchImpl, exec, allowedAuthors: [] });
    const [user, info] = await Promise.all([a.whoami(), a.inspectRepo()]);
    return { user, defaultBranch: info.defaultBranch, private: info.private, url: info.url, supportsPrs: a.supportsPrs };
  } catch (e) { throw Object.assign(new Error(`Could not connect: ${String(e.message).replace(token ?? '\u0000', '***').slice(0, 240)}`), { status: 400 }); }
}
