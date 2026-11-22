// The local forge: a code host that lives inside the factory. One BARE repository per project (state/forge/<project>/repo.git) plus pull
// request records (prs.json). No account, no token, no network. The sandbox clones from it and the factory pushes branches to it exactly as
// it would to GitHub; a human reviews the diff here and merges (UI, API or CLI only: never an agent tool, never a scenario by itself).
//
// SECURITY: everything pushed into the bare repo is written by an agent, so it is untrusted. The repo is created with an EMPTY hooks template,
// every git command here runs with SAFE_GIT (hooks, fsmonitor, external diff/textconv switched off), and merging never checks anything out:
// it builds the merge as objects (git merge-tree + commit-tree) and moves the branch with a compare-and-swap update-ref.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../util.mjs';
import { SAFE_GIT } from '../gitguard.mjs';
import { DEFAULT_PROTECTED, protectedViolations } from '../repoconfig.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
const MAX_DIFF = 400_000;
const IDENT = { GIT_AUTHOR_NAME: 'Agent Factory', GIT_AUTHOR_EMAIL: 'agent-factory@localhost', GIT_COMMITTER_NAME: 'Agent Factory', GIT_COMMITTER_EMAIL: 'agent-factory@localhost' };

export const forgeDir = (stateDir, id) => path.join(stateDir, 'forge', id);

// Create the project's repository. Empty (one initial commit on `base`) or imported from a URL / directory.
export async function initForge({ dir, base = 'main', importFrom, exec = run }) {
  const repo = path.join(dir, 'repo.git'); if (fs.existsSync(repo)) throw bad('This project already has a local repository');
  if (!BRANCH.test(base)) throw bad(`"${base}" is not a usable branch name`);
  fs.mkdirSync(dir, { recursive: true });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'af-tpl-'));                               // no hooks, no info/exclude: nothing for git to execute later
  const g = (args, o = {}) => exec('git', [...SAFE_GIT, ...args], { timeoutMs: 600_000, ...o, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...IDENT, ...(o.env ?? {}) } });
  try {
    if (importFrom) {
      const src = String(importFrom).trim();
      if (/^-/.test(src) || /^ext::/i.test(src) || /[\r\n\0]/.test(src)) throw bad('That does not look like a repository to import');
      if (!/^(https:\/\/|ssh:\/\/|git@)/.test(src) && !path.isAbsolute(src)) throw bad('Import from an https:// or ssh URL, or an absolute folder path');
      const c = await g(['-c', 'protocol.ext.allow=never', 'clone', '--bare', `--template=${empty}`, '--', path.isAbsolute(src) ? `file://${src}` : src, repo]);
      if (c.code !== 0) { fs.rmSync(repo, { recursive: true, force: true }); throw bad(`Could not import: ${c.out.trim().slice(0, 240)}`); }
      const h = (await g(['--git-dir', repo, 'symbolic-ref', 'HEAD'])).out.trim().replace('refs/heads/', '');
      const b = (await g(['--git-dir', repo, 'rev-parse', '--verify', `refs/heads/${base}`])); if (b.code !== 0) { await g(['--git-dir', repo, 'symbolic-ref', 'HEAD', `refs/heads/${h}`]); throw bad(`The imported repository has no "${base}" branch (it has "${h}"). Use that as the base branch.`); }
      await g(['--git-dir', repo, 'config', 'remote.origin.url', src]).catch(() => {}); await g(['--git-dir', repo, 'remote', 'remove', 'origin']).catch(() => {}); // keep the source URL out of the repo config: the publish target is configured explicitly
    } else {
      let r = await g(['init', '--bare', `--template=${empty}`, `--initial-branch=${base}`, repo]); if (r.code !== 0) throw bad(`git init failed: ${r.out.slice(0, 200)}`);
      const tree = (await g(['--git-dir', repo, 'mktree'], { input: '' })).out.trim();
      const commit = (await g(['--git-dir', repo, 'commit-tree', tree, '-m', 'Initial commit'])).out.trim();
      r = await g(['--git-dir', repo, 'update-ref', `refs/heads/${base}`, commit]); if (r.code !== 0) throw bad(`could not create ${base}: ${r.out.slice(0, 200)}`);
    }
    // The repo ignores hooks itself. Pushes run git-receive-pack, which reads THIS config, not the options the factory passes on its own commands.
    for (const [k, v] of [['core.hooksPath', '/dev/null'], ['receive.fsckObjects', 'true'], ['transfer.fsckObjects', 'true'], ['receive.denyDeletes', 'true'], ['receive.denyNonFastForwards', 'false']]) { const r = await g(['--git-dir', repo, 'config', k, v]); if (r.code !== 0) throw bad(`could not harden the repository: ${r.out.slice(0, 160)}`); }
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  return { repo };
}

