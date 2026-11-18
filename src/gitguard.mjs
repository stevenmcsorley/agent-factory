// The agent works in a checkout it can WRITE, including .git. The factory then runs git on the HOST in that directory, with credentials in
// the environment. Anything git will execute from the repository (hooks, core.fsmonitor, core.sshCommand, credential helpers, ext:: remotes,
// filter drivers, a redirected remote) is therefore a way for a compromised agent to run code on the host. So before every host-side git
// command we rebuild the repo's config from scratch (only the remote WE cloned from), delete hooks and other executable extension points,
// and run git with the dangerous features switched off.
import fs from 'node:fs';
import path from 'node:path';

export const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'diff.external=', '-c', 'protocol.ext.allow=never', '-c', 'core.untrackedCache=false'];

export function lockGit(dir, remoteUrl) {
  const g = path.join(dir, '.git');
  let st; try { st = fs.lstatSync(g); } catch { throw new Error('not a git checkout'); }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('.git must be a real directory (refusing to run git here)');
  for (const f of ['hooks', 'info/attributes', 'info/sparse-checkout', 'objects/info/alternates', 'objects/info/http-alternates', 'commondir', 'gitdir', 'config.worktree', 'modules']) fs.rmSync(path.join(g, f), { recursive: true, force: true });
  if (remoteUrl !== undefined) {
    if (/[\r\n\0"\\]/.test(remoteUrl) || /^ext::/i.test(remoteUrl)) throw new Error('refusing a suspicious remote URL');
    const cfg = ['[core]', '\trepositoryformatversion = 0', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = true', '[remote "origin"]', `\turl = ${remoteUrl}`, '\tfetch = +refs/heads/*:refs/remotes/origin/*', ''].join('\n');
    const tmp = path.join(g, 'config.tmp'); fs.writeFileSync(tmp, cfg); fs.renameSync(tmp, path.join(g, 'config'));
  }
}
