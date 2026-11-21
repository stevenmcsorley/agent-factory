// Engine methods for notifications. Installed on Engine.prototype (see the bottom of engine.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { makeNotifier, normalizeNotify, EVENTS } from './notify.mjs';

const MAP = { 'pr-opened': 'pr-ready', failed: 'failed', parked: 'parked' };

export const notifyMethods = {
  getNotify() { return { notify: this.cfg.notify ?? null, events: EVENTS }; },
  setNotify(input) { const before = this.cfg.notify ?? null; const next = normalizeNotify(input); if (next) this.cfg.notify = next; else delete this.cfg.notify; this._persist(); this._audit({ what: 'notify', from: before ? { ...before, url: '(set)' } : null, to: next ? { ...next, url: '(set)' } : null }); return this.getNotify(); },
  _notify(e) { try { this._notifier ??= makeNotifier(() => this.cfg.notify); return this._notifier(e).catch(() => ({ sent: false })); } catch { return Promise.resolve({ sent: false }); } },
  _notifyEvent(project, ev) { const event = MAP[ev.event]; if (event) this._notify({ event, project, title: ev.title ?? `#${ev.ticket}`, url: event === 'pr-ready' ? ev.url : undefined, detail: event === 'pr-ready' ? undefined : `ticket #${ev.ticket}` }); },
  async testNotify() { if (!this.cfg.notify) throw Object.assign(new Error('Set a notification address first'), { status: 400 }); const c = this.cfg.notify; const r = await makeNotifier(() => ({ ...c, enabled: true, events: Object.keys(EVENTS) }))({ event: 'pr-ready', title: 'Test notification from Agent Factory', detail: 'If you can read this, it works.' }); return r; },
  // Things that are states, not transitions: the daily cap, and pipelines that broke after a merge. Each is announced once.
  async notifyScan() {
    if (!this.cfg.notify) return; const f = path.join(this.cfg.stateDir, 'notify-state.json'); let st = {}; try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* first run */ }
    const day = new Date().toISOString().slice(0, 10); const sample = this.cfg.projects[0]; let changed = false;
    if (sample && this._due(sample).reasons.some((r) => r.code === 'daily-cap') && st.capDay !== day) { st.capDay = day; changed = true; this._notify({ event: 'cap-reached', title: 'Daily run cap reached', detail: 'Ready tickets will wait until tomorrow, or raise the cap in Settings.' }); }
    const failing = await this.deployFailures(false).catch(() => []); const keys = failing.map((x) => `${x.project}:${x.workflow}:${x.runId}`); const seen = new Set(st.deploy ?? []);
    for (const x of failing) if (!seen.has(`${x.project}:${x.workflow}:${x.runId}`)) { changed = true; this._notify({ event: 'deploy-failing', project: x.project, title: `${x.workflow} is failing after a merge`, detail: x.pr ? `after PR #${x.pr}` : undefined, url: x.url ?? undefined }); }
    if (JSON.stringify([...seen].sort()) !== JSON.stringify([...keys].sort())) { st.deploy = keys; changed = true; }
    if (changed) { try { fs.writeFileSync(`${f}.tmp`, JSON.stringify(st)); fs.renameSync(`${f}.tmp`, f); } catch { /* best effort */ } }
  },
};
