# Act 3: Build, review, test, ship
File `act-3-build-review-ship.mp4` · 60–90 s. Longest clip: cut hard, or use
two passes: build and review, then release and approval.

| # | Screen | On screen | Caption / voice-over | ~s |
|---|---|---|---|---|
| 1 | R, task thread | Paste: "First pass is up: <PR link>, @Mia can you review this?" | "Paste a pull request and name a reviewer." | 6 |
| 2 | R | Private summary: *PRs: booking-web/128 (Add) · Reviewers: @Mia (Add) · Status → In review* → **Accept**. Card shows the PR and 👀 In review. | "One summary: link it, add Mia, move to review." | 8 |
| 3 | M, task thread | Mia types "Approved ✅ small nit on rounding. @Tom please test this on staging". | "Reviewer hands off to QA, in plain words." | 8 |
| 4 | M | Private summary *Testers: @Tom (Add) · Status: In review → In testing* → **Accept** → thread logs it; 🧪 In testing. | "In testing, with a tester." | 5 |
| 5 | T, task thread | Tom: "I'm out tomorrow, @Mia can you test this instead?" → summary *Testers: @Mia (Add) · @Tom (Remove)* → **Accept**. Needs `ai: true`; without it, use the card's ⋯ → **Edit**. | "Handing work on is just a message." | 8 |
| 6 | Y | `@Cade assign reviewer @Rex` (✅, then Rex is asked to review the PRs in the thread), then `unassign`; open card ⋯ → **Edit** briefly. | "Or be explicit, or use one form for everything." | 8 |
| 7 | R | Card ⋯ → **Release** → tick the PR, note, approver **You** → submit. | "Ship part of it early with a partial release." | 10 |
| 8 | Y, task thread | **Approve / Not approve** appears; click **Not approve**. Rex re-sends with `@Cade deliver`; Y clicks **Approve**. | "Only the approver can say yes." | 12 |
| 9 | T | `@Cade status client review` → ✅ → private **Ask for approval** → pick You. | "Send it to the client for review." | 8 |
| 10 | Y | **Approve** → ✅ Done, card unpinned. | "Approved. Done, and the pin goes away." | 6 |

Optional insert (5 s): a task in review where the reviewer types "LGTM"; they get a private
summary *Status: In review → In testing* with **Accept**, and the testers are asked. Use it if the clip runs short.

Screen key: **S** Sarah (client) · **Y** You (lead) · **R** Rex (dev) · **M** Mia (reviewer) · **T** Tom (QA). Setup and export: [script-0-setup.md](script-0-setup.md).
