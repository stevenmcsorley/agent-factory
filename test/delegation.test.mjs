// The delegation rules: every combination that matters, so "who does what and why" is a tested promise, not a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, effectiveRoute, DEFAULT_ROUTES, MODES, ROUTES } from '../src/delegation.mjs';

const OK = { orUsable: true, orReady: true, orRemaining: 900, planLimited: false, codexUsable: true };
const d = (o) => decide({ mode: 'mix', ...OK, ...o });

test('codex only and openrouter only are strict: no quiet use of the other provider', () => {
  for (const role of Object.keys(DEFAULT_ROUTES)) { assert.equal(decide({ role, mode: 'codex', ...OK }).provider, 'codex', role); assert.equal(decide({ role, mode: 'openrouter', ...OK }).provider, 'openrouter', role); }
  assert.equal(decide({ role: 'builder', mode: 'codex', ...OK, codexUsable: false }).provider, 'none', 'Codex only and Codex limited: nothing quietly uses the free models');
  assert.equal(decide({ role: 'builder', mode: 'openrouter', ...OK, orReady: false }).provider, 'none'); assert.match(decide({ role: 'builder', mode: 'openrouter', ...OK, orReady: false }).why, /resting/); assert.match(decide({ role: 'builder', mode: 'openrouter', ...OK, orRemaining: 3 }).why, /allowance/); assert.match(decide({ role: 'builder', mode: 'openrouter', ...OK, orUsable: false }).why, /not set up/);
  assert.equal(decide({ role: 'builder', mode: 'openrouter', ...OK, codexUsable: false }).provider, 'openrouter', 'OpenRouter only does not care that Codex is limited');
});

test('mix, by default: reviewers go to the free models as ONE request; the planner stays on Codex', () => {
  const r = d({ role: 'reviewer' }); assert.deepEqual([r.provider, r.shot, r.escalate], ['openrouter', true, true]); assert.match(r.why, /one short request/); assert.equal(d({ role: 'security' }).provider, 'codex', 'unbenchmarked: Codex until proven'); assert.equal(d({ role: 'security', routes: { security: 'openrouter' } }).shot, true, 'but you can send it to the free models');
  assert.equal(d({ role: 'planner' }).provider, 'codex'); assert.match(d({ role: 'planner' }).why, /quality first/); assert.equal(d({ role: 'builder', size: 'S', attempt: 1, role: 'reviewer' }).shot, true);
});

test('mix: a builder on a small ticket, first attempt, goes to the free models; a bigger ticket, an unknown size, or a retry goes to Codex', () => {
  assert.equal(d({ role: 'builder', size: 'S', attempt: 1 }).provider, 'openrouter'); assert.equal(d({ role: 'builder', size: 'S', attempt: 1 }).escalate, true, 'and Codex is the escalation if it fails');
  assert.equal(d({ role: 'builder', size: 'M', attempt: 1 }).provider, 'codex'); assert.match(d({ role: 'builder', size: 'L' }).why, /size L/); assert.equal(d({ role: 'builder', size: null }).provider, 'codex'); assert.match(d({ role: 'builder', size: null }).why, /not known/);
  assert.equal(d({ role: 'builder', size: 'S', attempt: 2 }).provider, 'codex'); assert.match(d({ role: 'builder', size: 'S', attempt: 2 }).why, /retry/); assert.equal(d({ role: 'fixer', size: 'S', attempt: 2 }).provider, 'codex');
});

test('mix: a role you set yourself wins over the default (and says so)', () => {
  assert.equal(d({ role: 'reviewer', routes: { reviewer: 'codex' } }).provider, 'codex'); assert.match(d({ role: 'reviewer', routes: { reviewer: 'codex' } }).why, /you set/);
  assert.equal(d({ role: 'builder', size: 'L', attempt: 3, routes: { builder: 'openrouter' } }).provider, 'openrouter', 'an explicit OpenRouter choice is honoured even for a big ticket'); assert.equal(effectiveRoute('builder', { routes: { builder: 'codex' } }).source, 'you'); assert.equal(effectiveRoute('builder', {}).source, 'default');
  assert.equal(effectiveRoute('mystery', {}).route, 'codex', 'an unknown role defaults to Codex'); assert.equal(d({ role: 'reviewer', routes: { reviewer: 'nonsense' } }).provider, 'openrouter', 'an invalid route is ignored');
});

test('mix: the free models are not available (not set up, all resting, allowance used) so Codex does it, with the reason; a verdict needs only one request', () => {
  assert.equal(d({ role: 'reviewer', orUsable: false }).provider, 'codex'); assert.match(d({ role: 'reviewer', orUsable: false }).why, /not set up/); assert.match(d({ role: 'reviewer', orReady: false }).why, /resting/);
  assert.equal(d({ role: 'builder', size: 'S', orRemaining: 5 }).provider, 'codex', 'a tool-using task needs about eight requests'); assert.equal(d({ role: 'reviewer', orRemaining: 1 }).provider, 'openrouter', 'a verdict needs one'); assert.equal(d({ role: 'reviewer', orRemaining: 0 }).provider, 'codex');
});

test('mix: Codex limited or missing, the free models stand in (except where you said Codex only); both gone is stated plainly', () => {
  assert.equal(d({ role: 'builder', size: 'L', codexUsable: false }).provider, 'openrouter'); assert.match(d({ role: 'builder', size: 'L', codexUsable: false }).why, /Codex is limited/);
  assert.equal(d({ role: 'builder', size: 'L', codexUsable: false, routes: { builder: 'codex' } }).provider, 'none', 'a role you pinned to Codex waits for Codex'); assert.equal(d({ role: 'planner', codexUsable: false }).provider, 'openrouter', 'the default for the planner is Codex, but it is a default, so it is covered');
  const both = d({ role: 'reviewer', codexUsable: false, orReady: false }); assert.equal(both.provider, 'none'); assert.match(both.why, /neither provider/);
});

test('constants: modes and routes are what the settings accept, and every role has a default with a reason', () => {
  assert.deepEqual(MODES, ['mix', 'codex', 'openrouter']); assert.deepEqual(ROUTES, ['codex', 'openrouter', 'auto']); for (const [r, v] of Object.entries(DEFAULT_ROUTES)) { assert.ok(ROUTES.includes(v.route), r); assert.ok(v.why.length > 10, r); }
});
