import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../util.mjs';

// Sandbox: fresh clone into a temp dir; `exec` runs a command inside it.
// kind 'docker': command runs in a container with only the workspace mounted (no host creds).
// kind 'local' : command runs directly on host in the workspace (dev/test only, NOT isolated).
// Best-effort removal that can never throw: cleanup trouble must not lose a finished run's result.
// Falls back to chmod, then to a throwaway container (for files a previous root-owned container left behind).
export function destroyDir(dir, log) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { /* fall through */ }
  try { execFileSync('chmod', ['-R', 'u+rwX', dir], { stdio: 'ignore' }); fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { /* fall through */ }
  try {
    execFileSync('docker', ['run', '--rm', '-v', `${path.dirname(dir)}:/t`, 'alpine', 'rm', '-rf', `/t/${path.basename(dir)}`], { stdio: 'ignore', timeout: 60000 });
    return !fs.existsSync(dir);
  } catch { if (log) try { fs.appendFileSync(log, `WARN could not remove ${dir}\n`); } catch { /* ignore */ } return false; }
}

export function sandbox({ kind = 'docker', image = 'node:22-bookworm', network = 'bridge', extraEnv = {}, log }) {
  return {
    kind,
    async create({ cloneUrl, branch, base = 'main', newBranch = true }) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-'));
      const c = await run('git', ['clone', '--depth', '50', '--branch', base, cloneUrl, dir], { log });
      if (c.code !== 0) throw new Error(`clone failed: ${c.out}`);
      if (newBranch) {
        const b = await run('git', ['checkout', '-b', branch], { cwd: dir, log });
        if (b.code !== 0) throw new Error(`branch failed: ${b.out}`);
      }
      return { dir, destroy: () => destroyDir(dir, log) };
    },
    exec(ws, cmd, args, { timeoutMs, input, env: callEnv = {}, image: imageOverride, mounts = [] } = {}) {
      const env = { HOME: '/tmp', ...extraEnv, ...callEnv };
      if (kind === 'local') return run(cmd, args, { cwd: ws.dir, timeoutMs, input, log, env: { ...process.env, ...env } });
      // `-e KEY` (no value) makes docker read it from our process env, so secrets never appear in argv or the audit log.
      const envArgs = Object.keys(env).flatMap((k) => ['-e', k]);
      return run('docker', ['run', '--rm', '-i', '--user', `${process.getuid()}:${process.getgid()}`, '--network', network, '--memory', '2g', '--cpus', '2',
        '-v', `${ws.dir}:/work`, ...mounts.flatMap((m) => ['-v', m]), '-w', '/work', ...envArgs, imageOverride ?? image, cmd, ...args],
        { timeoutMs, input, log, env: { ...process.env, ...env } });
    },
  };
}
