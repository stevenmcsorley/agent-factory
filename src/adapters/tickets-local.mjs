// The built-in tracker: issues, epics, labels, comments and states kept inside the factory (state/projects/<id>/tracker.json). No account, no token, no
// network, no lag. It implements the same contract as the GitHub, Ossicone, Jira and Linear adapters, so plans, scenarios, webhooks and the inbox work with it
// unchanged. Only the factory (UI, API, CLI, webhooks, plans) can create tickets here, so there is no "who is allowed to queue work" question to answer.
import fs from 'node:fs';
import path from 'node:path';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const clip = (v, n) => String(v ?? '').replace(/\u0000/g, '').slice(0, n);

export function localTickets({ dir, project = 'project' }) {
  const file = path.join(dir, 'tracker.json');
  // A corrupt file is never silently replaced by an empty tracker: keep a copy and stop, so nothing is lost.
  const load = () => {
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return { next: 1, issues: [] }; }
    try { const d = JSON.parse(raw); return { next: Number(d.next) || 1, issues: Array.isArray(d.issues) ? d.issues : [] }; }
    catch { const keep = `${file}.corrupt-${Date.now()}`; try { fs.writeFileSync(keep, raw); } catch { /* best effort */ } throw bad(`The tracker file is corrupt (a copy was kept at ${keep}). Fix or restore it before continuing.`, 500); }
  };
  const save = (d) => { fs.mkdirSync(dir, { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 1)); fs.renameSync(tmp, file); };
  const now = () => new Date().toISOString();
  const find = (d, id) => d.issues.find((i) => String(i.id) === String(id)) ?? (() => { throw bad(`No such ticket: ${id}`, 404); })();
  const view = (i) => ({ id: i.id, title: i.title, body: i.body, labels: [...i.labels], state: i.state === 'closed' ? 'CLOSED' : 'OPEN', url: `local:${project}/${i.id}`, updatedAt: i.updatedAt, createdAt: i.createdAt, type: i.type, epic: i.epic ?? null });
  const mutate = (id, fn) => { const d = load(); const i = find(d, id); fn(i, d); i.updatedAt = now(); save(d); return i; };
  // An epic closes by itself once every child is closed (and reopens if a child is reopened).
  const settleEpic = (d, epicId) => { if (!epicId) return; const e = d.issues.find((x) => String(x.id) === String(epicId)); if (!e) return; const kids = d.issues.filter((x) => String(x.epic) === String(epicId)); e.state = kids.length && kids.every((k) => k.state === 'closed') ? 'closed' : 'open'; e.updatedAt = now(); };
  const tasks = (d) => d.issues.filter((i) => i.type !== 'epic');
  return {
    async poll() { return tasks(load()).filter((i) => i.state === 'open' && i.labels.includes('agent-ready') && !i.labels.includes('agent-working')).map(view); },
    async listWorking() { return tasks(load()).filter((i) => i.labels.includes('agent-working')).map(view); },
    async listAgentTickets() { return tasks(load()).filter((i) => i.labels.some((l) => l.startsWith('agent-'))).map(view); },
    async create({ title, body, repo, epic }) {
      const t = clip(title, 200).trim(); if (!t) throw bad('A ticket needs a title'); const d = load();
      if (epic !== undefined && epic !== null && epic !== '') { const e = d.issues.find((x) => String(x.id) === String(epic)); if (!e || e.type !== 'epic') throw bad(`No such epic: ${epic}`); }
      const i = { id: d.next++, type: 'task', title: t, body: clip(body, 20_000), labels: ['agent-ready', ...(repo ? [`repo:${clip(repo, 100)}`] : [])], state: 'open', epic: epic ? Number(epic) : null, comments: [], createdAt: now(), updatedAt: now() };
      d.issues.push(i); if (i.epic) settleEpic(d, i.epic); save(d); return { id: i.id, url: `local:${project}/${i.id}` };
    },
    // Epics are not work: they carry no agent-* label, so the factory never picks them up.
    async createEpic({ title, body }) {
      const t = clip(title, 200).trim(); if (!t) throw bad('An epic needs a title'); const d = load();
      const i = { id: d.next++, type: 'epic', title: t, body: clip(body, 20_000), labels: ['factory-plan'], state: 'open', epic: null, comments: [], createdAt: now(), updatedAt: now() }; d.issues.push(i); save(d); return { id: i.id, url: `local:${project}/${i.id}` };
    },
    async get(id) {
      const d = load(); const i = find(d, id); const out = { ...view(i), comments: (i.comments ?? []).map((c) => ({ author: c.author, body: c.body, at: c.at, factory: /^agent-factory|^Opened (?:https?:|local-pr:)/.test(c.body) })) };
      if (i.type === 'epic') out.children = d.issues.filter((x) => String(x.epic) === String(i.id)).map(view);
      if (i.epic) { const e = d.issues.find((x) => String(x.id) === String(i.epic)); if (e) out.epicInfo = { id: e.id, title: e.title, url: `local:${project}/${e.id}` }; }
      return out;
    },
    async update(id, { title, body }) { mutate(id, (i) => { if (title !== undefined) { const t = clip(title, 200).trim(); if (!t) throw bad('A ticket needs a title'); i.title = t; } if (body !== undefined) i.body = clip(body, 20_000); }); },
    async close(id) { mutate(id, (i, d) => { i.state = 'closed'; settleEpic(d, i.epic); }); },
    async reopen(id) { mutate(id, (i, d) => { i.state = 'open'; settleEpic(d, i.epic); }); },
    async label(id, add = [], remove = []) { mutate(id, (i) => { i.labels = [...new Set([...i.labels.filter((l) => !remove.includes(l)), ...add.map((l) => clip(l, 60))])]; }); },
    async comment(id, text) { const body = clip(text, 20_000); if (!body.trim()) return; mutate(id, (i) => { (i.comments ??= []).push({ author: /^agent-factory|^Opened (?:https?:|local-pr:)/.test(body) ? 'agent-factory' : 'you', body, at: now() }); }); },
    // Everything, for the tracker views: epics with their children and progress.
    async overview() { const d = load(); return { epics: d.issues.filter((i) => i.type === 'epic').map((e) => { const kids = d.issues.filter((x) => String(x.epic) === String(e.id)); return { ...view(e), total: kids.length, done: kids.filter((k) => k.state === 'closed').length }; }), tickets: tasks(d).length }; },
  };
}
