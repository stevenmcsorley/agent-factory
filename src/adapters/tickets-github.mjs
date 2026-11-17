import { run } from '../util.mjs';

// TicketSource backed by GitHub issues via the authenticated `gh` CLI.
// Only issues authored by an allowlisted user are returned (prompt-injection guard).
export function githubTickets({ repo, allowedAuthors, exec = run }) {
  const gh = async (args) => {
    const r = await exec('gh', args);
    if (r.code !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.out}`);
    return r.out;
  };
  const listIssues = async ({ labels, state }) => {
    const q = [`repos/${repo}/issues`, '-X', 'GET', '-f', `state=${state}`, '-f', 'per_page=100', ...(labels ? ['-f', `labels=${labels}`] : [])];
    return JSON.parse(await gh(['api', ...q]))
      .filter((i) => !i.pull_request && allowedAuthors.includes(i.user?.login)) // PRs also appear in this endpoint; untrusted authors never get through
      .map((i) => ({ id: i.number, title: i.title, body: i.body ?? '', labels: i.labels.map((l) => l.name), repo, url: i.html_url, state: i.state.toUpperCase(), updatedAt: i.updated_at }))
      .filter((t) => (!labels || t.labels.includes(labels)) && (state === 'all' || t.state === state.toUpperCase())); // never rely on server-side filtering alone
  };
  return {
    // Reads use the REST issues endpoint, NOT `gh issue list --label`: that goes through GitHub's search index, which lags by
    // several seconds, so a ticket queued a moment ago would be invisible to an immediate "Run now".
    async poll() {
      return (await listIssues({ labels: 'agent-ready', state: 'open' })).filter((t) => !t.labels.includes('agent-working'));
    },
    async listWorking() { return (await listIssues({ labels: 'agent-working', state: 'open' })).map((t) => ({ id: t.id, title: t.title })); },
    // Everything the factory has touched (any agent-* label), for dashboards.
    async listAgentTickets() {
      return (await listIssues({ state: 'all' })).filter((t) => t.labels.some((l) => l.startsWith('agent-')))
        .map((t) => ({ id: t.id, title: t.title, state: t.state, url: t.url, updatedAt: t.updatedAt, labels: t.labels }));
    },
    async create({ title, body }) {
      const url = (await gh(['issue', 'create', '-R', repo, '--title', title, '--body', body ?? '', '--label', 'agent-ready'])).trim().split('\n').pop();
      return { url };
    },
    async label(id, add = [], remove = []) {
      const args = ['issue', 'edit', String(id), '-R', repo];
      for (const l of add) args.push('--add-label', l);
      for (const l of remove) args.push('--remove-label', l);
      await gh(args);
    },
    async comment(id, text) { await gh(['issue', 'comment', String(id), '-R', repo, '--body', text]); },
  };
}
