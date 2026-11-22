// The improvement loop. Every finished job is scored from what the factory already recorded about it (attempts, its own tests, what the reviewer found, the visual and quality checks), the
// problems that keep coming back are grouped, and each group becomes a concrete fix you can approve: a short instruction the agents receive (a skill), or a change of who does a job.
// After a fix is applied the same problem is measured again, so you can see whether it helped. Everything here is pure (no files, no clock) so it can be tested: the engine feeds it the records.
import { createHash } from 'node:crypto';

const DAY = 86_400_000;
const W = (u) => (u.input - (u.cached ?? 0)) + (u.cached ?? 0) * 0.1 + (u.output ?? 0) * 6;
// the problems a job can have: a plain label, how much it costs the score, and the advice that fixes it
export const TAGS = {
  retry: { label: 'Needed more than one attempt', penalty: 10 },
  'verify-failed': { label: 'Its own tests failed', penalty: 30 },
  'review-changes': { label: 'The reviewer asked for changes', penalty: 12 },
  'finding-security': { label: 'A security problem was found', penalty: 8 },
  'finding-a11y': { label: 'An accessibility problem was found', penalty: 5 },
  'finding-tests': { label: 'Tests were weak, missing or loosened', penalty: 5 },
  'finding-scope': { label: 'It changed things it was not asked to', penalty: 5 },
  'finding-conventions': { label: 'It ignored how the project already does things', penalty: 5 },
  'finding-requirement': { label: 'It missed part of the ticket', penalty: 5 },
  'finding-bug': { label: 'It introduced a bug or a regression', penalty: 6 },
  'visual-regression': { label: 'It looked wrong in the screenshots', penalty: 15 },
  'quality-gate': { label: 'It failed the code-quality check', penalty: 20 },
  'fix-round': { label: 'Needed an automatic fix round', penalty: 8 },
  conflicts: { label: 'Clashed with other work', penalty: 4 },
  expensive: { label: 'Used far more than a usual job', penalty: 5 },
};
const FINDING_RULES = [['finding-security', /secur|inject|\bxss\b|secret|credential|csrf|sanitis|sanitiz|vulnerab|inline script/i], ['finding-a11y', /accessib|alt text|\balt\b|\baria\b|aria-|contrast|\blabel|keyboard|focus ring|screen reader/i], ['finding-tests', /\btests?\b|assert|coverage|weaken|skipp?ed|test file/i],
  ['finding-scope', /out of scope|outside (of )?the ticket|not (part of|asked|requested)|unrelated|beyond the ticket|ticket.s scope|\bscope\b|also changes|changing .* outside/i], ['finding-conventions', /convention|existing (style|pattern|class|component)|naming|inconsistent|house style|shared (class|style|stylesheet)|design token|duplicat|reuse/i],
  ['finding-requirement', /missing|does not (implement|handle|add|include)|not implemented|never (adds|sets|handles)|requirement|acceptance|the ticket (asks|says|requires)|omits/i]];
export function classifyFinding(f) { const text = `${f?.issue ?? ''} ${f?.fix ?? ''}`; for (const [tag, re] of FINDING_RULES) if (re.test(text)) return tag; return ['major', 'blocker', 'critical'].includes(String(f?.severity ?? '').toLowerCase()) ? 'finding-bug' : null; }

