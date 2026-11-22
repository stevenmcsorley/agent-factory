// A fix round for a pull request that autonomous mode is holding because the reviewers asked for changes: check out the PR branch, optionally look at it afresh,
// have the builder address the findings, run the project's checks and the reviewers again, and push. The agent never commits or pushes (this harness does);
// protected paths refuse; nothing here merges. The merge gate decides afterwards, exactly as for any other pull request.
import { startRun, tail, changedFiles } from './trace.mjs';
import { recordRun } from './budget.mjs';
import { effectiveConfig } from './factory.mjs';
import { protectedViolations } from './repoconfig.mjs';
import { feedbackFromReview } from './review.mjs';

export const fixPrompt = (pr, findings) => [
  `You are an autonomous software engineer. You previously opened pull request #${pr.number} ("${pr.title}") on this branch. Independent reviewers asked for changes.`,
  'Make the smallest change that addresses every finding below, without removing what the change is for and without recreating files that already exist. Do not run git commit or git push (the harness does that). Make sure the project\'s tests still pass, and add or adjust a test for anything a finding says is untested.',
  findings,
].join('\n\n');

// deps: the factory-loop bundle (host, sandbox, agent, vcs, config, stateDir). run: the factory's record of the run that opened the PR (its review, verify command, coverage…).
// ticket: {id, title, body}. Returns { status, review, pushed }.
export async function reviewFixRound({ host, sandbox, agent, vcs, config, stateDir }, pr, { run, ticket, reviewFirst = false, round = 1 }) {
  const t = startRun({ prNumber: pr.number, title: `Fix reviewer findings on #${pr.number}: ${pr.title ?? ''}`.trim(), round: 'review-fix', repo: config.repo, costUsd: 0 }, { onEvent: config.onEvent, project: config.projectId });
  const rec = t.rec; let ws; let rv = run?.review ?? null; let pushable = false; let changed = false;
  const review = async () => { t.phase('review', 'the reviewers read the branch'); try { return await config.review({ ws, ticket, context: config.contextFor?.(ticket), role: (n, d) => t.role(n, d), meta: { run: rec.id, ticket: ticket?.id } }); } catch (e) { return { verdict: 'error', summary: String(e.message ?? e).slice(0, 200), findings: [] }; } };
  try {
    t.phase('sandbox', 'cloning the PR branch');
    ws = await sandbox.create({ cloneUrl: config.cloneUrl, branch: pr.branch, base: pr.branch, newBranch: false, gitEnv: config.gitEnv });
    const cfg = effectiveConfig(config, ws.dir);
    if (reviewFirst) { rv = await review(); if (rv.verdict === 'approve') rec.status = 'ok'; }
    if (rec.status !== 'ok') {
      if (!rv || rv.verdict !== 'changes') { rec.status = rv?.verdict === 'error' ? 'review-error' : 'nothing-to-fix'; }
      else {
        let extra = '';
        for (let a = 1; a <= (cfg.maxAttempts ?? 2); a++) {
          t.phase('agent', `addressing ${(rv.findings ?? []).filter((f) => f.severity !== 'minor').length || 'the'} finding(s), attempt ${a}`);
          const r = await agent.run(sandbox, ws, fixPrompt(pr, feedbackFromReview(rv)) + extra, { timeoutMs: cfg.timeoutMs ?? 900_000, meta: { run: rec.id, ref: `PR #${pr.number}` } });
          rec.costUsd += r.costUsd ?? 0; t.note('agentSummary', tail(r.out)); if (r.timedOut) { rec.status = 'timeout'; break; }
          const status = await vcs.diffStat(ws); if (!status) { rec.status = 'no-change'; extra = '\nYou made no changes last time. Make the requested changes.'; continue; }
          changed = true; t.note('changed', changedFiles(status));
          const bad = protectedViolations(status, cfg.protectedPaths); if (bad.length) { rec.status = 'protected-path'; rec.error = `touched protected paths: ${bad.join(', ')}`; changed = false; break; }
          if (cfg.verify) { t.phase('verify', cfg.verify); const v = await sandbox.exec(ws, 'sh', ['-c', cfg.verify], { timeoutMs: cfg.timeoutMs ?? 900_000, image: cfg.image }); t.note('verifyTail', tail(v.out)); if (v.code !== 0) { rec.status = 'verify-failed'; pushable = false; extra = `\n# Verification failed\n${v.out.slice(-3000)}`; continue; } }
          pushable = true; rv = await review(); rec.status = rv.verdict === 'approve' ? 'ok' : 'review-changes'; if (rv.verdict === 'approve') break;
          extra = `\n${feedbackFromReview(rv)}`;
        }
      }
    }
    if (pushable && changed) { t.phase('push', pr.branch); await vcs.commitAndPush(ws, { branch: pr.branch, message: `Address reviewer findings on #${pr.number} (round ${round})\n\nagent-factory` });
      await host.comment(pr, `Autonomous mode addressed the reviewers' findings (round ${round}); the reviewers now say: ${rv?.verdict ?? 'unknown'}.`).catch(() => {}); rec.pushed = true; }
  } catch (e) { rec.status = 'error'; rec.error = String(e.message ?? e); }
  finally {
    rec.finished = new Date().toISOString(); t.finish();
    // A run record that SUPERSEDES the original for this pull request (same pr, new review), so the merge gate reads the latest verdict. Only when the review actually ran.
    const reviewed = rv && rv !== run?.review; const ok = rec.status === 'ok' || rec.status === 'review-changes';
    recordRun(config.runsDir ?? stateDir, reviewed && ok && (rec.pushed || reviewFirst) ? { project: config.projectId, ...run, id: rec.id, started: rec.started, finished: rec.finished, phases: rec.phases, status: 'ok', review: rv, fixRound: round, costUsd: (run?.costUsd ?? 0) + rec.costUsd, agentSummary: rec.agentSummary ?? run?.agentSummary, verifyTail: rec.verifyTail ?? run?.verifyTail }
      : { project: config.projectId, ...rec });
    try { ws?.destroy(); } catch { /* best effort */ }
  }
  return { status: rec.status, review: rv, pushed: !!rec.pushed, error: rec.error };
}
