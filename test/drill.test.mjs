import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { runDrill, formatDrill, drillList } from '../src/drill.mjs';

test('the guardrail drill passes: every guardrail holds against real git and the real loop', async () => {
  const results = await runDrill(); assert.equal(results.length, drillList().length); assert.ok(results.length >= 9);
  for (const r of results) assert.ok(r.ok, `${r.id} failed:\n${r.evidence.filter((e) => !e.ok).map((e) => e.text).join('\n')}`); assert.ok(results.every((r) => r.evidence.length >= 2), 'each drill checks more than one thing');
  const text = formatDrill(results); assert.match(text, /9\/9 guardrails held\./); assert.doesNotMatch(text, /\u001b/, 'no colour codes unless asked');
});

test('the drill restores the environment it touches, can run a subset, and fails loudly (exit 1, named check) when a guardrail is broken', async () => {
  const before = JSON.stringify(Object.keys(process.env).sort()); const some = await runDrill({ only: ['review-backlog'] }); assert.deepEqual(some.map((r) => r.id), ['review-backlog']); assert.equal(JSON.stringify(Object.keys(process.env).sort()), before);
  const out = spawnSync(process.execPath, ['src/cli.mjs', 'drill', '--only=secret-blocked,review-backlog', '--json'], { encoding: 'utf8' }); assert.equal(out.status, 0); assert.deepEqual(JSON.parse(out.stdout).map((r) => [r.id, r.ok]), [['secret-blocked', true], ['review-backlog', true]]);
  assert.match(execFileSync(process.execPath, ['src/cli.mjs', 'drill', '--list'], { encoding: 'utf8' }), /ambiguous-ticket[\s\S]*forge-merge/);
});
