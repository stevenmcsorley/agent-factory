import { randomBytes } from 'node:crypto';

// Run tracing: every run gets an id and a list of timed phases (claim → sandbox → agent → verify → push → pr), plus the
// artefacts a human wants (agent summary, verify output tail, changed files). Each phase change is also emitted as a live
// event so the UI can show what the factory is doing right now. Pure bookkeeping: it never affects control flow.
export function startRun(base, { onEvent, project } = {}) {
  const rec = { id: randomBytes(4).toString('hex'), started: new Date().toISOString(), status: 'running', phases: [], ...base };
  const emit = (e) => { try { onEvent?.({ at: new Date().toISOString(), project, run: rec.id, ticket: rec.ticket, pr: rec.prNumber, title: rec.title, ...e }); } catch { /* observers must never break a run */ } };
  const close = () => { const p = rec.phases.at(-1); if (p && p.ms === undefined) p.ms = Date.now() - p.t; };
  emit({ type: 'start' });
  return {
    rec,
    phase(name, detail) { close(); rec.phases.push({ name, detail, t: Date.now() }); rec.phase = name; emit({ type: 'phase', phase: name, detail }); },
    note(key, value) { rec[key] = value; },
    finish(status) {
      close(); if (status) rec.status = status;
      rec.phases.forEach((p) => { p.at = new Date(p.t).toISOString(); delete p.t; });
      emit({ type: 'end', status: rec.status });
      return rec;
    },
  };
}

export const tail = (s, n = 1500) => String(s ?? '').trim().slice(-n);
export const changedFiles = (porcelain) => String(porcelain ?? '').split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, '').trim()).slice(0, 50);
