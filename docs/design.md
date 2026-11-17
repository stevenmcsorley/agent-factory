# Design notes (original, partly superseded by the code)

> Written before the first prototype. The README describes what exists today; this records the intent and the roadmap.

A small, self-hosted orchestrator that turns tickets into reviewed PRs using any CLI coding agent.

## Principles
- Adapter pattern for everything swappable (your standing preference): `TicketSource`, `Sandbox`, `Agent`, `Vcs`.
- Human stays at the merge button. The factory opens PRs; it never merges in v1.
- Every run is bounded: timeout, attempt cap, global concurrency, and an audit log.
- Dogfood: failed runs file tickets back into the same backlog.

## Loop (one tick)
1. `tickets.poll()` → issues labelled `agent-ready` (and not `agent-working`).
2. **Claim**: set label `agent-working`, write lease (id, expiry) to state. Crash recovery = expired lease.
3. **Provision**: `sandbox.create(repo, branch)` — fresh clone into a temp dir, container with no host mounts except the workspace.
4. **Run**: `agent.run(prompt, workspace, timeout)` — prompt built from ticket title/body + repo conventions.
5. **Verify**: run repo's verify command (`.agent-factory.json` → `verify`, default none). Failure → feed output back to agent, up to `maxAttempts`.
6. **Deliver**: if diff non-empty and verify passed → commit, push `agent/<id>-<slug>`, open PR, comment on ticket, label `agent-review`. Otherwise comment failure, label `agent-failed`.
7. **Feedback (v2)**: webhook/poll for failing checks or review comments on `agent/*` PRs → re-enter step 4 on the same branch.

## Adapters
| Port | v0 prototype | Next |
|---|---|---|
| TicketSource | GitHub issues (`gh`), local JSON file (tests/demo) | Ossicone (REST, done), Linear, Jira |
| Sandbox | Docker (`docker run`, workspace bind-mount, network on), local temp dir (dev only) | Firecracker/gVisor, remote VM |
| Agent | `claude -p`, `codex exec`, arbitrary shell command | OpenHands agent server |
| Vcs | `git` + `gh pr create` | GitLab, Gitea |

## State & audit
- `state/runs.json` (v0) → SQLite (v1): ticket, attempt, status, lease, cost, log path.
- `state/logs/<run>.log`: every command and agent output. 

## Safety / governance (v1 must-haves)
- Per-repo allowlist (`config.repos`); factory ignores tickets elsewhere.
- Least-privilege token (fine-grained PAT, contents+PR write on allowlisted repos only). No tokens inside the sandbox in v0: push happens from the host after the agent exits.
- Only issues authored/labelled by an allowlisted user are claimable (prompt-injection guard: ticket text is untrusted input).
- Kill switch: `touch state/STOP`.
- Budget: `maxConcurrent`, `timeoutMs`, `maxAttempts`; cost tracking when agent adapter reports it.

## Deployment
Run the orchestrator and UI on one machine with Docker. For heavier use, run sandboxes on a separate, beefier host rather than a small SBC.

## Self-improvement loop
On `agent-failed` or repeated verify failures the factory opens a ticket in its *own* repo with the log tail, labelled `agent-ready` after human triage. Human triage step is deliberate.

## Non-goals (v1)
Auto-merge, multi-agent planning, browser use, cost optimisation, web UI.

## Open questions
- Webhooks vs. polling for ticket sources.
- Where sandboxes should run at scale: a separate VM or a microVM runtime.
