import { run } from '../util.mjs';

export const MARKER = '<!-- agent-factory -->';

// PullRequestHost backed by the `gh` CLI. Feedback = failed CI checks + comments/reviews from allowlisted authors
// (comments carrying MARKER are the factory's own and are ignored, otherwise it would answer itself forever).
export function githubHost({ repo, allowedAuthors }) {
  const gh = async (args, { allowFail = false } = {}) => {
    const r = await run('gh', args);
    if (r.code !== 0 && !allowFail) throw new Error(`gh ${args.join(' ')} failed: ${r.out}`);
    return r.out;
  };
  const json = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
  return {
    async listAgentPrs() {
      const prs = json(await gh(['pr', 'list', '-R', repo, '--state', 'open', '--json', 'number,headRefName,headRefOid,title', '--limit', '50']), []);
      return prs.filter((p) => p.headRefName.startsWith('agent/')).map((p) => ({ number: p.number, branch: p.headRefName, sha: p.headRefOid, title: p.title }));
    },
    async getFeedback(pr) {
      // `gh pr checks` exits non-zero when checks fail or are pending, so don't treat exit code as error.
      const checks = json(await gh(['pr', 'checks', String(pr.number), '-R', repo, '--json', 'name,bucket,link'], { allowFail: true }), []);
      const failedChecks = [];
      for (const c of checks.filter((c) => c.bucket === 'fail')) {
        const runId = /\/runs\/(\d+)/.exec(c.link ?? '')?.[1];
        const log = runId ? (await gh(['run', 'view', runId, '-R', repo, '--log-failed'], { allowFail: true })).slice(-3000) : '';
        failedChecks.push({ name: c.name, log });
      }
      const pending = checks.some((c) => c.bucket === 'pending');
      const rd = async (p) => json(await gh(['api', '--paginate', p], { allowFail: true }), []);
      const [inline, convo, reviews] = await Promise.all([
        rd(`repos/${repo}/pulls/${pr.number}/comments`), rd(`repos/${repo}/issues/${pr.number}/comments`), rd(`repos/${repo}/pulls/${pr.number}/reviews`)]);
      const comments = [
        ...inline.map((c) => ({ id: `i${c.id}`, author: c.user.login, body: `${c.path}:${c.line ?? ''} — ${c.body}` , raw: c.body })),
        ...convo.map((c) => ({ id: `c${c.id}`, author: c.user.login, body: c.body, raw: c.body })),
        ...reviews.map((c) => ({ id: `r${c.id}`, author: c.user.login, body: c.body, raw: c.body })),
      ].filter((c) => c.raw && allowedAuthors.includes(c.author) && !c.raw.includes(MARKER));
      return { failedChecks, pending, comments };
    },
    async comment(pr, text) { await gh(['pr', 'comment', String(pr.number), '-R', repo, '--body', `${text}\n\n${MARKER}`]); },
    async label(pr, name) {
      await gh(['label', 'create', name, '-R', repo, '--force']);
      await gh(['pr', 'edit', String(pr.number), '-R', repo, '--add-label', name]);
    },
  };
}
