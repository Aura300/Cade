# Act 1 flow, observed in the live Slack UI (2026-10-28)

Workspace XTECKLK (`T0CBGKFCPT9`), private channel `alternate-dev` (`C0CCJQ18QN8`),
also `all-xtecklk` (`C0CCSC58EP2`). Cade is under Apps. There is no `acme-*` channel
in this workspace, so the DEMO.md names need mapping to real channels.

## Confirmed selectors / labels

| Step | What Slack shows | Locator that works |
|---|---|---|
| Channel URL | `https://app.slack.com/client/T0CBGKFCPT9/<channelId>` | `post()` already builds `/client/<id>` from the origin; it needs the team id: `/client/${teamId}/${channelId}` |
| Composer | `textbox "Message to alternate-dev"` (contenteditable) | `getByRole("textbox", { name: /^Message/ })` |
| Hover toolbar | appears only on real mouse hover; group "Message actions" | hover the message row, then `getByRole("group", { name: "Message actions" })` |
| ⋯ button | `button "More actions"` in that toolbar | `getByRole("button", { name: "More actions" })` |
| Menu | `menu "Message actions"` | |
| Cade shortcuts | NOT a "More actions" menu item. They are under **Connect to apps** | `menuitem "Connect to apps"` |
| Submenu items | `New task` (Cade), `Move to existing` (Cade), `New incident` (Cade), `More message shortcuts…` | `getByRole("menuitem", { name: /^New task/ })` |

Hard-won details:
- Message rows have ids like `message-list_<ts>`, with `data-qa` unreliable. Use role/name or the row text.
- Submenus open on real mouse hover and close when the mouse leaves. `click()` on
  "Connect to apps" does nothing. Do: move the mouse onto "Connect to apps", wait for the
  submenu items, move the mouse horizontally (same y) into the submenu, then click.
  `locator.hover()` alone was not enough; `page.mouse.move(..., { steps })` worked.
- `lib.mjs` `messageAction` is wrong for this UI: it clicks `[data-qa="more_message_actions"]`
  then a "More actions" menuitem. Replace with the sequence above.

## Forms (confirmed on a fresh message in all-xtecklk, then cancelled)

Clicking **New task** on a message Cade had already moved gives a toast
"Sorry, that didn't work. Try again?" and no form. Always use a brand-new message.

**New task** (modal title "New task"):
- `Task title`: text input, placeholder "Write something", prefilled with the whole message
  (47-char counter shown, text cut off in view). `getByLabel("Task title")`.
- `Due date (optional)`: date input, placeholder "Select a date", with "Open calendar" button.
- `Priority`: combobox, placeholder "Select a priority". Options: `Urgent`, `High`, `Medium`, `Low`
  (the emoji precedes the text).
- Buttons: `Cancel`, `Create`.
- No Project picker, because this workspace has one group.
- The combobox has no accessible name matching "priority"; `getByRole("combobox", { name: /priority/i })`
  timed out in one case, so click the field by its placeholder text or position.

**Move to existing** (modal title "Move to existing"):
- `Move it to`: combobox, placeholder "Choose a task". Options read
  `In progress · Test Requirement - Feature 1` (status · title).
  `getByRole("combobox", { name: /choose a task/i })` and `getByText("Choose a task")` both
  timed out; clicking the field by position worked.
- A hint line under it shows the message being moved.
- Buttons: `Cancel`, `Move`.

Still to look at: the card in the dev channel after Create, and the 📤 marker / thread copy.
Those need a real Create, so they're left for the recording run.

## Steps for the video (Act 1)

1. Guest (Sarah) posts the deposit question in the client channel.
2. Lead: hover message, ⋯ (More actions), Connect to apps, New task.
3. Form: Project, title "Deposit payments at booking", priority High, due ~3 weeks, Create.
4. Show the pinned card in the dev channel, with Sarah's message in its thread.
5. Guest DMs the follow-up (configurable per property).
6. Lead: hover, ⋯, Connect to apps, Move to existing, Project, pick the task, Move.
7. Show the DM copied into the task thread.

---

# Acts 2-6, explored with a single account (2026-10-28)

Workspace is a test one (cards, messages and tasks can be freely created/changed). Channel for
all of this: `alternate-dev`. Everything below was run as one user acting as owner, reviewer and
approver at once, so multi-person hand-offs are noted but not shown.

## Driving Slack from a script (techniques that worked)

- **Mentions in the composer:** type `@Cade`, wait ~1 s, press `Tab` (picks the person), then type
  the rest. Typing the full text straight in does not create a mention. Use `getByRole("textbox", { name: /^Message/ })`
  in the channel and `/Reply/` in the thread panel.
- **Slash commands:** type `/cade tasks`, wait 1.5 s, press Enter **twice** (first Enter accepts the
  autocomplete, the second sends). Output is private ("Only visible to you") and lands at the bottom
  of the channel.
- **Open a thread:** click the card's `N replies` button; the thread opens in a right-hand panel.
- **Card ⋯ menu:** `getByRole("button", { name: "More options" })` inside the card's list item.
  Use the card in the **channel list**. The copy of the card shown at the top of the thread
  panel has its own ⋯ and the Release action **fails** there (Slack shows ⚠ `block_kit_error_icon`).
  Close the thread panel before using Release.
