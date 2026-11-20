# Evidence: a real UI redesign through the factory (Ossicone, 2026-11-20)

A real, unscripted use of the factory on a live app (Ossicone, a React + Tailwind project tracker running on a Raspberry Pi). The brief was one sentence from the owner: the projects page looked poor, was bad on mobile, descriptions were one huge paragraph, and the cards needed to be more visual. The work then grew, one screen at a time, to the board, issue detail, issues list and backlog.

I split it into small, sequential tickets, each with exact helper signatures, tests and constraints. The factory built each one in a sandbox, ran the project's own checks (typecheck, unit tests, production build) and opened a draft PR. The owner merged each PR; the factory never merges.

**Result: 17 tickets, 17 draft PRs, every one built on the first attempt (attempts = 1), median build 5.5 minutes, none rejected.**

| # | Ticket | PR | Build | Files |
|---|--------|----|-------|-------|
| 3 | Projects: clamp long descriptions ("Show more") | #4 | 277 s | 4 |
| 6 | Mobile app shell: phone search, 44px targets, accessible nav | #7 | 333 s | 7 |
| 5 | Projects: visual cards (progress, status mix, 14-day sparkline) | #8 | 421 s | 4 |
| 9 | Projects: search and seven useful sorts, URL state, loading/error/no-results | #10 | 382 s | 4 |
| 11 | Projects polish: one per row, wide desktop layout, single key, Safari fix | #12 | 387 s | 10 |
| 13 | Projects card: description rendered above the name on desktop | #14 | 431 s | 1 |
| 15 | Board: responsive header and controls, skeleton | #16 | 272 s | 2 |
| 17 | Projects: pagination with a reusable `Pagination` component | #18 | 270 s | 7 |
| 19 | Board columns usable on tablets | #20 | 210 s | 1 |
| 21 | Sprint goal: tidy clamped display, 200-character limit | #22 | 313 s | 5 |
| 23 | Board: accessible "Move to" menu (touch and keyboard) | #24 | 377 s | 5 |
| 25 | Search results: pagination | #26 | 374 s | 1 |
| 27 | Board: clamp the project description in the board header | #28 | 279 s | 1 |
| 29 | Issue detail: responsive single-column layout | #30 | 293 s | 1 |
| 31 | Issues list: cards below xl, stacked filters, shared pager | #32 | 410 s | 2 |
| 35 | Backlog: cards below xl, wrapping headers, mobile-safe modal | #36 | 452 s | 3 |
| 37 | Backlog: "Move to" menu (backlog and sprints) | #38 | 388 s | 4 |

Factory flow card for the period: 19 accepted changes, first-pass rate 97% (39 runs), rework 0, one review-feedback round.

## What review caught

Every PR passed the factory's checks the first time, and review still found real problems. This is the point of keeping a human review step.

- **Safari bug (ticket 9, found in review).** `listStateToSearch` relied on `URLSearchParams.size`, missing in Safari before 17, so search and sort would silently not reach the URL on older iPhones. Fixed in ticket 11 with a regression test that hides `size`.
- **Layout bug the checks cannot see (ticket 11).** The wide desktop card rendered the description above the project name, outside the card. Unit tests and the build passed; it only showed in a browser at 1024px and wider. Fixed in ticket 13 (two class changes).
- **Review-feedback loop used for real (ticket 15).** The Create Issue button measured 36px on phones against a 44px target. I left a review comment on the PR and the factory pushed a fix commit on its own (round 1).
- **A miss on my side (ticket 21).** The owner sent a screenshot of the live board still showing a wall of text. My sprint-goal ticket fixed the goal, but the wall was the project description rendered by the board component's own header. Ticket 27 fixed it.
- **Smaller:** the avatar and badge both showed the project key, and the card said "Updated Just now" with a stray capital; both fixed in ticket 11.

## How each PR was reviewed

Each PR was rendered in Chrome with a throwaway Vite harness and mocked data, then measured with scripts at 1500, 1280, 1024, 768, 390 and 360px: one column or the right layout, no horizontal page scroll, tap targets of at least 44px on phones, menus inside the viewport, sort orders, URL persistence, loading, error and empty states, keyboard operation (arrows, Escape returning focus), and that drag-and-drop still works.

## What went wrong around it (not the factory)

- **A deploy blocked, correctly.** The Ossicone MCP server was moved to a single Code Mode endpoint (`search` + `execute`, about 3,400 down to under 400 tokens of tool list). The backend OAuth integration test still expected the old tool list, so the pipeline's verify step failed twice and the deploy was skipped. Nothing broken reached the Pi. The test was fixed and run the way CI runs it (fresh install, throwaway Postgres: 11 of 11 pass), then the deploy went green.
- **A merge I should have confirmed.** I merged the first Code Mode PR as written (a second `/mcp-code` endpoint) when the owner wanted one endpoint that replaces the tool list. The two-endpoint version was live on the Pi for roughly half an hour before a follow-up PR made `/mcp` itself serve Code Mode.
- **The daily run cap fired.** The factory stopped at its limit of 20 runs a day; it was raised to 100 deliberately, with a restart.

## Limits

- Everything was tested with mock data, not the live Ossicone data.
- Backlog moves are not atomic on the backend: a sprint-to-sprint move is a remove then an add, so a failed add after a successful remove leaves the server and screen out of step until refresh.
- Not yet redesigned: create/edit issue, sprint history, reports.
- Cost per change is not recorded (the agent runs on a ChatGPT login, not a metered key).
