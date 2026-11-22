// The design stage: design is stage zero of a plan for a project with a UI (the way a studio designs the whole site before building it). The designer makes one screen
// per page and the artwork, they are approved (by you, or automatically when the project runs unattended), and only then are build tickets released. Every
// ticket is told which approved screen it builds, reviewers check the change against it, and a design that changes later shows which pages have drifted.
// Also the restyle flow for an existing project: new designs for a rebrand or restyle, then tickets that make the real pages match them.
// Installed on Engine.prototype (see the bottom of engine.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as pk from './pack.mjs';
import * as ds from './designs.mjs';
import { htmlFiles, areaOfPage, pageOfArea, ticketPages, planPages, planTickets, conformance } from './designphase.mjs';
import { hostKind } from './hosts.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const MODES = ['auto', 'on', 'off'];
const approvedScreens = (dir) => ds.listDesigns(dir).filter((d) => d.status === 'approved' && d.approvedVersion && d.kind !== 'assets');
const approvedAssets = (dir) => ds.listDesigns(dir).filter((d) => d.status === 'approved' && d.approvedVersion && d.kind === 'assets');

export const designPhaseMethods = {
  designMode(p) { return MODES.includes(p.designPhase) ? p.designPhase : 'auto'; },
  setDesignPhase(id, mode) { const p = this.project(id); if (!MODES.includes(mode)) throw bad(`mode must be one of ${MODES.join(', ')}`); const before = this.designMode(p); if (mode === 'auto') delete p.designPhase; else p.designPhase = mode; this._persist(); this._audit({ what: 'design-phase', project: id, from: before, to: mode }); return this.designPhaseStatus(id); },
  // Does this project want a design stage? auto = yes when the brief or the plan names HTML pages (it has a UI); on/off are explicit.
  _wantsDesigns(p, pack) { const m = this.designMode(p); if (m === 'off') return false; if (m === 'on') return true; return htmlFiles(pack.brief?.scope).length > 0 || planPages(pack.plan).length > 0; },
  _designPages(pack) { const found = [...new Set([...planPages(pack.plan), ...htmlFiles(pack.brief?.scope)])]; return (found.length ? found : ['index.html']).slice(0, 5); },

  // Where the stage stands: none | pending | running | review (made, waiting for approval) | approved | failed | skipped
  designPhaseState(id, pack) {
    pack ??= pk.loadPack(this._packDir(id)); const d = pack.plan?.design; if (!d?.required) return { state: 'none' }; if (d.skipped) return { state: 'skipped' };
    const pass = this._designPass?.get(id); if (pass?.state === 'running') return { state: 'running', done: pass.done, total: pass.total };
    if (pass?.state === 'failed' && !d.retried) return { state: 'failed', error: pass.error };
    const dir = this._packDir(id); const all = ds.listDesigns(dir).filter((x) => x.status !== 'archived'); const need = (d.pages ?? []).map(areaOfPage);
    const okScreen = (a) => all.some((x) => x.kind !== 'assets' && x.area === a && x.status === 'approved'); const haveScreen = (a) => all.some((x) => x.kind !== 'assets' && x.area === a && x.versions.length);
    const assetsOk = !d.assets || all.some((x) => x.kind === 'assets' && x.status === 'approved'); const assetsHave = !d.assets || all.some((x) => x.kind === 'assets' && x.versions.length);
    if (need.every(okScreen) && assetsOk) return { state: 'approved' }; if (need.every(haveScreen) && assetsHave) return { state: 'review' }; return { state: 'pending' };
  },
  // Why build tickets must wait (null when they may be released).
  designPhaseBlock(id, pack) { const s = this.designPhaseState(id, pack); return ['pending', 'running', 'review', 'failed'].includes(s.state) ? s : null; },
  designPhaseStatus(id) {
    const p = this.project(id); const pack = pk.loadPack(this._packDir(id)); const dir = this._packDir(id); const s = this.designPhaseState(id, pack); const d = pack.plan?.design ?? null;
    const designs = ds.listDesigns(dir).filter((x) => x.status !== 'archived').map((x) => ({ id: x.id, title: x.title, kind: x.kind ?? 'screen', area: x.area ?? null, status: x.status, version: x.approvedVersion ?? x.versions.at(-1)?.n ?? null, versions: x.versions.length, error: x.error ?? null }));
    return { project: id, mode: this.designMode(p), wants: this._wantsDesigns(p, pack), ...s, required: !!d?.required, pages: d?.pages ?? [], assets: !!d?.assets, designs, drift: this.designDrift(id), restyle: pack.restyle ?? null };
  },
  // Approve every design that has a version and is waiting: the "yes, build from these" for the whole stage.
  approveDesigns(id) {
    const dir = this._packDir(id); const out = []; for (const x of ds.listDesigns(dir).filter((y) => y.status !== 'archived' && y.status !== 'approved' && y.versions.length)) { try { this.setDesignStatus(id, x.id, 'approved', x.versions.at(-1).n); out.push(x.title); } catch { /* one that cannot be approved stays as it is */ } }
    this._audit({ what: 'design-phase', project: id, action: 'approved-all', count: out.length }); this.releasePlan(id).catch(() => {}); return { approved: out, ...this.designPhaseStatus(id) };
  },
  skipDesignPhase(id) { const dir = this._packDir(id); const pack = pk.loadPack(dir); if (!pack.plan?.design?.required) throw bad('This plan has no design stage'); pack.plan.design.skipped = true; pk.savePack(dir, pack); this._audit({ what: 'design-phase', project: id, action: 'skipped' }); this.releasePlan(id).catch(() => {}); return this.designPhaseStatus(id); },
  retryDesignPhase(id) { const dir = this._packDir(id); const pack = pk.loadPack(dir); if (!pack.plan?.design?.required) throw bad('This plan has no design stage'); this._designPass?.delete(id); return this.designProject(id, { pages: pack.plan.design.pages, assets: pack.plan.design.assets, approve: this._autoApproveDesigns(this.project(id)) }); },
  _autoApproveDesigns(p) { return p.autonomy?.mode === 'merge' && !!this.cfg.autonomy?.allow; },
  // Called when a plan is launched: record that this plan starts with a design stage and start the designer. Unattended projects approve as they go; otherwise it waits for you.
  async _beginDesignPhase(id) {
    const p = this.project(id); const dir = this._packDir(id); const pack = pk.loadPack(dir); if (!pack.plan || pack.plan.design || !this._wantsDesigns(p, pack)) return null;
    pack.plan.design = { required: true, pages: this._designPages(pack), assets: true, startedAt: new Date().toISOString(), autoApprove: this._autoApproveDesigns(p) }; pk.savePack(dir, pack);
    try { this.designProject(id, { pages: pack.plan.design.pages, assets: true, approve: pack.plan.design.autoApprove }); } catch (e) { this._designPass ??= new Map(); this._designPass.set(id, { state: 'failed', error: String(e.message ?? e).slice(0, 300), total: 0, done: 0 }); }
    return this.designPhaseState(id, pk.loadPack(dir));
  },

  // ---- every ticket is told which approved screen it builds
  _ticketDesignHint(p, t) {
    const dir = this._packDir(p.id); const pages = ticketPages(t?.body); if (!pages.length) return ''; const screens = approvedScreens(dir); const art = approvedAssets(dir); const out = [];
    for (const f of pages) { const d = screens.find((x) => x.area === areaOfPage(f)); if (d) out.push(`- ${f}: the approved screen is .factory-context/designs/${d.id}.html ("${d.title}", version ${d.approvedVersion}). Open it before you start.`); }
    if (!out.length && !art.length) return '';
    return [`### This ticket builds a designed screen`, out.length ? `Build exactly what the approved design shows: the same section order, markup patterns, class names and styles. Where the written copy source differs in wording from the mockup, the copy source wins.\n${out.join('\n')}` : '',
      art.length ? `The approved artwork is in .factory-context/designs/${art[0].id}/ (${(art[0].versions.find((v) => v.n === art[0].approvedVersion)?.files ?? []).map((f) => `${f}.svg`).join(', ')}). Use those files (copy the ones this ticket needs to the paths it names) instead of drawing new ones.` : '',
      'Reviewers: compare the change with that screen and flag any major difference in structure, layout or styling.'].filter(Boolean).join('\n');
  },
  // A cheap, objective check for the reviewers: does the built page have the headings and navigation of its design? (Words only; looks stay the reviewers' job.)
  _designCheckText(p, ticket, wsDir) {
    try { const dir = this._packDir(p.id); const pages = ticketPages(ticket?.body); const screens = approvedScreens(dir); const lines = [];
      for (const f of pages) { const d = screens.find((x) => x.area === areaOfPage(f)); if (!d) continue; const file = path.join(wsDir, f);
        if (!fs.existsSync(file)) { lines.push(`${f}: the page does not exist in the change.`); continue; } const c = conformance(ds.readHtml(dir, d.id, d.approvedVersion), fs.readFileSync(file, 'utf8'));
        lines.push(c.ok ? `${f}: has all ${c.designHeadings} headings and ${c.designNav} navigation links of its approved design.` : `${f}: differs from its approved design. ${c.missingHeadings.length ? `Missing headings: ${c.missingHeadings.slice(0, 6).map((h) => `"${h}"`).join(', ')}. ` : ''}${c.missingNav.length ? `Missing navigation links: ${c.missingNav.slice(0, 6).map((h) => `"${h}"`).join(', ')}.` : ''}`.trim()); }
      return lines.length ? `### Automatic design check (headings and navigation compared with the approved screens)\n${lines.join('\n')}` : '';
    } catch { return ''; }
  },

  // ---- drift: an approved design newer than what was built from it
  designDrift(id) {
    try { const dir = this._packDir(id); const pack = pk.loadPack(dir); const out = []; const tickets = planTickets(pack.plan).filter((t) => t.status === 'done');
      for (const d of approvedScreens(dir)) { if (!d.area) continue; const built = tickets.filter((t) => ticketPages(t.body).some((f) => areaOfPage(f) === d.area)); if (!built.length) continue;
        const have = Math.max(0, ...built.map((t) => t.designVersions?.[d.area] ?? 0)); if (d.approvedVersion > have) out.push({ page: pageOfArea(d.area), design: d.title, builtFrom: have || null, current: d.approvedVersion, tickets: built.map((t) => t.id) }); }
      return out; } catch { return []; }
  },
  // Stamped on every ticket as it is released: which version of each screen it was built from.
  _designStamp(id) { try { const dir = this._packDir(id); return Object.fromEntries(approvedScreens(dir).filter((d) => d.area).map((d) => [d.area, d.approvedVersion])); } catch { return {}; } },

  // ---- plan the tickets that make the real pages match the approved designs (after a restyle, or when pages have drifted)
  async matchDesigns(id, { all = false, launch } = {}) {
    const p = this.project(id); const dir = this._packDir(id); const pack = pk.loadPack(dir); const screens = approvedScreens(dir); const art = approvedAssets(dir);
    if (!screens.length && !art.length) throw bad('There are no approved designs to match yet. Approve the designs first.');
    if (pack.plan && pack.plan.status === 'launched') throw bad('A plan is still running. Let it finish (or discard it) before planning the match.', 409);
    const drifted = new Set(this.designDrift(id).map((x) => areaOfPage(x.page))); const pick = screens.filter((d) => d.area && (all || !pack.plan || drifted.size === 0 || drifted.has(d.area))).sort((a, b) => (a.area === 'index' ? -1 : b.area === 'index' ? 1 : a.area.localeCompare(b.area)));   // home first, then alphabetical: the same order every time
    if (!pick.length && !art.length) return { created: false, reason: 'every page already matches its approved design' };
    const rule = 'Change how it looks and how it is laid out, not what it says or does: keep the existing content, links, behaviour and tests working. Only add to or adjust shared files; never recreate them.';
    const tickets = [{ id: 'shared-look', title: 'Apply the shared look from the approved designs', size: 'M', dependsOn: [], body: `Update the shared styles (design tokens, typography, spacing, buttons, cards) and the shared header, navigation and footer so every page uses the look of the approved designs in .factory-context/designs. Appends to: the shared stylesheet and the shared layout. ${rule}\n\nAcceptance: the shared look matches the approved designs; the existing tests pass.` }];
    if (art.length) tickets.push({ id: 'use-artwork', title: 'Use the approved artwork', size: 'S', dependsOn: ['shared-look'], body: `Add the approved artwork files (.factory-context/designs/${art[0].id}/) to the project's images folder and use them where the approved designs show them, instead of any existing placeholders. ${rule}\n\nAcceptance: the artwork loads from local files with alt text; the existing tests pass.` });
    for (const d of pick) tickets.push({ id: `match-${d.area}`, title: `Match ${d.title} to its approved design`, size: 'M', dependsOn: ['shared-look', ...(art.length ? ['use-artwork'] : [])], body: `Builds: \`${pageOfArea(d.area)}\`\nMake the page match its approved screen (.factory-context/designs/${d.id}.html, version ${d.approvedVersion}): the same sections, layout and styling. ${rule}\n\nAcceptance: the page matches its design; every existing test still passes.` });
    pack.plan = pk.normalizePlan({ summary: 'Make the pages match the approved designs', epics: [{ id: 'match-designs', title: 'Match the approved designs', goal: 'The real pages follow the approved designs.', tickets }] }, { sourceIds: pack.sources.map((x) => x.id) }); pack.plan.status = 'proposed'; pack.plan.createdAt = new Date().toISOString(); pk.savePack(dir, pack);
    this._audit({ what: 'match-designs', project: id, tickets: tickets.length });
    if (launch ?? this._autoApproveDesigns(p)) { await this.launchPlan(id); return { created: true, launched: true, tickets: tickets.length }; } return { created: true, launched: false, tickets: tickets.length };
  },

  // ---- restyle / rebrand an existing project: look at what exists, design the new direction, then (when approved) plan the tickets that make the pages match
  _repoPages(p) { try { if (hostKind(p) !== 'local') return []; const gitDir = this._forge(p).repoPath; return execFileSync('git', ['--git-dir', gitDir, 'ls-tree', '-r', '--name-only', p.base ?? 'main'], { stdio: 'pipe' }).toString().split('\n').filter((f) => /^[\w-]+\.html$/i.test(f)).slice(0, 12); } catch { return []; } },
  async restyleProject(id, { direction, pages, assets, approve, match } = {}) {
    const p = this.project(id); const text = String(direction ?? '').trim(); if (text.length < 15) throw bad('Say what the new look should be (a sentence or two at least).'); this.assertAgentAvailable();
    const screens = p.preview ? this.getScreens(id) : null; if (p.preview && !screens?.pages?.length) { try { this.startScreenshots(id); } catch { /* the designer works from the brief and the repository without them */ } }
    const all = this._repoPages(p); const list = Array.isArray(pages) ? pages : pages === 'all' ? all : (all.length ? [all.includes('index.html') ? 'index.html' : all[0], ...all.filter((f) => f !== 'index.html' && f !== all[0]).slice(0, 1)] : ['index.html']);
    const wantArt = assets ?? /brand|logo|illustrat|artwork|icon/i.test(text); const auto = approve ?? this._autoApproveDesigns(p); const dir = this._packDir(id); const pack = pk.loadPack(dir); pack.restyle = { direction: text.slice(0, 1500), at: new Date().toISOString(), pages: list, assets: wantArt }; pk.savePack(dir, pack);
    const r = this.designProject(id, { pages: list.slice(0, 5), assets: wantArt, approve: auto, force: true, extra: `The owner wants a restyle. New direction (data): ${text.slice(0, 1500)}\n\nThis is a redesign of an EXISTING page: keep what the page says and does (its content, features and links), change how it looks. The app as it looks today is in .factory-context/current-screens when screenshots were taken.`, onDone: async () => { if (match ?? auto) await this.matchDesigns(id, { all: true, launch: auto }).catch((e) => this._audit({ what: 'match-designs-error', project: id, error: String(e.message ?? e).slice(0, 200) })); } });
    return { ...r, pages: list, assets: wantArt };
  },
};
