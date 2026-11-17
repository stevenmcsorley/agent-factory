import { run } from '../util.mjs';

// TicketSource backed by GitHub issues via the authenticated `gh` CLI.
// Only issues authored by an allowlisted user are returned (prompt-injection guard).
export function githubTickets({ repo, allowedAuthors }) {
  const gh = async (args) => {
    const r = await run('gh', args);
    if (r.code !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.out}`);
    return r.out;
  };
  return {
    async poll() {
      const out = await gh(['issue', 'list', '-R', repo, '--label', 'agent-ready', '--state', 'open',
        '--json', 'number,title,body,labels,author', '--limit', '20']);
      return JSON.parse(out)
        .filter((i) => allowedAuthors.includes(i.author.login))
        .map((i) => ({ id: i.number, title: i.title, body: i.body, labels: i.labels.map((l) => l.name), repo }))
        .filter((t) => !t.labels.includes('agent-working'));
    },
    async listWorking() {
      const out = await gh(['issue', 'list', '-R', repo, '--label', 'agent-working', '--state', 'open', '--json', 'number,title', '--limit', '50']);
      return JSON.parse(out).map((i) => ({ id: i.number, title: i.title }));
    },
    // Everything the factory has touched (any agent-* label), for dashboards. Same author allowlist as poll().
    async listAgentTickets() {
      const out = await gh(['issue', 'list', '-R', repo, '--state', 'all', '--json', 'number,title,labels,author,state,url,updatedAt', '--limit', '100']);
      return JSON.parse(out).filter((i) => allowedAuthors.includes(i.author.login))
        .map((i) => ({ id: i.number, title: i.title, state: i.state, url: i.url, updatedAt: i.updatedAt, labels: i.labels.map((l) => l.name) }))
        .filter((t) => t.labels.some((l) => l.startsWith('agent-')));
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
