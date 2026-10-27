# Cade demo script

One story that touches **every feature**: a client asks for a feature in
their channel, it becomes a task in the dev channel, the team builds,
reviews, tests and ships it, the client approves, an incident lands in the
middle, and the team runs its own work and standup. ~10–12 minutes in full;
each act also works as a short standalone clip. The checklist at the end
maps every feature to its step.

## Before you record

**People** (separate Slack accounts or teammates; two browser profiles side
by side work well):

| Role | Name in the script | Works in |
|---|---|---|
| Client PM | **Sarah** | `#acme-client`, DMs with You |
| Team lead | **You** | everywhere |
| Developer | **Rex** | `#acme-dev` |
| Reviewer | **Mia** | `#acme-dev` |
| QA | **Tom** | `#acme-dev` |

**Channels:** `#acme-dev` is the group's dev channel in `CHANNEL_PAIRS`,
where tasks and incidents live. `#acme-client` is any channel you share
with the client; Cade doesn't need to be in it.

**Seed beforehand** (so pickers and lists aren't empty):
- `#acme-dev`: `/cade task` → **"Upgrade Node to 22 on staging"**, Medium,
  Rex as developer (`@Cade assign developer @Rex`).
- `#acme-dev`: `/cade task` → **"Remove legacy coupon code"**, Low, nobody
  assigned (for standup `-unassigned`).
- `#acme-dev`: a top-level message posted **before** the demo, then click
  **Not now** on Cade's prompt (used for `@Cade task` in Act 5):
  > Flaky test: `booking.spec.ts` times out on CI about 1 run in 5.
- A second group (say `test`) in `CHANNEL_PAIRS`, so the **Project** picker
  has a choice.
- Google Sheet open in a browser tab, if set up.

**Do a full dry run.** Private (ephemeral) messages and forms are only
visible to the account they're for, so record from that account's screen
at those moments.

---

## Act 1 — A message becomes a task · ~3 min

### 1. The client asks, in their channel *(opener)*
**Sarah**, `#acme-client`:
> Can guests pay a deposit when they book, instead of the full amount upfront?
> We'd like 20% at booking and the rest 7 days before check-in.

- **You**: ⋯ on Sarah's message → **More actions** → **New task**.
- The form asks for the **Project** (pick *acme*), with the title prefilled
  from the first line. Shorten it to **"Deposit payments at booking"**,
  priority **High**, due ~3 weeks out → **Create**.
- **Show:** the task posted and pinned in `#acme-dev`, Sarah's message copied
  into its thread with a link back, and, if Cade is in `#acme-client`, the
  original marked :outbox_tray: with "moved this message to the task
  thread… Please carry on the conversation there."
- *Everyone on the task can read Sarah's words, even without access to the
  client's channel; only the link back needs it.*

### 2. A follow-up in a DM → Move to existing
**Sarah**, in a DM with You:
> Also — the deposit % should be configurable per property, some owners want 30%.

- **You**: ⋯ → **More actions** → **Move to existing** → **Project** *acme*
  → the open tasks appear → *Deposit payments at booking* → **Move**.
- **Show:** the DM message copied into the task's thread.

---

## Act 2 — The team picks it up · `#acme-dev` · ~2 min

### 3. Hand it to a developer
In the **Deposit payments** task thread, **You**:
> @Rex please start working on this — first cut by Friday?

- Cade privately offers to add Rex as developer → **Accept** → Rex is asked
  in the thread to pick it up; the task stays 📝 To do.

### 4. The developer says they've started
**Rex**:
> Okay, started working on this

- **Accept** → ▶️ In progress.
- *Assigning never starts the work; the developer saying so does.*

### 5. The team owns priority and due date
**You**, in the task thread:
> `@Cade priority urgent`

> `@Cade due 14/11/2026`

- **Show:** the card updates; the colour strip follows the priority. Or use
  the card's ⋯ → **Edit**, one form for everything.

---

## Act 3 — Build, review, test, ship · `#acme-dev` · ~4 min

### 6. Paste a PR, mention a reviewer → Cade offers both
**Deposit payments** task thread, **Rex**:
> First pass is up: https://github.com/acme/booking-web/pull/128 — @Mia can you review this?

- **Link and add reviewer** → PR shown on the card as `booking-web/128`, Mia
  as reviewer, 👀 In review.

### 7. Explicit commands for PRs
**Rex**:
> `@Cade pr add https://github.com/acme/booking-web/pull/131`

> `@Cade pr add https://github.com/acme/booking-web/pull/999`

> `@Cade pr remove https://github.com/acme/booking-web/pull/999`

### 8. Hand-off to QA in plain words
**Mia**:
> Approved ✅ small nit on rounding, fixed in a follow-up. @Tom please test this on staging

- **Accept** → 🧪 In testing, Tom as tester.

### 9. Handing work on
**Tom**:
> I'm out tomorrow — @Mia can you test this instead?

- **Accept** → Mia is the tester, Tom isn't.

### 10. Explicit assign / unassign / role picker
**You**:
> `@Cade assign reviewer @Rex`

> `@Cade unassign reviewer @Rex`

> `@Cade assign`

- The last one shows a button that opens one form with every role.

### 11. Ship part of it early → partial release
**Rex**:
> `@Cade release`

- **Choose PRs** → tick #128 → note **"Deposit checkout flow (20% default)"**
  → **Who approves**: whoever handles the client, here **You**.
- **Show:** the task thread gets it with **Approve / Not approve**, which
  only You can click. After checking with Sarah, **Not approve** → Rex
  fixes it and sends again with `@Cade deliver` → **Approve**. The card
  shows #128 approved.

### 12. Status: menu and typed
**Tom**:
> `@Cade status`

- Pick a status from the menu, then:
> `@Cade status client review`

- Cade reacts ✅ and shows Tom a private **Ask for approval** → pick You →
  the task thread mentions You with the remaining PRs and **Approve / Not
  approve**.

### 13. Progress in plain words
In a task that's 👀 In review, the reviewer (**Mia**):
> LGTM

→ offers In testing, and the testers are asked. In testing, the tester
(**Tom**):
> QA passed on staging

→ offers Done. Anyone on the task saying "done", "merged" or "deployed"
gets the same. Questions ("done?") and "not done yet" ask nothing.

### 14. The client decides
**Not approve** once → back to ▶️ In progress, and the thread is told. Tom
sets Client review again → **Approve** → ✅ Done, and the task is unpinned.

---

## Act 4 — Something breaks · ~1.5 min

### 15. Report an incident from the client's message
**Sarah**, `#acme-client`:
> Card payments are failing at checkout for EU customers!

- **You**: ⋯ → **More actions** → **New incident** → *acme* →
  **Report**.
- **Show:** the card in `#acme-dev` reads **Incident · Card payments are
  failing…**, 🔴 Urgent, due Immediate, with Sarah's message in its thread.
- **Rex** tries `@Cade priority low` in it → *"Incidents are always 🔴
  Urgent and due Immediate…"*. Its ⋯ → **Edit** has no priority or due
  date.
- *(`/cade incident` in `#acme-dev` does the same from scratch.)*

### 16. Work the incident
In the incident's thread, **You**:
> @Rex please look into this ASAP, Stripe dashboard shows 3DS failures.

- Accept → Rex assigned. **Rex**: `on it` → In progress. Then `@Cade status
  done`.

---

## Act 5 — The team's own work · `#acme-dev` · ~2 min

### 17. A dev message becomes a task
**Rex**, top level:
> Staging DB is running out of disk again — we should add log rotation before the release.

- Prompt: **New task · New incident · Move to existing · Not now**
  → **New task** → title prefilled → Medium → **Create**.
- **Show:** the task is posted; the message is copied into its thread with
  :outbox_tray:.

### 18. Move to an existing task
**Mia**, top level:
> FYI the Node 22 upgrade also needs the Docker base image bumped.

- **Move to existing** → the same form as the shortcut → *Upgrade Node to 22
  on staging* → **Move**.
- *(Or add 🔀 to the message for the same picker, or 🎫 to track it.)*

### 19. Track an older message
In the thread of the seeded *"Flaky test…"* message: `@Cade task` → **New
task** → **Create**. `@Cade move` there again → *"This message was already
moved: see it there."*

### 20. Deleting safely
In the **Log rotation** task thread: `@Cade delete` → **Cancel** stands out;
**Delete task** asks again → confirm. Cade's messages go and the pin is
removed.

---

## Act 6 — Everyone's view · ~1.5 min

### 21. My tasks, with filters
> `/cade tasks`

> `/cade tasks -all`

> `/cade tasks -unassigned`

> `/cade tasks review @Mia`

> `/cade tasks -status=in-progress,in-testing -due<@tomorrow`

### 22. Standup
- `/cade standup` in `#acme-dev` → **Next** through each developer, change a
  status from the menu (it's posted in the task's thread).
- `/cade standup -unassigned` → give *Remove legacy coupon code* a developer.

### 23. The Google Sheet
Switch tabs: every task with status, priority, due date, people, tracked /
completed times and task links, including the deleted one marked
**Deleted**.

### 24. Help
> `@Cade help`

---

## Feature checklist

| Feature | Step |
|---|---|
| New task from another channel, with the Project picker | 1 |
| Move to existing from a DM, project then open tasks | 2 |
| New incident from a message | 15 |
| `/cade task`, `/cade incident` | seed, 15 |
| Prompt on top-level dev messages | 17, 18 |
| `@Cade task` / `@Cade incident` on a message's thread | 19 |
| `@Cade move` + already-moved guard + :outbox_tray: | 18, 19 |
| 🎫 / 🔀 emoji | 18 |
| Hand-offs in plain words (develop / review / test) | 3, 6, 8, 16 |
| "Started working on this" → In progress | 4, 16 |
| Handing work on | 9 |
| "LGTM" / "QA passed" / "done" → next status | 13 |
| `@Cade assign` / `unassign` / role picker form | 10 |
| PR paste suggestion, `pr add`, `pr remove`, → In review | 6, 7 |
| Partial release, approve / not approve, `deliver` alias | 11 |
| `@Cade status` menu and typed status ✅ | 12 |
| Client review approve / not approve | 12, 14 |
| Priority / due date, and the card's ⋯ → Edit | 5 |
| Incident priority is fixed | 15 |
| Pins follow open / done | 1, 14 |
| `@Cade delete` with double confirm | 20 |
| `/cade tasks` + filters | 21 |
| `/cade standup`, `-unassigned` | 22 |
| Google Sheet sync | 23 |
| `@Cade help` | 24 |

Not shown on camera (mention in voice-over): posts that Slack refuses are
retried automatically every few minutes.

## Talking points
- **Nobody leaves Slack** — requests come from anywhere; the team works in threads.
- **Everyone can read the request** — it's copied into the task, even from a DM.
- **Cade only asks, privately** — suggestions never change anything without a click.
- **Tidy channels** — stray messages get moved; the tray shows what's handled.
- **One source of truth** — task cards, summaries and the Sheet update together.

## Recording tips
- 1080p, Slack zoom ~110%, hide unrelated channels in the sidebar.
- Keep the dummy messages in a text file and paste them.
- Pause a beat after each click so Cade's update lands on camera.
- Cut by act; each act is a standalone short.
