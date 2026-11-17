import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spentToday, recordRun } from '../src/budget.mjs';
import { parseClaudeJson } from '../src/adapters/agents.mjs';
import { hostAllowed } from '../src/egress-proxy.mjs';
import { startEgress } from '../src/egress.mjs';
import { run } from '../src/util.mjs';
import { tick } from '../src/factory.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));

test('parseClaudeJson extracts result and cost; tolerates garbage', () => {
  const r = parseClaudeJson({ code: 0, out: 'noise\n' + JSON.stringify({ result: 'done', total_cost_usd: 0.42, is_error: false }) + '\n' });
  assert.equal(r.out, 'done'); assert.equal(r.costUsd, 0.42);
  assert.equal(parseClaudeJson({ code: 1, out: 'not json' }).costUsd, 0);
});

test('spentToday sums only today; tick refuses when over daily budget', async () => {
  const d = tmp(); const today = new Date().toISOString();
  recordRun(d, { ticket: 1, costUsd: 1.5, finished: today });
  recordRun(d, { ticket: 2, costUsd: 9, finished: '2020-01-01T00:00:00Z' });
  assert.equal(spentToday(d), 1.5);
  const out = await tick({ tickets: {}, sandbox: {}, agent: {}, vcs: {}, config: { dailyBudgetUsd: 1 }, stateDir: d });
  assert.deepEqual(out, [{ status: 'budget-exhausted' }]);
});

test('hostAllowed: exact + subdomain only, no suffix tricks', () => {
  const a = ['api.anthropic.com'];
  assert.ok(hostAllowed('api.anthropic.com', a)); assert.ok(hostAllowed('X.API.anthropic.com.', a));
  assert.ok(!hostAllowed('notapi.anthropic.com', a)); assert.ok(!hostAllowed('api.anthropic.com.evil.io', a)); assert.ok(!hostAllowed('example.com', a));
});

// Real Docker integration: internal network has no direct route; proxy allows only listed hosts.
test('egress: direct blocked, allowlisted host reachable via proxy, others denied', { skip: process.env.FACTORY_DOCKER_TESTS !== '1', timeout: 120000 }, async () => {
  const eg = await startEgress({ allow: ['api.anthropic.com'], network: 'factory-agents-test', name: 'factory-egress-test' });
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const curl = (args, env = {}) => run('docker', ['run', '--rm', '--network', eg.network, ...Object.keys(env).flatMap((k) => ['-e', `${k}=${env[k]}`]),
      'node:22-bookworm', 'curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', ...args], { timeoutMs: 60000 });
    const direct = await curl(['https://api.anthropic.com']);
    assert.notEqual(direct.code, 0, `direct should fail: ${direct.out}`);
    const allowed = await curl(['https://api.anthropic.com'], eg.env);
    assert.equal(allowed.code, 0, allowed.out); assert.match(allowed.out, /^(2|3|4)\d\d$/); // any HTTP answer = reached upstream
    const denied = await curl(['https://example.com'], eg.env);
    assert.notEqual(denied.code, 0, 'example.com must be blocked');
    const logs = await eg.logs();
    assert.match(logs, /ALLOW api\.anthropic\.com:443/); assert.match(logs, /DENY example\.com:443/);
  } finally { await eg.stop(); await run('docker', ['network', 'rm', 'factory-agents-test']); }
});

import { runsToday } from '../src/budget.mjs';
import { agents, parseCodexJsonl } from '../src/adapters/agents.mjs';

test('maxRunsPerDay stops the factory even when cost is zero (subscription)', async () => {
  const d = tmp(); const now = new Date().toISOString();
  recordRun(d, { ticket: 1, costUsd: 0, finished: now }); recordRun(d, { pr: 2, costUsd: 0, finished: now });
  assert.equal(runsToday(d), 2);
  const out = await tick({ tickets: {}, sandbox: {}, agent: {}, vcs: {}, config: { maxRunsPerDay: 2 }, stateDir: d });
  assert.deepEqual(out, [{ status: 'budget-exhausted' }]);
});

test('parseCodexJsonl sums tokens and keeps last message; tolerates noise', () => {
  const out = ['starting', JSON.stringify({ type: 'item.completed', item: { text: 'first' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
    JSON.stringify({ type: 'item.completed', item: { text: 'final' } })].join('\n');
  const r = parseCodexJsonl({ code: 0, out });
  assert.equal(r.out, 'final'); assert.deepEqual(r.tokens, { input: 10, output: 5 });
});

test('codexContainer guards: docker only, needs dedicated codexHome with auth.json, mounts it rw and never mounts ~/.codex by default', async () => {
  await assert.rejects(agents.codexContainer({ codexHome: '/x' }).run({ kind: 'local' }, {}, 'p', {}), /docker/);
  await assert.rejects(agents.codexContainer({}).run({ kind: 'docker' }, {}, 'p', {}), /codexHome/);
  const home = tmp(); fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  let seen; const sb = { kind: 'docker', exec: async (_w, cmd, args, o) => { seen = { cmd, args, o }; return { code: 0, out: '' }; } };
  await agents.codexContainer({ codexHome: home }).run(sb, {}, 'do it', { timeoutMs: 5 });
  assert.equal(seen.cmd, 'codex'); assert.ok(seen.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(seen.o.mounts, [`${home}:/home/node/.codex`]);
  assert.ok(!JSON.stringify(seen).includes(os.homedir() + '/.codex'));
});
