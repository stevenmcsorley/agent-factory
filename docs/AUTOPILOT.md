# Autopilot: schedules, roles, skills, designs and autonomous mode

Everything here is off or neutral by default. With nothing switched on, the factory behaves exactly as before: one agent builds each ticket, opens a draft PR, and a human merges.
All of it can be driven from the UI (a project's **Autopilot** and **Designs** tabs, the **Skills** page, **Settings**) and from MCP (`search` for the tool names below).

## Why is this waiting?
`why_waiting` (and the Autopilot tab's "Right now" card) lists every reason a ready ticket is not being picked up: the factory is paused, the project is paused, it is outside its schedule, the daily run cap or budget is reached. Each reason says when it can resume.

## Schedules (`set_schedule`)
Per project: `startAt` (nothing before this date), `hoursPerDay` (agent time per local day, counted from recorded runs), `windows` (`[{days:[0-6], from:"22:00", to:"06:00"}]`, may cross midnight; after midnight a window belongs to the day it started on), `priority` (1 first to 9 last when many projects are due), `stopWhenDone` (pause the project when its plan is complete). Times are the machine's local time. A run already in progress is never cut off at a boundary; the next one simply does not start.
For 100 projects at 5 hours a day each: give them all `hoursPerDay: 5`, give the important ones a lower `priority`, and keep `limits.parallelProjects` and `maxRunsPerDay` at what your plan can carry.

## Roles (`get_roles`, `set_roles`, `set_project_roles`)
`builder` (always on), `reviewer` (optional), `designer`, `fixer` (CI failures and review comments on an open PR), `planner`, `skill-writer`. Each can use its own model and reasoning effort. The reviewer is a second agent run that reads the change before its PR opens, on a throwaway copy of the workspace so it cannot alter what it is judging. Blocking findings go back to the builder; if they are still unresolved on the last attempt the PR opens **flagged** on its Provenance note. An unreadable verdict counts as an error, never an approval. It costs one extra agent run per attempt, so it is off until you turn it on (globally or per project).

## Skills (`list_skills`, `save_skill`, `preview_skills`, `draft_skill`, ...)
A skill is a Markdown file with a small header (name, description, roles, projects) that agents receive for a kind of work. Built-ins ship for code review, bug fixing, test writing, UI design and skill writing; saving a skill with a built-in's name makes your own copy, and deleting it restores the built-in. `preview_skills` shows exactly what a role would get on a project. The skill-writer drafts or improves a skill from a description; the draft is only ever shown to you to read, edit and save.

## Designs (`create_design`, `revise_design`, `edit_design`, `approve_design`, ...)
Ask the designer for a mockup. It reads the brief and your approved designs and writes one self-contained HTML file. You review it (desktop and phone width), ask for changes (the next version keeps what you did not mention), edit the HTML yourself, and approve or reject. **Only approved designs reach the builder**, with their stylesheet and the full file under `.factory-context/designs/`. Mockups are cleaned on the way in (no scripts, frames or outside requests) and previewed in a sandboxed frame from a short-lived unguessable address under a policy that allows no scripts and no network.

## Autonomous mode (`set_autonomy_allowed`, `set_autonomy`, `autonomy_status`)
**This merges pull requests without a human.** It is opt-in twice: a factory-wide switch (Settings) and a per-project mode. Turning the factory-wide switch off stops every project at once.
A PR merges only when all of these hold: the run ended ok; the quality gate passed; a test command checked the change and covers the files it touched; the reviewer agent approved (unless you turn that requirement off); CI is green and finished; no review comment is unhandled; and today's per-project and factory-wide merge caps are not reached. Anything else is *held*, with the reasons shown on the Autopilot tab. Every merge is written to `state/audit.jsonl`, commented on the ticket, and the ticket is closed.
After merging, a pipeline that breaks becomes **one fix ticket per failing run**, at most `fixAttemptsPerWorkflow` per workflow (the count resets when it is green again), then it stops and leaves it to you.
Supported for GitHub (`gh pr ready` + squash merge; branch protection that needs a human approval makes `gh` refuse, and that is reported as a held reason, never forced) and the local forge. GitLab and Bitbucket are refused for now. Not tested against a real GitHub repository yet: try it on a scratch repo first.

## Ticket file allowlist
A ticket can include a fenced block listing the only files that may change:

    ```allowed-files
    src/billing/**
    test/billing.test.js
    ```

A change touching anything else is refused: the agent gets one chance to put the extra files back, and if it does not, nothing is pushed.

A ticket that declares `allowed-files` also **waits while an open pull request changes any of those files**, so two changes to the same files do not collide. It goes as soon as that PR is merged or closed; the reason is shown on the project's Autopilot tab. Tickets without the block are never held.

## Visual check (`set_preview`, `visual_check_now`, `get_preview`)
Tests and typechecks cannot see a layout that breaks on a phone, text you cannot read, or a page that throws. With a project's **preview** set (how to start the app, its port, the routes to load), the factory, after a change passes its tests, starts the app in the sandbox and loads every route at 360, 768 and 1280 px (light and dark) in a real Chromium. It looks for: sideways scroll, text below WCAG contrast (under 3:1 fails, under 4.5:1 is a warning), tap targets under 44 px on the phone width (warning), console errors and uncaught exceptions, pages that fail to load or answer 4xx/5xx. It only observes: it never clicks or types.
**Only new problems count.** Run "Check now" once on the base branch to record a baseline; later changes are judged on what they add, so an app with old problems is not blocked by them. New failures go back to the builder like a failing test (one retry per attempt); on the last attempt the PR opens with the problems listed on its Provenance note. A check that could not run (the app would not start, no browser image) is recorded and never blocks the PR. In autonomous mode, new failures and a check that could not run both hold the merge. Screenshots are kept with the run and shown on its page.
Setup: build the browser image once (`docker build -f Dockerfile.visual -t agent-factory-visual:latest .`, about 2.3 GB), then set the preview on the project's Autopilot tab or with `set_preview`. Limits: Node-based dev servers and static sites only (the container is Node on Debian; other stacks need their own image), and pages that need a backend need that backend to be reachable or mocked by the dev server. The measurements are heuristics (for example, text over a gradient or image is not contrast-checked).
