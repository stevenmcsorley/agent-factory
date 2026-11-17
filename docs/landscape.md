# Landscape research (2026-11-17)

Question: is there an open-source / self-hosted equivalent of Devin's always-on cloud agents ("dark factory" style software delivery)? The claim going around was "it doesn't exist just now".

## Verdict

**The claim is mostly outdated.** Self-hosted, event-triggered agents exist. What is still thin is the *delivery-pipeline* layer: a backlog-driven, budgeted, multi-repo fleet with CI/review loops and self-improvement. That is the realistic gap.

## What exists (checked 2026-11-17; primary = fetched from the project's own README)

| Project | Self-host | Always-on / triggers | Sandbox | Notes |
|---|---|---|---|---|
| **OpenHands** (formerly OpenDevin) — github.com/OpenHands/OpenHands | Yes (npm, Docker, multi-container, source) | README: "Automations … run on a schedule or in response to webhook events"; integrations Slack, GitHub, Linear, Notion | Docker per conversation (multi-container mode); bare install has full host access | MIT per repo sidebar; ~93k stars. Can drive Claude Code, Codex, Gemini CLI, OpenCode as agents. Enterprise features (SSO/RBAC) reportedly commercial — unverified. Closest thing to "the open Devin". |
| **Open SWE / "Robin"** (LangChain) — github.com/langchain-ai/open-swe | Partly: README says deploy-as-is needs LangSmith Managed Deep Agents; otherwise fork | GitHub issues/PRs + scheduled tasks, Slack, Linear | Per-thread Linux sandboxes (LangSmith default) | MIT, but "not accepting issues or contributions", breaking changes expected. Does CI monitoring + PR review. Good reference design, poor dependency. |
| **GitHub Copilot coding agent** | No | Assign issue to @copilot | Ephemeral Actions VM | Proprietary; per secondary sources. |
| **OpenAI Codex cloud** | No | chatgpt.com/codex, @codex on GitHub | Per-task sandbox | Proprietary; per secondary sources. |
| **Cursor background agents** | No | Slack, Linear, GitHub, editor | Cloud VMs | Proprietary; per secondary sources. |
| **Devin** — docs.devin.ai | No | Slack/Teams, Linear/Jira, API, CLI `/handoff` | Shell + IDE + browser (docs don't describe isolation) | Docs page fetched does not mention always-on, triggers or pricing. |
| SWE-agent, Aider, Cline | Yes | No (single task / interactive) | Varies | Task-level agents, not a pipeline. |

Caveat: the product comparisons for the proprietary tools come from SEO blog posts that disagree on prices/features. Treat as indicative only.

## Where the real gap is

OpenHands covers "event in → agent run → PR". Weak or absent in what I could verify:

1. **Backlog-as-queue**: pull work from *your* tracker with claim/lease semantics, retries, priority, and per-ticket budgets — not just react to a mention.
2. **Closed loop on CI + review**: re-enter the agent on failing checks or review comments until green, with an attempt cap (Open SWE does this; OpenHands status unverified).
3. **Fleet governance**: global concurrency, cost/time budgets, kill switch, audit log of every command, least-privilege per-repo credentials.
4. **Agent-agnostic worker**: swap Claude Code / Codex / OpenHands / shell per ticket class, so the factory isn't tied to one vendor.
5. **Self-improvement loop**: factory failures become tickets in its own backlog (using the tool to improve itself).
6. **Small, auditable core** that fits a single small VM — OpenHands is a large platform.

## Recommendation

Don't clone OpenHands. Build a **thin orchestrator (~1–2k LOC) with adapters** for tickets / sandbox / agent / VCS, and let OpenHands be *one possible agent adapter* later. Differentiators: 1–6 above. Build-vs-adopt risk: if OpenHands' automations already satisfy 1–3 for you, adopt it and only build 4–5. **First action in any adoption path: spend an hour running OpenHands automations against a scratch repo** — I did not run it, only read the README.

## Sources
- https://github.com/OpenHands/OpenHands
- https://github.com/langchain-ai/open-swe
- https://docs.devin.ai/
- https://northflank.com/blog/top-devin-ai-alternatives-for-autonomous-coding
- https://alexcloudstar.com/blog/best-background-coding-agents-2026/
