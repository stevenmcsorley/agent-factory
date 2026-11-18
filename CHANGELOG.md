# Changelog

## Unreleased
- **Code explorer redesign:** the Code tab now has Overview, Findings, Files, Repeated code, Tests and Ignored sub-tabs. Findings show the real code line (secrets masked), why it matters and how to fix it, deep links to the line on the code host, search, severity/kind filters, grouping, and per-finding Queue fix / Ignore file. Files view with sizes, test status and findings per file. The CLI honours `.gitignore` in your own working copy.
- **Ignore files in the analysis and the PR gate:** lock files, minified/generated files, snapshots, build output and images are skipped by default; add your own patterns per project (Code tab), globally or in the repo's `.agent-factory.json`. The Code tab shows what was skipped.
- **Security fix:** git commands on the host no longer run repository-controlled code (hooks, fsmonitor, sshCommand, credential helpers, `ext::` or redirected remotes planted by the agent in `.git`). See SECURITY.md.
- **Built-in code inspection** (no server, no download): a Code tab per project with folder layout, repeated code (exact files and lines), untested files, and our own quality rules with a trend; each finding can be queued as a ticket. `agent-factory analyze <folder|url>` prints the same report in the terminal.
- **Quality gate on the agent's own change**: only the lines it added or changed are checked (one retry; a leftover secret stops the PR, other findings are flagged on it). Tested with a real agent.
- Re-analysis is a background job with live progress. (An optional SonarQube integration was built and then removed again: it needed a 1.4 GB download and 10% free disk.)
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
