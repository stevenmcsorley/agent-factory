import { run } from '../util.mjs';

// Vcs: commit and push (git), open the PR/MR through the code host. Runs on the HOST after the agent exits, so no tokens enter the
// sandbox. `gitEnv` carries git credentials for non-GitHub hosts as environment variables (never argv, URLs or logs).
// `openPr`: a function ({repo, branch, base, title, body}) => url|null, or false to skip PR creation.
export function gitVcs({ log, openPr = false, gitEnv = {} }) {
  const env = () => ({ ...process.env, ...gitEnv });
  return {
    async diffStat(ws) { return (await run('git', ['status', '--porcelain'], { cwd: ws.dir, log })).out.trim(); },
    async commitAndPush(ws, { branch, message, remote = 'origin' }) {
      for (const a of [['add', '-A'], ['commit', '-m', message], ['push', remote, branch]]) {
        const r = await run('git', a, { cwd: ws.dir, log, env: env() });
        if (r.code !== 0) throw new Error(`git ${a[0]} failed: ${r.out.replace(/Authorization: [^\s]+/g, 'Authorization: ***').slice(0, 400)}`);
      }
    },
    async openPr(ws, args) { return typeof openPr === 'function' ? openPr(args) : null; },
  };
}
