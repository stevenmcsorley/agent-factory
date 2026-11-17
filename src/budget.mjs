import fs from 'node:fs';
import path from 'node:path';

// Sum costUsd of runs finished today (UTC) from runs.jsonl. Both ticket runs and feedback rounds append there.
export function spentToday(stateDir, now = new Date()) {
  const f = path.join(stateDir, 'runs.jsonl');
  if (!fs.existsSync(f)) return 0;
  const day = now.toISOString().slice(0, 10);
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => (r.finished ?? '').startsWith(day)).reduce((a, r) => a + (r.costUsd ?? 0), 0);
}

// Agent invocations finished today (UTC). On a subscription the real limit is rate-limit/quota, so cap run count too.
export function runsToday(stateDir, now = new Date()) {
  const f = path.join(stateDir, 'runs.jsonl');
  if (!fs.existsSync(f)) return 0;
  const day = now.toISOString().slice(0, 10);
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => (r.finished ?? '').startsWith(day)).length;
}

export const overBudget = (stateDir, config) =>
  (config.dailyBudgetUsd != null && spentToday(stateDir) >= config.dailyBudgetUsd) ||
  (config.maxRunsPerDay != null && runsToday(stateDir) >= config.maxRunsPerDay);

export function recordRun(stateDir, rec) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'runs.jsonl'), JSON.stringify(rec) + '\n');
}

export function readRuns(stateDir) {
  const f = path.join(stateDir, 'runs.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
