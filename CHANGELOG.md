# Changelog

## 0.3.0
- **Control room UI** redesigned: live assembly line with a monoline animated icon per station, work-order pages, ticker, light and dark themes, self-hosted fonts.
- **Inbox**: act on everything that needs a human (add detail and requeue, comment, edit, close, review PRs). Also available over MCP.
- **Pluggable trackers and code hosts**: GitHub Issues, Ossicone, Jira, Linear; GitHub, GitLab, Bitbucket, any git remote. Guided setup with connection tests.
- **MCP server** with Code Mode (`/mcp-code`, about 270 tokens) and direct tools (`/mcp`).
- `/healthz` for uptime monitors; `service` command prints a systemd unit; agent logins run inside Docker.
- Fixes: tickets created from the UI are found immediately (GitHub's lists lag by seconds); closed tickets no longer count as queued; Ossicone ticket links and numeric comment ids; animation jitter from full-page redraws.

## 0.1.0
- First public release: tickets in, draft PRs out, in a Docker sandbox with an egress allowlist.
