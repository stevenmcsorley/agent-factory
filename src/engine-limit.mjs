// The agent plan's usage limit, handled for the whole factory. When ANY agent (builder, reviewer, designer, planner...) reports that the account has hit its limit,
// every agent stops being started until the time it names. With auto-resume on (the default) work then restarts by itself, and tickets that the limit failed are put back in the queue.
// Without it the factory still pauses, and tells you when to press Resume. Installed on Engine.prototype (see the bottom of engine.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { parseUsageLimit, retryAtMs } from './agentlimit.mjs';
import { readRuns } from './budget.mjs';

const FALLBACK_MS = 30 * 60_000;   // a limit with no readable time: look again in half an hour
const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export const limitMethods = {
  _limitFile() { return path.join(this.cfg.stateDir, 'plan-limit.json'); },
  autoResume() { return this.cfg.autoResume !== false; },
  // The current limit, or null. Read from disk once, and also derived from the latest rate-limited run so a restart does not forget it.
  planLimit() {
    if (this._limit === undefined) {
      this._limit = null; try { this._limit = JSON.parse(fs.readFileSync(this._limitFile(), 'utf8')); } catch { /* none saved */ }
      if (!this._limit) { const runs = readRuns(this.cfg.stateDir); const last = runs.filter((r) => r.status === 'rate-limited' && r.retryAt).at(-1);
        // a run that reached the agent AFTER that one (and was not itself rate-limited) proves the limit has lifted (you reset it, or it was a shorter window than announced)
        const lifted = last && runs.some((r) => r.status !== 'rate-limited' && Date.parse(r.started ?? r.finished ?? 0) > Date.parse(last.finished ?? last.started ?? 0));
        if (lifted) { /* stale: ignore */ } else { const until = last ? retryAtMs(last.retryAt, Date.parse(last.finished ?? last.started ?? new Date().toISOString())) : null; if (until && until > Date.now()) this._limit = { until, message: last.error ?? 'The agent hit its usage limit', at: last.finished ?? new Date().toISOString(), derived: true }; } }
    }
    const l = this._limit; if (l && Date.now() >= l.until) { this._expireLimit(); return null; }
    return l ? { ...l, untilText: when(l.until), autoResume: this.autoResume() } : null;
  },
  _saveLimit() { try { if (this._limit) fs.writeFileSync(this._limitFile(), JSON.stringify(this._limit)); else fs.rmSync(this._limitFile(), { force: true }); } catch { /* best effort */ } },
  // An agent reported the limit.
  _noteLimit(lim, now = Date.now()) {
    const until = retryAtMs(lim.retryAt, now) ?? now + FALLBACK_MS; const cur = this.planLimit(); if (cur && cur.until >= until) return;
    this._limit = { until, message: lim.message ?? 'The agent hit its usage limit', at: new Date(now).toISOString() }; this._saveLimit(); this.cache.clear();
    this._audit({ what: 'plan-limit', until: new Date(until).toISOString(), autoResume: this.autoResume() });
    this._notify?.({ event: 'limit-reached', title: 'The agent plan hit its usage limit', detail: `agents are paused until ${when(until)}${this.autoResume() ? ' and will resume by themselves' : ': press Resume'}` });
  },
  // The time has come (or you pressed Resume): start again, and put back the tickets the limit failed.
  _expireLimit({ requeue = true } = {}) {
    if (!this._limit) return; this._limit = null; this._saveLimit(); this.cache.clear(); this._audit({ what: 'plan-limit-cleared' });
    if (requeue && this.autoResume()) this.requeueLimited().catch(() => {});
    this._notify?.({ event: 'plan-resumed', title: 'Agents are working again', detail: this.autoResume() ? 'the usage limit has reset' : 'the limit was cleared' });
  },
  clearPlanLimit() { const had = !!this.planLimit(); this._expireLimit({ requeue: true }); return { cleared: had }; },
  assertAgentAvailable() { const l = this.planLimit(); if (l) throw Object.assign(new Error(`The agent plan's usage limit is reached. Agents are paused until ${l.untilText}${l.autoResume ? ' and resume by themselves' : ''}. (Press Resume anyway on the Control room to try now.)`), { status: 429 }); },
  // Tickets that only failed because of the limit go back in the queue (not ones that failed for a real reason).
  async requeueLimited() {
    const lastBy = new Map(); for (const r of readRuns(this.cfg.stateDir)) if (r.ticket != null) lastBy.set(`${r.project}#${r.ticket}`, r); const out = [];
    const hit = new Set([...lastBy.values()].filter((r) => r.status === 'rate-limited').map((r) => r.project));   // only projects the limit actually stopped: do not walk every tracker (some are GitHub)
    for (const p of this.cfg.projects.filter((x) => hit.has(x.id))) { let list; try { list = await this.freshTickets(p.id); } catch { continue; }
      for (const t of list) { if (t.state === 'CLOSED' || !(t.labels ?? []).includes('agent-failed')) continue; if (lastBy.get(`${p.id}#${t.id}`)?.status !== 'rate-limited') continue;
        try { await this.ticketAction(p.id, t.id, 'requeue'); out.push({ project: p.id, ticket: t.id }); } catch { /* it needs a human: leave it in the inbox */ } } }
    return out;
  },
  setAutoResume(on) { if (typeof on !== 'boolean') throw Object.assign(new Error('autoResume must be true or false'), { status: 400 }); this.cfg.autoResume = on; this._persist(); this._audit({ what: 'settings', changes: { autoResume: { from: !on, to: on } } }); return { autoResume: on, limit: this.planLimit() }; },
};
