// TicketSource backed by Ossicone's REST API (Bearer API token; see the Ossicone API docs).
// State lives in the issue's `labels` array (same agent-* labels as the GitHub adapter) and, for visibility on the
// board, `status` (in_progress while working, code_review when a PR is up).
// Author guard: only issues whose reporterId is in allowedReporterIds are claimable.
export function ossiconeTickets({ baseUrl, token, projectId, allowedReporterIds, workspaceId, fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(workspaceId ? { 'X-Workspace-Id': String(workspaceId) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`ossicone ${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
  const issues = async () => call('GET', `/api/issues?projectId=${projectId}`);
  // A ticket names its repository with a label `repo:owner/name`; without one the factory's default repo applies.
  const repoOf = (labels) => labels.find((l) => /^repo:[\w.-]+\/[\w.-]+$/.test(l))?.slice(5);
  const base = baseUrl.replace(/\/$/, '');
  // Links, state and timestamps are part of every ticket so dashboards and the inbox can deep-link and tell open from done.
  const norm = (i) => { const labels = i.labels ?? []; return { id: i.id, title: i.title, body: i.description ?? '', labels, repo: repoOf(labels), reporterId: i.reporterId ?? i.reporter?.id,
    url: `${base}/projects/${i.projectId ?? projectId}/issues/${i.id}`, state: i.status === 'done' ? 'CLOSED' : 'OPEN', updatedAt: i.updatedAt }; };
  return {
    async poll() {
      return (await issues()).map(norm)
        .filter((t) => t.labels.includes('agent-ready') && !t.labels.includes('agent-working') && allowedReporterIds.includes(t.reporterId));
    },
    async listWorking() { return (await issues()).map(norm).filter((t) => t.labels.includes('agent-working')); },
    async listAgentTickets() {
      return (await issues()).map(norm).filter((t) => t.labels.some((l) => l.startsWith('agent-')) && allowedReporterIds.includes(t.reporterId));
    },
    // reporterId is mandatory on Ossicone's REST create; it is the token owner.
    async create({ title, body, repo, epic }) {
      const me = await call('GET', '/api/auth/me');
      const i = await call('POST', '/api/issues', { title, description: body ?? '', projectId, type: 'task', reporterId: me.id, ...(epic ? { epicId: Number(epic) } : {}),
        labels: ['agent-ready', ...(repo ? [`repo:${repo}`] : [])] });
      return { id: i.id };
    },
    // The plan lives in the tracker: an epic per plan epic (no agent-* label, so the factory never treats it as work), with the tickets linked to it.
    async createEpic({ title, body }) {
      const me = await call('GET', '/api/auth/me');
      const i = await call('POST', '/api/issues', { title, description: body ?? '', projectId, type: 'epic', reporterId: me.id, labels: ['factory-plan'] });
      return { id: i.id, url: `${baseUrl.replace(/\/$/, '')}/projects/${projectId}/issues/${i.id}` };
    },
    // For the setup wizard: who am I, and which projects can I pick?
    async identify() {
      const me = await call('GET', '/api/auth/me'); const ps = await call('GET', '/api/projects');
      return { user: { id: me.id, name: me.name ?? me.email, email: me.email, alsoMatches: [me.id] }, projects: ps.map((p) => ({ id: p.id, name: `${p.name} (${p.key})` })) };
    },
    async get(id) {
      const i = await call('GET', `/api/issues/${Number(id)}`); const t = norm(i);
      if (!allowedReporterIds.includes(t.reporterId)) throw new Error('That ticket was not created by an allowed reporter');
      const cs = await call('GET', `/api/comments/issue/${Number(id)}`).catch(() => []);
      return { ...t, comments: (cs ?? []).map((c) => ({ author: c.author?.name ?? c.user?.name, body: c.content, at: c.createdAt, factory: /^agent-factory|^Opened https?:\/\//.test(c.content ?? '') })) };
    },
    async update(id, { title, body }) { await this.get(id); await call('PATCH', `/api/issues/${Number(id)}`, { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { description: body } : {}) }); },
    async close(id) { await this.get(id); await call('PATCH', `/api/issues/${Number(id)}`, { status: 'done' }); },
    async label(id, add = [], remove = []) {
      const cur = norm(await call('GET', `/api/issues/${id}`));
      const labels = [...new Set([...cur.labels.filter((l) => !remove.includes(l)), ...add])];
      const status = add.includes('agent-working') ? 'in_progress' : add.includes('agent-review') ? 'code_review'
        : add.includes('agent-failed') || add.includes('agent-ready') ? 'todo' : undefined;
      await call('PATCH', `/api/issues/${id}`, { labels, ...(status ? { status } : {}) });
    },
    async comment(id, text) { await call('POST', '/api/comments', { content: text, issueId: Number(id) }); }, // ids from URLs arrive as strings; Ossicone requires a number
  };
}
