import fs from 'node:fs';
import path from 'node:path';

// File-backed leases: {ticketId: {runId, pid, expires}}. A ticket labelled agent-working with no live lease
// is an orphan (crash/kill) and gets requeued by recover().
export function leaseStore(stateDir) {
  const file = path.join(stateDir, 'leases.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = (d) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(d, null, 2)); };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  return {
    acquire(id, ttlMs) { const d = load(); d[id] = { pid: process.pid, expires: Date.now() + ttlMs, recoveries: d[id]?.recoveries ?? 0 }; save(d); },
    release(id) { const d = load(); const r = d[id]?.recoveries; if (r) d[id] = { recoveries: r, expires: 0 }; else delete d[id]; save(d); },
    isLive(id) { const l = load()[id]; return !!l && l.expires > Date.now() && alive(l.pid); },
    bumpRecoveries(id) { const d = load(); d[id] = { ...(d[id] ?? {}), expires: 0, recoveries: (d[id]?.recoveries ?? 0) + 1 }; save(d); return d[id].recoveries; },
  };
}

// Requeue orphaned tickets; after maxRecoveries give up so a poison ticket can't loop forever.
export async function recover({ tickets, leases, maxRecoveries = 2 }) {
  const out = [];
  for (const t of await tickets.listWorking()) {
    if (leases.isLive(t.id)) continue;
    const n = leases.bumpRecoveries(t.id);
    if (n > maxRecoveries) {
      await tickets.comment(t.id, `agent-factory: run died ${n} times; marking agent-failed for human triage.`);
      await tickets.label(t.id, ['agent-failed'], ['agent-working']);
      out.push({ ticket: t.id, action: 'failed' });
    } else {
      await tickets.comment(t.id, `agent-factory: previous run died (recovery ${n}/${maxRecoveries}); requeued.`);
      await tickets.label(t.id, ['agent-ready'], ['agent-working']);
      out.push({ ticket: t.id, action: 'requeued' });
    }
  }
  return out;
}