- **Combobox fields** in Cade's modals (Priority, Move it to, Who approves) do not match
  role+name; click them by position or by the placeholder text, then `getByRole("option", ...)`.
- **Timing:** Cade's private prompts need 6-8 s after a plain-word message, and the top-level
  "new task?" prompt about 12-15 s. If the next message is sent before the previous Accept
  is processed, Cade computes the next suggestion from the old status (saw "In review -> Done"
  right after "LGTM" was accepted). Pause at least 6 s between steps.
- **Slackbot GitHub prompt:** the first pasted github.com link triggers a private Slackbot card
  ("Would you like to install the GitHub app?"). Click `No, thanks` once, before recording; it says
  it will not ask again.

## Observed behaviour, by step

| Demo step | What I did | What Cade showed |
|---|---|---|
| 1 Create task | New task form, title + Medium, Create | Card in dev channel: `[MEDIUM] <title>`, 📝 To do, Unassigned, `Tracked by @user`, pinned. Thread gets "Moved from @user's message: <text>". Original message gets no tray in a channel Cade is not in. |
| 5 priority/due | `@Cade priority urgent`, `@Cade due 14/11/2026` | ✅ reaction on my message; card updates (`[URGENT]`, red strip, `Due 14/11/2026`) within ~3 s |
| 3 assign | `@Cade assign owner @Name` | ✅; card shows `Owner @Name` |
| 4 started | "Okay, started working on this" (as owner) | Private: "Should I update the task? Status: To do -> In progress" with `Accept` `Edit…` `Reject`; after Accept, thread shows "@X set the status to In progress." |
| 6 PR paste | "First pass is up: https://github.com/acme/booking-web/pull/128 — @Name can you review this?" | Private: Reviewers: @Name (Add), PRs: booking-web/128 (Add), Status In progress -> In review; `Accept`. After Accept: thread "linked booking-web/128. assigned themselves as reviewer. set the status to In review"; card shows `Pending: booking-web/128` and `Review @Name` |
| 10 Edit | Card ⋯ -> Edit | Form: Owners / Reviewers / Testers (multi-pickers, "Choose ..."), Status (To do, In progress, In review, In testing, Client review, Done), Priority (Urgent, High, Medium, Low), Due date, "Pull requests, one link per line"; `Cancel` `Save` |
| 11 Release | Card ⋯ -> Release (only present once a PR is attached) | Modal "Send for approval": "PRs to send to the client" checkbox per PR, "What this completes" text, "Who approves" person picker (`Choose a person`); `Cancel` `Send`. Result: card "Pending approval: <note> (booking-web/128)", thread message "@X sent these PRs for approval... Completes: ..." with `Approve` / `Not approve`. After Approve the card reads "Approved: <note> (booking-web/128)" and the thread says "approved them. Thanks". |
| 12 client review | `@Cade status client review` after approval | Replied "good news! @X approved booking-web/128." (no Ask-for-approval prompt, since nothing was left to approve) |
| 13 progress words | "LGTM" (reviewer) | Private: Status In review -> In testing, `Accept`; card becomes 🧪 In testing |
| 13 "QA passed on staging" | right after the above | Offered In review -> Done (stale status, see timing). Not accepted. |
| 15 incident | Prompt/shortcut -> New incident | Modal "New incident": "What's the incident?" (prefilled) and the hint "Incidents are 🔴 Urgent and due Immediate. I'll pass this straight to the team."; `Cancel` `Report`. Card: `[URGENT] [Incident] <text>`, 📝 To do · Due Immediate, Unassigned, `Reported by @user`. Original message gets 📤 and a thread reply. Card ⋯ has no priority/due edit in the form's summary (menu: Edit, Refresh, Archive). |
| 17 top-level prompt | Posted a plain message in the dev channel | After ~12 s, private: "Is this a new task, a new incident, or part of an existing one?" with `New task` `New incident` `Move to existing` `Not now` |
| 20 Archive | Card ⋯ -> Archive | Immediate, no confirm. Card line becomes "🗄️ Archived by @user · Due Immediate". |
| 21 tasks | `/cade tasks` | "Your alternate tasks" grouped Owned / Reviewing / Testing, each `• <title> · <status> · <priority> · Due ...` |
| 22 standup | `/cade standup` | "Standup: @user · 1 of 2", "1 open task · alternate", each task with a status dropdown, `Next: <person>` and `End` buttons |
| 24 help | `@Cade help` in channel | Cade answers in the message's thread |

## Not covered / needs a second person or more setup

- Hand-offs between different people (Rex, Mia, Tom): the plain-word suggestions depend on who
  speaks, so Sarah/Rex/Mia/Tom lines need real second accounts, or accept that the lead says them.
- Move to existing from a DM, and the Project picker (this workspace has one group, so no picker).
- Not-yet-seen: `@Cade pr add/remove`, `unassign`, `@Cade task` / `@Cade move` on an old message
  and the "already moved" guard, 🎫 / 🔀 emoji, `/cade tasks -all` and its filters,
  `/cade standup -unassigned`, admin `/cade remove <link>` (double confirm), the Google Sheet tab.
- The "Not approve" path, and Done -> unpinned.
