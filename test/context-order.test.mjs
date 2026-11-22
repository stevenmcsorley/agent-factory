import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import * as pk from '../src/pack.mjs';
import * as ds from '../src/designs.mjs';
import { buildPrompt } from '../src/factory.mjs';

test('the prompt starts with what is the same for every ticket, so a provider can reuse its cache of that beginning; ticket-specific text comes last', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-'));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } }] });
  const e = new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: {} }); const dir = pk.packDir(cfg.stateDir, 'a');
  pk.patchPack(dir, { brief: { goal: 'A small site that sells bespoke shelves to tenement flats', scope: 'Home, gallery, quote form' }, stack: 'Plain HTML and CSS only', decisions: 'Brand: Close' });
  pk.addSourceText(dir, { title: 'Pricing research', kind: 'research', text: 'Shelving prices per metre depend on the oak boards and the number of doors fitted in the alcove.' }); pk.addSourceText(dir, { title: 'Gallery notes', kind: 'research', text: 'The gallery filter groups projects by room: alcoves, bay windows and box rooms.' });
  const d = ds.createDesign(dir, { title: 'Home', request: 'A home page with a hero and a quote button' }); ds.addVersion(dir, d.id, { html: '<html><head><style>:root{--brand:#0f5f63}</style></head><body><h1>Home</h1></body></html>' }); ds.setStatus(dir, d.id, 'approved');
  const ctx = e.deps(e.project('a')).config.contextFor; const t1 = { id: 1, title: 'Build the gallery filter by room', body: 'Filter projects by room: alcoves, bay windows and box rooms.' }; const t2 = { id: 2, title: 'Price the oak shelving per metre', body: 'Show shelving prices per metre for oak boards and doors.' };
  const c1 = ctx(t1), c2 = ctx(t2); assert.notEqual(c1, c2, 'the two tickets get different context');
  let common = 0; while (common < c1.length && c1[common] === c2[common]) common++;
  assert.ok(common > 0.7 * Math.min(c1.length, c2.length) || common > 800, `the shared beginning is long (${common} of ${c1.length}/${c2.length} chars)`);
  const iBrief = c1.indexOf('### Project brief'), iDesign = c1.indexOf('### Approved designs'), iSkills = c1.indexOf('### Skills for this work'), iExcerpt = c1.indexOf('#### Excerpt:');
  assert.ok(iBrief >= 0 && iDesign > iBrief && iSkills > iDesign, 'brief, then approved designs, then skills'); assert.ok(iExcerpt > iSkills, 'the ticket-specific excerpt comes after all the fixed parts');
  assert.match(c1, /Excerpt: Gallery notes/); assert.match(c2, /Excerpt: Pricing research/);
  const p1 = buildPrompt(t1, '', 'profile', c1, 'RULES'), p2 = buildPrompt(t2, '', 'profile', c2, 'RULES'); let pc = 0; while (pc < p1.length && p1[pc] === p2[pc]) pc++; assert.ok(p1.slice(pc).includes('Ticket') || p1.indexOf('# Ticket #1') >= pc - 1, 'the two prompts only part ways late');
  assert.ok(pc > 800, `the prompts share ${pc} characters before they differ`);
  assert.equal(pk.renderContext(pk.loadPack(dir), dir, t1), pk.renderContextParts(pk.loadPack(dir), dir, t1).fixed + '\n\n' + pk.renderContextParts(pk.loadPack(dir), dir, t1).perTicket, 'renderContext still returns everything, for other callers');
});
