import { run } from '../util.mjs';

// TicketSource backed by GitHub issues via the authenticated `gh` CLI.
// Only issues authored by an allowlisted user are returned (prompt-injection guard).
// Tickets this process created in the last couple of minutes. GitHub's issue LIST endpoints lag by ~6s (measured), but fetching one
// issue by number is read-your-writes, so poll() also fetches these directly: "Run now" right after queueing must not miss the ticket.
const RECENT = new Map(); // `${repo}#${number}` -> created-at ms
const RECENT_MS = 120000;

export function githubTickets({ repo, allowedAuthors, exec = run }) {
  const gh = async (args) => {
    const r = await exec('gh', args);
    if (r.code !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.out}`);
    return r.out;
  };
  const normIssue = (i) => ({ id: i.number, title: i.title, body: i.body ?? '', labels: i.labels.map((l) => l.name), repo, url: i.html_url, state: i.state.toUpperCase(), updatedAt: i.updated_at });
  const trustedIssue = (i) => !i.pull_request && allowedAuthors.includes(i.user?.login);
  const listIssues = async ({ labels, state }) => {
    const q = [`repos/${repo}/issues`, '-X', 'GET', '-f', `state=${state}`, '-f', 'per_page=100', ...(labels ? ['-f', `labels=${labels}`] : [])];
    return JSON.parse(await gh(['api', ...q]))
      .filter(trustedIssue) // PRs also appear in this endpoint; untrusted authors never get through
      .map(normIssue)
      .filter((t) => (!labels || t.labels.includes(labels)) && (state === 'all' || t.state === state.toUpperCase())); // never rely on server-side filtering alone
  };
  return {
    // Reads use the REST issues endpoint (cheaper and unambiguous vs `gh issue list`). NOTE: every GitHub LIST endpoint lags by several
    // seconds after a write (measured ~6s), which is why poll() also fetches just-created tickets individually (see RECENT above).
    async poll() {
      const listed = await listIssues({ labels: 'agent-ready', state: 'open' }); const have = new Set(listed.map((t) => t.id)); const extra = [];
      for (const [key, at] of RECENT) {
        const [r, n] = key.split('#'); if (r !== repo) continue;
        if (Date.now() - at > RECENT_MS || have.has(Number(n))) { RECENT.delete(key); continue; }
        try { const i = JSON.parse(await gh(['api', `repos/${repo}/issues/${n}`])); const t = normIssue(i); if (trustedIssue(i) && t.state === 'OPEN' && t.labels.includes('agent-ready')) extra.push(t); } catch { /* not visible yet; try next cycle */ }
      }
      return [...listed, ...extra].filter((t) => !t.labels.includes('agent-working'));
    },
    async listWorking() { return (await listIssues({ labels: 'agent-working', state: 'open' })).map((t) => ({ id: t.id, title: t.title })); },
    // Everything the factory has touched (any agent-* label), for dashboards.
    async listAgentTickets() {
      return (await listIssues({ state: 'all' })).filter((t) => t.labels.some((l) => l.startsWith('agent-')))
        .map((t) => ({ id: t.id, title: t.title, state: t.state, url: t.url, updatedAt: t.updatedAt, labels: t.labels }));
    },
    async create({ title, body }) {
      const url = (await gh(['issue', 'create', '-R', repo, '--title', title, '--body', body ?? '', '--label', 'agent-ready'])).trim().split('\n').pop();
      const n = /\/issues\/(\d+)$/.exec(url)?.[1]; if (n) RECENT.set(`${repo}#${n}`, Date.now());
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
