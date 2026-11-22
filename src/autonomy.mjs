// Autonomous mode: when a project is allowed to merge its own pull requests with no human approval.
// This overrides the factory's "never merges" default, so it is opt-in twice (the factory-wide switch AND the project's own mode),
// and every condition below must hold for every merge. The decision is a pure function so the exact reasons can be shown and tested.
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export const AUTONOMY_DEFAULTS = { mode: 'off', requireReviewer: true, requireChecks: true, maxMergesPerDay: 5, fixFailures: true, fixAttemptsPerWorkflow: 2, fixReviewRounds: 2, autoResolveConflicts: true };

export function normalizeAutonomy(input, current = {}) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('autonomy must be an object like { mode: "merge" }');
  const known = Object.keys(AUTONOMY_DEFAULTS); const unknown = Object.keys(input).filter((k) => !known.includes(k)); if (unknown.length) throw bad(`"${unknown[0]}" is not an autonomy setting. Settings: ${known.join(', ')}`);
  const out = { ...AUTONOMY_DEFAULTS, ...current };
  if (input.mode !== undefined) { if (!['off', 'merge'].includes(input.mode)) throw bad('mode must be "off" or "merge"'); out.mode = input.mode; }
  for (const k of ['requireReviewer', 'requireChecks', 'fixFailures', 'autoResolveConflicts']) if (input[k] !== undefined) { if (typeof input[k] !== 'boolean') throw bad(`${k} must be true or false`); out[k] = input[k]; }
  for (const [k, max, min] of [['maxMergesPerDay', 100, 1], ['fixAttemptsPerWorkflow', 5, 1], ['fixReviewRounds', 5, 0]]) if (input[k] !== undefined) { const n = Number(input[k]); if (!Number.isInteger(n) || n < min || n > max) throw bad(`${k} must be a whole number from ${min} to ${max}`); out[k] = n; }
  return out;
}

// May this pull request be merged now? { ok, blockers: [why not] }. `run` is the factory's record of the run that opened it.
export function mergeVerdict({ global, auto, run, feedback, seenComments = [], mergedToday = 0 }) {
  const b = [];
  if (!global?.allow) b.push('autonomous merging is switched off for the whole factory');
  if (auto?.mode !== 'merge') b.push('this project is not in autonomous mode');
  if (!run) b.push('the factory did not open this pull request');
  else {
    if (run.status !== 'ok') b.push(`its run ended "${run.status}"`);
    if (run.quality && run.quality.passed === false) b.push('the quality gate flagged the change');
    if (auto?.requireChecks !== false && !run.verifyCmd) b.push('no test command checked this change');
    if (auto?.requireChecks !== false && run.coverage?.uncovered?.length) b.push(`the test command does not cover ${run.coverage.uncovered.slice(0, 3).join(', ')}${run.coverage.uncovered.length > 3 ? '…' : ''}`);
    if (run.visual && (run.visual.status === 'fail' || (run.visual.status === 'error' && auto?.requireChecks !== false))) b.push(run.visual.status === 'fail' ? 'the visual check found new problems' : 'the visual check could not run');
    if (run.review?.verdict === 'changes') b.push('the reviewer asked for changes');
    else if (auto?.requireReviewer !== false && run.review?.verdict !== 'approve') b.push(run.review ? 'the reviewer did not approve' : 'no reviewer agent has approved it');
  }
  if (feedback?.pending) b.push('checks are still running');
  if (feedback?.failedChecks?.length) b.push(`checks failed: ${feedback.failedChecks.slice(0, 3).map((c) => c.name).join(', ')}`);
  const unread = (feedback?.comments ?? []).filter((c) => !seenComments.includes(c.id)); if (unread.length) b.push(`${unread.length} review comment${unread.length === 1 ? '' : 's'} not yet handled`);
  if (mergedToday >= (auto?.maxMergesPerDay ?? AUTONOMY_DEFAULTS.maxMergesPerDay)) b.push(`today's limit of ${auto?.maxMergesPerDay ?? AUTONOMY_DEFAULTS.maxMergesPerDay} automatic merges is reached`);
  return { ok: b.length === 0, blockers: b };
}

// The ticket the factory files when the pipeline breaks after a merge. Concrete enough to pass the clarity gate and to start from.
export function fixTicket(f, { verify } = {}) {
  const title = `Fix failing "${f.workflow}" after merge${f.pr ? ` of PR #${f.pr}` : ''}`;
  const body = [`The "${f.workflow}" pipeline is failing on the base branch${f.sha ? ` at commit ${f.sha}` : ''}${f.pr ? `, right after PR #${f.pr} was merged` : ''}.`,
    f.headline ? `Last change: ${f.headline}` : '', f.url ? `Failing run: ${f.url}` : '', '',
    'What to do:', `1. Reproduce the failure locally${verify ? ` by running \`${verify}\`` : ' by running the project\'s test and build commands'}.`,
    '2. Find the cause (start with the files changed by the last merge) and fix it with the smallest change.',
    '3. Add or adjust a test so this failure cannot return unnoticed.',
    'Done means: the test and build commands pass locally, and the change touches only what the fix needs.'].filter((x) => x !== '').join('\n');
  return { title, body };
}
