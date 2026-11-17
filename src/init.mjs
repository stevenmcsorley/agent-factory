import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { run } from './util.mjs';
import { withDefaults, saveConfig, validateConfig } from './config.mjs';
import { doctor } from './doctor.mjs';
import { inspectRepo, ensureLabels, whoami } from './github.mjs';

const inherit = (cmd, args, env = {}) => new Promise((res) => spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).on('close', (c) => res(c)));
export const ok = (m) => console.log(`  ✓ ${m}`);
export const bad = (m, fix) => console.log(`  ✗ ${m}${fix ? `\n      → ${fix}` : ''}`);

export async function ensureToken(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const f = path.join(stateDir, 'ui-token');
  if (!fs.existsSync(f)) fs.writeFileSync(f, randomBytes(24).toString('base64url') + '\n', { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

// Run an interactive command INSIDE the sandbox image (so the host needs no codex/claude CLI). `mount` = host dir to expose as the agent's HOME config.
export const containerRun = (image, cmd, { mounts = [] } = {}) => inherit('docker', ['run', '--rm', '-i', ...(process.stdin.isTTY ? ['-t'] : []), '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/home/node', ...mounts.flatMap((m) => ['-v', m]), image, ...cmd]);

export async function buildImage(root, tag = 'agent-factory-agent:latest') {
  console.log(`Building the agent sandbox image (${tag}); the first build takes a minute...`);
  return (await inherit('docker', ['build', '-f', path.join(root, 'Dockerfile.agent'), '-t', tag, root])) === 0;
}

// Interactive (or flag-driven) first-run setup. Safe to re-run: it never overwrites an existing project list.
export async function init({ configPath, root, flags }) {
  const interactive = process.stdin.isTTY && !flags.yes;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, def = '') => (rl ? (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def : def);
  console.log('\nAgent Factory setup\n');

  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const stateDir = path.resolve(path.dirname(configPath), existing.stateDir ?? 'state');

  console.log('1. Checking prerequisites');
  const pre = await doctor(withDefaults({ stateDir, agent: { kind: 'shell' }, sandbox: { kind: 'docker', agentImage: 'agent-factory-agent:latest' } }));
  let blocked = false;
  for (const c of pre.filter((x) => ['node', 'git', 'docker'].includes(x.id))) { if (c.ok) ok(c.detail); else { bad(c.detail, c.fix); blocked = true; } }
  const ghOk = (await run('gh', ['auth', 'status'])).code === 0;
  ghOk ? ok('GitHub CLI signed in') : console.log('  - GitHub CLI not signed in: fine if you use GitLab, Bitbucket or another git host (add projects in the UI); needed for GitHub (`gh auth login`)');
  if (blocked) { rl?.close(); console.log('\nFix the items above and run setup again.'); return 1; }
  if (!pre.find((c) => c.id === 'agent-image')?.ok && !(await buildImage(root))) { rl?.close(); return 1; }
  ok('sandbox image ready');

  console.log('\n2. Choosing an agent');
  const kind = (flags.agent ? flags.agent : await ask('Which coding agent should do the work? (codex = ChatGPT subscription, claude = Claude subscription or API key)', existing.agent?.kind?.replace('Container', '') ?? 'codex')).toLowerCase();
  if (!['codex', 'claude'].includes(kind)) { rl?.close(); console.log('Choose codex or claude.'); return 1; }
  const agent = kind === 'codex' ? { kind: 'codexContainer', codexHome: existing.agent?.codexHome ?? path.join(os.homedir(), '.agent-factory', 'codex') } : { kind: 'claudeContainer' };
  const secrets = path.join(stateDir, 'secrets.env');
  if (kind === 'codex') {
    fs.mkdirSync(agent.codexHome, { recursive: true, mode: 0o700 });
    if (fs.existsSync(path.join(agent.codexHome, 'auth.json'))) ok('dedicated Codex login found');
    else {
      console.log(`  The factory uses its OWN Codex login (${agent.codexHome}), never your personal one.\n  A code and a link will appear; open the link, sign in, enter the code.`);
      if (!process.stdin.isTTY) { bad('login needs an interactive terminal', `run: npm run init   (or: docker run --rm -it --user $(id -u):$(id -g) -e HOME=/home/node -v ${agent.codexHome}:/home/node/.codex agent-factory-agent:latest codex login --device-auth)`); }
      else await containerRun('agent-factory-agent:latest', ['codex', 'login', '--device-auth'], { mounts: [`${agent.codexHome}:/home/node/.codex`] });
      fs.existsSync(path.join(agent.codexHome, 'auth.json')) ? ok('logged in') : bad('login did not complete', `run: CODEX_HOME=${agent.codexHome} codex login --device-auth`);
    }
  } else if (!/CLAUDE_CODE_OAUTH_TOKEN=|ANTHROPIC_API_KEY=/.test(fs.existsSync(secrets) ? fs.readFileSync(secrets, 'utf8') : '')) {
    if (interactive && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY && (await ask('Create a long-lived Claude token now? It needs a Claude subscription and opens a login link (n = paste an API key instead)', 'y')).toLowerCase().startsWith('y'))
      await containerRun('agent-factory-agent:latest', ['claude', 'setup-token']);
    const t = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || await ask('Paste the token (or an Anthropic API key) here: it is stored in an owner-only file, never in the config');
    if (t) { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(secrets, `${t.startsWith('sk-ant-api') ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'}=${t}\n`, { mode: 0o600 }); ok('token saved'); } else bad('no token provided');
  } else ok('Claude credential found');

  console.log('\n3. Your first project (you can skip this and add projects in the UI)');
  const projects = existing.projects ?? [];
  const repo = flags.repo ?? (projects.length || !ghOk ? '' : await ask('GitHub repository the factory should work on (owner/name, blank to skip; other hosts can be added in the UI)'));
  if (repo) {
    try {
      const info = await inspectRepo(repo); const user = await whoami(); await ensureLabels(repo);
      projects.push({ id: repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-'), repo, base: info.defaultBranch, tickets: { kind: 'github', allowedAuthors: [user] } });
      ok(`${repo} added (base ${info.defaultBranch}, only issues by ${user} can queue work)`);
    } catch (e) { bad(e.message); }
  }

  const cfg = withDefaults({ ...existing, agent, projects, stateDir });
  const problems = validateConfig(cfg);
  if (problems.length) { rl?.close(); console.log(problems.join('\n')); return 1; }
  saveConfig(configPath, cfg);
  const token = await ensureToken(stateDir);
  rl?.close();
  // `npm start` only works inside a clone; from npx (or anywhere else) print the command that always works.
  const inClone = fs.existsSync(path.join(process.cwd(), 'package.json')) && JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).name === 'agent-factory';
  const startCmd = inClone ? 'npm start' : `node ${path.join(root, 'src', 'cli.mjs')} start --config=${configPath}`;
  console.log(`\nDone. Config: ${configPath}\n\nStart the factory:\n  ${startCmd}\n\nThen open  http://${cfg.ui.host}:${cfg.ui.port}/#token=${token}\n\nKeep it running in the background (Linux):  node ${path.join(root, 'src', 'cli.mjs')} service --config=${configPath}\n`);
  return 0;
}
