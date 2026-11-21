// Engine methods for designs: ask the designer agent for a mockup, revise it on your feedback, edit it by hand, approve or reject it.
// Installed on Engine.prototype (see the bottom of engine.mjs). Approved designs reach the builder through _designContext and materializeDesigns.
import fs from 'node:fs';
import path from 'node:path';
import { getPrompt } from './prompts.mjs';
import * as pk from './pack.mjs';
import * as ds from './designs.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export const designMethods = {
  _designDir(id) { return this._packDir(id); },
  designs(id) { const dir = this._designDir(id); return { designs: ds.listDesigns(dir).map((d) => ({ ...d, working: this.designJobs?.has(`${id}:${d.id}`) ?? false })) }; },
  getDesign(id, did) { const dir = this._designDir(id); return { ...ds.getDesign(dir, did), working: this.designJobs?.has(`${id}:${did}`) ?? false }; },
  designHtml(id, did, version) { return ds.readHtml(this._designDir(id), did, version); },
  _materializeDesigns(id, wsDir) { try { ds.materializeDesigns(this._designDir(id), wsDir); } catch { /* context is a helper, never a blocker */ } },
  _designContext(id) { try { return ds.designContext(this._designDir(id)); } catch { return ''; } },

  startDesign(id, { title, request } = {}) {
    const dir = this._designDir(id); const d = ds.createDesign(dir, { title, request });
    this._runDesign(id, d.id, { request: d.request }); this._audit({ what: 'design', project: id, design: d.id, action: 'requested' }); return this.getDesign(id, d.id);
  },
  // Feedback from you becomes the next version. The previous version is shown to the designer so it changes what you asked for and keeps the rest.
  reviseDesign(id, did, { feedback } = {}) {
    const dir = this._designDir(id); const d = ds.getDesign(dir, did); if (this.designJobs?.has(`${id}:${did}`)) throw bad('The designer is still working on this one', 409);
    if (!d.versions.length) throw bad('There is no version to revise yet'); ds.addComment(dir, did, feedback); ds.setStatus(dir, did, 'drafting');
    this._runDesign(id, did, { request: d.request, feedback: String(feedback).slice(0, 4000), previous: ds.readHtml(dir, did, d.versions.at(-1).n) }); return this.getDesign(id, did);
  },
  // Your own edit: saved as a new version by "you", and the design goes back to waiting for approval.
  editDesign(id, did, { html, note } = {}) {
    const dir = this._designDir(id); if (this.designJobs?.has(`${id}:${did}`)) throw bad('The designer is still working on this one', 409);
    const d = ds.addVersion(dir, did, { html, by: 'you', rationale: note || 'Edited by hand.' }); this._audit({ what: 'design', project: id, design: did, action: 'edited' }); return this.getDesign(id, did);
  },
  setDesignStatus(id, did, status, version) {
    const dir = this._designDir(id); const d = ds.setStatus(dir, did, status, version); this._audit({ what: 'design', project: id, design: did, action: status, version: d.approvedVersion ?? null }); return this.getDesign(id, did);
  },
  deleteDesign(id, did) { const dir = this._designDir(id); const r = ds.removeDesign(dir, did); this._audit({ what: 'design', project: id, design: did, action: 'deleted' }); return r; },

  _runDesign(id, did, { request, feedback, previous }) {
    this.designJobs ??= new Map(); const key = `${id}:${did}`; if (this.designJobs.has(key)) return;
    this.designJobs.set(key, { startedAt: Date.now() });
    this._designAgent(id, did, { request, feedback, previous }).catch((e) => { try { ds.setError(this._designDir(id), did, e.message ?? String(e)); } catch { /* design deleted meanwhile */ } }).finally(() => this.designJobs.delete(key));
  },
  async _designAgent(id, did, { request, feedback, previous }) {
    const p = this.project(id); const dir = this._designDir(id); const pack = pk.loadPack(dir); const d = this.deps(p, 'designer'); let ws;
    try {
      ws = await d.sandbox.create({ cloneUrl: d.config.cloneUrl, branch: 'design', base: p.base, newBranch: false, gitEnv: d.config.gitEnv, depth: 1 });
      pk.materialize(pack, dir, ws.dir); ds.materializeDesigns(dir, ws.dir);
      const out = path.join(ws.dir, '.factory-design'); fs.mkdirSync(out, { recursive: true }); if (previous) fs.writeFileSync(path.join(out, 'previous.html'), previous);
      const prompt = [getPrompt('designer-rules', {}, this._promptDirs()), this._skillsText('designer', id) ? `\n${this._skillsText('designer', id)}` : '', `\n## What to design (data)\n${request}`,
        previous ? `\n## Your previous version is in .factory-design/previous.html. Change only what this feedback asks for and keep the rest (data):\n${feedback}` : ''].join('\n');
      const r = await d.agent.run(d.sandbox, ws, prompt, { timeoutMs: this.cfg.limits.timeoutMs ?? 900_000 });
      if (r.timedOut) throw bad('The designer timed out');
      let html; try { html = fs.readFileSync(path.join(out, 'design.html'), 'utf8'); } catch { html = /```html\n([\s\S]*?)```/i.exec(String(r.out))?.[1]; }
      if (!html) throw bad('The designer did not produce a design file. Try again, or describe the screen in more detail.');
      const rationale = String(r.out ?? '').replace(/```html[\s\S]*?```/gi, '').trim().slice(-1400);
      ds.addVersion(dir, did, { html, rationale, feedback });
    } finally { try { ws?.destroy(); } catch { /* best effort */ } }
  },
};
