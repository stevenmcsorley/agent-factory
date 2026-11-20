# Security policy

Agent Factory executes code written by AI agents in Docker sandboxes, so security reports are taken seriously.

**Report a vulnerability privately** using GitHub's "Report a vulnerability" button on the Security tab of this repository. Please do not open a public issue for security problems. Include what you did, what you expected, what happened, and your Docker/Node versions.

In scope: sandbox or egress-proxy escapes, UI/API authentication or CSRF/DNS-rebinding bypasses, credential exposure in logs or containers, protected-path bypasses, and ways for an unauthorised ticket author to queue work.

Out of scope: prompt-injection that a *permitted* ticket author deliberately performs (review every PR), and Docker/kernel vulnerabilities themselves.

This is early software; there is no formal SLA, but reports get a human reply.

## Advisories

**Fixed: host-side git ran repository-controlled code (before commit 'Lock down git on the host').** The agent works in a checkout it can write, including `.git`. The factory then ran `git status/add/commit/push` on the host in that directory with git credentials in the environment, so a compromised or prompt-injected agent could plant a hook (`.git/hooks/pre-commit`) or config (`core.fsmonitor`, `core.sshCommand`, a credential helper, an `ext::` or redirected remote) and have it executed on the host. Now, before any host-side git command, the config is rebuilt from scratch with only the remote the factory cloned from, hooks and other executable extension points are deleted, and git runs with hooks, fsmonitor and the `ext::` transport disabled. A regression test (`test/gitguard.test.mjs`) plants all of these and checks nothing runs and the push goes to the real remote. If you ran versions before this, treat repositories where an untrusted ticket author could steer the agent as potentially affected and rotate git tokens.

## Local forge

The local forge (`host.kind: "local"`) stores a bare git repository per project in the state directory. Everything pushed into it is written by an agent and is treated as untrusted: the repository is created without hooks and configured to ignore them (pushes run `git-receive-pack`, which reads the repository's own config, so client-side options alone would not be enough), objects are fsck-checked on receive, sandboxes clone over `file://` so they copy objects instead of hard-linking repository files, and every command the factory runs there uses the same locked-down git options as host-side commands on agent checkouts. Merging builds the result as git objects and moves the branch with a compare-and-swap; it never checks out agent-written content. Protected paths are checked again at merge time and a branch that changed after verification cannot be merged. Merge and publish are human actions only (UI, REST with the token, CLI, or a scenario step behind an approval); no MCP or agent operation exists for them.
