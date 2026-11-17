import { run } from '../util.mjs';

// Vcs: commit, push, open PR. Runs on the HOST after the agent exits, so no tokens enter the sandbox.
export function gitVcs({ log, openPr = true, repo }) {
  return {
    async diffStat(ws) { return (await run('git', ['status', '--porcelain'], { cwd: ws.dir, log })).out.trim(); },
    async commitAndPush(ws, { branch, message, remote = 'origin' }) {
      for (const a of [['add', '-A'], ['commit', '-m', message], ['push', remote, branch]]) {
        const r = await run('git', a, { cwd: ws.dir, log });
        if (r.code !== 0) throw new Error(`git ${a[0]} failed: ${r.out}`);
      }
    },
    async openPr(ws, { branch, title, body, base = 'main', repo: repoOverride }) {
      if (!openPr) return null;
      const r = await run('gh', ['pr', 'create', '-R', repoOverride ?? repo, '--head', branch, '--base', base, '--title', title, '--body', body, '--draft'], { cwd: ws.dir, log });
      if (r.code !== 0) throw new Error(`gh pr create failed: ${r.out}`);
      return r.out.trim().split('\n').pop();
    },
  };
}
