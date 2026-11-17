# Agent Factory

**Self-hosted software delivery on autopilot: tickets in, reviewed pull requests out.**

Label a GitHub issue `agent-ready` (or queue one from the web UI). Agent Factory claims it, runs a coding agent in a locked-down Docker sandbox, runs your tests, and opens a **draft pull request**. If CI fails or you leave review comments, it goes back and pushes fixes. **It never merges: you do.**

- **Bring your own agent**: Claude Code or Codex, on a subscription or an API key. Others can be added behind a small adapter.
- **Runs on your machine**: no hosted service, no telemetry.
- **Web UI**: see every project, the ticket queue, PRs and runs; queue work; pause everything; add an existing repo or create a brand-new project from a template.
- **Safe by default**: agents run in containers with no route to the internet except an allowlisted proxy, tickets from strangers are ignored, CI/config files are protected, and daily caps stop runaway use.

> **Status: v0.1, early.** It works end to end on real repositories (see [What's verified](#whats-verified)), but it is young software that runs code written by an AI. Read [Security](#security-model) before pointing it at anything you care about, and start with a throwaway repo.

## Quickstart

You need: **Node 22+**, **Docker**, **git**, and the **GitHub CLI** signed in (`gh auth login`). Plus a Codex (ChatGPT) or Claude login.

```bash
git clone https://github.com/stevenmcsorley/agent-factory.git
cd agent-factory
npm run init     # checks prerequisites, builds the sandbox image, logs the agent in, adds your first repo
npm start        # prints the UI link
```

Open the printed link (it contains your UI token). Then either label an issue `agent-ready` in your repo or use **Projects → New ticket** in the UI.

`npm run doctor` re-checks everything and tells you how to fix what is wrong.

## How it works

```
 ticket (GitHub issue / Ossicone)         ┌──────────────── Docker sandbox ────────────────┐
   labelled agent-ready  ───►  gate  ───► │  clone → agent edits → tests run               │
   (author must be allowlisted)  │        │  (no internet except the allowlisted proxy)    │
                                 ▼        └───────────────────────┬────────────────────────┘
                  too vague? ask a question                       ▼
                                                       protected-path check → push branch
                                                                  ▼
                     CI fails / review comments  ◄───────  draft pull request  ───►  you review & merge
                              │
                              └──► agent pushes a fix (bounded rounds), then hands back to a human
```

1. **Clarity gate.** A ticket with nothing concrete to build ("make it better") gets a question and the `agent-needs-info` label instead of burning an agent run.
2. **Sandboxed run.** A fresh clone is mounted into a container. The agent can only reach its provider's API through an allowlisting proxy. It gets no GitHub credentials; pushing happens on the host afterwards.
3. **Verify.** Your test command runs in the same sandbox, with a retry if it fails. The command comes from `.agent-factory.json` in the repo, or is auto-detected (npm, pytest, go, cargo, make).
4. **Protected paths.** If the agent touched `.github/`, `.agent-factory.json` or other CI files, the run is rejected and nothing is pushed.
5. **Draft PR**, with the ticket relabelled `agent-review` and a comment linking it.
6. **Feedback loop.** Failing CI or comments from allowlisted users trigger follow-up commits on the same branch, up to a round limit, then `agent-needs-human`.

Ticket states are plain labels: `agent-ready` → `agent-working` → `agent-review` (or `agent-failed`, `agent-needs-info`, `agent-needs-human`).

## The web UI

| Page | What you can do |
|---|---|
| Overview | Today's usage vs. caps, every project's health, recent runs, Run now / Pause |
| Project | Ticket queue with states, open agent PRs, run history, live log, **queue a new ticket** (with a live "is this clear enough?" hint), pause or remove the project |
| Add a project | Add an existing repo, **or create a new GitHub repo** from a template (blank, node, python) and queue your description as its first ticket |
| Runs | Every agent run and feedback round |
| Health | The same checks as `npm run doctor`, each with a fix |

It listens on `127.0.0.1` only and every API call needs the token in `state/ui-token`.

## Configuration

`npm run init` writes `agent-factory.json`; you rarely need to edit it. Projects can be added from the UI or the CLI (`node src/cli.mjs add owner/repo`).

```jsonc
{
  "agent":   { "kind": "codexContainer", "codexHome": "~/.agent-factory/codex" },   // or "claudeContainer"
  "limits":  { "maxRunsPerDay": 20, "dailyBudgetUsd": 5, "maxAttempts": 2, "timeoutMs": 900000 },
  "projects": [
    { "id": "my-app", "repo": "me/my-app", "base": "main",
      "tickets": { "kind": "github", "allowedAuthors": ["me"] } }
  ]
}
```

**Per-repo settings** live in the repo itself, in `.agent-factory.json` on the base branch (so an agent cannot rewrite its own rules):

```json
{ "verify": "npm ci && npm test", "image": "node:22-bookworm", "maxAttempts": 3, "protectedPaths": [".github/", "infra/"] }
```

Other ticket sources: `ossicone` (a self-hosted tracker; see `src/adapters/tickets-ossicone.mjs`) and `file` (for testing). One Ossicone project can fan out to several repos with a `repo:owner/name` label and an `allowedRepos` list.

## Security model

Agent Factory runs code that a language model wrote, driven by text anyone with access to your tracker can type. Treat it like a CI system, not a toy.

- **Who can queue work:** only issues authored by `allowedAuthors` (GitHub) / `allowedReporterIds` (Ossicone). Ticket text is treated as untrusted data in the agent's prompt.
- **Sandbox:** each run is a throwaway container (`--user` = your uid, 2 GB / 2 CPU) on a Docker `--internal` network. The only way out is a tiny proxy that allows CONNECT to your agent's API hosts (and the npm registry) and denies everything else. The agent receives no GitHub token.
- **Credentials:** Codex uses a **dedicated login directory** for the factory, never your personal `~/.codex` (a container refreshing tokens could invalidate your own session). Claude uses a long-lived token from `claude setup-token` or an API key, passed by name (`docker -e KEY`), never on a command line or in logs. Secrets live in `state/secrets.env` (mode 600), not in the config.
- **Blast radius:** PRs only, never merges; protected paths (CI, its own config) are off limits; caps on runs per day, attempts, time and (for API keys) spend; `Pause` in the UI or `touch state/STOP` halts everything.
- **UI/API:** loopback bind (refused otherwise unless you opt in), bearer token on every API route, Host-header allowlist against DNS rebinding, same-origin writes only, strict CSP, request size limits, no `innerHTML`.
- **Known limits:** the proxy allows any path on an allowed host (so a sandboxed agent could still send data *to* `api.anthropic.com`/`chatgpt.com`); a determined prompt injection in a ticket from an allowed author is still a risk, so review every PR; Docker is not a perfect security boundary; if you expose the UI beyond localhost, put TLS and your own auth in front.

Report vulnerabilities privately via GitHub's "Report a vulnerability" (Security tab), not a public issue. See [SECURITY.md](SECURITY.md).

## Provider terms

Using a consumer subscription (ChatGPT, Claude) to drive an unattended agent may be restricted by the provider's terms, and OpenAI's own guidance recommends API keys for CI-style automation. Read the current terms for whichever you use. Subscription runs also share rate limits with your normal use, which is why `maxRunsPerDay` exists.

## What's verified

All of this was run for real, not just unit-tested:

- Issue → sandboxed agent (Claude and Codex) → tests → draft PR on real GitHub repos, including across multiple repos from one tracker.
- Failing GitHub Actions CI → log fetched → agent fix pushed → CI green. Review comment → follow-up commit.
- Crash recovery, daily caps, protected paths, repo allowlist, clarity gate.
- The egress proxy blocking direct access and non-allowlisted hosts (real Docker test).
- The web UI driven through its API and viewed in a browser; project creation against GitHub is covered by tests with a fake GitHub, not yet end to end.

**Not done yet:** a long unattended soak (days), non-Node repos end to end (detection exists; images/egress hosts are yours to set), GitLab/other forges, webhooks instead of polling, SQLite state (it is JSON files), multi-user auth for the UI.

## Development

```bash
npm test                          # ~46 tests, no network needed
FACTORY_DOCKER_TESTS=1 npm test   # also runs the real Docker egress-proxy test
```

Zero runtime dependencies. Layout: `src/factory.mjs` (ticket loop), `src/feedback.mjs` (CI/review loop), `src/engine.mjs` (projects, limits), `src/server.mjs` + `ui/` (API and UI), `src/adapters/` (tickets, sandbox, agents, git host). Design notes: [docs/design.md](docs/design.md); the landscape and why this exists: [docs/landscape.md](docs/landscape.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
