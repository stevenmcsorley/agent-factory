// The design stage: design first, then build; every ticket is told which screen it builds; reviewers get an objective design check; drift; restyle; match.
import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import * as ds from '../src/designs.mjs';
import { callOp } from '../src/ops.mjs';
import { ticketPages, areaOfPage, htmlFiles, planPages, headingsOf, navLinksOf, conformance } from '../src/designphase.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const page = (h1, nav = ['Home', 'Shop']) => `<!doctype html><html><body><header><nav>${nav.map((n) => `<a href="#">${n}</a>`).join('')}</nav></header><main><h1>${h1}</h1><h2>Shop by problem</h2></main></body></html>`;

// A factory whose designer is scripted: it draws a page named in the prompt, or two SVGs for an artwork set, and remembers every prompt it was given.
function world() {
  const root = tmp(); const prompts = [];
  const sandbox = { create: async ({ cloneUrl, branch, base, newBranch }) => { const dir = fs.mkdtempSync(path.join(root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', newBranch === false && branch !== 'design' && branch !== 'screens' ? branch : base, cloneUrl, dir]); return { dir, cloneUrl, destroy() {} }; }, exec: async () => ({ code: 0, out: '' }) };
  const agent = { run: async (_sb, ws, prompt) => { if (!/## What to (design|draw)/.test(prompt)) return { out: 'ok', costUsd: 0 }; prompts.push(prompt); const out = path.join(ws.dir, '.factory-design');
    if (/## What to draw/.test(prompt)) { write(path.join(out, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'); write(path.join(out, 'assets', 'hero.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>'); }
    else write(path.join(out, 'design.html'), page(/the (\S+\.html) page/.exec(prompt)?.[1] ?? 'page').replace('<header>', '<style>body { margin: 0; color: #222 }</style><header>')); return { out: 'designed', costUsd: 0 }; } };
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { sandbox, agent } });
  return { e, root, prompts };
}
const EPICS = [{ id: 's', title: 'Site', goal: 'g', tickets: [
  { id: 'foundation', title: 'Foundation', size: 'M', dependsOn: [], body: 'Creates: `index.html`, `styles.css`.\nBuild the shared shell with a test that checks it.' },
  { id: 'about', title: 'About page', size: 'S', dependsOn: ['foundation'], body: 'Creates: `about.html`.\nBuild the about page with a test that checks it.' }] }];
async function project(w, { mode, unattended } = {}) {
  await w.e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } }); w.e.setVerify('app', { verify: 'npm test' });
  w.e.setPack('app', { brief: { goal: 'A small shop site for tenement flats.', scope: '- `index.html` Home.\n- `about.html` About.' } }); if (mode) w.e.setDesignPhase('app', mode);
  if (unattended) { w.e.setAutonomyAllowed({ allow: true }); w.e.setUnattended('app', { designs: false }); }
  await callOp(w.e, 'set_plan', { project: 'app', epics: EPICS });
}
const settle = async (w) => { for (let i = 0; i < 300 && (w.e._designPass?.get('app')?.state === 'running' || w.e.designJobs?.size); i++) await new Promise((r) => setTimeout(r, 40)); };

test('helpers: which pages a ticket builds, area names, headings and navigation, and what a built page lacks', () => {
  assert.deepEqual(ticketPages('Creates: `shop.html`, `images/x.svg`.\nAppends to: `index.html`'), ['shop.html']); assert.deepEqual(ticketPages('Builds: `about.html`'), ['about.html']); assert.deepEqual(ticketPages('Appends to: `index.html`'), []);
  assert.equal(areaOfPage('measuring-guide.html'), 'measuring-guide'); assert.deepEqual(htmlFiles('`a.html` and `B.html` and `c.css`'), ['a.html', 'b.html']); assert.deepEqual(planPages({ epics: EPICS }), ['index.html', 'about.html']);
  assert.deepEqual(headingsOf('<h1>Make  your <b>home</b></h1><h2>Shop</h2><h4>x</h4>'), ['make your home', 'shop']); assert.deepEqual(navLinksOf(page('x', ['Home', 'Shop'])), ['home', 'shop']);
  const c = conformance(page('Hello'), page('Hello', ['Home'])); assert.deepEqual(c.missingNav, ['shop']); assert.equal(c.ok, false); assert.equal(conformance(page('Hello'), page('Hello')).ok, true); assert.deepEqual(conformance(page('Hello'), page('Bye')).missingHeadings, ['hello']);
});

test('design stage: launching a plan for a project with a UI designs first; no build ticket exists until the designs are approved; then the first is released and stamped with the design versions', async () => {
  const w = world(); await project(w); await w.e.launchPlan('app'); await settle(w);
  const st = w.e.designPhaseStatus('app'); assert.equal(st.required, true); assert.deepEqual(st.pages, ['index.html', 'about.html']); assert.equal(st.state, 'review', 'made, waiting for you'); assert.equal(st.designs.length, 3);
  assert.equal((await w.e.getPlan('app')).progress.queued, 0, 'no ticket was created while the designs await approval'); assert.deepEqual(await w.e.releasePlan('app'), { released: 0, waiting: 'designs', design: 'review' });
  const r = await callOp(w.e, 'approve_designs', { project: 'app' }); assert.equal(r.approved.length, 3); assert.equal(r.state, 'approved');
  for (let i = 0; i < 100 && (await w.e.getPlan('app')).progress.queued < 1; i++) await new Promise((x) => setTimeout(x, 40)); const g = await w.e.getPlan('app'); assert.equal(g.progress.queued, 1, 'the first ticket is released now');
  const t = g.plan.epics[0].tickets[0]; assert.deepEqual(Object.keys(t.designVersions).sort(), ['about', 'index'], 'stamped with the design versions it was built from');
});

test('design stage: an unattended project approves its own designs and carries straight on', async () => {
  const w = world(); await project(w, { unattended: true }); await w.e.launchPlan('app'); await settle(w);
  assert.equal(w.e.designPhaseStatus('app').state, 'approved'); await w.e.releasePlan('app'); assert.equal((await w.e.getPlan('app')).progress.queued, 1);
});

test('design stage: off means off, auto skips a project with no pages, skip and retry work, and a failed designer blocks until retried or skipped', async () => {
  let w = world(); await project(w, { mode: 'off' }); await w.e.launchPlan('app'); assert.equal(w.e.designPhaseStatus('app').required, false); assert.equal((await w.e.getPlan('app')).progress.queued, 1, 'no design stage: builds at once');
  w = world(); await w.e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } }); w.e.setPack('app', { brief: { goal: 'A command line tool that sorts files.', scope: '- sort by date' } });
  await callOp(w.e, 'set_plan', { project: 'app', epics: [{ id: 'e', title: 'E', goal: 'g', tickets: [{ id: 'sort', title: 'Sort', size: 'S', dependsOn: [], body: 'Add sorting in sort.js with a test that checks it.' }] }] }); await w.e.launchPlan('app'); assert.equal(w.e.designPhaseStatus('app').required, false, 'auto: no pages, no UI, no design stage');
  assert.throws(() => w.e.setDesignPhase('app', 'sometimes'), /auto, on, off/);
  w = world(); await project(w); w.e.assertAgentAvailable = () => { throw Object.assign(new Error('The usage limit is reached'), { status: 429 }); }; await w.e.launchPlan('app'); assert.equal(w.e.designPhaseStatus('app').state, 'failed'); assert.equal((await w.e.getPlan('app')).progress.queued, 0, 'blocked');
  delete w.e.assertAgentAvailable; await callOp(w.e, 'retry_design_phase', { project: 'app' }); await settle(w); assert.equal(w.e.designPhaseStatus('app').state, 'review');
  w = world(); await project(w); w.e.assertAgentAvailable = () => { throw new Error('limit'); }; await w.e.launchPlan('app'); const s = await callOp(w.e, 'skip_design_phase', { project: 'app' }); assert.equal(s.state, 'skipped'); await w.e.releasePlan('app'); assert.equal((await w.e.getPlan('app')).progress.queued, 1);
});

