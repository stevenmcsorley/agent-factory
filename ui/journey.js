// The parcel's journey, separate from the data. A real job spends under a second in most stages, so following the data directly makes the parcel jump (straight to the agent, then snap ahead).
// Here the journey is its own timeline: a parcel visits every station in order, stays long enough for that machine's motion to play, never gets ahead of the real job, and when the job is done it
// carries on through the stations it has not yet seen and then into the shipped bin. Pure, so it can be tested.
export const STAGE_OF = { claim: 'claim', sandbox: 'sandbox', agent: 'agent', tests: 'agent', verify: 'verify', visual: 'verify', review: 'verify', push: 'push', pr: 'pr' };
// How long a parcel stays at each machine (ms): about one full cycle of that machine's working motion, plus the time to glide in.
export const DWELL = { claim: 2600, sandbox: 3000, agent: 3800, verify: 3000, push: 3000, pr: 3200 };
export const dwellFor = (key) => DWELL[key] ?? 2600;
// The station index a phase name belongs to (null when it is not one of the line's stations, so the parcel stays where it is).
export function stationOf(phase, keys) { const k = STAGE_OF[phase]; const i = keys.indexOf(k); return i < 0 ? null : i; }
// What the parcel does next. vis = station it is at now (-1 = still in the hopper), target = the furthest station the real job has reached, done = the real job has ended.
// Returns { move: station } to advance one station, { exit: true } to leave for the shipped bin, { drop: true } to fall off the belt (the job stopped without shipping), or null to wait where it is.
export function nextStep({ vis, target, done, last, outcome = null }) {
  if (done && outcome && outcome !== 'ok') return vis < 0 ? { drop: true } : (vis >= target ? { drop: true } : { move: vis + 1 });   // a job that did not ship still visits the machines it really reached, then drops off the belt where it stopped
  if (vis < target) return { move: vis + 1 };                 // catch up one station at a time, never skipping one
  if (done) return vis < last ? { move: vis + 1 } : { exit: true };   // the job has ended: finish the journey
  return null;
}
