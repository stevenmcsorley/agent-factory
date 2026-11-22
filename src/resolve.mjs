// Resolve merge conflicts on a pull request branch: merge the base branch INTO the branch (so the change keeps its history), hand the conflicted files to the
// agent, check no conflict marker is left and the project's own checks pass, then push the merge commit. The agent never commits or pushes: this harness does.
// Same safety as a feedback round: runs in the sandbox, protected paths refuse, the round is recorded like any other run.
import { startRun, tail, changedFiles } from './trace.mjs';
import { recordRun } from './budget.mjs';
import { effectiveConfig } from './factory.mjs';
import { protectedViolations } from './repoconfig.mjs';
import { run as sh } from './util.mjs';
import { lockGit, SAFE_GIT } from './gitguard.mjs';

const MARKER = /^(<{7}|={7}$|>{7})/m;

export function resolvePrompt(pr, base, files, findings = '') {
  return [
    `You are an autonomous software engineer. Pull request #${pr.number} ("${pr.title}") cannot merge because the base branch "${base}" has changed since it was built. The harness has started merging "${base}" into this branch and the merge stopped on conflicts.`,
    `Resolve every conflict in the working tree. Keep BOTH sides' intent: what the pull request adds, and what ${base} already contains. Where both created the same shared file (a home page, a stylesheet, a test file, package.json), keep ${base}'s version as the foundation and add only what this change genuinely needs on top of it. Do not recreate or duplicate things that already exist.`,
    `Conflicted files:\n${files.map((f) => `- ${f}`).join('\n')}`,
    'Remove every conflict marker (<<<<<<<, =======, >>>>>>>). Do not run git commit, git merge --abort or git push; the harness commits and pushes. Make sure the project\'s tests still pass.',
    findings ? `\n${findings}` : '',
  ].filter(Boolean).join('\n\n');
}

// deps: the same bundle the factory loop uses (host, sandbox, agent, vcs, config, stateDir). `pr`: {number, branch, title}. Returns the run record.
export async function resolveConflicts({ host, sandbox, agent, vcs, config, stateDir }, pr, { base = 'main', findings = '' } = {}) {
  const run = startRun({ pr: pr.number, prNumber: pr.number, title: `Resolve conflicts on #${pr.number}: ${pr.title ?? ''}`.trim(), round: 'conflicts', repo: config.repo, costUsd: 0 }, { onEvent: config.onEvent, project: config.projectId });
  const rec = run.rec; let ws; const git = (args, o = {}) => sh('git', [...SAFE_GIT, ...args], { cwd: ws.dir, ...o });
  try {
    run.phase('sandbox', 'cloning the PR branch');
    ws = await sandbox.create({ cloneUrl: config.cloneUrl, branch: pr.branch, base: pr.branch, newBranch: false, gitEnv: config.gitEnv });
    lockGit(ws.dir, ws.cloneUrl);
    run.phase('merge', `merging ${base} into ${pr.branch}`);
    const f = await git(['fetch', 'origin', base]); if (f.code !== 0) throw new Error(`could not fetch ${base}: ${f.out.slice(0, 200)}`);
    const m = await git(['-c', 'user.name=Agent Factory', '-c', 'user.email=agent-factory@localhost', 'merge', '--no-commit', '--no-ff', `origin/${base}`]);
    const conflicted = (await git(['diff', '--name-only', '--diff-filter=U'])).out.split('\n').map((x) => x.trim()).filter(Boolean);
    if (m.code === 0 && !conflicted.length) { const merging = (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0; rec.status = merging ? 'ok' : 'no-change'; run.note('agentSummary', merging ? `${base} merged into the branch cleanly: nothing to resolve.` : `The branch already contains ${base}.`); }
    else {
      if (!conflicted.length) throw new Error(`the merge failed without conflicts: ${m.out.slice(0, 200)}`);
      run.note('conflicts', conflicted); const cfg = effectiveConfig(config, ws.dir); let extra = '';
      for (let a = 1; a <= (cfg.maxAttempts ?? 2); a++) {
        run.phase('agent', `resolving ${conflicted.length} file${conflicted.length === 1 ? '' : 's'}, attempt ${a}`);
        const r = await agent.run(sandbox, ws, resolvePrompt(pr, base, conflicted, findings) + extra, { timeoutMs: cfg.timeoutMs ?? 900_000, meta: { run: rec.id, ref: `PR #${pr.number}` } });
        rec.costUsd += r.costUsd ?? 0; run.note('agentSummary', tail(r.out)); if (r.timedOut) { rec.status = 'timeout'; break; }
        await git(['add', '-A']); const left = (await git(['diff', '--name-only', '--diff-filter=U'])).out.trim();
        const marked = []; for (const file of conflicted) { const c = await sh('grep', ['-lE', '^(<{7}|={7}$|>{7})', '--', file], { cwd: ws.dir }); if (c.code === 0) marked.push(file); }
        if (left || marked.length) { rec.status = 'unresolved'; extra = `\n# Conflicts remain\nThese files still contain conflict markers: ${[...new Set([...left.split('\n').filter(Boolean), ...marked])].join(', ')}. Resolve them.`; continue; }
        const status = await vcs.diffStat(ws); run.note('changed', changedFiles(status));
        const bad = protectedViolations(status, cfg.protectedPaths); if (bad.length) { rec.status = 'protected-path'; rec.error = `touched protected paths: ${bad.join(', ')}`; break; }
        if (cfg.verify) { run.phase('verify', cfg.verify); const v = await sandbox.exec(ws, 'sh', ['-c', cfg.verify], { timeoutMs: cfg.timeoutMs ?? 900_000, image: cfg.image }); run.note('verifyTail', tail(v.out)); if (v.code !== 0) { rec.status = 'verify-failed'; extra = `\n# Verification failed\n${v.out.slice(-3000)}`; continue; } }
        rec.status = 'ok'; break;
      }
    }
    if (rec.status === 'ok') {
      run.phase('push', pr.branch);
      await vcs.commitAndPush(ws, { branch: pr.branch, message: `Merge ${base} into ${pr.branch}: resolve conflicts\n\nagent-factory` });
      await host.comment(pr, `Merged ${base} into this branch and resolved the conflicts${rec.conflicts?.length ? ` in ${rec.conflicts.join(', ')}` : ''}. Review the result before merging.`);
    } else await host.comment(pr, `agent-factory could not resolve the conflicts automatically (${rec.status}). Nothing was pushed: rebuild it on the current ${base}, or fix it by hand.`).catch(() => {});
  } catch (e) { rec.status = 'error'; rec.error = String(e.message ?? e); }
  finally { rec.prLink = config.prLink?.(pr.number) ?? null; rec.finished = new Date().toISOString(); run.finish(); recordRun(config.runsDir ?? stateDir, { project: config.projectId, ...rec }); try { ws?.destroy(); } catch { /* best effort */ } }
  return rec;
}
