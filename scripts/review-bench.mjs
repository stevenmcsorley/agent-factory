#!/usr/bin/env node
// Reviewer strategy benchmark with the REAL agent: `node scripts/review-bench.mjs [--strategies=shot,shot_rules,atoms,agent] [--cases=missing-alt,clean-css] [--save] [--json]`
// Runs planted defects and clean changes (src/reviewbench.mjs) through different ways of reviewing and reports what each catches, wrongly blocks, and costs in tokens.
// It uses your agent's usage: a rough guide is printed first. Everything happens in a throwaway state folder and throwaway repositories; nothing touches your projects.
// The cheap strategies run first; `agent` (the current reviewer, which explores a checkout) is the expensive one and is opt-in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Engine } = await import(path.join(root, 'src/engine.mjs'));
const { withDefaults } = await import(path.join(root, 'src/config.mjs'));
const { CASES, STRATEGIES, runBench } = await import(path.join(root, 'src/reviewbench.mjs'));
const { readUsage } = await import(path.join(root, 'src/usage.mjs'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const real = JSON.parse(fs.readFileSync(path.resolve(flags.config ?? path.join(root, 'agent-factory.json')), 'utf8'));
const strategies = typeof flags.strategies === 'string' ? flags.strategies.split(',') : ['shot', 'shot_rules', 'atoms']; const bad = strategies.filter((s) => !STRATEGIES[s]); if (bad.length) { console.error(`Unknown strategy: ${bad.join(', ')}. Choose from ${Object.keys(STRATEGIES).join(', ')}`); process.exit(2); }
const cases = typeof flags.cases === 'string' ? CASES.filter((c) => flags.cases.split(',').includes(c.id)) : CASES; if (!cases.length) { console.error('No such cases.'); process.exit(2); }
const maxCalls = Number(flags['max-calls'] ?? 0) || Infinity; const say = (s) => { if (!flags.json) console.log(s); };
const planned = strategies.reduce((n, s) => n + cases.length * (s === 'atoms' ? 4 : 1), 0);
say(`Reviewer benchmark: ${cases.length} cases (${cases.filter((c) => c.kind === 'defect').length} planted defects, ${cases.filter((c) => c.kind === 'clean').length} clean) × ${strategies.join(', ')} = ${planned} agent calls. ~15k tokens each for the one-call strategies, ~90k for "agent".`);
if (planned > maxCalls) { console.error(`That is ${planned} calls, over --max-calls=${maxCalls}.`); process.exit(2); }

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-state-')); const cfg = { stateDir: path.join(state, 's'), agent: real.agent, roles: { reviewer: real.roles?.reviewer ?? {} }, sandbox: real.sandbox, limits: { maxConcurrent: 1, maxAttempts: 1, timeoutMs: real.limits?.timeoutMs ?? 900000, maxRunsPerDay: 500 }, projects: [] };
const cfgPath = path.join(state, 'c.json'); fs.writeFileSync(cfgPath, JSON.stringify(cfg)); const e = new Engine(withDefaults(cfg), { configPath: cfgPath, env: {}, factories: {} });
const log = path.join(state, 'bench.log'); const agent = e._agentFor('reviewer', log, { project: 'bench' }); const sandbox = e._sandboxFor(log); let calls = 0;
const runAgent = async ({ prompt, dir, meta }) => { const r = await agent.run(sandbox, { dir }, prompt, { timeoutMs: cfg.limits.timeoutMs, meta }); calls++;
  if (/usage limit|rate.?limit|try again at/i.test(String(r?.out)) && !/"verdict"/.test(String(r?.out))) throw Object.assign(new Error(`The agent is limited: ${String(r.out).slice(0, 160)}`), { limited: true }); return r?.out ?? ''; };
const usageFor = (ref) => { const u = readUsage(e.cfg.stateDir).filter((x) => x.ref === ref); if (!u.length) return null; return u.reduce((a, x) => ({ input: a.input + x.input, cached: a.cached + x.cached, output: a.output + x.output, steps: a.steps + (x.steps ?? 0) }), { input: 0, cached: 0, output: 0, steps: 0 }); };
const pad = (s, n) => String(s).padEnd(n);
const onRow = (r) => say(`  ${pad(r.strategy, 11)} ${pad(r.case, 24)} ${pad(r.outcome, 20)} ${r.verdicts.join(' ')}  ${r.tokens.input ? `${Math.round(r.tokens.input / 1000)}k in (${Math.round(100 * r.tokens.cached / r.tokens.input)}% cached) ${r.tokens.steps} steps` : ''} ${Math.round(r.ms / 1000)}s`);
let result; try { result = await runBench({ cases, strategies, runAgent, usageFor, onRow }); } catch (err) { say(`\nStopped: ${err.message}`); if (err.limited) say('Run it again after the limit lifts (use --cases and --strategies to resume where it stopped).'); fs.rmSync(state, { recursive: true, force: true }); process.exit(3); }
const { rows, summary } = result;
if (flags.json) console.log(JSON.stringify({ agent: real.agent?.kind, model: real.agent?.model ?? null, rows, summary }, null, 2)); else {
  say(`\n${pad('strategy', 12)} ${pad('caught', 8)} ${pad('wrong why', 10)} ${pad('missed', 7)} ${pad('false block', 12)} ${pad('calls', 6)} ${pad('tokens in', 10)} ${pad('cached', 7)} ${pad('weighted/case', 14)}`);
  for (const [s, v] of Object.entries(summary)) say(`${pad(s, 12)} ${pad(`${v.caught}/${v.defects}`, 8)} ${pad(v.wrongReason, 10)} ${pad(v.missed, 7)} ${pad(`${v.falseBlocks}/${v.cleans}`, 12)} ${pad(v.calls, 6)} ${pad(`${Math.round(v.input / 1000)}k`, 10)} ${pad(v.input ? `${Math.round(100 * v.cached / v.input)}%` : '-', 7)} ${pad(`${Math.round(v.perCase / 1000)}k`, 14)}`);
  say('\ncaught = blocked AND named the planted problem · wrong why = blocked for another reason · false block = a clean change was blocked · weighted = fresh input + 0.1×cached + 6×output');
}
if (flags.save) { const f = path.join(root, 'docs', 'evidence', `review-bench-${new Date().toISOString().slice(0, 10)}.json`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), agent: real.agent?.kind, model: real.agent?.model ?? null, effort: real.agent?.reasoningEffort ?? null, rows, summary }, null, 2)); say(`Saved ${path.relative(root, f)}`); }
fs.rmSync(state, { recursive: true, force: true });
