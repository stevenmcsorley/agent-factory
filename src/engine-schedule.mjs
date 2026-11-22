// Engine methods for schedules and for explaining why work is waiting. Installed on Engine.prototype (see the bottom of engine.mjs).
import { normalizeSchedule, scheduleState, usedToday } from './schedule.mjs';
import { runsToday, spentToday, readRuns } from './budget.mjs';
import * as pk from './pack.mjs';

export const scheduleMethods = {
  // May this project take work right now? { allowed, reasons: [{ code, reason, nextAt? }] }. Every reason a ready ticket might sit still is listed, so the UI can say which.
  _due(p, now = Date.now()) {
    const reasons = []; const l = this.cfg.limits;
    if (this.paused()) reasons.push({ code: 'factory-paused', reason: 'the whole factory is paused' });
    if (p.paused) reasons.push({ code: 'project-paused', reason: 'this project is paused' });
    const lim = this.planLimit(); if (lim) reasons.push({ code: 'plan-limit', reason: `the agent plan's usage limit is reached; agents resume ${lim.autoResume ? 'by themselves ' : 'when you press Resume, after '}${lim.untilText}`, nextAt: new Date(lim.until).toISOString() });
    const sch = scheduleState(p.schedule, now, p.schedule?.hoursPerDay ? usedToday(readRuns(this.cfg.stateDir), p.id, now) : 0);
    if (!sch.allowed) reasons.push({ code: sch.code, reason: sch.reason, nextAt: sch.nextAt });
    if (l.maxRunsPerDay != null && runsToday(this.cfg.stateDir) >= l.maxRunsPerDay) reasons.push({ code: 'daily-cap', reason: `the factory's daily run cap is reached (${l.maxRunsPerDay} of ${l.maxRunsPerDay})` });
    if (l.dailyBudgetUsd != null && spentToday(this.cfg.stateDir) >= l.dailyBudgetUsd) reasons.push({ code: 'daily-budget', reason: `the daily budget of $${l.dailyBudgetUsd} is spent` });
    return { allowed: reasons.length === 0, reasons };
  },
  // Projects whose turn it is: unpaused, inside their schedule, lowest priority number first. A project that finished its plan and asked to stop is paused here.
  _dueProjects(now = Date.now()) {
    const due = []; if (this.planLimit()) return due;   // the plan's limit pauses every agent, so no project is due until it lifts
    for (const p of this.cfg.projects) {
      if (p.schedule?.stopWhenDone && !p.paused) {
        try { if (pk.loadPack(pk.packDir(this.cfg.stateDir, p.id)).plan?.status === 'complete') { p.paused = true; this._persist(); this._audit({ what: 'schedule', project: p.id, note: 'plan complete: project paused (stopWhenDone)' }); } } catch { /* best effort */ }
      }
      const own = scheduleState(p.schedule, now, p.schedule?.hoursPerDay ? usedToday(readRuns(this.cfg.stateDir), p.id, now) : 0);
      if (!p.paused && own.allowed) due.push(p);
    }
    return due.sort((a, b) => (a.schedule?.priority ?? 5) - (b.schedule?.priority ?? 5));
  },
  waiting(id) { const p = this.project(id); const d = this._due(p); return { project: id, waiting: !d.allowed, reasons: d.reasons, heldTickets: this.holds?.get(id) ?? [], schedule: p.schedule ?? null, usedTodayMs: usedToday(readRuns(this.cfg.stateDir), id) }; },
  setSchedule(id, input) {
    const p = this.project(id); const before = p.schedule ?? null; const next = normalizeSchedule(input);
    if (next) p.schedule = next; else delete p.schedule;
    this._persist(); this._audit({ what: 'schedule', project: id, from: before, to: next });
    return this.waiting(id);
  },
};
