// Watches what happens AFTER a merge. The factory opens PRs and learns when they merge, but a merge is not the end: the repository's
// own pipeline (deploy, CI on the base branch) can still fail, and nobody told the factory. This reads the workflow runs on the
// base branch and reports the ones that are red right now, so they show up in the Inbox with a link and the PR that caused them.
// "Red now" = the most recent finished run of a workflow failed. A later green run of the same workflow clears it by itself.
// Cancelled and skipped runs are neutral (a newer push cancelling an older run is normal), runs still in progress are ignored.
import { run } from './util.mjs';

const BAD = new Set(['failure', 'timed_out', 'startup_failure']);
const NEUTRAL = new Set(['cancelled', 'skipped', 'neutral', 'stale', null, undefined]);

const headline = (msg) => String(msg ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 140) ?? '';
// "Merge pull request #12 from owner/branch" (merge commit) or "Title (#12)" (squash).
export const prNumberOf = (msg) => { const h = headline(msg); const m = /^Merge pull request #(\d+)\b/.exec(h) ?? /\(#(\d+)\)\s*$/.exec(h); return m ? Number(m[1]) : null; };

// runs: the `workflow_runs` array of the GitHub API (newest first). Returns the workflows that are failing right now.
export function failingWorkflows(runs) {
  const byWorkflow = new Map();
  for (const r of runs ?? []) {
    if (r.status !== 'completed' || NEUTRAL.has(r.conclusion)) continue;       // only a real verdict counts
    const key = r.workflow_id ?? r.name ?? 'workflow';
    const cur = byWorkflow.get(key);
    if (!cur || new Date(r.created_at) > new Date(cur.created_at)) byWorkflow.set(key, r);
  }
  return [...byWorkflow.values()].filter((r) => BAD.has(r.conclusion)).map((r) => ({
    workflow: String(r.name ?? 'workflow').slice(0, 80), runId: r.id, url: typeof r.html_url === 'string' && /^https:\/\/github\.com\//.test(r.html_url) ? r.html_url : null,
    conclusion: r.conclusion, sha: String(r.head_sha ?? '').slice(0, 7), headline: headline(r.head_commit?.message), pr: prNumberOf(r.head_commit?.message), at: r.updated_at ?? r.created_at ?? null,
  })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Default transport: the `gh` CLI the factory already uses. Injectable for tests.
export async function fetchBaseRuns(repo, base, exec = run) {
  const r = await exec('gh', ['api', `repos/${repo}/actions/runs?branch=${encodeURIComponent(base)}&event=push&per_page=30`], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(String(r.out ?? '').trim().slice(0, 200) || 'gh api failed');
  return JSON.parse(r.out).workflow_runs ?? [];
}
