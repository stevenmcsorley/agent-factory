# Make it yours: changing how the factory works

Agent Factory is meant to be adapted. Your tracker, your host, your deploy target, your definition of "ready to ship" and the wording your agents see are all yours to change, and you can change the app itself. This guide says how, and where the safety lines are.

**Principles**

1. **Data over code.** Workflows, gates, prompts, ignore rules and quality limits are files you edit, not code you fork.
2. **Code only when you must, and trust is explicit.** Plugins are trusted code. You enable one on purpose, offline, and the factory pins a hash of its files.
3. **Humans hold the gates.** Approving a go-live, enabling a plugin and merging a PR are human acts. Agents (including anything connected over MCP) cannot do them.

## What you can change

| You want to change… | How | Where |
|---|---|---|
| The workflow from idea to live (prototype only? deploy? when?) | **Scenarios**: JSON files of steps, checks and approval gates | `scenarios/*.json` next to your config |
| Which service does the deploy (Cloudflare, your server, a hook) | A scenario step: the built-in `http` step, a bundled plugin, or your own plugin | `plugins/<name>/` |
| The ticket tracker or code host | A plugin calling `registerSource` / `registerHost` (same shape as the built-in Jira, Linear, GitLab…) | `plugins/` |
| Extra checks on the agent's code | A plugin calling `registerRule`, or the existing quality-gate and ignore settings | `plugins/`, `agent-factory.json` |
| New kinds of library part | Built in: component, hook, util, service, schema, style, config, **theme, pattern, form, skill**. A plugin can add more with `registerPartKind` | `plugins/` |
| New operations for MCP and the CLI | A plugin calling `registerOp` | `plugins/` |
| What the agents are told | **Prompts**: a Markdown file replaces the built-in rules | `prompts/task-rules.md` next to your config |
| Limits, gates, ignore patterns, concurrency | Configuration | `agent-factory.json`, or a repo's `.agent-factory.json` |
| The app itself | Fork it, or let the factory manage its own repo (below) | this repo |

**Not pluggable yet (honest list):** starter templates for brand-new repos, adding a brand-new CLI agent (beyond Claude and Codex), and UI pages. Those still need a code change to the app.

---

## Scenarios

A scenario is a JSON file. A **run** walks its steps in order, waits at human gates, and records everything.

```json
{
  "id": "ship",
  "name": "Ship to production",
  "params":     { "domain": { "label": "Domain", "required": true } },
  "secrets":    ["AF_CLOUDFLARE_TOKEN"],
  "allowHosts": ["api.cloudflare.com"],
  "steps": [
    { "id": "merged",  "type": "check",   "check": "plan-complete", "title": "Every planned ticket is merged" },
    { "id": "approve", "type": "approve", "message": "Go live on {{params.domain}}?" },
    { "id": "dns",     "type": "cloudflare.dns", "zone": "{{params.zone}}", "name": "{{params.domain}}", "content": "site.pages.dev" }
  ]
}
```

* **Steps** run in order (or per `requires: ["stepId"]`). `optional: true` lets a failing step be skipped. `timeoutMs` bounds how long a waiting step may wait.
* **Built-in step types:**
  * `ticket`: queue work for the agent (`title`, `body`, and `waitFor: "closed"` to wait until it is merged).
  * `check`: is the project ready? `brief-ready`, `plan-complete`, `queue-empty`, `gate-ok`, or `http-ok` (`url`). A check that is not true yet *waits* and is re-checked each cycle.
  * `approve`: a human says yes (UI or `agent-factory scenario approve`).
  * `http`: an HTTPS call (`method`, `url`, `headers`, `body`, `expect`).
  * `note`: a marker or documentation step.
* **Plugin step types** look like `cloudflare.dns`.
* **Templates:** `{{params.x}}`, `{{project.id}}`, `{{project.repo}}`, `{{brief.goal}}`, `{{steps.<id>.output.<field>}}`, and `{{secret:AF_NAME}}`.
* **Secrets** must be listed in the scenario's `secrets`, must live in `state/secrets.env`, and are redacted from everything stored.
* **`allowHosts`** is the only list of hosts a scenario's HTTP calls may reach: HTTPS only, no redirects, no IP addresses, no localhost or private names.

**Dry run first.** Every run is a dry run unless you say apply (`--apply`, or "Run for real" in the UI, which asks you to confirm). A dry run evaluates checks for real but only *describes* what other steps would do. Plugin steps can show a precise preview: the bundled Cloudflare DNS step reads the zone and shows "create" or "update" with the exact record.

**Lifecycle: prototype or deploy.** Two scenarios ship with the factory: `prototype` (brief ready → everything merged → quality gate → done, no deployment) and `ship` (everything merged → queue empty → quality gate → **a human approves** → deploy). "At what point can we say yes deploy" is exactly the checks you put before the `approve` step. `docs/examples/cloudflare-ship.json` is a complete example with DNS and a Pages deployment.

**Run and watch:** the **Scenarios** page, or:

```bash
agent-factory scenario list
agent-factory scenario run my-app ship --environment=production            # dry run
agent-factory scenario run my-app ship --environment=production --apply    # for real, stops at the approval
agent-factory scenario runs my-app
agent-factory scenario approve my-app <run> approve                        # a human decision
```

---

## Plugins

```
plugins/<name>/plugin.json   { "name": "my-deploy", "version": "1.0.0", "description": "…", "secrets": ["AF_MY_TOKEN"], "main": "index.mjs" }
plugins/<name>/index.mjs     export function register(api) { … }
```

Scaffold one: `agent-factory plugin new my-deploy`. Then `agent-factory plugin list`, `agent-factory plugin enable my-deploy`, restart.

