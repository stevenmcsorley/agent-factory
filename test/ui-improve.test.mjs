// The Improvements page, drawn against REAL data shapes (from a real engine): the suggestion cards, the editable wording, the effect of an applied fix, and the empty state, all in plain words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class El { constructor(t) { this.tag = t; this.nodeType = 1; this.kids = []; this.attrs = {}; this.dataset = {}; this.style = {}; }
  append(...ns) { for (const n of ns) { assert.ok(n && (n.nodeType === 1 || n.nodeType === 3), `bad child: ${n} in <${this.tag}>`); this.kids.push(n); } } replaceChildren(...ns) { this.kids = []; this.append(...ns); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; } addEventListener() {}
  get value() { if (this.tag === 'select') { const o = this.all().filter((x) => x.tag === 'option'); return (o.find((x) => 'selected' in x.attrs) ?? o[0])?.attrs.value ?? ''; } return this.attrs.value ?? ''; } set value(v) { this.attrs.value = v; } get textContent() { return this.kids.map((k) => (k.nodeType === 3 ? k.text : k.textContent)).join(' '); } all() { return this.kids.flatMap((k) => (k.nodeType === 1 ? [k, ...k.all()] : [])); } }
globalThis.document = { createElement: (t) => new El(t), createElementNS: (_n, t) => new El(t), createTextNode: (text) => ({ nodeType: 3, text }) }; globalThis.location = { hash: '', pathname: '/', search: '' };
const { improvePage } = await import('../ui/improve.js'); const { Engine } = await import('../src/engine.mjs'); const { withDefaults } = await import('../src/config.mjs'); const { recordRun } = await import('../src/budget.mjs');
const text = (nodes) => nodes.map((n) => n.textContent).join(' ').replace(/\s+/g, ' ');
const JARGON = [/weighted/i, /\btag\b/i, /\bprovider id\b/i, /\bheuristic/i, /\bregex/i, /finding-/i, /\bJSON\b/, /\bsha\b/i];
let n = 0; const run = (o = {}) => ({ id: `r${(++n).toString(16).padStart(8, '0')}`, project: 'shop', ticket: n, title: `Ticket ${n}`, started: new Date(Date.now() - 86_400_000).toISOString(), status: 'ok', attempts: 1, tokens: { input: 1000, output: 100 }, review: { verdict: 'approve', findings: [] }, ...o });
const changes = (issue) => ({ review: { verdict: 'changes', summary: 'needs work', findings: [{ severity: 'major', issue }] } });
const engine = (runs) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-imp-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} }); for (const r of runs) recordRun(e.cfg.stateDir, r); return e; };
const load = (e) => ({ d: e.improvements({ days: 14 }), rows: e.runScores({ days: 14, limit: 60 }), hz: e.harnessReport({ days: 14 }) });
const all = (nodes) => nodes.flatMap((x) => (x.all ? x.all() : []));

test('improvements: scores, what keeps going wrong, a suggestion with editable wording and plain buttons, and recent jobs', () => {
  const e = engine([...Array.from({ length: 4 }, () => run(changes('Also changes the header outside the ticket scope'))), ...Array.from({ length: 6 }, () => run())]); const nodes = improvePage.draw(load(e), { rerender() {} }); const t = text(nodes);
  for (const re of [/Improvements/, /Nothing changes until you approve it/, /10\s+jobs scored/, /average score/, /done right first time/, /Suggested fixes/, /Keep changes to what the ticket asks for/, /seen in 4 of 10 jobs \(40%\)/, /Give agents this instruction/, /Not now/, /What keeps going wrong/, /It changed things it was not asked to/, /Recent jobs/, /Ticket \d+/]) assert.match(t, re, String(re));
  const ta = all(nodes).find((x) => x.tag === 'textarea'); assert.ok(ta, 'the wording can be edited'); assert.match(ta.textContent, /Do only what the ticket asks/); for (const j of JARGON) assert.doesNotMatch(t, j, `developer wording: ${j}`);
  assert.ok(all(nodes).some((x) => x.tag === 'a' && /^#\/run\//.test(x.attrs.href ?? '')), 'examples link to the job');
});
test('improvements: an applied fix says whether it helped; a dismissed one can be brought back; too few jobs says so', () => {
  const e = engine([...Array.from({ length: 5 }, (_, i) => run({ started: new Date(Date.now() - (6 - i * 0.2) * 86_400_000).toISOString(), ...changes('outside the ticket scope') })), ...Array.from({ length: 6 }, (_, i) => run({ started: new Date(Date.now() - (2 - i * 0.2) * 86_400_000).toISOString() }))]);
  const id = e.improvements({}).ideas[0].id; e.applyImprovement(id); const j = e._impLoad(); j.decisions[id].at = new Date(Date.now() - 3 * 86_400_000).toISOString(); e._impSave(j); const t = text(improvePage.draw(load(e), { rerender() {} }));
  assert.match(t, /Applied/); assert.match(t, /It helped\./); assert.match(t, /Since you applied it: 0%/); assert.doesNotMatch(t, /Give agents this instruction/, 'an applied fix has no apply button');
  const e2 = engine([...Array.from({ length: 4 }, () => run(changes('outside the ticket scope'))), ...Array.from({ length: 6 }, () => run())]); e2.dismissImprovement(e2.improvements({}).ideas[0].id); const t2 = text(improvePage.draw(load(e2), { rerender() {} })); assert.match(t2, /Bring it back/); assert.match(t2, /Not now/);
  const t3 = text(improvePage.draw(load(engine([run(), run()])), { rerender() {} })); assert.match(t3, /Not enough finished jobs yet/); assert.match(t3, /at least 5/); assert.match(text(improvePage.draw(load(engine([])), { rerender() {} })), /jobs scored/, 'an empty factory still draws');
});

test('the harness panel answers "is it working?" in plain words: the verdict, what was caught, step-ups, and the models side by side', () => {
  const e = engine([...Array.from({ length: 6 }, () => run())]); e._audit({ what: 'harness', action: 'step-up', role: 'reviewer', from: 'gpt-6-luna', to: 'gpt-6.2-astra', why: 'it did not give a clear verdict', project: 'p' });
  const r0 = run({ claims: { ok: false, findings: [{ kind: 'claimed-tests-missing', blocking: true, detail: 'The summary says tests were added, but no test file changed.' }] } }); recordRun(e.cfg.stateDir, r0); const t = text(improvePage.draw(load(e), { rerender() {} }));
  for (const re of [/Is the harness working\?/, /Too early to say/, /problems caught/, /jobs stepped up/, /jobs on cheaper models/, /Before the harness/, /Since it went live/, /Right first time/, /reviewer: gpt-6-luna gave way to gpt-6\.2-astra, because it did not give a clear verdict/, /The summary says tests were added/, /Check your plan usage/]) assert.match(t, re, String(re));
  for (const j of JARGON) assert.doesNotMatch(t, j, `developer wording: ${j}`); assert.doesNotMatch(t, /weighted/i);
});