// One primary build run (the first run for a ticket); fix runs for the same ticket make it "fix-round". status other than ok / verify-failed (limits, factory errors) is not the agent's fault: scored 'stopped', left out of the averages.
export function scoreRun(rec, { fixRounds = 0, medianWeighted = null } = {}) {
  const tags = []; const add = (id, detail) => { if (!tags.some((t) => t.id === id)) tags.push({ id, detail: detail ?? null }); };
  if (rec.status !== 'ok' && rec.status !== 'verify-failed') return { score: null, outcome: 'stopped', tags: [] };
  if ((rec.attempts ?? 1) > 1) add('retry', `${rec.attempts} attempts`);
  if (rec.status === 'verify-failed') add('verify-failed', String(rec.verifyTail ?? '').slice(-160) || null);
  const rv = rec.review; if (rv?.verdict === 'changes') add('review-changes', String(rv.summary ?? '').slice(0, 200));
  for (const f of rv?.findings ?? []) { const t = classifyFinding(f); if (t) add(t, String(f.issue ?? '').slice(0, 200)); }
  if (rec.visual?.status === 'fail') add('visual-regression', String(rec.visual.summary ?? '').slice(0, 160));
  if (rec.quality && rec.quality.passed === false) add('quality-gate', (rec.quality.blockers ?? []).slice(0, 2).join('; ').slice(0, 160) || null);
  if (fixRounds > 0) add('fix-round', `${fixRounds} fix round${fixRounds === 1 ? '' : 's'}`);
  if ((rec.conflicts ?? []).length) add('conflicts', rec.conflicts.slice(0, 3).join(', '));
  const w = rec.tokens ? W(rec.tokens) : 0; if (medianWeighted && w > medianWeighted * 3 && w > 50_000) add('expensive', `${Math.round(w / medianWeighted)}× the usual`);
  const cut = tags.reduce((n, t) => n + (t.id === 'retry' ? Math.min(25, TAGS.retry.penalty * ((rec.attempts ?? 2) - 1)) : (TAGS[t.id]?.penalty ?? 0)), 0);
  return { score: Math.max(0, 100 - cut), outcome: rec.status === 'ok' ? 'ok' : 'failed', tags };
}