test('each ticket is told which approved screen it builds (and only that), plus the artwork; reviewers are told to compare', async () => {
  const w = world(); await project(w, { unattended: true }); await w.e.launchPlan('app'); await settle(w); const p = w.e.project('app'); const dir = w.e._packDir('app');
  const idx = ds.listDesigns(dir).find((d) => d.area === 'index'); const hint = w.e._ticketDesignHint(p, EPICS[0].tickets[0]);
  assert.match(hint, new RegExp(`index\\.html: the approved screen is \\.factory-context/designs/${idx.id}\\.html`)); assert.doesNotMatch(hint, /about\.html:/, 'only the page this ticket builds'); assert.match(hint, /approved artwork is in .*logo\.svg/); assert.match(hint, /Reviewers: compare/);
  assert.equal(w.e._ticketDesignHint(p, { body: 'Add sorting.' }), '', 'a ticket that builds no page gets nothing');
  const ctx = w.e.deps(p).config.contextFor({ id: 1, title: 'Foundation', body: EPICS[0].tickets[0].body }); assert.match(ctx, /This ticket builds a designed screen/);
});

test('reviewers get an objective design check: missing headings and navigation, a missing page', async () => {
  const w = world(); await project(w, { unattended: true }); await w.e.launchPlan('app'); await settle(w); const p = w.e.project('app'); const ws = tmp();
  write(path.join(ws, 'index.html'), page('Index', ['Home'])); const t = w.e._designCheckText(p, EPICS[0].tickets[0], ws); assert.match(t, /index\.html: differs from its approved design/); assert.match(t, /Missing navigation links: "shop"/);
  write(path.join(ws, 'index.html'), page('index.html')); assert.match(w.e._designCheckText(p, EPICS[0].tickets[0], ws), /has all 2 headings and 2 navigation links/); fs.rmSync(path.join(ws, 'index.html')); assert.match(w.e._designCheckText(p, EPICS[0].tickets[0], ws), /the page does not exist/);
});

