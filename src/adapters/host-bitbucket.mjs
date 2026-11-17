import { gitAuthEnv } from '../gitauth.mjs';
import { MARKER } from './githost-github.mjs';

// Bitbucket Cloud via REST 2.0, authenticated with a username + app password (or repository access token with username "x-token-auth").
// Bitbucket has no PR labels and no draft flag, so "[Draft]" goes in the title and escalation is a comment only.
export function bitbucketHost({ repo, username, token, allowedAuthors = [], fetchImpl = fetch }) {
  const api = 'https://api.bitbucket.org/2.0'; const auth = `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${api}${path}`, { method, headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Bitbucket ${method} ${path.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  };
  const who = (u) => [u?.nickname, u?.display_name, u?.account_id, u?.username].filter(Boolean);
  return {
    kind: 'bitbucket', supportsPrs: true,
    cloneUrl: (r = repo) => `https://bitbucket.org/${r}.git`,
    gitEnv: () => gitAuthEnv('https://bitbucket.org', username, token),
    prUrl: (_r, n) => `https://bitbucket.org/${repo}/pull-requests/${n}`,
    async whoami() { const u = await call('GET', '/user'); return u.nickname ?? u.display_name; },
    async inspectRepo() {
      const r = await call('GET', `/repositories/${repo}`);
      const perm = (await call('GET', `/user/permissions/repositories?q=${encodeURIComponent(`repository.full_name="${repo}"`)}`)).values?.[0]?.permission;
      if (!['write', 'admin'].includes(perm)) throw new Error(`Your Bitbucket credentials have "${perm ?? 'no'}" permission on ${repo}; write or admin is needed to push branches and open pull requests`);
      return { defaultBranch: r.mainbranch?.name ?? 'main', private: r.is_private, url: r.links?.html?.href };
    },
    async openPr({ branch, base, title, body }) { return (await call('POST', `/repositories/${repo}/pullrequests`, { title: `[Draft] ${title}`, description: body, source: { branch: { name: branch } }, destination: { branch: { name: base } } })).links.html.href; },
    pr: {
      async listAgentPrs() { return (await call('GET', `/repositories/${repo}/pullrequests?state=OPEN&pagelen=50`)).values.filter((p) => p.source.branch.name.startsWith('agent/')).map((p) => ({ number: p.id, branch: p.source.branch.name, sha: p.source.commit?.hash, title: p.title.replace(/^\[Draft\]\s*/i, '') })); },
      async getFeedback(pr) {
        const statuses = (await call('GET', `/repositories/${repo}/pullrequests/${pr.number}/statuses?pagelen=50`)).values ?? [];
        const failedChecks = statuses.filter((s) => s.state === 'FAILED').map((s) => ({ name: s.name, log: `${s.description ?? ''}\n${s.url ?? ''}`.trim() })); // Bitbucket exposes no build log through this API
        const pending = statuses.some((s) => s.state === 'INPROGRESS');
        const cs = (await call('GET', `/repositories/${repo}/pullrequests/${pr.number}/comments?pagelen=100`)).values ?? [];
        const comments = cs.filter((c) => !c.deleted && c.content?.raw && who(c.user).some((n) => allowedAuthors.includes(n)) && !c.content.raw.includes(MARKER))
          .map((c) => ({ id: `c${c.id}`, author: c.user.nickname ?? c.user.display_name, body: c.inline ? `${c.inline.path}:${c.inline.to ?? ''} — ${c.content.raw}` : c.content.raw, raw: c.content.raw }));
        return { failedChecks, pending, comments };
      },
      async comment(pr, text) { await call('POST', `/repositories/${repo}/pullrequests/${pr.number}/comments`, { content: { raw: `${text}\n\n${MARKER}` } }); },
      async label() { /* Bitbucket pull requests have no labels; the preceding comment carries the message */ },
    },
  };
}
