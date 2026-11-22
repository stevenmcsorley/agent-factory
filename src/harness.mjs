// A harness for each agent: the plain code AROUND a model that makes a cheaper or older one dependable. The model is not trusted on its word: its output must pass a check, a failed check steps the job up
// to the next, stronger model, and what each agent is held to is written down here so it can be shown (Agents -> Who does what) and tested. Models are the interchangeable part; this is the constant part.
import { parseVerdict } from './review.mjs';

// What each agent is held to, in plain words. (`checks` are enforced by the factory, not requested of the model.)
export const HARNESS = {
  builder: { summary: 'Held to its own tests, an honest summary, and the project\'s rules.', checks: ['The project\'s tests must pass', 'Its summary must match what it changed (no tests claimed but not written, none switched off)', 'The quality gate and the design and screen checks must pass', 'A second agent reads the change before it ships'], guards: ['Time limit per attempt', 'A fixed number of attempts, each on the next model step'] },
  fixer: { summary: 'Same checks as the builder, on a pull request that needed changes.', checks: ['The project\'s tests must pass', 'Its summary must match what it changed', 'The reviewer reads it again'], guards: ['A fixed number of fix rounds', 'Each retry steps up a model'] },
  reviewer: { summary: 'Sees only the change and gives a verdict.', checks: ['The answer must be a clear verdict (approve or changes) with findings that name a severity', 'If it is not, the next model does the review'], guards: ['One request, no tools, no wandering around the repository'] },
  security: { summary: 'Looks for security problems in the change.', checks: ['The answer must be a clear verdict', 'If it is not, the next model does it'], guards: ['One request, no tools'] },
  tester: { summary: 'Adds tests for new code.', checks: ['The new tests must pass, otherwise they are undone', 'Only test files may change'], guards: ['Runs once per ticket'] },
  'spec-writer': { summary: 'Turns a ticket into a clear plan of what to build.', checks: ['It must write something real (not empty or a few words)', 'If not, the next model does it'], guards: ['A short piece of writing, no tools'] },
  'skill-writer': { summary: 'Drafts an instruction for the agents.', checks: ['It must write something real', 'Nothing is saved until you approve it'], guards: ['A short piece of writing, no tools'] },
  designer: { summary: 'Makes the screens and artwork.', checks: ['Each screen must exist and be non-empty', 'Built pages are checked against the approved design'], guards: ['You approve the designs before building starts'] },
  planner: { summary: 'Plans the whole project.', checks: ['The plan must be readable and complete', 'You approve it'], guards: ['Everything else follows it, so it stays on the strongest model'] },
};

// Where each agent starts, cheapest first. The usual model is always the last step, added automatically. `evidence` says how sure we are:
// 'measured' = benchmarked here (docs/evidence), 'provisional' = a sensible start that the Improvements page will confirm or call off. An empty list means: the usual model, no steps.
export const DEFAULT_TIERS = {
  reviewer: { models: ['gpt-6-luna'], evidence: 'measured', proof: 'docs/evidence/reviewer-codex-models-2026-11-22.json' },
  security: { models: ['gpt-6-luna'], evidence: 'measured', proof: 'docs/evidence/role-bench-2026-11-22.json' },
  tester: { models: ['gpt-6.1-sol'], evidence: 'provisional' },
  'spec-writer': { models: ['gpt-6-luna'], evidence: 'provisional' },
  'skill-writer': { models: ['gpt-6-luna'], evidence: 'provisional' },
  designer: { models: [], evidence: 'none' },
  planner: { models: [], evidence: 'none' },
  builder: { models: ['gpt-6-luna'], sizes: ['S'], evidence: 'provisional', proof: 'docs/evidence/role-bench-2026-11-22.json' },
  fixer: { models: [], evidence: 'none' },
};

// Is this output usable? The harness never takes a model's word for it.
export function validateOutput(role, out) {
  const t = String(out ?? '').trim(); if (!t) return { ok: false, why: 'it came back empty' };
  if (role === 'reviewer' || role === 'security') { if (parseVerdict(t).verdict === 'error') return { ok: false, why: 'it did not give a clear verdict' }; }
  if ((role === 'spec-writer' || role === 'skill-writer') && t.length < 80) return { ok: false, why: 'it wrote almost nothing' };
  return { ok: true };
}

// ---- is the harness working? Everything is measured from what the factory recorded; nothing here is a claim.
export const HARNESS_SINCE = '2026-11-22T16:35:00Z';   // when the claims check and the model steps went live (override: cfg.harness.since)
const W = (u) => (u.input - (u.cached ?? 0)) + (u.cached ?? 0) * 0.1 + (u.output ?? 0) * 6;
const med = (xs) => { const a = xs.filter(Number.isFinite).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
// usage rows of one provider's builder calls grouped by model: how many jobs, and what a typical job costs
export function costByModel(usage, since = null) {
  const by = {}; for (const u of usage) { if (u.role !== 'builder' || (u.via && u.via !== 'codex') || !u.model) continue; if (since && u.at < since) continue; (by[u.model] ??= []).push(W(u)); }
  return Object.entries(by).map(([model, xs]) => ({ model, costJobs: xs.length, medianTokens: Math.round(med(xs)), totalTokens: Math.round(xs.reduce((a, b) => a + b, 0)) })).sort((a, b) => b.costJobs - a.costJobs);
}
// the plain verdict. `models` = [{ model, jobs, average }] (scores), `cost` = costByModel output, `usual` = the model everything used to run on.
export function harnessVerdict({ models = [], cost = [], usual, minJobs = 6 }) {
  const cheap = models.filter((m) => m.model !== usual); const main = models.find((m) => m.model === usual); const c = (m) => cost.find((x) => x.model === m);
  const best = cheap.sort((a, b) => b.jobs - a.jobs)[0];
  if (!best || best.jobs < minJobs || !main || main.jobs < minJobs) return { state: 'early', text: `Too early to say. ${best ? `${best.model} has built ${best.jobs} job${best.jobs === 1 ? '' : 's'}; ` : 'No cheaper model has built a job yet; '}it needs at least ${minJobs} on each side to compare.`, needs: minJobs };
  const gap = main.average - best.average; const ct = c(best.model)?.medianTokens, cu = c(usual)?.medianTokens; const tokens = ct && cu ? Math.round((100 * (ct - cu)) / cu) : null;
  if (gap > 3) return { state: 'revert', text: `Not holding up: jobs started on ${best.model} score ${best.average}, against ${main.average} on ${usual}. I would put the builder back on the usual model.`, gap, tokens };
  if (tokens != null && tokens > 10) return { state: 'mixed', text: `Same quality (${best.average} against ${main.average}), but ${best.model} uses ${tokens}% more tokens per job. Whether it costs less of your Codex plan cannot be measured here: check your plan usage before keeping it.`, gap, tokens };
  return { state: 'holding', text: `Holding up: same quality (${best.average} against ${main.average})${tokens != null ? ` and ${tokens <= 0 ? `${-tokens}% fewer` : `${tokens}% more`} tokens per job` : ''}.`, gap, tokens };
}
