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
