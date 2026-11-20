# The AI workflow as a system

This is how Agent Factory structures AI-assisted delivery, written as a system with stages, trust boundaries, guardrails, verification and failure modes. It is meant to be walked through, and every claim below points at something you can run or read.

**Prove the guardrails in under a minute:** `npm run drill` runs the real ticket loop, real git and the real local forge against a scripted agent that misbehaves on purpose, and reports pass or fail per guardrail with evidence. No network, no Docker, no accounts.

## 1. The workflow, as stages

```
 brief ──► plan ──► ticket ──► gate ──► claim ──► sandbox ──► agent ──► verify ──► quality gate ──► push ──► draft PR ──► human review/merge
 (decisions) (epics,  (acceptance  (too short?  (lease +     (fresh     (writes     (host runs   (changed lines   (host     (provenance:   (never the agent)
              deps)    criteria)    asks)        token)       clone,     code)       the tests)   only; secrets,   pushes)   what was
                                                              no creds)                           test tampering)            checked)
                                       ▲                                                  │                │
                                       └──────────── one retry with the specific failure ◄┴────────────────┘      review comments / CI ──► bounded follow-up rounds
```

Around the loop: a **Project Pack** (brief, conventions, decisions, source material) that every run receives; a **plan** that turns a brief into small tickets released as their dependencies merge; a **reuse library** of tested parts the agent is told about and the factory tracks; **scenarios** (JSON workflows with human approval gates) for going live; and a **portfolio** view so several projects can be built at once without losing track.

## 2. Where AI is trusted, and where it is not

The architectural decision is simple: **the model proposes, deterministic code and a human decide.**

| Decision | Who makes it | Why |
|---|---|---|
| What to build | A human (brief, ticket, acceptance criteria) | The agent is not asked to invent requirements |
| Whether a ticket is clear enough | A narrow rule first (too short), then the agent (it must ask: `NEEDS_INFO`) | A word-matching rule wrongly refused good tickets, so real ambiguity is delegated and flagged as a trust point |
| Writing the change | The agent, in a throwaway sandbox with no credentials | The part AI is good at, with a small blast radius |
| Whether the change passes | **The factory, on the host, after the agent exits**, using config the agent cannot edit | An agent that runs its own checks can mark its own homework |
| Whether secrets, test tampering or protected-path edits are present | The factory (gate), not the agent | Same reason |
| Whether a run may publish | A lease token, re-checked before every write | A late or replaced worker must not act on stale authority |
| Merging and publishing | **A human only** (button, CLI, or a scenario step behind an approval); no agent or MCP operation exists for it | Irreversible and outward-facing |
| Going live | A human approval step in a scenario | Same |

What is **not** independent, stated plainly: the repository's own tests live in the repo the agent edits, so an agent can rewrite a test while keeping its assertion count. Protect the tests that encode agreed decisions with `protectedPaths`. Also, the agent's judgement of "this ticket is ambiguous" is a model decision, not a guarantee.

## 3. Context and session boundaries

- **One run, one fresh clone, one throwaway container.** Nothing carries over between runs except what is written down (tracker, repo, run records).
- **Context is assembled per run from written artefacts, not from conversation:** the project's brief, conventions, recorded decisions, attached sources, the part of the plan the ticket belongs to, and the reusable parts that match. It lands in a git-excluded `.factory-context/` folder in the clone.
- **The agreement is versioned.** Each PR records the brief revision it was built from, so a change can be tied to the agreement in force.
- **Planning is separate from building.** A planner job turns a brief into epics and small tickets with dependencies; tickets are released as their dependencies merge. Big requests never reach the build step as one blob.
- **The agent holds no credentials.** Pushing and PR creation happen on the host afterwards.

## 4. Validation and verification

1. **Gate before work:** a ticket too short to act on is stopped before any agent runs, at no cost.
2. **Verify in the sandbox:** the project's test command runs after the agent exits. A failure goes back to the agent once with the output; a second failure stops the run.
3. **Quality gate on changed lines only:** new secrets and vulnerabilities, rewrites of existing library parts, and **weakened, deleted or skipped tests** are found by the factory. Secrets block; test weakening flags (or blocks with `blockTestWeakening`).
4. **Provenance on every PR:** which brief revision, and that the verify command passed on the working tree committed as a given commit, or that **no verify command was available and the change was not machine-checked**. A pass belongs to the revision it names.
5. **Review:** a human reads a draft PR. On the local forge, merge is refused if the branch changed after verification, touches protected paths, or conflicts.

## 5. Guardrails, and the drill that proves each

| Guardrail | Drill id |
|---|---|
| Vague tickets pause and ask instead of guessing (gate, then `NEEDS_INFO`) | `ambiguous-ticket` |
| A committed secret is blocked after one retry; no branch, no PR | `secret-blocked` |
| The agent cannot edit CI or its own rules (protected paths) | `protected-path` |
| The agent cannot weaken its own tests; honest changes pass clean | `weakened-test` |
| A dead run is recovered; a poison ticket is handed to a human after two tries | `killed-run` |
| A late or replaced worker cannot publish (fencing token) | `replaced-worker` |
| Work stops when review cannot keep up (`maxOpenReviews`) | `review-backlog` |
| A project the factory cannot test gets no agent runs, when you require it (`requireVerify`); otherwise the PR says it was not machine-checked | `unverified-blocked` |
| Merge refuses a changed, protected or conflicting branch; a planted hook never runs | `forge-merge` |

