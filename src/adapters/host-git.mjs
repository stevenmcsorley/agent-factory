import { run } from '../util.mjs';
import { gitAuthEnv } from '../gitauth.mjs';

// Any git remote (self-hosted Gitea/Forgejo, Azure DevOps, AWS CodeCommit, a bare repo on a server, ...). The factory pushes the branch
// `agent/<id>-<slug>` and says so on the ticket; a human opens the pull request. There is no PR or CI feedback loop for plain git.
// `remoteTemplate`, e.g. "https://git.example.com/{repo}.git" or "git@git.example.com:{repo}.git" (ssh uses the host user's ssh keys).
export function gitHost({ remoteTemplate, repo, username = 'git', token, exec = run }) {
  const url = (r = repo) => remoteTemplate.replace('{repo}', r);
  const https = /^https:\/\//.test(remoteTemplate);
  return {
    kind: 'git', supportsPrs: false,
    cloneUrl: url,
    gitEnv: () => (https && token ? gitAuthEnv(new URL(url()).origin, username, token) : {}),
    prUrl: () => null,
    async whoami() { return username; },
    // Read access check only: git cannot tell whether a push would be allowed without trying one.
    async inspectRepo() {
      const r = await exec('git', ['ls-remote', '--symref', url(), 'HEAD'], { env: { ...process.env, ...this.gitEnv(), GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 30000 });
      if (r.code !== 0) throw new Error(`Cannot read ${url()}: ${r.out.trim().slice(0, 200)}`);
      return { defaultBranch: /ref: refs\/heads\/(\S+)\s+HEAD/.exec(r.out)?.[1] ?? 'main', private: true, url: url() };
    },
    async openPr() { return null; },
    pr: { async listAgentPrs() { return []; }, async getFeedback() { return { failedChecks: [], pending: false, comments: [] }; }, async comment() {}, async label() {} },
  };
}