test('drift: a design approved after (or changed since) a page was built shows which pages no longer match', async () => {
  const w = world(); await project(w, { unattended: true }); await w.e.launchPlan('app'); await settle(w); const dir = w.e._packDir('app'); const pack = (await import('../src/pack.mjs')).loadPack(dir);
  for (const t of pack.plan.epics[0].tickets) { t.status = 'done'; t.designVersions = { index: 1, about: 1 }; } (await import('../src/pack.mjs')).savePack(dir, pack); assert.deepEqual(w.e.designDrift('app'), []);
  const about = ds.listDesigns(dir).find((d) => d.area === 'about'); ds.addVersion(dir, about.id, { html: page('About v2'), by: 'you', rationale: 'changed' }); w.e.setDesignStatus('app', about.id, 'approved', 2);
  assert.deepEqual(w.e.designDrift('app').map((x) => [x.page, x.builtFrom, x.current]), [['about.html', 1, 2]]);
});

test('match designs: shared look first, then the artwork, then one ticket per page; refuses while a plan is running; launches when asked', async () => {
  const w = world(); await project(w, { unattended: true }); await w.e.launchPlan('app'); await settle(w); const dir = w.e._packDir('app'); const pk = await import('../src/pack.mjs');
  await assert.rejects(() => w.e.matchDesigns('app', {}), /launched and is not finished yet/); const pack = pk.loadPack(dir); pack.plan.status = 'complete'; pk.savePack(dir, pack);
  const r = await callOp(w.e, 'match_designs', { project: 'app', all: true, launch: false }); assert.equal(r.created, true); assert.equal(r.launched, false); const ts = pk.loadPack(dir).plan.epics[0].tickets;
  assert.deepEqual(ts.map((t) => t.id), ['shared-look', 'use-artwork', 'match-index', 'match-about']); assert.deepEqual(ts[3].dependsOn, ['shared-look', 'use-artwork']); assert.deepEqual(ticketPages(ts[3].body), ['about.html']); assert.match(ts[2].body, /approved screen \(.factory-context\/designs\//);
});

test('restyle: designs the new direction for the key pages from what exists, approved automatically when unattended, then plans and launches the match tickets', async () => {
  const w = world(); await project(w, { unattended: true }); const pk = await import('../src/pack.mjs'); const dir = w.e._packDir('app'); const pack = pk.loadPack(dir); pack.plan = null; pk.savePack(dir, pack);
  await assert.rejects(() => w.e.restyleProject('app', { direction: 'darker' }), /sentence or two/); const r = await w.e.restyleProject('app', { direction: 'A warmer, more editorial look with a new logo and illustrations.', pages: ['index.html'] });
  assert.equal(r.started, true); assert.equal(r.assets, true, 'a new logo was asked for, so artwork is drawn too'); for (let i = 0; i < 300 && (w.e._designPass.get('app')?.state === 'running' || pk.loadPack(dir).plan?.status !== 'launched'); i++) await new Promise((x) => setTimeout(x, 40));
  assert.match(w.prompts.join('\n'), /The owner wants a restyle/); assert.match(w.prompts.join('\n'), /warmer, more editorial/); const plan = pk.loadPack(dir).plan; assert.equal(plan.status, 'launched'); assert.deepEqual(plan.epics[0].tickets.map((t) => t.id), ['shared-look', 'use-artwork', 'match-index']);
  assert.equal(pk.loadPack(dir).restyle.direction.startsWith('A warmer'), true);
});

test('design phase over MCP: status, mode and the new operations exist', async () => {
  const w = world(); await project(w); const s = await callOp(w.e, 'design_phase_status', { project: 'app' }); assert.equal(s.mode, 'auto'); assert.equal(s.wants, true); assert.equal((await callOp(w.e, 'set_design_phase', { project: 'app', mode: 'off' })).mode, 'off');
});

test('token economy: a ticket told which screen it builds gets the slim design context (one shared stylesheet, no designer chatter); other tickets get the full one', async () => {
  const w = world(); await project(w, { unattended: true }); await w.e.launchPlan('app'); await settle(w); const p = w.e.project('app'); const dir = w.e._packDir('app');
  const css = (s) => (s.match(/```css/g) ?? []).length; const full = ds.designContext(dir); const slim = ds.designContext(dir, { slim: true });
  assert.equal(css(full), 2, 'full: a stylesheet per screen'); assert.equal(css(slim), 1, 'slim: only the shared one'); assert.ok(slim.length < full.length); assert.match(slim, /Full mockup: \.factory-context\/designs\//, 'every screen is still listed with its mockup path');
  const withPage = w.e.deps(p).config.contextFor({ id: 1, title: 'Foundation', body: EPICS[0].tickets[0].body }); const noPage = w.e.deps(p).config.contextFor({ id: 2, title: 'Sort', body: 'Add sorting in sort.js.' });
  assert.equal(css(withPage), 1); assert.equal(css(noPage), 2);
});

test('token economy: reviewers get what they need (brief, this ticket\'s screen and sources) and not the builder\'s skills, parts or every stylesheet', async () => {
  const w = world(); await project(w, { unattended: true }); await w.e.launchPlan('app'); await settle(w); const p = w.e.project('app'); const cfg = w.e.deps(p).config; const t = { id: 1, title: 'Foundation', body: EPICS[0].tickets[0].body };
  const builder = cfg.contextFor(t); const reviewer = cfg.reviewContextFor(t);
  assert.match(reviewer, /Project brief/); assert.match(reviewer, /This ticket builds a designed screen/); assert.doesNotMatch(reviewer, /```css/); assert.ok(reviewer.length < builder.length, 'smaller than the builder\'s');
});

test('a failed design does not stop the others, is tried twice, is reported plainly, and its page is not counted as designed', async () => {
  const src = fs.readFileSync(new URL('../src/engine-unattended.mjs', import.meta.url), 'utf8');
  assert.match(src, /for \(let attempt = 1; attempt <= 2 && !ok; attempt\+\+\)/, 'two tries per design'); assert.match(src, /st\.failed\.push\(/, 'a job that still fails is recorded and the loop carries on'); assert.match(src, /The other designs were made\. Run it again to retry just the missing ones/); assert.match(src, /d\.status !== 'failed'\);\s*\/\/ a design that failed is not a design/);
  const dp = fs.readFileSync(new URL('../src/engine-designphase.mjs', import.meta.url), 'utf8'); assert.match(dp, /this\._designPass\?\.get\(id\)\?\.state === 'failed'\) return this\.designProject\(id, \{\}\)/, 'retry works for a failed restyle or unattended design pass too'); assert.match(dp, /Nothing to retry/);
});
