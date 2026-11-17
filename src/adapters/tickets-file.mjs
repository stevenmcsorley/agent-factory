import fs from 'node:fs';

// TicketSource backed by a JSON array: [{id,title,body,labels:[],comments:[]}]. For tests/demo.
export function fileTickets(path) {
  const load = () => JSON.parse(fs.readFileSync(path, 'utf8'));
  const save = (d) => fs.writeFileSync(path, JSON.stringify(d, null, 2));
  const mutate = (id, fn) => { const d = load(); const t = d.find((x) => String(x.id) === String(id)); fn(t); save(d); };
  return {
    async poll() { return load().filter((t) => t.labels.includes('agent-ready') && !t.labels.includes('agent-working')); },
    async listWorking() { return load().filter((t) => t.labels.includes('agent-working')); },
    async listAgentTickets() { return load().filter((t) => t.labels.some((l) => l.startsWith('agent-'))); },
    async create({ title, body }) { const d = load(); const id = Math.max(0, ...d.map((t) => Number(t.id))) + 1; d.push({ id, title, body, labels: ['agent-ready'], comments: [] }); save(d); return { id }; },
    async label(id, add = [], remove = []) {
      mutate(id, (t) => { t.labels = [...new Set([...t.labels.filter((l) => !remove.includes(l)), ...add])]; });
    },
    async comment(id, text) { mutate(id, (t) => { (t.comments ??= []).push(text); }); },
  };
}
