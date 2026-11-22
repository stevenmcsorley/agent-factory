// The parcel's journey: it visits every station in order, never skips one, never gets ahead of the real job, and finishes the journey after the job has ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, stationOf, dwellFor, DWELL, STAGE_OF } from '../ui/journey.js';

const KEYS = ['claim', 'sandbox', 'agent', 'verify', 'push', 'pr'];
test('phases map onto the six stations (review and visual sit at verify; an unknown phase leaves the parcel where it is)', () => {
  assert.deepEqual(['claim', 'sandbox', 'agent', 'tests', 'verify', 'visual', 'review', 'push', 'pr'].map((p) => stationOf(p, KEYS)), [0, 1, 2, 2, 3, 3, 3, 4, 5]); assert.equal(stationOf('mystery', KEYS), null); assert.ok(STAGE_OF.review);
});
test('a parcel catches up one station at a time: a job that jumps straight to the agent still passes the claim and the sandbox', () => {
  let vis = -1; const seen = []; for (let i = 0; i < 10; i++) { const n = nextStep({ vis, target: 2, done: false, last: 5 }); if (!n) break; seen.push(n.move); vis = n.move; } assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(nextStep({ vis: 2, target: 2, done: false, last: 5 }), null, 'it waits at the agent while the real job is still there'); assert.equal(nextStep({ vis: 0, target: 0, done: false, last: 5 }), null);
});
test('never ahead of the real job, and never backwards', () => { for (let target = -1; target <= 5; target++) for (let vis = -1; vis <= 5; vis++) { const n = nextStep({ vis, target, done: false, last: 5 }); if (n) { assert.ok(n.move <= target, `vis ${vis} target ${target}`); assert.equal(n.move, vis + 1); } } });
test('when the job has ended the parcel finishes the journey through the stations it has not seen, then leaves for the bin', () => {
  let vis = 2; const seen = []; for (let i = 0; i < 10; i++) { const n = nextStep({ vis, target: 5, done: true, last: 5 }); seen.push(n.exit ? 'exit' : n.move); if (n.exit) break; vis = n.move; } assert.deepEqual(seen, [3, 4, 5, 'exit']);
  assert.deepEqual(nextStep({ vis: 5, target: 5, done: true, last: 5 }), { exit: true }); assert.deepEqual(nextStep({ vis: 0, target: 0, done: true, last: 5 }), { move: 1 }, 'a job that ended at once still visits every machine');
});
test('each machine is given long enough for its motion to play', () => { for (const k of KEYS) assert.ok(DWELL[k] >= 2500 && dwellFor(k) === DWELL[k], k); assert.equal(dwellFor('unknown'), 2600); const total = KEYS.reduce((n, k) => n + dwellFor(k), 0); assert.ok(total < 25_000, `a whole journey is ${total} ms`); });
