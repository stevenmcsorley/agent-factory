# Changelog

## Unreleased
- **Security fix:** git commands on the host no longer run repository-controlled code (hooks, fsmonitor, sshCommand, credential helpers, `ext::` or redirected remotes planted by the agent in `.git`). See SECURITY.md.
- **Built-in quality engine** (no server, no download): our own rules, a quality gate for the whole repo with a trend over time, and the same gate on the agent's own change, checking only the lines it added or changed (one retry; a leftover secret stops the PR, other findings are flagged on it). SonarQube is now an optional, advanced add-on.
- **Optional SonarQube integration** (Health page): run the official Community container for you, or connect your own server/SonarCloud. New projects are scanned in the background and Re-analyze re-scans; results (quality gate, bugs, vulnerabilities, smells, coverage, findings with a Queue fix button) appear on the project's Code health card. Re-analysis is now a background job with live progress.
- **Repository analysis** on add (and Re-analyze): language, package manager, detected test command (including apps in subfolders), A–E ratings for size, tests, duplication, upkeep and committed secrets, with an editable verify command. Saved with the project, summarised in the agent prompt, and flagged on Health when a project has no way to verify.
- The ticket pre-check now only blocks tickets too short to act on; the agent proceeds on stated assumptions or asks specific questions (`NEEDS_INFO:`).
- Pasting any repository URL (web, `.git`, ssh) is accepted.

## 0.3.0
- **Control room UI** redesigned: live assembly line with a monoline animated icon per station, work-order pages, ticker, light and dark themes, self-hosted fonts.
- **Inbox**: act on everything that needs a human (add detail and requeue, comment, edit, close, review PRs). Also available over MCP.
- **Pluggable trackers and code hosts**: GitHub Issues, Ossicone, Jira, Linear; GitHub, GitLab, Bitbucket, any git remote. Guided setup with connection tests.
- **MCP server** with Code Mode (`/mcp-code`, about 270 tokens) and direct tools (`/mcp`).
- `/healthz` for uptime monitors; `service` command prints a systemd unit; agent logins run inside Docker.
- Fixes: tickets created from the UI are found immediately (GitHub's lists lag by seconds); closed tickets no longer count as queued; Ossicone ticket links and numeric comment ids; animation jitter from full-page redraws.

## 0.1.0
- First public release: tickets in, draft PRs out, in a Docker sandbox with an egress allowlist.
