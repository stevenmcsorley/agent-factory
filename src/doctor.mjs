import fs from 'node:fs';
import path from 'node:path';
import { run } from './util.mjs';
import { validateConfig } from './config.mjs';
import { hostKind } from './hosts.mjs';

// Every check returns { id, ok, detail, fix? }. `exec` is injectable for tests.
export async function doctor(cfg, { exec = run, env = process.env } = {}) {
  const checks = [];
  const add = (id, ok, detail, fix) => checks.push({ id, ok, detail, ...(ok ? {} : { fix }) });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22, `Node ${process.versions.node}`, 'Install Node 22 or newer');
  const git = await exec('git', ['--version']); add('git', git.code === 0, git.out.trim().slice(0, 40), 'Install git');
  const dk = await exec('docker', ['info', '--format', '{{.ServerVersion}}']);
  add('docker', dk.code === 0, dk.code === 0 ? `Docker ${dk.out.trim()}` : 'Docker daemon not reachable', 'Install Docker and make sure your user can run `docker ps`');
  const gh = await exec('gh', ['auth', 'status']);
  const needsGh = (cfg.projects ?? []).some((p) => hostKind(p) === 'github' || p.tickets?.kind === 'github');
  add('github', gh.code === 0 || !needsGh, gh.code === 0 ? 'gh is signed in' : needsGh ? 'gh is not signed in' : 'gh is not signed in (only needed for GitHub projects)', 'Run `gh auth login`');
  if (cfg.sandbox?.kind === 'docker' && dk.code === 0) {
    const img = await exec('docker', ['image', 'inspect', cfg.sandbox.agentImage ?? 'agent-factory-agent:latest']);
    add('agent-image', img.code === 0, `${cfg.sandbox.agentImage} ${img.code === 0 ? 'present' : 'missing'}`, 'Run `npm run build-image`');
  }
  const kind = cfg.agent?.kind;
  if (kind === 'claudeContainer') {
    const ok = !!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
    add('agent-auth', ok, ok ? 'Claude credential present in environment' : 'No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY', 'Run `claude setup-token` and put the token in the secrets file (see README)');
  } else if (kind === 'codexContainer') {
    const f = path.join(cfg.agent.codexHome ?? '', 'auth.json'); const ok = !!cfg.agent.codexHome && fs.existsSync(f);
    add('agent-auth', ok, ok ? 'Dedicated Codex login found' : 'No dedicated Codex login', `Run \`CODEX_HOME=${cfg.agent.codexHome} codex login --device-auth\``);
  }
  const missing = (cfg.projects ?? []).flatMap((p) => [p.tickets?.tokenEnv, p.host?.tokenEnv].filter(Boolean).filter((n) => !env[n]).map((n) => `${p.id}: ${n}`));
  add('secrets', missing.length === 0, missing.length ? `Missing tokens: ${missing.join(', ')}` : 'All project tokens present', 'Re-add the project in the UI, or put NAME=token lines in state/secrets.env');
  const unverified = (cfg.projects ?? []).filter((p) => !(p.config?.verify || p.profile?.verify) && !p.profile?.hasRepoConfig).map((p) => p.id);
  add('verification', unverified.length === 0, unverified.length ? `No test command known for: ${unverified.join(', ')}. Pull requests there may be unverified (re-analyze or set a verify command)` : 'Every project has a way to verify changes', 'Open the project and press Re-analyze, or set `config.verify` / add .agent-factory.json to the repo');
  const problems = validateConfig(cfg);
  add('config', problems.length === 0, problems.length ? problems.join('; ') : `${cfg.projects.length} project(s), valid`, 'Fix the listed config problems');
  add('running', !fs.existsSync(path.join(cfg.stateDir, 'STOP')), fs.existsSync(path.join(cfg.stateDir, 'STOP')) ? 'Paused (STOP file present)' : 'Not paused', 'Resume from the UI or delete the STOP file');
  return checks;
}
