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
  designs(id) { const dir = this._designDir(id); return { designs: ds.listDesigns(dir).map((d) => ({ ...d, working: this.designJobs?.has(`${id}:${d.id}`) ?? false })), inUse: ds.inUse(dir) }; },
  // Exactly what the builder is told about designs on its next ticket.
  designContextFor(id) { const dir = this._designDir(id); return { ...ds.inUse(dir), text: ds.designContext(dir) }; },
  getDesign(id, did) { const dir = this._designDir(id); return { ...ds.getDesign(dir, did), working: this.designJobs?.has(`${id}:${did}`) ?? false }; },
  designAssets(id, did, version) { return ds.readAssets(this._designDir(id), did, version); },
  designHtml(id, did, version) { return ds.readHtml(this._designDir(id), did, version); },
  _materializeDesigns(id, wsDir) { try { ds.materializeDesigns(this._designDir(id), wsDir); } catch { /* context is a helper, never a blocker */ } },
  _designContext(id) { try { return ds.designContext(this._designDir(id)); } catch { return ''; } },

  startDesign(id, { title, request, kind, area } = {}) {
    this.assertAgentAvailable();
    const dir = this._designDir(id); const d = ds.createDesign(dir, { title, request, kind, area });
    this._runDesign(id, d.id, { request: d.request, kind: d.kind }); this._audit({ what: 'design', project: id, design: d.id, action: 'requested' }); return this.getDesign(id, d.id);
  },
  // Feedback from you becomes the next version. The previous version is shown to the designer so it changes what you asked for and keeps the rest.
  reviseDesign(id, did, { feedback } = {}) {
    this.assertAgentAvailable();
    const dir = this._designDir(id); const d = ds.getDesign(dir, did); if (this.designJobs?.has(`${id}:${did}`)) throw bad('The designer is still working on this one', 409);
    if (!d.versions.length) throw bad('There is no version to revise yet'); ds.addComment(dir, did, feedback); ds.setStatus(dir, did, 'drafting');
    const previous = d.kind === 'assets' ? ds.readAssets(dir, did, d.versions.at(-1).n) : ds.readHtml(dir, did, d.versions.at(-1).n);
    this._runDesign(id, did, { request: d.request, feedback: String(feedback).slice(0, 4000), previous, kind: d.kind }); return this.getDesign(id, did);
  },
  // Your own edit: saved as a new version by "you", and the design goes back to waiting for approval.
  editDesign(id, did, { html, note, files } = {}) {
    const dir = this._designDir(id); if (this.designJobs?.has(`${id}:${did}`)) throw bad('The designer is still working on this one', 409);
    const cur = ds.getDesign(dir, did);
    if (cur.kind === 'assets') {   // your edit: the files you send replace or add to the current set, the rest carry over
      const base = new Map((cur.versions.length ? ds.readAssets(dir, did, cur.versions.at(-1).n) : []).map((f) => [f.name, f.svg])); for (const f of Array.isArray(files) ? files : []) base.set(String(f.name).replace(/\.svg$/i, ''), f.svg); for (const r of (Array.isArray(files) ? files : []).filter((f) => f.svg === null)) base.delete(String(r.name).replace(/\.svg$/i, ''));
      ds.addAssetVersion(dir, did, { files: [...base.entries()].filter(([, v]) => typeof v === 'string').map(([name, svg]) => ({ name, svg })), by: 'you', rationale: note || 'Edited by hand.' }); this._audit({ what: 'design', project: id, design: did, action: 'edited' }); return this.getDesign(id, did);
    }
    const d = ds.addVersion(dir, did, { html, by: 'you', rationale: note || 'Edited by hand.' }); this._audit({ what: 'design', project: id, design: did, action: 'edited' }); return this.getDesign(id, did);
  },
  setDesignStatus(id, did, status, version) {
    const dir = this._designDir(id); const d = ds.setStatus(dir, did, status, version); this._audit({ what: 'design', project: id, design: did, action: status, version: d.approvedVersion ?? null, ...(d.retired?.length ? { retired: d.retired } : {}) });
    return { ...this.getDesign(id, did), ...(d.retired?.length ? { retired: d.retired } : {}) };
  },
  archiveDesign(id, did) { const dir = this._designDir(id); if (this.designJobs?.has(`${id}:${did}`)) throw bad('The designer is still working on this one', 409); ds.setStatus(dir, did, 'archived'); this._audit({ what: 'design', project: id, design: did, action: 'archived' }); return this.getDesign(id, did); },
  restoreDesign(id, did) { const dir = this._designDir(id); ds.restoreDesign(dir, did); this._audit({ what: 'design', project: id, design: did, action: 'restored' }); return this.getDesign(id, did); },
  updateDesign(id, did, meta = {}) { const dir = this._designDir(id); ds.updateMeta(dir, did, meta); return this.getDesign(id, did); },
  deleteDesignVersion(id, did, n) { const dir = this._designDir(id); if (this.designJobs?.has(`${id}:${did}`)) throw bad('The designer is still working on this one', 409); ds.deleteVersion(dir, did, Number(n)); this._audit({ what: 'design', project: id, design: did, action: 'version-deleted', version: Number(n) }); return this.getDesign(id, did); },
  deleteDesign(id, did) { const dir = this._designDir(id); const r = ds.removeDesign(dir, did); this._audit({ what: 'design', project: id, design: did, action: 'deleted' }); return r; },

  _runDesign(id, did, { request, feedback, previous, kind }) {
    this.designJobs ??= new Map(); const key = `${id}:${did}`; if (this.designJobs.has(key)) return;
    this.designJobs.set(key, { startedAt: Date.now() });
    this._designAgent(id, did, { request, feedback, previous, kind }).catch((e) => { try { ds.setError(this._designDir(id), did, e.message ?? String(e)); } catch { /* design deleted meanwhile */ } }).finally(() => this.designJobs.delete(key));
  },
  async _designAgent(id, did, { request, feedback, previous, kind = 'screen' }) {
    const p = this.project(id); const dir = this._designDir(id); const pack = pk.loadPack(dir); const d = this.deps(p, 'designer'); let ws; const assets = kind === 'assets';
    try {
      ws = await d.sandbox.create({ cloneUrl: d.config.cloneUrl, branch: 'design', base: p.base, newBranch: false, gitEnv: d.config.gitEnv, depth: 1 });
      pk.materialize(pack, dir, ws.dir); ds.materializeDesigns(dir, ws.dir); this._materializeScreens?.(id, ws.dir);
      const out = path.join(ws.dir, '.factory-design'); fs.mkdirSync(out, { recursive: true });
      if (previous) { if (assets) { fs.mkdirSync(path.join(out, 'previous'), { recursive: true }); for (const f of previous) fs.writeFileSync(path.join(out, 'previous', `${f.name}.svg`), f.svg); } else fs.writeFileSync(path.join(out, 'previous.html'), previous); }
      const screens = fs.existsSync(path.join(ws.dir, '.factory-context', 'current-screens')) ? '\n\nThe app as it looks today: screenshots and a summary of its real text, fonts and colours are in .factory-context/current-screens/ (see screens.json). Start from that look and keep the product\'s identity unless the request says otherwise.' : '';
      const role = assets ? 'assets-rules' : 'designer-rules';
      const prompt = [getPrompt(role, {}, this._promptDirs()), this._skillsText('designer', id) ? `\n${this._skillsText('designer', id)}` : '', `\n## What to ${assets ? 'draw' : 'design'} (data)\n${request}${screens}`,
        previous ? `\n## Your previous version is in .factory-design/${assets ? 'previous/' : 'previous.html'}. Change only what this feedback asks for and keep the rest (data):\n${feedback}` : ''].join('\n');
      const r = await d.agent.run(d.sandbox, ws, prompt, { timeoutMs: this.cfg.limits.timeoutMs ?? 900_000, meta: { ref: `${kind === 'assets' ? 'artwork' : 'design'} ${did}` } });
      if (r.timedOut) throw bad('The designer timed out');
      const rationale = String(r.out ?? '').replace(/```[a-z]*[\s\S]*?```/gi, '').trim().slice(-1400);
      if (assets) {
        let names = []; try { names = fs.readdirSync(path.join(out, 'assets')).filter((f) => /\.svg$/i.test(f)); } catch { /* none */ }
        if (!names.length) throw bad('The designer did not produce any SVG files. Try again, or describe the artwork in more detail.');
        ds.addAssetVersion(dir, did, { files: names.slice(0, 12).map((f) => ({ name: f, svg: fs.readFileSync(path.join(out, 'assets', f), 'utf8') })), rationale, feedback });
      } else {
        let html; try { html = fs.readFileSync(path.join(out, 'design.html'), 'utf8'); } catch { html = /```html\n([\s\S]*?)```/i.exec(String(r.out))?.[1]; }
        if (!html) throw bad('The designer did not produce a design file. Try again, or describe the screen in more detail.');
        ds.addVersion(dir, did, { html, rationale: String(r.out ?? '').replace(/```html[\s\S]*?```/gi, '').trim().slice(-1400), feedback });
      }
    } finally { try { ws?.destroy(); } catch { /* best effort */ } }
  },
  // Approved artwork becomes real files in the project: a pull request that adds them (you review and merge it like any other change).
  async publishAssets(id, did, { dir: target = 'assets' } = {}) {
    const p = this.project(id); const pd = this._designDir(id); const d = ds.getDesign(pd, did);
    if (d.kind !== 'assets') throw bad('Only a set of assets can be added to the repository'); if (d.status !== 'approved') throw bad('Approve the artwork first');
    const t = String(target).replace(/^\.?\//, '').replace(/\/+$/, ''); if (!/^[A-Za-z0-9._\-]+(\/[A-Za-z0-9._\-]+){0,4}$/.test(t) || t.split('/').some((x) => x === '..' || x.startsWith('.git'))) throw bad('That folder is not allowed (use something like assets/brand or public/images)');
    const files = ds.readAssets(pd, did, d.approvedVersion); const dd = this.deps(p); const branch = `factory/assets-${did}-${Date.now().toString(36)}`; let ws;
    try {
      ws = await dd.sandbox.create({ cloneUrl: dd.config.cloneUrl, branch, base: p.base, gitEnv: dd.config.gitEnv, depth: 1 });
      for (const f of files) { const full = path.join(ws.dir, t, `${f.name}.svg`); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, `${f.svg}\n`); }
      if (!(await dd.vcs.diffStat(ws))) return { published: false, message: 'The repository already has these files.' };
      await dd.vcs.commitAndPush(ws, { branch, message: `Add artwork: ${d.title}` });
      const url = await dd.vcs.openPr(ws, { branch, base: p.base, repo: p.repo, title: `Add artwork: ${d.title}`, body: `Added by Agent Factory from the approved design "${d.title}" (version ${d.approvedVersion}).\n\nFiles in \`${t}/\`: ${files.map((f) => `\`${f.name}.svg\``).join(', ')}.\n\nReview the artwork and merge. Nothing else changes.` });
      ds.setPublished(pd, did, { dir: t, pr: url ?? branch }); this._audit({ what: 'design', project: id, design: did, action: 'published', dir: t }); return { published: true, pr: url ?? branch, dir: t };
    } finally { try { ws?.destroy(); } catch { /* best effort */ } }
  },
};
