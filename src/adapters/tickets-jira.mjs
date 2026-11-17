// TicketSource backed by Jira (Cloud or Data Center/Server) over REST v2. State lives in issue LABELS (agent-ready → agent-working →
// agent-review/…), exactly like the other sources, so no workflow customisation is needed. Optionally also move the issue between
// statuses via `statuses: { working: "In Progress", review: "In Review", failed: "To Do" }` (transition names; failures are non-fatal).
// Only issues whose reporter is in `allowedReporters` (accountId, username or email) are ever claimed.
const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const PROJECT = /^[A-Z][A-Z0-9_]+$/i;
const FIELDS = ['summary', 'description', 'labels', 'reporter', 'status', 'updated'];
const b64 = (s) => Buffer.from(s).toString('base64');

// v3 (and any ADF fallback) returns descriptions as Atlassian Document Format JSON; flatten to text.
export function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const kids = (node.content ?? []).map(adfToText);
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type)) return kids.join('') + '\n';
  return kids.join('');
}
export const textToAdf = (text) => ({ type: 'doc', version: 1, content: String(text).split(/\n{2,}/).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) });

export function jiraTickets({ baseUrl, projectKey, flavor = 'cloud', auth, email, token, allowedReporters = [], statuses = {}, issueType = 'Task', fetchImpl = fetch, log = () => {} }) {
  if (!PROJECT.test(projectKey ?? '')) throw new Error('Jira projectKey must look like ABC');
  const base = baseUrl.replace(/\/$/, '');
  const mode = auth ?? (flavor === 'cloud' ? 'basic' : 'bearer');
  const headers = { Authorization: mode === 'basic' ? `Basic ${b64(`${email}:${token}`)}` : `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  const call = async (method, path, body, { allow = [] } = {}) => {
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (!res.ok && !allow.includes(res.status)) throw new Error(`Jira ${method} ${path.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.status === 204 ? null : res.status >= 400 ? { __status: res.status } : res.json();
  };
  const reporterIds = (i) => [i.fields.reporter?.accountId, i.fields.reporter?.name, i.fields.reporter?.key, i.fields.reporter?.emailAddress].filter(Boolean);
  const norm = (i) => ({ id: i.key, title: i.fields.summary ?? '', body: adfToText(i.fields.description).trim(), labels: i.fields.labels ?? [], reporterIds: reporterIds(i),
    url: `${base}/browse/${i.key}`, state: i.fields.status?.statusCategory?.key === 'done' ? 'CLOSED' : 'OPEN', updatedAt: i.fields.updated });
  const trusted = (t) => t.reporterIds.some((r) => allowedReporters.includes(r));

  // Cloud: the enhanced-search endpoint (the old /search was removed). Try v2 first, then v3; Data Center keeps /search.
  const search = async (jql) => {
    const body = { jql, fields: FIELDS, maxResults: 100 };
    if (flavor !== 'cloud') return (await call('POST', '/rest/api/2/search', body)).issues ?? [];
    for (const v of [2, 3]) { const r = await call('POST', `/rest/api/${v}/search/jql`, body, { allow: [404, 410] }); if (!r?.__status) return r.issues ?? []; }
    throw new Error('Jira search endpoint not found (is this a Jira Cloud URL?)');
  };
  const key = (id) => { if (!KEY.test(id)) throw new Error(`Invalid Jira issue key: ${id}`); return id; };
  const AGENT = ['agent-ready', 'agent-working', 'agent-review', 'agent-failed', 'agent-needs-info', 'agent-needs-human'];
  const q = (label) => `project = "${projectKey.toUpperCase()}" AND labels = "${label}" AND statusCategory != Done ORDER BY created ASC`;

  async function transition(id, name) {
    if (!name) return;
    try {
      const r = await call('GET', `/rest/api/2/issue/${key(id)}/transitions`);
      const t = r.transitions?.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.to?.name?.toLowerCase() === name.toLowerCase());
      if (t) await call('POST', `/rest/api/2/issue/${key(id)}/transitions`, { transition: { id: t.id } });
    } catch (e) { log(`jira transition skipped: ${e.message}`); }
  }
  return {
    async poll() { return (await search(q('agent-ready'))).map(norm).filter((t) => trusted(t) && !t.labels.includes('agent-working')); },
    async listWorking() { return (await search(q('agent-working'))).map(norm).filter(trusted).map((t) => ({ id: t.id, title: t.title })); },
    async listAgentTickets() {
      const jql = `project = "${projectKey.toUpperCase()}" AND labels in (${AGENT.map((l) => `"${l}"`).join(', ')}) ORDER BY updated DESC`;
      return (await search(jql)).map(norm).filter(trusted).map(({ reporterIds, ...t }) => t);
    },
    async label(id, add = [], remove = []) {
      await call('PUT', `/rest/api/2/issue/${key(id)}`, { update: { labels: [...remove.map((l) => ({ remove: l })), ...add.map((l) => ({ add: l }))] } });
      const to = add.includes('agent-working') ? statuses.working : add.includes('agent-review') ? statuses.review : add.includes('agent-failed') ? statuses.failed : null;
      await transition(id, to);
    },
    async comment(id, text) { await call('POST', `/rest/api/2/issue/${key(id)}/comment`, { body: text }); },
    async create({ title, body }) {
      const r = await call('POST', '/rest/api/2/issue', { fields: { project: { key: projectKey.toUpperCase() }, summary: title, description: body ?? '', issuetype: { name: issueType }, labels: ['agent-ready'] } });
      return { id: r.key, url: `${base}/browse/${r.key}` };
    },
    // For the setup wizard: who am I, and which projects can I pick?
    async identify() {
      const me = await call('GET', '/rest/api/2/myself');
      const list = flavor === 'cloud' ? (await call('GET', '/rest/api/2/project/search?maxResults=100')).values : await call('GET', '/rest/api/2/project');
      return { user: { id: me.accountId ?? me.name ?? me.key, name: me.displayName ?? me.name, email: me.emailAddress, alsoMatches: [me.accountId, me.name, me.key, me.emailAddress].filter(Boolean) },
        projects: (list ?? []).map((p) => ({ id: p.key, name: `${p.name} (${p.key})` })) };
    },
  };
}