const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
// Score every primary run in the window. usage rows give the provider that built it.
export function scoreRuns(runs, usage = [], { now = Date.now(), days = 14 } = {}) {
  const from = now - days * DAY; const rows = runs.filter((r) => Date.parse(r.started) >= from);
  const fixes = new Map(); for (const r of runs) if (r.fixRound > 0 || r.round > 0) { const k = `${r.project}/${r.ticket ?? r.prNumber}`; fixes.set(k, (fixes.get(k) ?? 0) + 1); }
  const byRun = new Map(); for (const u of usage) if (u.run && (u.role === 'builder' || u.role === 'fixer') && u.via !== 'none') { const m = byRun.get(u.run) ?? {}; m[u.via ?? 'codex'] = (m[u.via ?? 'codex'] ?? 0) + 1; byRun.set(u.run, m); }
  const med = median(rows.filter((r) => r.tokens).map((r) => W(r.tokens)));
  return rows.filter((r) => !(r.fixRound > 0) && !(r.round > 0)).map((r) => { const s = scoreRun(r, { fixRounds: fixes.get(`${r.project}/${r.ticket}`) ?? 0, medianWeighted: med }); const v = byRun.get(r.id); const provider = v ? Object.entries(v).sort((a, b) => b[1] - a[1])[0][0] : 'codex';
    return { id: r.id, project: r.project, ticket: r.ticket ?? null, title: r.title ?? null, at: r.started, provider, attempts: r.attempts ?? 1, ...s }; }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// ---- what to do about it
const SKILLS = {
  'finding-scope': { name: 'stay-in-scope', title: 'Keep changes to what the ticket asks for', roles: 'builder,fixer', text: 'Do only what the ticket asks. Do not restyle, rename, move or tidy code that the ticket does not mention, and do not change shared styles or helpers in a way that affects other pages. If you notice something else worth fixing, mention it in your summary instead of changing it.' },
  'finding-tests': { name: 'tests-that-test', title: 'Write tests that really test the change', roles: 'builder,tester,fixer', text: 'Add or update a test for every behaviour you change. Never delete, skip or loosen an existing test to make it pass. Do not add tests that only repeat what another test already checks.' },
  'finding-conventions': { name: 'follow-the-house-style', title: 'Follow how the project already does things', roles: 'builder,fixer', text: 'Before writing new code, look at how the surrounding code does the same thing and follow it: reuse the existing classes, components, colours and helpers instead of inventing new ones, and keep the existing naming.' },
  'finding-a11y': { name: 'accessible-by-default', title: 'Build in accessibility from the start', roles: 'builder,designer,fixer', text: 'Give every image meaningful alt text (empty only for pure decoration). Give every form field a visible label. Keep text readable against its background in both light and dark. Make sure everything can be used with the keyboard.' },
  'finding-security': { name: 'no-security-shortcuts', title: 'No security shortcuts', roles: 'builder,fixer', text: 'Never put secrets or keys in code. Escape or sanitise anything that comes from a user. Do not add inline scripts or load code or fonts from other sites.' },
  'finding-requirement': { name: 'cover-every-point', title: 'Cover every point of the ticket', roles: 'builder,fixer', text: 'Before you finish, re-read the ticket and tick off every point it asks for. If a point cannot be done, say so in your summary instead of leaving it out silently.' },
  'finding-bug': { name: 'check-what-else-uses-it', title: 'Check what else uses the code you change', roles: 'builder,fixer', text: 'Before changing shared code, search for everything else that uses it and make sure it still works. Prefer adding something new over changing something shared.' },
  'verify-failed': { name: 'run-the-checks-first', title: 'Run the checks before finishing', roles: 'builder,fixer', text: 'Run the project\'s test command before you finish, read any failure carefully and fix it. Keep changes small so a failure is easy to find.' },
  retry: { name: 'run-the-checks-first', title: 'Run the checks before finishing', roles: 'builder,fixer', text: 'Run the project\'s test command before you finish, read any failure carefully and fix it. Keep changes small so a failure is easy to find.' },
  'visual-regression': { name: 'check-the-screens', title: 'Check the screens you touch', roles: 'builder,designer,fixer', text: 'After changing styles, think through every page that uses them at phone and desktop widths, in light and dark. A style used by several pages must not be changed in a way that breaks the others.' },
};
export const hashId = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);
const pct = (x) => `${Math.round(x * 100)}%`;
const MIN_COUNT = 3, MIN_SHARE = 0.15, MIN_JOBS = 5;

// decisions: { id: { status:'applied'|'dismissed', at, baseline? } }; skillNames: names that already exist; policy: { routes }
export function buildImprovements({ scored, decisions = {}, skillNames = [], policy = { routes: {} }, now = Date.now() } = {}) {
  const real = scored.filter((s) => s.outcome !== 'stopped'); const n = real.length; const clean = real.filter((s) => !s.tags.length).length;
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, s) => a + s.score, 0) / xs.length) : null);
  const half = now - 7 * DAY; const recent = real.filter((s) => Date.parse(s.at) >= half); const before = real.filter((s) => Date.parse(s.at) < half);
  const health = { jobs: n, stopped: scored.length - n, average: avg(real), cleanFirstTime: n ? clean / n : null, retried: n ? real.filter((s) => s.tags.some((t) => t.id === 'retry')).length / n : null, reviewerChanges: n ? real.filter((s) => s.tags.some((t) => t.id === 'review-changes')).length / n : null, trend: recent.length >= 3 && before.length >= 3 ? avg(recent) - avg(before) : null };
  const count = new Map(); for (const s of real) for (const t of s.tags) { const e = count.get(t.id) ?? { tag: t.id, label: TAGS[t.id]?.label ?? t.id, count: 0, examples: [], projects: {} }; e.count++; e.projects[s.project] = (e.projects[s.project] ?? 0) + 1; if (e.examples.length < 3 && t.detail) e.examples.push({ run: s.id, project: s.project, title: s.title, detail: t.detail }); count.set(t.id, e); }
  const problems = [...count.values()].map((e) => ({ ...e, share: n ? e.count / n : 0 })).sort((a, b) => b.count - a.count);
  const byProvider = {}; for (const p of ['codex', 'openrouter', 'local']) { const xs = real.filter((s) => s.provider === p); byProvider[p] = { jobs: xs.length, average: avg(xs), cleanFirstTime: xs.length ? xs.filter((s) => !s.tags.length).length / xs.length : null }; }
  const ideas = [];
  const effect = (tag, d) => { if (!d?.at) return null; const t0 = Date.parse(d.at); const after = real.filter((s) => Date.parse(s.at) > t0); if (after.length < 4) return { runsAfter: after.length, enough: false }; const had = after.filter((s) => s.tags.some((t) => t.id === tag)).length / after.length; return { runsAfter: after.length, enough: true, before: d.baseline?.share ?? null, after: had }; };
  if (n >= MIN_JOBS) for (const pr of problems) { const sk = SKILLS[pr.tag]; if (!sk || ideas.some((i) => i.change?.skill?.name === sk.name)) continue; const id = hashId(`skill:${sk.name}`); const d = decisions[id]; const exists = skillNames.includes(sk.name);
    if (!d && (pr.count < MIN_COUNT || pr.share < MIN_SHARE || exists)) continue; const top = Object.entries(pr.projects).sort((a, b) => b[1] - a[1])[0];
    ideas.push({ id, kind: 'skill', tag: pr.tag, title: sk.title, why: `${TAGS[pr.tag].label}: seen in ${pr.count} of ${n} jobs (${pct(pr.share)})${top && top[1] / pr.count >= 0.7 && Object.keys(pr.projects).length > 1 ? `, mostly on ${top[0]}` : ''}. Agents will be given this instruction.`, count: pr.count, share: pr.share, examples: pr.examples, change: { skill: { name: sk.name, description: sk.title, text: sk.text, roles: sk.roles, projects: 'all' } }, status: d?.status ?? 'new', appliedAt: d?.at ?? null, effect: d?.status === 'applied' ? effect(pr.tag, d) : null }); }
  // who should do the building: compare the providers on the same kind of job, only with enough jobs on both sides
  const cx = byProvider.codex; for (const alt of ['openrouter', 'local']) { const a = byProvider[alt]; if (cx.jobs < 6 || a.jobs < 6) continue; const gap = cx.average - a.average; const route = policy.routes?.builder ?? null; const name = alt === 'local' ? 'local models' : 'free models';
    if (gap >= 15 && route !== 'codex') { const id = hashId(`route:builder:codex:${alt}`); const d = decisions[id]; ideas.push({ id, kind: 'route', tag: `provider-${alt}`, title: `Stop giving building jobs to the ${name}`, why: `Jobs built by the ${name} scored ${a.average} on average (${a.jobs} jobs), against ${cx.average} for Codex (${cx.jobs} jobs).`, count: a.jobs, share: null, examples: [], change: { routes: { builder: 'codex', fixer: 'codex' } }, status: d?.status ?? 'new', appliedAt: d?.at ?? null, effect: null }); }
    if (gap <= 3 && route === 'codex') { const id = hashId(`route:builder:auto:${alt}`); const d = decisions[id]; ideas.push({ id, kind: 'route', tag: `provider-${alt}`, title: `Let the ${name} build too`, why: `Jobs built by the ${name} scored ${a.average} (${a.jobs} jobs), as well as Codex (${cx.average}, ${cx.jobs} jobs). That would save your Codex plan.`, count: a.jobs, share: null, examples: [], change: { routes: { builder: 'auto', fixer: 'auto' } }, status: d?.status ?? 'new', appliedAt: d?.at ?? null, effect: null }); } }
  // a fix you applied whose problem has since vanished is the best news: keep it visible with its effect
  for (const [id, d] of Object.entries(decisions)) if (!ideas.some((i) => i.id === id) && d.title) ideas.push({ id, kind: d.kind, tag: d.tag, title: d.title, why: d.why ?? '', count: d.baseline?.count ?? 0, share: d.baseline?.share ?? null, examples: [], change: d.change, status: d.status, appliedAt: d.at ?? null, effect: d.status === 'applied' && d.kind === 'skill' ? effect(d.tag, d) : null });
  // ones already decided stay visible (so you can see the effect), the rest newest first
  ideas.sort((a, b) => (a.status === 'new' ? 0 : 1) - (b.status === 'new' ? 0 : 1) || b.count - a.count);
  return { health, problems, byProvider, ideas, enough: n >= MIN_JOBS };
}
