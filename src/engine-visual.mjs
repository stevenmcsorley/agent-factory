// Engine methods for the visual check: a project's preview settings, a "check now" job that records what is already wrong (the baseline),
// and the hook the build loop calls after a change passes its tests. Installed on Engine.prototype (see the bottom of engine.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { normalizePreview, runVisual, evaluate, VISUAL_IMAGE } from './visual.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export const visualMethods = {
  _visualDir(id) { return path.join(this.projectDir(this.project(id)), 'visual'); },
  getPreview(id) {
    const p = this.project(id); const base = readJson(path.join(this._visualDir(id), 'baseline.json')); const job = this.visualJobs?.get(id) ?? null;
    return { preview: p.preview ?? null, image: p.preview?.image ?? this.cfg.sandbox.visualImage ?? VISUAL_IMAGE, baseline: base ? { at: base.at, summary: base.summary, counts: base.counts, pages: base.pages, findings: base.findings, shots: base.shots } : null, job };
  },
  setPreview(id, input) {
    const p = this.project(id); const before = p.preview ?? null; const next = normalizePreview(input);
    if (next) p.preview = next; else delete p.preview;
    const same = (x) => JSON.stringify({ ...(x ?? {}), enabled: undefined });   // switching the check on or off does not change what the app is, so it keeps its baseline
    if (same(before) !== same(next)) fs.rmSync(path.join(this._visualDir(id), 'baseline.json'), { force: true });   // a different app set-up means a different baseline
    this._persist(); this._audit({ what: 'preview', project: id, from: before, to: next }); return this.getPreview(id);
  },
  // Runs the check on the base branch and keeps the result as the baseline: what is ALREADY wrong, so later changes are only judged on what they add.
  startVisualCheck(id) {
    const p = this.project(id); if (!p.preview) throw bad('Set the preview first: how to start the app, its port and the routes to check');
    this.visualJobs ??= new Map(); if (this.visualJobs.get(id)?.state === 'running') return this.visualJobs.get(id);
    const job = { state: 'running', startedAt: Date.now(), phase: 'starting' }; this.visualJobs.set(id, job);
    this._visualOnBase(p, (ph) => { job.phase = ph; }).then((v) => { job.state = 'done'; job.result = v.status === 'error' ? { status: 'error', summary: v.summary, serverLog: v.serverLog } : { status: 'recorded', summary: `Baseline recorded: ${v.counts.fail} problem${v.counts.fail === 1 ? '' : 's'} and ${v.counts.warn} to look at already there. New changes are judged only on what they add.` }; })
      .catch((e) => { job.state = 'error'; job.error = String(e.message ?? e).slice(0, 400); }).finally(() => { job.finishedAt = Date.now(); });
    return job;
  },
  async _visualOnBase(p, onPhase) {
    const d = this.deps(p); let ws; const dir = this._visualDir(p.id);
    try {
      onPhase?.('cloning the base branch'); ws = await d.sandbox.create({ cloneUrl: d.config.cloneUrl, branch: 'visual', base: p.base, newBranch: false, gitEnv: d.config.gitEnv, depth: 1 });
      onPhase?.('starting the app and loading each page (a few minutes the first time)');
      const rep = await runVisual({ sandbox: d.sandbox, ws, preview: p.preview, outDir: path.join(dir, 'baseline'), timeoutMs: (this.cfg.limits.timeoutMs ?? 900_000), image: p.preview.image ?? this.cfg.sandbox.visualImage ?? VISUAL_IMAGE });
      const v = evaluate(rep, null); if (v.status === 'error') return { ...v, serverLog: rep.serverLog };
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ at: new Date().toISOString(), summary: `${v.counts.fail} problem${v.counts.fail === 1 ? '' : 's'} and ${v.counts.warn} to look at, already on the base branch (new changes are only judged on what they add)`, counts: v.counts, pages: v.pages, findings: v.findings, keys: v.keys, shots: v.shots }));
      return v;
    } finally { try { ws?.destroy(); } catch { /* best effort */ } }
  },
  // The hook for the build loop. Undefined when the project has no preview (or switched it off), so the loop is exactly as before.
  _visualHook(p, sandbox) {
    if (!p.preview || p.preview.enabled === false) return undefined;
    return async ({ ws, runId }) => {
      const dir = this._visualDir(p.id); const baseline = readJson(path.join(dir, 'baseline.json'))?.keys ?? null;
      const rep = await runVisual({ sandbox, ws, preview: p.preview, outDir: path.join(dir, runId), timeoutMs: this.cfg.limits.timeoutMs ?? 900_000, image: p.preview.image ?? this.cfg.sandbox.visualImage ?? VISUAL_IMAGE });
      const v = evaluate(rep, baseline); const { keys, ...slim } = v; return { ...slim, baseline: !!baseline, checkedAt: new Date().toISOString(), ...(v.status === 'error' && rep.serverLog ? { serverLog: rep.serverLog } : {}) };
    };
  },
  visualFile(id, runId, file) {
    if (!/^(baseline|[a-f0-9]{8})$/.test(runId) || !/^[a-z0-9-]+\.png$/.test(file)) throw bad('Not found', 404);
    const f = path.join(this._visualDir(id), runId, file); if (!fs.existsSync(f)) throw bad('Not found', 404); return fs.readFileSync(f);
  },
};
