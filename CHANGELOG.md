# Changelog

## Unreleased
- **Portfolio page** (every project from brief to shipped, next step for each, "Needs you" list) and a planning prompt on the Control room, so briefs, plans and the library are discoverable.
- **Stale-tab fix:** the UI tells an already-open browser tab when the factory was updated and offers a reload (build id in `/api/status`).
- **Library page** in the UI: set up or connect the library, searchable part cards with API, usage, file viewer, tests and who uses which version; **Repeated code** with a promote form; **Upgrades**; and a how-it-works tab. `library_*` MCP operations, `agent-factory library …` CLI, header navigation tightened for the extra item.
- **Reuse library (backend, CLI and MCP):** a git repo you own holds tested parts (`parts/<slug>/part.json`, `src/`, `test/`, README). Create or connect it (`agent-factory library create|connect`), find repeated code across projects (`library candidates`; renamed copies are found too), promote it as a PR (`library promote`), search it (`library search`), and queue a ticket to use a part (`library use`). Before every run the factory tells the agent which parts match the ticket and provides their files; afterwards it records reuse in `.factory/parts.lock.json` and on the PR. New files that rewrite a part are flagged by the quality gate (one retry, then a flag). Version bumps open upgrade tickets in projects on the old version.
- **Project Pack** (Brief and Plan tabs): a structured brief (goal, users, scope, out of scope, done criteria, constraints), conventions, decisions and source material (files, links, text) for every project; the agent drafts a delivery **plan** (epics, small tickets with acceptance criteria and dependencies) you edit and launch; tickets are released as their dependencies are merged. Every agent run receives the relevant context. Publish the pack to the repo as a PR under `.factory/`.
- **Agent-native control:** `agent-factory portfolio | brief | source | plan | ops | op | agents-md` drive a running factory from the terminal (or any AI agent); `create_project`/`add_project` accept a brief and a plan request; new MCP operations for briefs, sources, plans, analysis and a portfolio view. See docs/AGENT-GUIDE.md.
- The create-new-project form is now brief-first (the one-box description is a quick start).
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
