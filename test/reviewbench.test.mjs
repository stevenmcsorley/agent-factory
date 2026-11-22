// The reviewer benchmark's own logic, with a scripted agent (no model, no cost): the corpus is real, strategies are isolated as claimed, scoring is right.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CASES, STRATEGIES, buildCase, judge, summarise, runBench, rulesDigest, baseFiles } from '../src/reviewbench.mjs';

const verdict = (v, issue = '', file = 'x') => JSON.stringify({ verdict: v, summary: 's', findings: v === 'changes' ? [{ severity: 'major', file, issue, fix: 'f' }] : [] });
const byId = Object.fromEntries(CASES.map((c) => [c.id, c]));

test('corpus: every case is a real, non-empty git diff; defects and clean changes are balanced the way the score assumes', () => {
  assert.equal(CASES.filter((c) => c.kind === 'defect').length, 8); assert.equal(CASES.filter((c) => c.kind === 'clean').length, 3); assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  for (const c of CASES) { const b = buildCase(c); try { assert.match(b.diff, /^diff --git /m, c.id); assert.ok(b.diff.length < 6000, `${c.id} diff is small`); } finally { b.cleanup(); } }
  const rule = buildCase(byId['repo-rule-description']); try { assert.doesNotMatch(rule.files['contact.html'], /name="description"/, 'the planted page lacks the described meta'); } finally { rule.cleanup(); }
  const good = buildCase(byId['clean-contact']); try { assert.match(good.files['contact.html'], /name="description"/); } finally { good.cleanup(); }
  assert.match(rulesDigest(baseFiles()), /meta name="description"/, 'the written rule that the repo-rule case breaks is in the digest');
});

test('strategies: only the current reviewer gets the checkout; the others get an EMPTY directory; the atoms are four narrow calls; the rules digest is only where promised', async () => {
  const seen = []; const runAgent = async ({ prompt, dir, meta }) => { seen.push({ s: meta.strategy, atom: meta.atom, entries: fs.readdirSync(dir), prompt }); return verdict('approve'); };
  await runBench({ cases: [byId['missing-alt']], runAgent });
  const by = (s) => seen.filter((x) => x.s === s);
  assert.ok(by('agent')[0].entries.includes('about.html'), 'the full agent has the repository'); for (const s of ['shot', 'shot_rules', 'atoms']) for (const x of by(s)) assert.deepEqual(x.entries, [], `${s} has nothing to explore`);
  assert.equal(by('atoms').length, 4); assert.deepEqual(by('atoms').map((x) => x.atom), ['markup', 'constraints', 'tests', 'scope']);
  assert.doesNotMatch(by('shot')[0].prompt, /written rules|Never weaken or delete a test/); assert.match(by('shot_rules')[0].prompt, /Never weaken or delete a test/); assert.match(by('atoms')[1].prompt, /Never weaken or delete a test/); assert.doesNotMatch(by('atoms')[0].prompt, /Never weaken or delete a test/);
  assert.match(by('shot')[0].prompt, /do not try to open files/i); assert.doesNotMatch(by('agent')[0].prompt, /do not try to open files/i);
});

test('scoring: caught, caught for the wrong reason, missed, passed, false block', () => {
  const d = byId['missing-alt'], clean = byId['clean-css']; const f = (issue) => [{ id: 'r', verdict: 'changes', findings: [{ severity: 'major', file: 'a', issue }] }];
  assert.equal(judge(d, f('the image has no alt text')).outcome, 'caught'); assert.equal(judge(d, f('the heading is too long')).outcome, 'caught-wrong-reason'); assert.equal(judge(d, [{ id: 'r', verdict: 'approve', findings: [] }]).outcome, 'missed');
  assert.equal(judge(d, [{ id: 'r', verdict: 'approve', findings: [{ severity: 'minor', file: 'a', issue: 'alt' }] }]).outcome, 'missed', 'a minor note that does not block is a miss');
  assert.equal(judge(clean, [{ id: 'r', verdict: 'approve', findings: [] }]).outcome, 'passed'); assert.equal(judge(clean, f('something')).outcome, 'false-block');
  assert.equal(judge(d, [{ id: 'a', verdict: 'approve', findings: [] }, { id: 'b', ...f('no alt')[0] }]).outcome, 'caught', 'any specialist saying changes counts');
});

test('a full run: totals add up per strategy, tokens come from the caller, and the atoms count four calls per case', async () => {
  // A scripted reviewer that sees everything except the repo rule unless it is in the prompt or the checkout.
  const runAgent = async ({ prompt, meta }) => { const c = byId[meta.case]; if (c.kind === 'clean') return verdict('approve'); if (c.id === 'repo-rule-description' && !/Never weaken or delete a test/.test(prompt) && meta.strategy !== 'agent') return verdict('approve'); return verdict('changes', `defect: ${c.catches.source.split('|')[0].replace(/\\/g, '')}`); };
  const usage = { input: 1000, cached: 800, output: 100, steps: 2 }; const usageFor = (ref) => (ref.startsWith('bench:atoms') ? { ...usage, input: 400, cached: 100 } : usage);
  const { rows, summary } = await runBench({ runAgent, usageFor });
  assert.equal(rows.length, CASES.length * 4); assert.equal(summary.agent.caught, 8); assert.equal(summary.shot.caught, 7, 'no rules, no repo: it misses the repo-rule defect'); assert.equal(summary.shot_rules.caught, 8); assert.equal(summary.atoms.caught, 8);
  for (const s of Object.values(summary)) { assert.equal(s.defects, 8); assert.equal(s.cleans, 3); assert.equal(s.falseBlocks, 0); }
  assert.equal(summary.agent.calls, 11); assert.equal(summary.atoms.calls, 44); assert.equal(summary.agent.input, 11000); assert.equal(summary.agent.weighted, Math.round(11 * (200 + 80 + 600)));
});

test('summarise: false blocks and wrong-reason catches are counted separately from catches', () => {
  const s = summarise([{ strategy: 'x', kind: 'defect', outcome: 'caught' }, { strategy: 'x', kind: 'defect', outcome: 'caught-wrong-reason' }, { strategy: 'x', kind: 'defect', outcome: 'missed' }, { strategy: 'x', kind: 'clean', outcome: 'false-block' }, { strategy: 'x', kind: 'clean', outcome: 'passed' }]).x;
  assert.deepEqual([s.caught, s.wrongReason, s.missed, s.falseBlocks, s.passed], [1, 1, 1, 1, 1]);
});
