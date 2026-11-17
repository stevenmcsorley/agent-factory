// TicketSource backed by Linear (GraphQL). State lives in issue LABELS (created on demand in the team), like the other sources.
// To stay robust across API versions it uses only basic filters (team, state type) and filters labels/creators client-side.
// Only issues created by `allowedCreatorIds` are ever claimed. Auth: a personal API key, sent as-is (no "Bearer").
export function linearTickets({ teamId, token, allowedCreatorIds = [], endpoint = 'https://api.linear.app/graphql', fetchImpl = fetch }) {
  const gql = async (query, variables = {}) => {
    const res = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Linear -> ${res.status} ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    if (j.errors?.length) throw new Error(`Linear: ${j.errors.map((e) => e.message).join('; ').slice(0, 200)}`);
    return j.data;
  };
  const ISSUE = 'id identifier title description url updatedAt creator { id } labels { nodes { id name } } state { name type }';
  const uuids = new Map(); // identifier -> uuid, filled by every fetch
  const norm = (n) => { uuids.set(n.identifier, n.id); return { id: n.identifier, title: n.title, body: n.description ?? '', labels: n.labels.nodes.map((l) => l.name), creatorId: n.creator?.id, url: n.url,
    state: ['completed', 'canceled'].includes(n.state?.type) ? 'CLOSED' : 'OPEN', updatedAt: n.updatedAt, _labelIds: n.labels.nodes.map((l) => l.id) }; };
  const trusted = (t) => allowedCreatorIds.includes(t.creatorId);
  const fetchIssues = async () => (await gql(`query($t: ID!) { issues(filter: { team: { id: { eq: $t } } }, first: 100, orderBy: updatedAt) { nodes { ${ISSUE} } } }`, { t: teamId })).issues.nodes.map(norm).filter(trusted);

  let labelCache;
  const labelId = async (name) => {
    labelCache ??= new Map((await gql('query($t: ID!) { issueLabels(filter: { team: { id: { eq: $t } } }, first: 250) { nodes { id name } } }', { t: teamId })).issueLabels.nodes.map((l) => [l.name, l.id]));
    if (!labelCache.has(name)) { const r = await gql('mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { success issueLabel { id name } } }', { i: { name, teamId, color: '#6366f1' } }); labelCache.set(name, r.issueLabelCreate.issueLabel.id); }
    return labelCache.get(name);
  };
  const uuid = async (id) => uuids.get(id) ?? (await gql('query($i: String!) { issue(id: $i) { id identifier } }', { i: id })).issue.id;

  return {
    async poll() { return (await fetchIssues()).filter((t) => t.state === 'OPEN' && t.labels.includes('agent-ready') && !t.labels.includes('agent-working')); },
    async listWorking() { return (await fetchIssues()).filter((t) => t.state === 'OPEN' && t.labels.includes('agent-working')).map((t) => ({ id: t.id, title: t.title })); },
    async listAgentTickets() { return (await fetchIssues()).filter((t) => t.labels.some((l) => l.startsWith('agent-'))).map(({ creatorId, _labelIds, ...t }) => t); },
    async get(id) {
      const n = (await gql('query($i: String!) { issue(id: $i) { id identifier title description url updatedAt creator { id } labels { nodes { id name } } state { name type } comments(first: 30) { nodes { body createdAt user { name } } } } }', { i: id })).issue;
      const t = norm(n); if (!trusted(t)) throw new Error('That ticket was not created by an allowed creator');
      const { creatorId, _labelIds, ...rest } = t;
      return { ...rest, comments: n.comments.nodes.map((c) => ({ author: c.user?.name, body: c.body, at: c.createdAt, factory: /^agent-factory|^Opened https?:\/\//.test(c.body) })) };
    },
    async update(id, { title, body }) { await this.get(id); await gql('mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }', { id: await uuid(id), i: { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { description: body } : {}) } }); },
    async close() { throw Object.assign(new Error('Closing is not supported for Linear (workflow states differ): close it in Linear'), { status: 501 }); },
    async label(id, add = [], remove = []) {
      const i = (await gql('query($i: String!) { issue(id: $i) { id labels { nodes { id name } } } }', { i: id })).issue; uuids.set(id, i.id);
      const keep = i.labels.nodes.filter((l) => !remove.includes(l.name)).map((l) => l.id);
      const added = []; for (const n of add) added.push(await labelId(n));
      await gql('mutation($id: String!, $l: [String!]) { issueUpdate(id: $id, input: { labelIds: $l }) { success } }', { id: i.id, l: [...new Set([...keep, ...added])] });
    },
    async comment(id, text) { await gql('mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }', { i: { issueId: await uuid(id), body: text } }); },
    async create({ title, body }) {
      const r = (await gql('mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { identifier url } } }', { i: { teamId, title, description: body ?? '', labelIds: [await labelId('agent-ready')] } })).issueCreate.issue;
      return { id: r.identifier, url: r.url };
    },
    async identify() {
      const d = await gql('{ viewer { id name email } teams(first: 100) { nodes { id key name } } }');
      return { user: { id: d.viewer.id, name: d.viewer.name, email: d.viewer.email, alsoMatches: [d.viewer.id] }, projects: d.teams.nodes.map((t) => ({ id: t.id, name: `${t.name} (${t.key})` })) };
    },
  };
}
