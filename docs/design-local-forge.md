# Design: the local forge

Status: proposal, nothing built yet. Read it, change what you disagree with, then I build it.

## Why

Today a project needs an online host (GitHub, GitLab, Bitbucket) before the factory can do anything. That means an account, a token and waiting on a network for every PR, even for a prototype you may throw away. The built-in tracker removed that for tickets. The local forge does the same for code: the factory builds, you review and merge on your own machine, and you push to a real remote only when you decide the work is worth publishing.

## What it is

A new code host kind, `local`, registered next to `github`, `gitlab`, `bitbucket` and `git` in `src/hosts.mjs`. It implements the same host contract, so the factory loop, the PR feedback loop, scenarios and the UI treat it like any other host.

- **Storage:** one bare repository per project at `state/forge/<project>/repo.git`, plus `state/forge/<project>/prs.json` for PR records.
- **Clone URL:** the bare repo's filesystem path. The sandbox already clones from a URL, so no sandbox change is needed.
- **Pull requests:** a record per PR: number, branch, base, title, body, state (`open`, `merged`, `closed`), draft flag, labels, comments, the head commit at last update, created/updated times. Always opened as drafts, like the other hosts.
- **Feedback loop:** `getFeedback` returns human comments from the record and the result of the project's verify command, so "address my review comments" works exactly as it does on GitHub.

## Host contract mapping

| Contract | Local forge |
| --- | --- |
| `cloneUrl`, `gitEnv` | bare repo path, no credentials |
| `inspectRepo` | checks the repo exists, returns its default branch |
| `openPr` | records a PR for the pushed branch, returns `local-pr:<project>/<n>` |
| `pr.listAgentPrs` | open PRs whose branch starts with `agent/` |
| `pr.getFeedback`, `comment`, `label` | read and write the PR record |
| `prUrl` | the UI route for that PR |
| new: `diff(pr)` | diff of base...head, rendered in the UI |
| new: `merge(pr)` | merges the branch into base (see Security) |
| new: `close(pr)` | marks closed, keeps the branch |

## Creating a project

- **From scratch:** `agent-factory add my-app --host=local` creates an empty bare repo with an initial commit on `main`.
- **Import an existing repo:** clone from a URL or a directory into the bare repo, remembering the origin as the *publish target*.
- **From the wizard:** "Code lives: on this machine" next to the existing hosts. Tickets and code can be local independently (local tracker with GitHub code, GitHub issues with local code, or both local).

## Reviewing and merging

The project's Pull requests tab gains, for local PRs: the diff (files changed, added/removed lines, the quality gate result and the Provenance section already in the PR body), a comment box, and **Merge** and **Close** buttons. Merge is a human action only: it is a REST/UI/CLI call, never an agent tool and never something a scenario does by itself, matching how approvals work today. Merge refuses when the verify result is for a different commit than the branch head (the provenance check from the playbook work), and offers fast-forward or merge commit.

## Publishing to a real remote

The point of working locally is to ship later. Publishing is a deliberate gate:

- A project can have a **publish target**: `{ kind: github|gitlab|bitbucket|git, repo, ... }`, configured like any host, with its token stored the usual way.
- **Publish** pushes the base branch (and optionally tags) to that remote, using the existing credential handling (token in an environment variable, never argv, never in the repo config).
- It is available as a scenario step `publish` (dry run by default, requires an approval step before it in `scenarios/ship.json`) and as a button and CLI command. Nothing is pushed on a schedule or by the agent.
- It refuses when the local base has unmerged agent PRs the owner has not looked at, if `limits.maxOpenReviews` is set and exceeded, or when the remote has commits we do not have (no force pushes, ever; you resolve divergence yourself).
- After a publish, the project can **switch host** to the remote so new PRs open there. Local PR history stays as a read-only archive.

## Security

The bare repo is written by the agent's pushes, so everything in it is untrusted, the same threat the git-hook advisory covered.

- Create it with an empty hook template (`git init --bare --template=<empty dir>`), and run every host-side git command with the existing `SAFE_GIT` options and `lockGit`, so a hook or config planted through a pushed branch can never run on the host.
- Merging and diffing happen in a temporary clone that is locked the same way, never in the bare repo's own working state.
- Protected paths (`.github/`, `.agent-factory.json`, anything the repo file lists) are enforced when the PR is **opened and again when it is merged**, so a branch edited after review cannot slip a protected change through.
- Branch names come from the factory (`agent/<id>-<slug>`); PR numbers are validated as integers before any path is built; the diff view renders as text, never HTML.
- `prs.json` is written atomically, and a corrupt file stops the forge and keeps a copy, as the tracker does.

## What this does not do

- It is not a hosting server. Nobody else can clone from it unless you share the folder or publish it. That is a feature for a first version.
- No CI. Verification is the project's verify command in the sandbox, as now. If you publish to GitHub and have CI there, it runs after publishing.
- No code review features beyond comments, diff and merge: no inline line comments, no approvals from multiple people, no branch protection rules.
- It does not replace a real forge for a team. It makes the first days of a project, and solo or offline work, fast.

## Build order

1. `host-local.mjs`: bare repo creation and import, PR records, `openPr`, `listAgentPrs`, `getFeedback`, comments, labels. Tests with real git.
2. Merge and diff with the locked temporary clone, protected-path recheck, verify-versus-head check. Tests including a hostile branch (planted hook, planted config, edited protected file after review).
3. API, CLI and UI: diff view, comment, merge, close.
4. Publish target, the `publish` scenario step, switch-host after publish.
5. Docs, then try it end to end with a real agent on a real small project.

## Open questions for you

1. Should merge default to fast-forward only (clean history) or allow merge commits?
2. Should publishing carry the full local history, or squash agent PRs into one commit per ticket?
3. Do you want local PRs to also be mirrored as real draft PRs when a publish target exists, or is "publish the base branch only" enough?
