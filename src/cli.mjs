#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from './util.mjs';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSecrets, validateConfig } from './config.mjs';
import { Engine } from './engine.mjs';
import { createServer, hostsFor } from './server.mjs';
import { doctor } from './doctor.mjs';
import { analyzeRepo } from './analyze.mjs';
import { textReport } from './report.mjs';
import { clientCommand } from './cli-client.mjs';
import { init, ensureToken, buildImage, ok, bad } from './init.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'help';
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));   // split at the FIRST '=' only
const configPath = path.resolve(flags.config ?? process.env.AGENT_FACTORY_CONFIG ?? 'agent-factory.json');

const HELP = `agent-factory <command>

  init           first-run setup: checks prerequisites, logs the agent in, adds a project
  start          run the factory and the web UI   (--no-loop = UI only)
  doctor         check that everything is ready
  add <o/r>      add a GitHub repo as a project
  tick           claim queued tickets once and exit
  feedback       process CI/review feedback on open agent PRs once and exit
  analyze [dir|url]  inspect a folder or git URL: layout, repeated code, untested files, quality (no config needed; --json, --ignore=a,b, --no-default-ignore)
  portfolio      the whole picture: every project's brief, plan, queue, PRs, quality   (needs the factory running)
  brief <proj>   show or set the project brief:  --goal= --scope= --users= --non-goals= --success= --constraints= --stack= --decisions=  (@file reads a file)
  source <proj> <file|url|->   attach a PRD, research or design:  --kind=prd|research|design|reference  --title=
  plan <proj>    draft a delivery plan from the brief:  --wait to follow it, --launch to approve, --show to just print
  library <sub>  the reuse library: status | create | connect | search <q> | get <part> | candidates | promote <proj> <files> --name= | extract <proj> --name= | try <part> <fn> --args= | use <part> <proj> | upgrades
  ops            list every operation (the same ones MCP exposes);  op <name> [json] --key=value  runs one
  agents-md      print docs/AGENT-GUIDE.md: the guide to give any AI agent so it can drive the factory
  build-image    build the agent sandbox image
  token          print the UI sign-in URL
  service        print a systemd unit that keeps the factory running (Linux)

  --config=PATH  (default ./agent-factory.json)`;

function boot() {
  if (!fs.existsSync(configPath)) { console.error(`No config at ${configPath}. Run: agent-factory init`); process.exit(1); }
  const cfg = loadConfig(configPath);
  for (const [k, v] of Object.entries(loadSecrets(path.join(cfg.stateDir, 'secrets.env')))) process.env[k] ??= v; // real env wins
  return cfg;
}

async function main() {
  if (cmd === 'help' || flags.help) return console.log(HELP);
  if (cmd === 'init') process.exit(await init({ configPath, root, flags }));
  if (cmd === 'service') {
    const unit = `[Unit]
Description=Agent Factory
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${path.dirname(configPath)}
ExecStart=${process.execPath} ${path.join(root, 'src', 'cli.mjs')} start --config=${configPath}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    console.log(`# Save as ~/.config/systemd/user/agent-factory.service, then:\n#   systemctl --user daemon-reload && systemctl --user enable --now agent-factory\n#   loginctl enable-linger $USER     # keep it running when you are logged out\n#   journalctl --user -u agent-factory -f\n\n${unit}`);
    return;
  }
  if (cmd === 'analyze') {
    const target = args.find((a, i) => i > 0 && !a.startsWith('--')) ?? '.'; let dir = path.resolve(target), tmp = null;
    if (/^(https:\/\/|ssh:\/\/|git@)/.test(target)) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-analyze-')); dir = tmp; process.stderr.write(`Cloning ${target} (read-only, depth 1)…\n`);
      const r = await run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--quiet', target, tmp], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      if (r.code !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); console.error(`Could not clone: ${r.out.trim().slice(0, 300)}`); process.exit(1); }
    } else if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`Not a folder: ${dir}`); process.exit(1); }
    let exclude = []; if (!tmp && fs.existsSync(path.join(dir, '.git'))) { const g = await run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd: dir }); if (g.code === 0) exclude = g.out.split('\n').filter(Boolean); }   // honour .gitignore when looking at your own working copy
    try { const prof = analyzeRepo(dir, { exclude, ignore: String(flags.ignore ?? '').split(',').filter(Boolean), ignoreDefaults: !flags['no-default-ignore'] }); console.log(flags.json ? JSON.stringify(prof, null, 2) : textReport(prof, tmp ? target : path.basename(dir))); } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
    return;
  }
  if (cmd === 'build-image') process.exit((await buildImage(root)) ? 0 : 1);
  const cfg = boot();
  if (cmd === 'token') return console.log(`http://${cfg.ui.host}:${cfg.ui.port}/#token=${await ensureToken(cfg.stateDir)}`);
  if (cmd === 'doctor') { const r = await doctor(cfg); r.forEach((c) => (c.ok ? ok(c.detail) : bad(c.detail, c.fix))); return process.exit(r.every((c) => c.ok || c.id === 'running') ? 0 : 1); }
  if (['ops', 'op', 'portfolio', 'brief', 'source', 'plan', 'library', 'agents-md'].includes(cmd)) { try { await clientCommand(cmd, args, flags, cfg, root); } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); } return; }
  const problems = validateConfig(cfg); if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  const engine = new Engine(cfg, { configPath });
  if (cmd === 'add') { const repo = args.find((a, i) => i > 0 && !a.startsWith('--')); const p = await engine.addProject({ repo }); return console.log(`Added ${p.id} (base ${p.base})`); }
  if (cmd === 'tick' || cmd === 'feedback') { await engine.start(); const r = await (cmd === 'tick' ? engine.tickAll() : engine.feedbackAll()); console.log(JSON.stringify(r, null, 2)); return; }
  if (cmd === 'start') {
    await engine.start();
    const token = await ensureToken(cfg.stateDir);
    const server = createServer(engine, { token, allowedHosts: hostsFor(cfg.ui.host, cfg.ui.port) });
    server.listen(cfg.ui.port, cfg.ui.host, () => {
      console.log(`Agent Factory is running\n  UI:  http://${cfg.ui.host}:${cfg.ui.port}/#token=${token}\n  ${cfg.projects.length} project(s), agent: ${cfg.agent.kind}${engine.paused() ? '\n  (paused: STOP file present)' : ''}`);
      if (!flags['no-loop']) engine.loop();
    });
    const bye = () => { engine.halt(); server.closeAllConnections(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
    return;
  }
  console.log(HELP); process.exit(1);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
