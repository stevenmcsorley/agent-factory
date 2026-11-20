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
import { discover as discoverPlugins, readEnabled, enablePlugin, disablePlugin, hashDir } from './plugins.mjs';
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
  add <o/r>      add a GitHub repo as a project  (--tracker=local to use the built-in tracker; --host=local to keep the code on this machine)
  merge <project> <pr>   merge a local-forge pull request (human action)
  publish <project>      push a local-forge project's base branch to its publish target
  tick           claim queued tickets once and exit
  feedback       process CI/review feedback on open agent PRs once and exit
  analyze [dir|url]  inspect a folder or git URL: layout, repeated code, untested files, quality (no config needed; --json, --ignore=a,b, --no-default-ignore)
  portfolio      the whole picture: every project's brief, plan, queue, PRs, quality   (needs the factory running)
  brief <proj>   show or set the project brief:  --goal= --scope= --users= --non-goals= --success= --constraints= --stack= --decisions=  (@file reads a file)
  source <proj> <file|url|->   attach a PRD, research or design:  --kind=prd|research|design|reference  --title=
  plan <proj>    draft a delivery plan from the brief:  --wait to follow it, --launch to approve, --show to just print
  library <sub>  the reuse library: status | create | connect | search <q> | get <part> | candidates | promote <proj> <files> --name= | extract <proj> --name= | try <part> <fn> --args= | use <part> <proj> | upgrades
  plugin <sub>   extensions: list | enable <name> | disable <name> | new <name>   (enabling is a deliberate, offline step; restart to apply)
  scenario <sub> custom workflows (deploys, go-live gates): list | run <proj> <id> [--apply] [--param=v] | runs <proj> | status <proj> <run> | approve <proj> <run> <step> | cancel <proj> <run>
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
  if (cmd === 'plugin') {
    const sub = args[1] ?? 'list'; const cdir = path.dirname(configPath); const dirs = [path.join(root, 'plugins'), path.join(cdir, 'plugins')]; const name = args[2];
    try {
      if (sub === 'list') { const en = readEnabled(cdir); const found = discoverPlugins(dirs); if (!found.length) return console.log(`No plugins found. Create one:  agent-factory plugin new my-plugin   (looked in ${dirs.join(' and ')})`);
        for (const p of found) { const e = en[p.manifest.name]; const state = p.error ? `INVALID (${p.error})` : !e ? 'available (not enabled)' : e.sha === p.sha ? 'enabled' : 'CHANGED since you enabled it: review, then enable again'; console.log(`${p.manifest.name.padEnd(18)} ${(p.manifest.version ?? '').padEnd(8)} ${state}${p.manifest.secrets?.length ? `\n${''.padEnd(27)}secrets: ${p.manifest.secrets.join(', ')}` : ''}${p.manifest.description ? `\n${''.padEnd(27)}${p.manifest.description}` : ''}`); } return; }
      if (sub === 'enable') { if (!name) throw new Error('Usage: agent-factory plugin enable <name> [--config=\'{"key":"value"}\']'); const r = enablePlugin(cdir, dirs, name, typeof flags.config === 'string' ? JSON.parse(flags.config) : undefined); return console.log(`Enabled ${r.name}@${r.version} (pinned to ${r.sha.slice(0, 12)}).${r.secrets.length ? `\nIt may use these secrets from state/secrets.env: ${r.secrets.join(', ')}` : ''}\nPlugins are trusted code: you just approved exactly these files. Restart the factory to load it.`); }
      if (sub === 'disable') { if (!name) throw new Error('Usage: agent-factory plugin disable <name>'); disablePlugin(cdir, name); return console.log(`Disabled ${name}. Restart the factory to unload it.`); }
      if (sub === 'new') { if (!name || !/^[a-z][a-z0-9-]{1,39}$/.test(name)) throw new Error('Usage: agent-factory plugin new <name>  (lowercase letters, digits, dashes)'); const d = path.join(cdir, 'plugins', name); if (fs.existsSync(d)) throw new Error(`${d} already exists`); fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'plugin.json'), `${JSON.stringify({ name, version: '0.1.0', description: 'What this plugin does', secrets: [], main: 'index.mjs' }, null, 2)}\n`);
        fs.writeFileSync(path.join(d, 'index.mjs'), `// ${name}: a factory plugin. Read docs/EXTENDING.md for everything register(api) can add.\nexport function register(api) {\n  // 1. A scenario step type, usable in scenario files as "type": "${name}.hello"\n  api.registerStep('hello', {\n    describe: (a) => \`say hello to \${a.who ?? 'world'}\`,          // shown in dry runs and approvals\n    plan: async (a) => ({ greeting: \`Hello, \${a.who ?? 'world'}\` }),   // optional: a read-only preview\n    run: async (a, ctx) => { ctx.log('running'); return { greeting: \`Hello, \${a.who ?? 'world'}\` }; },\n  });\n  // 2. An operation for MCP and the CLI: exposed as ${name.replace(/-/g, '_')}_ping\n  api.registerOp({ name: 'ping', readOnly: true, description: 'Check that the plugin is alive', handler: async () => ({ ok: true }) });\n}\n`);
        return console.log(`Created ${d}\nNext:  agent-factory plugin enable ${name}   then restart the factory.`); }
      throw new Error('Usage: agent-factory plugin list | enable <name> | disable <name> | new <name>');
    } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
  }
  if (cmd === 'build-image') process.exit((await buildImage(root)) ? 0 : 1);
  const cfg = boot();
  if (cmd === 'token') return console.log(`http://${cfg.ui.host}:${cfg.ui.port}/#token=${await ensureToken(cfg.stateDir)}`);
  if (cmd === 'doctor') { const r = await doctor(cfg); r.forEach((c) => (c.ok ? ok(c.detail) : bad(c.detail, c.fix))); return process.exit(r.every((c) => c.ok || c.id === 'running') ? 0 : 1); }
  if (['ops', 'op', 'portfolio', 'brief', 'source', 'plan', 'library', 'scenario', 'agents-md'].includes(cmd)) { try { await clientCommand(cmd, args, flags, cfg, root); } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); } return; }
  const problems = validateConfig(cfg); if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  const engine = new Engine(cfg, { configPath });
  if (cmd === 'add') { const repo = args.find((a, i) => i > 0 && !a.startsWith('--')); const p = await engine.addProject({ repo, ...(flags.tracker === 'local' ? { source: { kind: 'local' } } : {}), ...(flags.host === 'local' ? { host: { kind: 'local', ...(flags.import ? { importFrom: flags.import } : {}) } } : {}) }); return console.log(`Added ${p.id} (base ${p.base})`); }
  if (cmd === 'merge') { const [, proj, n] = args; console.log(JSON.stringify(await engine.prAction(proj, n, 'merge'), null, 2)); return process.exit(0); }
  if (cmd === 'publish') { console.log(JSON.stringify(await engine.publish(args[1], { switchHost: false }), null, 2)); return process.exit(0); }
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