**What `register(api)` can do**

| Call | Adds |
|---|---|
| `api.registerStep(name, { describe(args, ctx), plan?(args, ctx), run(args, ctx), validate?(args) })` | A scenario step type `<plugin>.<name>` (a deploy target, a notifier, anything) |
| `api.registerOp({ name, description, input, readOnly, handler(engine, args) })` | An operation for MCP and the CLI, named `<plugin>_<name>` |
| `api.registerRule({ id, type, severity, msg, langs, re })` | A quality rule applied to repository scans and to the agent's changed lines |
| `api.registerPartKind(name)` | A library part kind (`theme`, `form`, `skill`…) |
| `api.registerSource(kind, def)` / `api.registerHost(kind, def)` | A ticket tracker / code host, in the same shape as the built-ins |
| `api.secret("AF_NAME")` | A secret **you declared in plugin.json** (nothing else is readable) |
| `api.safeFetch(scenario, { method, url, headers, body }, fetch)` | The same restricted HTTPS client the `http` step uses |
| `api.config`, `api.log(msg)` | Per-plugin config (`plugin enable <name> --config='{…}'`) and logging |

A step's `ctx` has `engine`, `project`, `scenario`, `params`, `fetch`, `dryRun` and `log`. `plan()` is called in dry runs and must only **read**. `run()` is called for real runs, after any approval gate.

**Security model.** Plugin code runs inside the factory process, with the factory's permissions. So:
* Enabling is offline and human: `agent-factory plugin enable <name>` stores a hash of every file. There is no API or MCP operation to enable a plugin.
* If a single byte of an enabled plugin changes, it is **refused** at the next start until you review it and enable it again. This also protects you if the factory edits its own repository.
* A plugin sees only the secrets it declares, and every outbound call goes through `allowHosts`.
* Read a plugin before you enable it, exactly as you would an npm package.

**Bundled examples:** `plugins/cloudflare` (DNS upsert and Pages deployment; dry runs show the exact change; not yet verified against live Cloudflare) and `plugins/deploy-hook` (POST to any deploy hook).

**Deploying to *your* systems.** Nothing assumes a host. Pick whichever fits: the `http` step to a deploy hook, `deploy-hook.trigger`, GitHub Actions through `repository_dispatch` (an `http` step to `api.github.com`), or a plugin that does what you need (for instance one that starts a job on your self-hosted runner, or runs `rsync` over SSH). Put the steps after an `approve` step and test with dry runs.

---

## Prompts

Put `prompts/task-rules.md` next to your config to replace the rules every building agent is given (use `{{vars}}` if you like). A missing, empty or oversized (over 8 KB) file falls back to the built-in text, so a typo cannot leave an agent without rules. The built-in text is in `src/prompts.mjs`.

## Configuration you may already know

`agent-factory.json` holds limits (`maxRunsPerDay`, `maxConcurrent`), the quality gate (`limits.qualityGate`), analysis ignore patterns (`limits.analysis.ignore`) and per-project settings. A repository's own `.agent-factory.json` can set `verify`, `protectedPaths` and `analysis`, and the agent cannot edit it.

---

## Changing the whole app

**Fork it.** It is plain Node with one optional dependency, and the tests (`npm test`) cover the engine, the UI server and every adapter. Where things live:

| Area | Files |
|---|---|
| The ticket loop, prompts | `src/factory.mjs`, `src/prompts.mjs`, `src/triage.mjs` |
| Sandbox, egress, git safety | `src/adapters/sandbox.mjs`, `src/egress*.mjs`, `src/gitguard.mjs` |
| Trackers and hosts | `src/sources.mjs`, `src/hosts.mjs`, `src/adapters/*` |
| Briefs and plans | `src/pack.mjs` |
| Library | `src/library.mjs` |
| Quality and analysis | `src/quality.mjs`, `src/analyze.mjs`, `src/inspect.mjs`, `src/ignore.mjs` |
| Scenarios and plugins | `src/scenarios.mjs`, `src/plugins.mjs` |
| API, MCP, CLI | `src/server.mjs`, `src/ops.mjs`, `src/mcp.mjs`, `src/cli*.mjs` |
| UI | `ui/*.js` (vanilla modules, no build step) |

**Let the factory improve itself.** Add this repository as a project and queue tickets against it. The repository's `.agent-factory.json` marks the **security core as protected paths** (git safety, sandbox, egress proxy, the server's auth, the plugin loader, the scenario engine, the CI and licence files). A run that touches them is rejected, so self-improvement cannot quietly weaken the guarantees. Change those files by hand, review them, and merge.

## Verification you can tighten

Three settings decide how much the factory trusts the agent's own work: `qualityGate.blockTestWeakening` (block instead of flag weakened tests), repo-level `protectedPaths` (files the agent can never change: CI, fixtures, golden files), and `limits.maxOpenReviews` (stop starting work while review is backed up). The checks that *decide* acceptance run on the factory host, after the agent exits, from configuration the agent cannot edit. What is still not independent: the test files themselves live in the repository the agent edits, so protect the ones that encode agreed decisions.

## Honest limits

* Plugins are trusted code. There is no sandbox for them; the hash pin is a tripwire, not a cage.
* Scenario steps run on the factory host. Anything that must run on another machine (a runner, a server) needs a plugin or hook that triggers it there.
* Parallel builds are per project (`limits.parallelProjects`), not per ticket within a project, and the daily run cap can be overshot by a run or two when lanes start together.
* Scenarios and plugins are read at start (plugins) or on use (scenarios); there is no hot reload for plugins.