export function localHost({ project, dir, base = 'main', exec = run }) {
  const repo = path.join(dir, 'repo.git'), file = path.join(dir, 'prs.json');
  const g = (args, o = {}) => exec('git', [...SAFE_GIT, '--git-dir', repo, ...args], { timeoutMs: 120_000, ...o, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...IDENT, ...(o.env ?? {}) } });
  const gok = async (args, o) => { const r = await g(args, o); if (r.code !== 0) throw bad(r.out.trim().slice(0, 300) || `git ${args[0]} failed`); return r.out; };
  const load = () => {
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return { next: 1, prs: [] }; }
    try { const d = JSON.parse(raw); return { next: Number(d.next) || 1, prs: Array.isArray(d.prs) ? d.prs : [] }; }
    catch { const keep = `${file}.corrupt-${Date.now()}`; try { fs.writeFileSync(keep, raw); } catch { /* best effort */ } throw bad(`The pull request file is corrupt (a copy was kept at ${keep}). Fix or restore it before continuing.`, 500); }
  };
  const save = (d) => { fs.mkdirSync(dir, { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 1)); fs.renameSync(tmp, file); };
  const now = () => new Date().toISOString();
  const num = (n) => { const v = Number(n); if (!Number.isInteger(v) || v < 1) throw bad('Invalid pull request number'); return v; };
  const find = (d, n) => { const v = num(n); return d.prs.find((p) => p.number === v) ?? (() => { throw bad(`No such pull request: ${v}`, 404); })(); };
  const sha = async (branch) => { if (!BRANCH.test(branch)) throw bad('Invalid branch name'); const r = await g(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]); return r.code === 0 ? r.out.trim() : null; };
  const view = (p) => ({ number: p.number, branch: p.branch, base: p.base, title: p.title, body: p.body, state: p.state, labels: [...p.labels], head: p.head, mergedSha: p.mergedSha ?? null, createdAt: p.createdAt, updatedAt: p.updatedAt, comments: p.comments.map((c) => ({ ...c })) });

  const api = {
    kind: 'local', supportsPrs: true, forge: true, dir, repoPath: repo,
    cloneUrl: () => `file://${repo}`,        // file:// (not a bare path): git then COPIES objects instead of hard-linking them, so a sandbox can never touch the repo's own files
    gitEnv: () => ({}),
    prUrl: (_r, n) => `local-pr:${project}/pull/${n}`,
    async whoami() { return 'you'; },
    async inspectRepo() { const r = await g(['symbolic-ref', '--short', 'HEAD']); if (r.code !== 0) throw bad('The local repository is missing'); return { defaultBranch: r.out.trim(), private: true, url: repo }; },
    async openPr({ branch, base: b = base, title, body }) {
      const head = await sha(branch); if (!head) throw bad(`Branch ${branch} is not in the local repository`); const d = load();
      let p = d.prs.find((x) => x.state === 'open' && x.branch === branch);
      if (p) { Object.assign(p, { title, body, head, updatedAt: now() }); } else { p = { number: d.next++, branch, base: b, title: String(title ?? '').slice(0, 300), body: String(body ?? '').slice(0, 60_000), state: 'open', labels: [], head, comments: [], createdAt: now(), updatedAt: now() }; d.prs.push(p); }
      save(d); return api.prUrl(null, p.number);
    },
    // ---- the review side
    pr: {
      async listAgentPrs() { const out = []; for (const p of load().prs) { if (p.state !== 'open' || !p.branch.startsWith('agent/')) continue; const s = await sha(p.branch); if (s) out.push({ number: p.number, branch: p.branch, sha: s, title: p.title }); } return out; },
      async prState(n) { return find(load(), n).state; },
      async getFeedback(pr) { const p = find(load(), pr.number); return { failedChecks: [], pending: false, comments: p.comments.filter((c) => !c.factory).map((c) => ({ id: c.id, author: c.author, body: c.body, raw: c.body })) }; },
      // The factory comments after it has pushed a verified round, so this is also where the verified head moves forward.
      async comment(pr, text) { const d = load(); const p = find(d, pr.number); const head = await sha(p.branch); if (head) p.head = head; p.comments.push({ id: `c${p.comments.length + 1}`, author: 'agent-factory', body: String(text).slice(0, 20_000), at: now(), factory: true }); p.updatedAt = now(); save(d); },
      async label(pr, name) { const d = load(); const p = find(d, pr.number); if (!p.labels.includes(name)) p.labels.push(name); p.updatedAt = now(); save(d); },
    },
    // ---- human actions (called from the UI, REST and CLI only)
    list({ state = 'all' } = {}) { return load().prs.filter((p) => state === 'all' || p.state === state).map(view).reverse(); },
    get(n) { return view(find(load(), n)); },
    async diff(n) {
      const p = find(load(), n); const live = p.state === 'open' ? await sha(p.branch) : p.head; const bs = p.state === 'merged' ? `${p.mergedSha}^1` : p.base;
      if (!live) return { pr: view(p), files: [], diff: '', truncated: false, note: 'The branch no longer exists.' };
      const range = p.state === 'merged' ? [`${p.mergedSha}^1`, p.head] : [`refs/heads/${p.base}`, live];
      const stat = await g(['diff', '--no-ext-diff', '--no-textconv', '--numstat', `${range[0]}...${range[1]}`]); const text = await g(['diff', '--no-ext-diff', '--no-textconv', '--no-color', `${range[0]}...${range[1]}`]);
      const files = stat.out.split('\n').filter(Boolean).map((l) => { const [a, r, ...f] = l.split('\t'); return { path: f.join('\t'), added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) }; });
      void bs; return { pr: { ...view(p), liveHead: live, verifiedHead: p.head, stale: p.state === 'open' && live !== p.head }, files, diff: text.out.slice(0, MAX_DIFF), truncated: text.out.length > MAX_DIFF };
    },
    async comment(n, text, author = 'you') { const body = String(text ?? '').trim(); if (!body) throw bad('Write a comment first'); const d = load(); const p = find(d, n); p.comments.push({ id: `c${p.comments.length + 1}`, author, body: body.slice(0, 20_000), at: now(), factory: false }); p.updatedAt = now(); save(d); },
    // Would merging this into the base RIGHT NOW conflict, and what does it change? (Nothing is written: merge-tree only computes.)
    async mergeCheck(n) {
      const p = find(load(), n); if (p.state !== 'open') return { state: p.state, clean: null, conflicts: [], files: [] };
      const head = await sha(p.branch); const baseSha = await sha(p.base); if (!head || !baseSha) return { state: 'open', clean: null, conflicts: [], files: [] };
      const ns = await g(['diff', '--no-ext-diff', '--name-status', `${baseSha}...${head}`]); const files = ns.out.split('\n').filter(Boolean).map((l) => { const [s, ...f] = l.split('\t'); return { status: s[0], path: f[f.length - 1] }; });
      if ((await g(['merge-base', '--is-ancestor', baseSha, head])).code === 0) return { state: 'open', clean: true, conflicts: [], files, behind: 0 };
      const mt = await g(['merge-tree', '--write-tree', '--name-only', baseSha, head]); const lines = mt.out.split('\n').slice(1); const blank = lines.indexOf(''); const conflicts = mt.code === 0 ? [] : [...new Set((blank < 0 ? lines : lines.slice(0, blank)).map((x) => x.trim()).filter(Boolean))];   // after the tree id: the conflicted file names, then a blank line, then messages
      return { state: 'open', clean: mt.code === 0, conflicts: conflicts.slice(0, 20), files, behind: Number((await g(['rev-list', '--count', `${head}..${baseSha}`])).out) || 0 };
    },
    async close(n) { const d = load(); const p = find(d, n); if (p.state !== 'open') throw bad(`That pull request is already ${p.state}`); p.state = 'closed'; p.updatedAt = now(); save(d); return view(p); },
    // Merge by building objects, never by checking out. Fast-forward when the branch is simply ahead; otherwise a clean merge commit; conflicts refuse.
    async merge(n) {
      const d = load(); const p = find(d, n); if (p.state !== 'open') throw bad(`That pull request is already ${p.state}`);
      const head = await sha(p.branch); if (!head) throw bad(`The branch ${p.branch} no longer exists`);
      if (head !== p.head) throw bad('The branch has changed since it was verified. Ask the factory to re-run it (re-queue the ticket) instead of merging unchecked code.', 409);
      const baseRef = `refs/heads/${p.base}`; const baseSha = await sha(p.base); if (!baseSha) throw bad(`The base branch ${p.base} is missing`);
      // protected paths, checked again NOW against the base's own rules: a branch edited after review cannot slip a protected change through
      let protectedList = DEFAULT_PROTECTED; const cfgRaw = await g(['show', `${baseSha}:.agent-factory.json`]); if (cfgRaw.code === 0) { try { const pp = JSON.parse(cfgRaw.out).protectedPaths; if (Array.isArray(pp)) protectedList = [...new Set([...DEFAULT_PROTECTED, ...pp.filter((x) => typeof x === 'string')])]; } catch { /* unreadable repo config: defaults still apply */ } }
      const changed = (await gok(['diff', '--no-ext-diff', '--name-only', `${baseSha}...${head}`])).split('\n').filter(Boolean);
      const hit = protectedViolations(changed.map((f) => ` M ${f}`).join('\n'), protectedList); if (hit.length) throw bad(`This change touches protected files (${hit.slice(0, 5).join(', ')}). A human must make that change directly, not through an agent PR.`, 403);
      let target, how;
      if ((await g(['merge-base', '--is-ancestor', baseSha, head])).code === 0) { target = head; how = 'fast-forward'; }
      else {
        const mt = await g(['merge-tree', '--write-tree', '--no-messages', baseSha, head]);
        if (mt.code !== 0) throw bad(`This branch conflicts with ${p.base} and cannot be merged automatically: re-queue the ticket so the factory rebuilds it on the current ${p.base}.`, 409);
        const tree = mt.out.trim().split('\n')[0]; target = (await gok(['commit-tree', tree, '-p', baseSha, '-p', head, '-m', `Merge ${p.branch}: ${p.title}`])).trim(); how = 'merge commit';
      }
      const u = await g(['update-ref', '-m', `merge ${p.branch}`, baseRef, target, baseSha]); if (u.code !== 0) throw bad(`${p.base} moved while merging. Nothing was changed; try again.`, 409);
      await g(['update-ref', '-d', `refs/heads/${p.branch}`, head]);
      Object.assign(p, { state: 'merged', mergedSha: target, mergeHow: how, updatedAt: now() }); save(d); return { merged: true, how, sha: target };
    },
    // Push the base branch to the real remote. Never forced: if the remote has commits we do not have, it refuses and you resolve that yourself.
    async publish({ remoteUrl, gitEnv = {}, branch = base }) {
      if (/[\r\n\0]/.test(remoteUrl) || /^ext::/i.test(remoteUrl) || /^-/.test(remoteUrl)) throw bad('Refusing a suspicious remote URL');
      const local = await sha(branch); if (!local) throw bad(`The base branch ${branch} is missing`);
      const r = await g(['push', '--porcelain', remoteUrl, `refs/heads/${branch}:refs/heads/${branch}`], { env: { ...gitEnv }, timeoutMs: 300_000 });
      if (r.code !== 0) { const out = r.out.replace(/https:\/\/[^@\s]*@/g, 'https://***@'); throw bad(/rejected|non-fast-forward|fetch first/i.test(out) ? 'The remote has commits this repository does not have. Nothing was pushed (the factory never force-pushes). Pull the remote changes into this repository yourself, then publish again.' : `Publish failed: ${out.trim().slice(0, 300)}`, 409); }
      return { pushed: true, branch, sha: local };
    },
    async ahead({ remoteUrl, gitEnv = {}, branch = base }) { const local = await sha(branch); const r = await g(['ls-remote', remoteUrl, `refs/heads/${branch}`], { env: { ...gitEnv }, timeoutMs: 60_000 }); const remote = r.code === 0 ? r.out.split('\t')[0].trim() : null; return { local, remote: remote || null, upToDate: !!remote && remote === local }; },
  };
  return api;
}
