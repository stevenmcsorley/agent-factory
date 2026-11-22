import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
// Proves the harness's step-up on the REAL Codex path (not a stand-in): asks the reviewer for something that is not a verdict, so the cheaper model's answer must fail the check and the job must move to the next model. Uses a little of your Codex plan.
//   node scripts/harness-drill.mjs
import { fileURLToPath } from 'node:url';
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const { Engine } = await import(path.join(base, 'src/engine.mjs')); const { withDefaults } = await import(path.join(base, 'src/config.mjs')); const { readUsage } = await import(path.join(base, 'src/usage.mjs'));
const real = JSON.parse(fs.readFileSync(path.join(base, 'agent-factory.json'), 'utf8')); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-'));
const cfg = { stateDir: path.join(root, 's'), agent: real.agent, sandbox: real.sandbox, limits: { maxConcurrent: 1, maxAttempts: 1, timeoutMs: 300000, maxRunsPerDay: 50 }, projects: [], agents: { mode: 'codex' } };
const e = new Engine(withDefaults(cfg), { configPath: path.join(root, 'c.json'), env: {}, factories: {} });
console.log('reviewer ladder:', JSON.stringify(e._ladder('reviewer'))); const log = path.join(root, 'l.log'); const sb = e._sandboxFor(log); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
// a prompt that a model will obey with something that is NOT a verdict, so the harness's check must fail and the job must step up
const t0 = Date.now(); const r = await e._agentFor('reviewer', log, { project: 'drill' }).run(sb, { dir }, 'Reply with exactly the single word PINEAPPLE and nothing else.', { timeoutMs: 240000, meta: { shot: true, ref: 'drill' } });
console.log('final answer:', JSON.stringify(String(r.out).slice(0, 60)), '| final model:', r.model, '| wall', Date.now() - t0, 'ms');
const rows = readUsage(e.cfg.stateDir); console.log('usage rows:', rows.length); for (const u of rows) console.log(' ', JSON.stringify({ role: u.role, via: u.via, model: u.model, escalated: u.escalated, why: u.why, input: u.input, output: u.output }));
const aud = fs.readFileSync(path.join(e.cfg.stateDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a.what === 'harness'); console.log('audit harness events:', JSON.stringify(aud));
