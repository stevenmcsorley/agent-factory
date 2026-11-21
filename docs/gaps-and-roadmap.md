# Known gaps and what to build next

Written after a long real run: 17 tickets taken from "the projects page looks bad" to a redesigned, mobile-ready, dark-mode app on a live service ([evidence](evidence/ossicone-ui-redesign-2026-11-20.md)). Every item below comes from something that went wrong or took manual effort in that run, not from a checklist. Status is stated plainly.

| # | Gap | What it cost | Status |
|---|-----|--------------|--------|
| 1 | The factory cannot see UI breakage | Typecheck, tests and build passed every PR; a card with its description drawn above its name, a 20px sideways scroll and white text on a light panel were all found by hand in a browser, 17 times | **Built** (`src/visual.mjs`, `scripts/visual-runner.mjs`, `Dockerfile.visual`; see AUTOPILOT.md). Node dev servers and static sites; no mock-data support for pages that need a backend |
| 2 | Nothing watches what happens after a merge | Two deploys failed on a test the factory never ran; the factory did not notice | **Built** (`src/deploywatch.mjs`, Inbox) |
| 3 | The test command covers one folder of a monorepo | A ticket touching `backend/` would pass a `cd frontend && npm test` check and look verified | **Built** (`src/coverage.mjs`, PR note) |
| 4 | "Only these files may change" is not enforced | The agent changed one extra file; the gate said OK | **Built** (`src/allowlist.mjs`, an `allowed-files` block in the ticket; see AUTOPILOT.md) |
| 5 | Tickets that touch the same files are not sequenced | Ordering and rebasing were done by hand | **Partly built**: a ticket with an `allowed-files` block waits while an open PR changes any of those files, and the reason shows on the Autopilot tab. Tickets that do not declare files are not held, and there is no automatic rebase |
| 6 | The factory stops silently at limits | The daily run cap was hit and a ticket just sat there | Mostly built: `why_waiting` and the Autopilot tab list every reason per project with when it resumes. Not yet shown on each ticket, and no notifications |

## Built

**Post-merge pipeline watch (gap 2).** For GitHub projects the factory reads the workflow runs on the base branch (`gh api repos/<repo>/actions/runs?branch=<base>&event=push`). A workflow whose latest finished run failed (failure, timed out, startup failure) appears in the Inbox as *Failing after merge*, with the failed run's link and the PR it came from (parsed from the merge or squash commit message). It clears by itself when a later run of that workflow passes. Cancelled, skipped and in-progress runs are neutral: a newer push cancelling an older run neither raises nor hides a failure. It is cached for two minutes, skipped in demo mode, and a project can opt out with `deployWatch: false`. A GitHub or `gh` problem for one project is skipped quietly rather than turned into an Inbox item. Replayed against Ossicone's real history it flagged both of the failed deploys from the redesign session (PR #34 and PR #38) and cleared at the next green run.

**Coverage note on the PR (gap 3).** After verify passes, the factory reads which folders the command runs in (`cd frontend && ...`, `--prefix web`, `-C api`) and compares them with the changed files. Anything outside, other than docs and repository housekeeping, is listed in the PR's *Provenance* section as *Not covered by that command* and stored on the run (`coverage`). It never blocks: it is a heuristic about the command text, and says nothing when the command runs from the repository root. A brand-new folder appears as one entry (git lists it that way).

## Not built yet

**1. Visual check stage (highest value).** After verify, for projects that opt in with a `preview` command and a list of routes: start the app in the sandbox, load each route at 360, 768 and 1280 px with Playwright, and attach screenshots to the PR. Fail or warn automatically on: horizontal scroll (`scrollWidth > innerWidth`), tap targets under 44 px on phones, text contrast below 4.5:1 against the resolved background, console errors, and (when a dark theme exists) the same in dark. This replaces the throwaway harness that was rebuilt by hand for every review. Open questions: where the browser runs (inside the agent image, with its network allowlist), and how a project supplies mock data for pages that need a backend.

**4. Ticket-declared file allowlist.** A ticket that says "only these files change" should be machine-readable (a fenced `allowed-files` block, globs). The quality gate then warns, or blocks with a setting, on any changed path outside it, the same way protected paths are enforced today. It also bounds what an agent can touch when a ticket comes from a less trusted author.

**5. Overlap detection and sequencing.** Record the files each open PR and each queued ticket touches (from the diff, or from the allowlist above). Hold a ticket whose files overlap an open PR, with the reason shown on the ticket, and re-run or rebase it after the earlier PR merges. Today that ordering lives in the operator's head.

**6. Say why a ticket is waiting.** Show *waiting: daily cap reached (20 of 20)* (and the other reasons a ready ticket is not picked up: paused, lease held, requireVerify, over budget) on the ticket itself, and notify on the events that matter: PR ready, pipeline failing after merge, cap reached.

## Smaller

- **Egress proxy name.** The proxy container is always called `factory-egress`, so a second factory instance replaces the first one's proxy. Name it per state directory.
- **Janitor.** Stale `factory-*` and `af-*` temp folders can survive a crash. Sweep ones older than a day at startup.
- **Quota visibility.** Subscription runs report no cost. Show runs and tokens against the plan's rate limit, and the model and effort each run was asked for (the model and effort are now recorded per run).
- **Spec builder.** Tickets for this run were long and exact. Turn a short request plus a screenshot into acceptance criteria; the clarity gate currently only checks length.
- **Backup.** No export or restore of run history and config.
