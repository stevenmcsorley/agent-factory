# Evidence: a real UI redesign through the factory (Ossicone, 2026-11-20)

A real, unscripted use of the factory on a live app (Ossicone, a React + Tailwind project tracker running on a Raspberry Pi). The brief was one sentence from the owner: the projects page looked poor, was bad on mobile, descriptions were one huge paragraph, and the cards needed to be more visual. Search and useful sorting were added to the brief mid-run.

I split it into six small, sequential tickets, each with exact helper signatures, tests and constraints. The factory built each one in a sandbox, ran the project's own checks (typecheck, unit tests, production build), and opened a draft PR. The owner merged each PR; the factory never merges.

| # | Ticket | PR | Build time | Files | Attempts |
|---|--------|----|-----------|-------|----------|
| 1 | Clamp long descriptions ("Show more") | #4 | 277 s | 4 | 1 |
| 2 | Mobile shell: phone search, 44px targets, accessible nav | #7 | 333 s | 7 | 1 |
| 3 | Visual cards: progress, status mix, 14-day sparkline | #8 | 421 s | 4 | 1 |
| 4 | Search and seven useful sorts, URL state, loading/error/no-results states | #10 | 382 s | 4 | 1 |
| 5 | One card per row with a wide desktop layout, single key, Safari fix, tap targets | #12 | 387 s | 10 | 1 |
| 6 | Fix description drawn above the name on desktop | #14 | 431 s | 1 | 1 |

Factory flow card for the period: 8 accepted changes, first-pass rate 96%, rework 0, median build 5.9 minutes, no feedback rounds needed.

## What review caught

All six passed the factory's checks first time, and review still found real problems. This is the point of keeping a human review step.

- **Ticket 4:** `listStateToSearch` relied on `URLSearchParams.size`, missing in Safari before 17, so search and sort would silently not reach the URL on older iPhones. Fixed in ticket 5 with a regression test that hides `size`.
- **Ticket 5:** the wide desktop card rendered the description above the project name, outside the card. Unit tests and the build could not see it; it showed up only in a browser at 1024px and wider. Fixed in ticket 6 (two class changes, verified at 1500, 1024, 1023, 390 and 360px).
- **Ticket 3:** the avatar and badge showed the project key twice, and "Updated Just now" had a stray capital; both fixed in ticket 5.

## How it was reviewed

Each PR was rendered in Chrome using a throwaway Vite harness with mocked data designed so every sort gives a different first project. Checks included all seven sort orders, search (AND of terms, case-insensitive, lead name), URL persistence, remembered sort, skeleton/error/retry/no-results states, `/` shortcut, and measured layout at 1500, 1024, 1023, 768, 390 and 360px (one column, no horizontal scroll, tap targets at least 44px).

## Limits

- Tested with mock data, not the live Ossicone data.
- Only the Projects page, header and mobile shell were redesigned. The board, backlog and issue screens were not touched.
- Cost per change is not recorded (the agent runs on a ChatGPT login, not a metered key).