Also in place, covered by tests rather than the drill: containers on an `--internal` network with an allowlisted egress proxy; the agent gets no credentials; host-side git on agent-written checkouts is locked down (hooks, config, external diff drivers disabled); caps on runs per day, attempts, time and spend; Pause and a STOP file; tickets only from allow-listed authors.

`npm run drill` also detects regressions: deliberately breaking the fencing check, the protected-path check and the secret block each made exactly the matching drill fail (checked when the drill was written).

## 6. Failure modes encountered

Real ones, from building and using this. Each is fixed and has a regression test unless noted.

| Failure | What happened | Fix |
|---|---|---|
| **The factory ran agent-controlled code on the host** | Host-side git read hooks and config from a checkout the agent could write | `gitguard`: rebuild the config, delete hooks, switch off fsmonitor, external diff and textconv before any host git; advisory in `SECURITY.md` |
| **Verification silently skipped** | The test command analysis detected in a sub-folder was shown in the UI but never applied at run time, so monorepos ran unverified, and `doctor` counted them as verified. Found by independently checking three agent PRs | Runs now use the detected command; PRs said "not machine-checked" honestly in the meantime |
| **Detection claimed tests that did not exist** | Python projects were given a `pytest` command with no tests (and `pytest` absent from requirements) | Detect only when tests exist; install `pytest` with the requirements |
| **A hook in a pushed-to repo ran on the host** | Pushes run `git-receive-pack`, which reads the repository's own config, not the options the factory passes | The local forge ignores hooks in its own config; drill `forge-merge` |
| **Passes as root, fails as the sandbox user** | A test suite that signals processes behaved differently by uid | Found by running verify commands as the unprivileged sandbox user. Not enforced by the factory: the guide says to try a command in a container as a normal user before setting it |
| **The gate wrongly refused good tickets** | An over-eager rule refused "add a blank text file in the root directory" | The gate was made deliberately narrow; ambiguity is delegated to the agent |
| **An agent could mark its own homework** | Same author for code and tests: a green run can mean the test was loosened | Test-tampering detection, protected fixtures |
| **Drift in hand-copied code** | Four copies of the same auth code had diverged; one let a malformed hash raise; every copy crashed on `decode_access_token(None)` (found by writing the part's tests) | Promoted as a tested library part; three projects moved to it by agent PRs |
| **A late worker could still act** | A run replaced mid-flight could push or write to the tracker | Fencing tokens; drill `replaced-worker` |

## 7. Production risks AI introduces, and the mitigation

| Risk | Mitigation |
|---|---|
| Prompt injection through ticket text | Only allow-listed authors can queue work; ticket text is treated as untrusted data; the sandbox has no credentials and a restricted network |
| Secrets leaking into code or logs | The gate blocks new secrets on the diff; secrets are masked in snippets; credentials are passed by name, never on a command line |
| Unreviewed change reaching production | The agent can only open draft PRs; merge and publish are human-only; protected paths cover CI and deploy config |
| A confident but wrong change | Verify runs outside the agent; provenance says exactly what was checked; weakened tests are flagged |
| Runaway cost or volume | Daily caps, attempt limits, time limits, a review-backlog cap, Pause and STOP |
| Silent loss of verification | Provenance states "not machine-checked"; the Portfolio flags an unverified project and shows the machine-checked share; `requireVerify` refuses to spend an agent run on a project that cannot be tested; this was a real failure, see section 6 |
| Quiet drift between copies of the same logic | Repeated-code detection across projects, tracked parts with versions and upgrade tickets |
| Treating a pass as permanent | A pass names the revisions it applies to |

## 8. How the workflow was improved on purpose

The Portfolio's **Flow** card (ready to merged, where work waits, rework, cost) is the measuring half of that loop. The loop is: run it on real work, find where it failed or was overtrusted, turn the failure into a check and a regression test. Examples: a security review of host-side git produced the lock-down; a review of the workflow against a practitioner's draft playbook produced test-tampering detection, fencing, the review cap and provenance; using the factory to move three real projects onto shared parts exposed the verification gap above; writing tests for extracted code found bugs every copy shared; the drill exists so the guardrails are re-proven after every change instead of assumed.

## 9. What this does not cover (open risks)

- **One user.** It has been used by its author on their own projects, not yet by a team. Whether others can operate it is untested.
- **The drill proves the factory's checks, not the model.** It uses a scripted agent. The test-tampering, fencing and quality checks have not yet been seen catching a real model misbehaving in a real run (the secret check has: a real agent run was sent back by the gate after it flagged a planted AWS key, then produced a clean change).
- **No long soak.** Days of unattended running are untested.
- **Flow metrics are new.** The Portfolio page shows ready-to-merged, review wait, build time, decision wait, first-pass and rework rates, machine-checked share and cost per accepted change, but they only count from when event recording began, and the page says so when the sample is under five accepted changes. They are measurements, not conclusions.
- **Provider terms.** Using a consumer subscription for unattended agents may be restricted; see the README.
- **The repository was itself built with an AI coding agent** (Claude Code), working to the author's decisions. The workflow above is also how that work was reviewed: independent checks of agent output (tests run in containers, servers started and exercised) before accepting it.

## 10. A walkthrough, in order

1. `npm run drill`: nine guardrails, pass/fail with evidence.
2. `npm start`, then **Studio → New project → On this machine**: a project with no accounts; give it a brief and a test command.
3. Queue a ticket; watch it travel the line. Open the PR: diff, quality gate, provenance. Merge it (your decision), then publish if you want.
4. Break something on purpose (`docs/EXTENDING.md` shows how to add a rule) and run the drill again.
5. Read section 6 and ask which failure you would have found first.
