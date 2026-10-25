# Cade demo script

One story that touches **every feature**: a client asks for a feature, it
becomes a tracked task, the team builds, reviews, tests and ships it, the
client approves, an incident lands in the middle, and the team runs its own
work and standup. ~12–15 minutes in full; each act also works as a short
standalone clip. The checklist at the end maps every feature to its step.

## Before you record

**People** (separate Slack accounts or teammates; two browser profiles side
by side work well):

| Role | Name in the script | Works in |
|---|---|---|
| Client PM | **Sarah** | `#acme-client` |
| Team lead | **You** | everywhere |
| Developer | **Rex** | `#acme-dev`, `#acme-incidents` |
| Reviewer | **Mia** | `#acme-dev` |
| QA | **Tom** | `#acme-dev` |

**Channels** (one pair in `CHANNEL_PAIRS`): `#acme-client` (external),
`#acme-dev` (tasks), `#acme-incidents` (incidents).

**Seed beforehand** (so pickers and lists aren't empty):
- `#acme-client`: `/cade requirement` → **"Booking confirmation emails"**,
  Medium, no due date.
- `#acme-dev`: `/cade track` → **"Upgrade Node to 22 on staging"**, Medium,
  Rex as developer (`@Cade assign developer @Rex`).
- `#acme-dev`: `/cade track` → **"Remove legacy coupon code"**, Low, nobody
  assigned (for standup `-unassigned`).
- `#acme-dev`: a top-level message posted **before** the demo, then click
  **Not now** on Cade's prompt (used for `@Cade track` in Act 5):
  > Flaky test: `booking.spec.ts` times out on CI about 1 run in 5.
- Google Sheet open in a browser tab, if set up.

**Do a full dry run.** The move / prompt / start-from-thread flows are new
and haven't been tried in real Slack yet. Private (ephemeral) messages are
only visible to the account they're for, so record from that account's
screen at those moments.

---

## Act 1 — The client asks · `#acme-client` · ~3 min

### 1. A stray message becomes a requirement *(opener)*
**Sarah**, top level:
> Can guests pay a deposit when they book, instead of the full amount upfront?
> We'd like 20% at booking and the rest 7 days before check-in.

- Cade privately asks: **Start requirement · Report incident · Move to
  existing · Not now**.
- **Start requirement** → the name is prefilled from the first line. Shorten
  to **"Deposit payments at booking"**, priority **High**, due ~3 weeks out.
- **Show:** the requirement card (pinned, "Started by Sarah… not tracked
  yet"), Sarah's message copied into its thread, the original marked
  :outbox_tray: with "moved this message to the requirement thread… Please
  carry on the conversation there."

### 2. A follow-up lands in the wrong place → Move to existing
**Sarah**, top level:
> Also — the deposit % should be configurable per property, some owners want 30%.

- **Move to existing** → pick *Deposit payments at booking* → **Move**.
- *"Anything with the tray is handled — skip it."*

### 3. `@Cade move` after the fact
**Sarah**, top level, then click **Not now** on the prompt:
> Refunds for cancelled deposits should go back to the original card.

- Then reply in that message's thread: `@Cade move` → pick the requirement →
  **Move**.
- Try `@Cade move` again in the same thread → *"This message was already
  moved: see it there."*

### 4. Start a requirement from an existing thread
**Sarah**, top level, **Not now** on the prompt:
> Could we get a monthly occupancy report as a PDF, emailed to each owner?

- Reply in its thread: `@Cade requirement` → **Start requirement** →
  prefilled → **"Monthly owner occupancy report"**, Low → submit.
- *(`@Cade incident` works the same way for an existing message.)*

### 5. The client owns priority and due date
In the **Deposit payments** thread, **Sarah**:
> `@Cade priority urgent`

> `@Cade due 14/11/2026`

- **Show:** the card updates; the colour strip follows the priority.

---

## Act 2 — The team picks it up · ~3 min

### 6. Hand it to a developer before it's tracked → Track and assign
In the **Deposit payments** thread, **You**:
> @Rex please start working on this — first cut by Friday?

- Cade privately offers **Track and assign** → keep the title → **Create**.
- **Show:** task posted and pinned in `#acme-dev` with Rex as developer,
  ▶️ In progress, priority/due from the requirement, "from the requirement
  thread" link; the requirement card now says "tracked by You in the task
  thread"; Rex is asked in the task thread to pick it up.

### 7. Classic tracking with `@Cade track`
In the **Monthly owner occupancy report** thread, **You**:
> `@Cade track`

- **Track task** button → the form shows the requirement's priority and due
  date as the client set them → title **"Owner occupancy PDF report"** →
  **Create**.
- **Show:** the button turns into "@You tracked this as a task: …".
- Try `@Cade track` again → *"Good news: this requirement is already tracked
  as …"*.

### 8. Priority stays with the client
In the **Deposit payments** *task* thread in `#acme-dev`, **Rex**:
> `@Cade priority low`

- **Show:** Cade explains the client sets it in the requirement thread.
  Then, as **Sarah**, `@Cade priority high` in the requirement thread → the
  dev task follows.

### 9. Assigning after tracking, from the client thread
In the **Occupancy report** requirement thread, **You**:
> @Rex can you pick this up after the deposits work?

- Cade privately offers **Assign as developer / Assign and move to In
  progress** → pick one. Rex is asked in the task thread.

---

## Act 3 — Build, review, test, ship · `#acme-dev` · ~4 min

### 10. Paste a PR, mention a reviewer → Cade offers both
**Deposit payments** task thread, **Rex**:
> First pass is up: https://github.com/acme/booking-web/pull/128 — @Mia can you review this?

- **Link and add reviewer** → PR shown on the card as `booking-web#128`, Mia
  as reviewer, 👀 In review.

### 11. Explicit commands for PRs
**Rex**:
> `@Cade pr add https://github.com/acme/booking-web/pull/131`

> `@Cade pr add https://github.com/acme/booking-web/pull/999`

> `@Cade pr remove https://github.com/acme/booking-web/pull/999`

### 12. Hand-off to QA in plain words
**Mia**:
> Approved ✅ small nit on rounding, fixed in a follow-up. @Tom please test this on staging

- Accept the suggestion → 🧪 In testing, Tom as tester.

### 13. Explicit assign / unassign / role picker
**You**:
> `@Cade assign reviewer @Rex`

> `@Cade unassign reviewer @Rex`

> `@Cade assign`

- The last one shows a button per role → **Tester** → the people form with
  Tom already there.

### 14. Ship part of it early → partial release
**Rex**:
> `@Cade release`

- **Choose PRs** → tick #128 → note **"Deposit checkout flow (20% default)"**.
- **Show:** the requirement thread gets it with **Approve / Not approve**.
  **Sarah** clicks **Not approve** and replies:
  > The deposit line is missing on the confirmation email.
- **Rex** fixes it and sends again with `@Cade deliver` (same command) →
  **Sarah** clicks **Approve**. Both cards show #128 approved.

### 15. Status: menu and typed
**Tom**:
> `@Cade status`

- Pick 🧪 In testing from the menu (already set — show the menu anyway), then:
> `@Cade status client review`

- Cade reacts ✅; the requirement thread mentions Sarah with the remaining
  PRs and **Approve / Not approve**.

### 16. The client decides
**Sarah** clicks **Not approve** once → the task goes back to ▶️ In progress
and the task thread is told. **Tom** sends `@Cade status client review`
again → **Sarah** clicks **Approve** → ✅ Done, the task and requirement are
unpinned, and the requirement card shows Done.

---

## Act 4 — Something breaks · ~1.5 min

### 17. Report an incident
**Sarah**, `#acme-client`:
> `/cade incident` → **"Card payments failing at checkout for EU customers"**

- **Show:** the incident card (🔴 Urgent, Immediate) and a task already in
  `#acme-incidents` — no tracking step.
- **Sarah** tries `@Cade priority low` in the incident thread → *"Incidents
  are always 🔴 Urgent and due Immediate…"*.

### 18. Work the incident
In the `#acme-incidents` task thread, **You**:
> @Rex please look into this ASAP, Stripe dashboard shows 3DS failures.

- Accept → Rex assigned. **Rex**: `@Cade status done` → the incident thread
  hears it.

---

## Act 5 — The team's own work · `#acme-dev` · ~2 min

### 19. A dev message becomes a task
**Rex**, top level:
> Staging DB is running out of disk again — we should add log rotation before the release.

- Prompt: **Track as task · Move to existing · Not now** → **Track as task**
  → title prefilled → Medium → **Create**.
- **Show:** the task is posted; the message is copied into its thread with
  :outbox_tray:.

### 20. Move to an existing task
**Mia**, top level:
> FYI the Node 22 upgrade also needs the Docker base image bumped.

- **Move to existing** → *Upgrade Node to 22 on staging* → **Move**.

### 21. Track an older message
In the thread of the seeded *"Flaky test…"* message: `@Cade track` → **Track
task** → **Create**.

### 22. The team owns its own priority and due date
In the **Log rotation** task thread, **Rex**:
> `@Cade priority high`

> `@Cade due 07/11/2026`

### 23. Deleting safely
- In the **Log rotation** task thread: `@Cade delete` → **Cancel** stands
  out; **Delete task** asks again → confirm. Cade's messages go and the pin
  is removed.
- In the **Deposit payments** task thread: `@Cade remove` → *"This task is
  tracked by the requirement thread, so please remove it from there…"*.
- *(Optional finale)* In the **Monthly owner occupancy report** requirement
  thread: `@Cade remove` → the question names its task too → confirm → both
  go.

---

## Act 6 — Everyone's view · ~1.5 min

### 24. My tasks, with filters
> `/cade tasks`

> `/cade tasks -all`

> `/cade tasks -unassigned`

> `/cade tasks review @Mia`

> `/cade tasks -status=in-progress,in-testing -due<@tomorrow`

### 25. Standup
- `/cade standup` in `#acme-dev` → **Next** through each developer, change a
  status from the menu (it's posted in the task's thread).
- `/cade standup -unassigned` → give *Remove legacy coupon code* a developer.

### 26. The Google Sheet
Switch tabs: every task with status, priority, due date, people, tracked /
completed times, task and request links, including the deleted one marked
**Deleted**.

### 27. Help
> `@Cade help`

---

## Feature checklist

| Feature | Step |
|---|---|
| `/cade requirement` form | seed, 4 |
| Prompt on top-level external messages | 1, 2 |
| Prompt on top-level dev messages | 19, 20 |
| Start requirement / incident from a thread (`@Cade requirement`, `@Cade incident`) | 4 |
| `@Cade move` + already-moved guard + :outbox_tray: | 2, 3, 20 |
| Client-owned priority / due date (task follows) | 5, 8 |
| Incident priority is fixed | 17 |
| Track and assign from the requirement thread | 6 |
| `@Cade track` in a requirement thread + already tracked | 7 |
| `@Cade track` on a dev message thread | 21 |
| `/cade track` | seed |
| Assign suggestion after tracking (from the client thread) | 9 |
| Hand-offs in plain words (develop / review / test) | 6, 10, 12, 18 |
| `@Cade assign` / `unassign` / role picker form | 13 |
| PR paste suggestion, `pr add`, `pr remove`, → In review | 10, 11 |
| Partial release, approve / not approve, `deliver` alias | 14 |
| `@Cade status` menu and typed status ✅ | 15 |
| Client review approve / not approve | 15, 16 |
| Pins follow open / done | 1, 6, 16 |
| `/cade incident` → auto-tracked incident task | 17, 18 |
| Team-owned priority / due date | 22 |
| `@Cade delete` with double confirm, requirement-task guard | 23 |
| Removing a requirement removes its task | 23 |
| `/cade tasks` + filters | 24 |
| `/cade standup`, `-unassigned` | 25 |
| Google Sheet sync | 26 |
| `@Cade help` | 27 |

Not shown on camera (mention in voice-over): posts that Slack refuses are
retried automatically every few minutes; an orphaned task (its requirement
deleted by hand) can be removed from its own thread; a deleted incident's
task can be tracked again with `@Cade track` in the incident thread.

## Talking points
- **Nobody leaves Slack** — client, devs and QA all work in threads.
- **Clear ownership** — the client sets priority and due date; the team owns status.
- **Cade only asks, privately** — suggestions never change anything without a click.
- **Tidy channels** — stray messages get moved; the tray shows what's handled.
- **One source of truth** — task cards, requirement cards and the Sheet update together.

## Recording tips
- 1080p, Slack zoom ~110%, hide unrelated channels in the sidebar.
- Keep the dummy messages in a text file and paste them.
- Pause a beat after each click so Cade's update lands on camera.
- Cut by act; each act is a standalone short.
