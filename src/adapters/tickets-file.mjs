import fs from 'node:fs';

// TicketSource backed by a JSON array: [{id,title,body,labels:[],comments:[]}]. For tests/demo.
export function fileTickets(path) {
  const load = () => JSON.parse(fs.readFileSync(path, 'utf8'));
  const save = (d) => fs.writeFileSync(path, JSON.stringify(d, null, 2));
  const mutate = (id, fn) => { const d = load(); const t = d.find((x) => String(x.id) === String(id)); fn(t); save(d); };
  return {
    async poll() { return load().filter((t) => t.labels.includes('agent-ready') && !t.labels.includes('agent-working')); },
    async listWorking() { return load().filter((t) => t.labels.includes('agent-working')); },
    async listAgentTickets() { return load().filter((t) => t.labels.some((l) => l.startsWith('agent-'))).map((t) => ({ ...t, state: t.closed ? 'CLOSED' : 'OPEN' })); },
    async create({ title, body }) { const d = load(); const id = Math.max(0, ...d.map((t) => Number(t.id))) + 1; d.push({ id, title, body, labels: ['agent-ready'], comments: [] }); save(d); return { id }; },
    async get(id) { const t = load().find((x) => String(x.id) === String(id)); if (!t) throw new Error('No such ticket'); return { ...t, state: t.closed ? 'CLOSED' : 'OPEN', comments: (t.comments ?? []).map((b) => ({ author: 'factory', body: b, factory: true })) }; },
    async update(id, { title, body }) { mutate(id, (t) => { if (title !== undefined) t.title = title; if (body !== undefined) t.body = body; }); },
    async close(id) { mutate(id, (t) => { t.closed = true; }); },
    async label(id, add = [], remove = []) {
      mutate(id, (t) => { t.labels = [...new Set([...t.labels.filter((l) => !remove.includes(l)), ...add])]; });
    },
    async comment(id, text) { mutate(id, (t) => { (t.comments ??= []).push(text); }); },
  };
}
