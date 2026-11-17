import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Run a command, capture output, enforce timeout. Never throws on non-zero exit.
export function run(cmd, args, { cwd, timeoutMs = 0, input, env, log } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const t = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    const onData = (d) => { out += d; };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {}); // child may exit without reading stdin (EPIPE)
    child.on('error', (e) => { out += `\nspawn error: ${e.message}`; });
    child.on('close', (code) => {
      if (t) clearTimeout(t);
      if (log) fs.appendFileSync(log, `$ ${cmd} ${args.join(' ')}\n${out}\n[exit ${code}${timedOut ? ' TIMEOUT' : ''}]\n`);
      resolve({ code: timedOut ? 124 : code, out, timedOut });
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
