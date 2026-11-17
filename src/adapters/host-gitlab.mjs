import { gitAuthEnv } from '../gitauth.mjs';
import { MARKER } from './githost-github.mjs';

// GitLab (gitlab.com or self-managed) via REST v4. Merge requests are the "PRs"; "Draft:" marks them as not ready to merge.
const PENDING = new Set(['running', 'pending', 'created', 'waiting_for_resource', 'preparing', 'scheduled']);
export function gitlabHost({ baseUrl = 'https://gitlab.com', repo, token, allowedAuthors = [], fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/$/, ''); const api = `${root}/api/v4`; const pid = encodeURIComponent(repo);
  const call = async (method, path, body, { text = false } = {}) => {
    const res = await fetchImpl(`${api}${path}`, { method, headers: { 'PRIVATE-TOKEN': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`GitLab ${method} ${path.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
    return text ? res.text() : res.json();
  };
  return {
    kind: 'gitlab', supportsPrs: true,
    cloneUrl: (r = repo) => `${root}/${r}.git`,
    gitEnv: () => gitAuthEnv(new URL(root).origin, 'oauth2', token),
    prUrl: (_r, n) => `${root}/${repo}/-/merge_requests/${n}`,
    async whoami() { return (await call('GET', '/user')).username; },
    async inspectRepo() {
      const p = await call('GET', `/projects/${pid}`); const level = Math.max(p.permissions?.project_access?.access_level ?? 0, p.permissions?.group_access?.access_level ?? 0);
      if (level < 30) throw new Error(`Your GitLab token has access level ${level} on ${repo}; Developer (30) or higher is needed to push branches and open merge requests`);
      return { defaultBranch: p.default_branch ?? 'main', private: p.visibility !== 'public', url: p.web_url };
    },
    async openPr({ branch, base, title, body }) { return (await call('POST', `/projects/${pid}/merge_requests`, { source_branch: branch, target_branch: base, title: `Draft: ${title}`, description: body })).web_url; },
    pr: {
      async listAgentPrs() { return (await call('GET', `/projects/${pid}/merge_requests?state=opened&per_page=100`)).filter((m) => m.source_branch.startsWith('agent/')).map((m) => ({ number: m.iid, branch: m.source_branch, sha: m.sha, title: m.title.replace(/^Draft:\s*/i, '') })); },
      async getFeedback(pr) {
        const latest = (await call('GET', `/projects/${pid}/merge_requests/${pr.number}/pipelines`))[0];
        const failedChecks = []; const pending = !!latest && PENDING.has(latest.status);
        if (latest?.status === 'failed') {
          const jobs = await call('GET', `/projects/${pid}/pipelines/${latest.id}/jobs?scope[]=failed&per_page=10`);
          for (const j of jobs) failedChecks.push({ name: j.name, log: (await call('GET', `/projects/${pid}/jobs/${j.id}/trace`, null, { text: true }).catch(() => '')).slice(-3000) });
        }
        const notes = await call('GET', `/projects/${pid}/merge_requests/${pr.number}/notes?sort=asc&per_page=100`);
        const comments = notes.filter((n) => !n.system && allowedAuthors.includes(n.author?.username) && !n.body.includes(MARKER)).map((n) => ({ id: `n${n.id}`, author: n.author.username, body: n.body, raw: n.body }));
        return { failedChecks, pending, comments };
      },
      async comment(pr, text) { await call('POST', `/projects/${pid}/merge_requests/${pr.number}/notes`, { body: `${text}\n\n${MARKER}` }); },
      async label(pr, name) { await call('PUT', `/projects/${pid}/merge_requests/${pr.number}`, { add_labels: name }); },
    },
  };
}
