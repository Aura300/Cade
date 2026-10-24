# project-helper

Helper workflows for project management and requirement summarize, running as
the `project-helper` Cloudflare Worker behind the Luma Slack app.

## How commands are handled

Most commands are messages that start by @mentioning the bot, such as
`@LUMA assign @person`. Slack doesn't allow custom slash commands in threads,
and most commands are sent from a thread. Messages that don't start with
`@LUMA` are ignored. Commands that start something new also work as the
slash commands `/luma track` and `/luma requirement`, which open their form
straight away since a slash command, unlike a message, can open one.

```mermaid
flowchart LR
    Message["@LUMA name … (message event)"]
    Parse[parse.js: build a command]
    Dispatch[dispatch.js: find handler, check scope]
    Handler[Command handler]
    Reply[Reply in the message's thread]

    Message --> Parse --> Dispatch --> Handler --> Reply
```

| File | Role |
| --- | --- |
| `src/index.js` | HTTP routes, Slack signature check, posts replies |
| `src/commands/parse.js` | Turns an `@LUMA …` message or `/luma …` slash command into a command |
| `src/commands/dispatch.js` | Looks up the handler, checks where it may run, runs it |
| `src/commands/registry.js` | The list of command handlers |
| `src/commands/track.js`, `requirement.js`, `assign.js`, `unassign.js`, `status.js`, `details.js` (priority, due), `delete.js` | Command handlers |
| `src/tasks.js` | Task message layout and storage, shared by the handlers |
| `src/requirements.js` | Requirement message layout and storage, and finding a requirement's task |
| `src/sheet.js`, `google-sheet/Code.gs` | Records tasks in a Google Sheet |

A handler declares its name, usage, and where it may run: which channel, and
whether it must be sent in a thread. The dispatcher enforces these, so a
command used in the wrong place gets a hint such as "Use `@LUMA assign
@person` in a task thread in #aura300-dev". `@LUMA help`, a bare `@LUMA` or
an unknown command replies with the command list. To add a command, create a
module in `src/commands/` and add it to `src/commands/registry.js`. Its
comment describes the handler shape.

Buttons, menus and the task form are handled by the same modules: a handler
can register `actions` (by action ID) and `views` (by modal callback ID).

| Path | Slack feature |
| --- | --- |
| `/slack/events` | Event Subscriptions (`@LUMA` messages) |
| `/slack/interactions` | Interactivity (forms, buttons, menus) |
| `/slack/commands` | Slash Commands (`/luma track`, `/luma requirement`) |

## Task tracker commands

**`@LUMA track`** in `#aura300-external`, usually as a reply in the thread
where the request was discussed. Luma replies with a **Track task** button;
Slack only opens forms from a click. The form asks for the **task title**, an
optional **due date** (picked from a calendar and shown as DD/MM/YYYY) and the **priority** (Urgent, High, Medium,
Low). On submit, Luma:

1. posts the task to `#aura300-dev` and pins it to the channel. The task
   message shows the title; then the status, priority and due date; then the
   developer, reviewer and tester ("Unassigned" until someone is assigned);
   then who tracked it, with a link back to the request thread, and
2. replaces the button with "@you tracked a task: *title*", linking to the
   new task thread.

**`/luma track`** opens the same form straight away, without a button, so
you don't need to post a message first. In `#aura300-dev` the task is just
posted there. In `#aura300-external` Luma posts "@you is tracking a task"
to act as the external thread, then turns it into the usual announcement.

For the team's own work that has no request thread, send **`@LUMA track`**
(or `/luma track`) in `#aura300-dev` itself. The same button and form create the task in that
channel. Such a task has no external thread, so it shows only "Tracked by
@you", and status changes and deletion are not shared anywhere else.

### Requirements

**`/luma requirement`** in `#aura300-external` opens the same form as a
task: the requirement's **name**, an optional **due date** and the
**priority**. Luma then posts it as a new message to discuss in its thread. The
message shows:

1. the requirement name,
2. its status, priority and due date, and
3. the tracked task ("None yet" until there is one).

It starts **In discussion**. When it's agreed, send **`@LUMA track`** in its
thread: the form starts with the requirement's name, priority and due date,
which you can change before creating the task. Once
the task is created, the requirement shows 🔵 In progress, the task's
priority and due date, and a link to the task. When the dev channel uses
**Inform external thread**, the requirement's status changes to match
(Client review or Done). Deleting the task puts the requirement back to In
discussion.

`@LUMA priority` and `@LUMA due` (below) also work in the requirement's
thread. Before a task is tracked they change the requirement, so
`@LUMA track` starts with the new values. Once there is a task they change
the task in `#aura300-dev` instead, and Luma notes the change in the task's
thread. They only work in threads Luma started with `/luma requirement`;
other external threads have no message Luma can update.

### Task commands

In a task's thread in `#aura300-dev`:

- `@LUMA assign developer @person [@person …]` adds people as developers;
  `@LUMA assign reviewer @person` and `@LUMA assign tester @person` work the
  same way. Each role can have several people.
- `@LUMA unassign developer @person` removes people from that role;
  `@LUMA unassign @person` removes them from every role.
- `@LUMA status` replies with a menu of statuses (To do, In progress, In
  review, In testing, Client review, Done), starting at the current one.
  Picking one updates the task and replaces the menu with a confirmation.
  You can also skip the menu with `@LUMA status done` or
  `@LUMA status in progress`. New tasks start as `TODO`. Setting `DONE`
  unpins the task; moving it from `DONE` to any other status pins it again,
  so the channel's pins list shows the open tasks. When a task moves from an
  open status (To do, In progress, In review, In testing) to Client review
  or Done, the confirmation asks whether to tell the external thread the
  task was tracked from: **Inform external thread** posts "@you marked a
  task as Done: *title*" there, linking back to the task; **I'll tell them**
  posts nothing. Moving between Client review and Done doesn't ask again.
- `@LUMA priority high` changes the priority (Urgent, High, Medium, Low);
  `@LUMA priority` replies with a menu. `@LUMA due 30/11/2026` changes the
  due date (YYYY-MM-DD also works), `@LUMA due none` removes it, and
  `@LUMA due` replies with a date picker. For a task tracked from a
  requirement, the requirement message shows the change too.
- `@LUMA delete` (or `@LUMA remove`) replies with **Delete task** and
  **Cancel** buttons. **Delete task** opens a second "Delete task?" dialog,
  and only the person who sent `@LUMA delete` can confirm or cancel. Once
  confirmed, Luma deletes the task message and all of its own replies in the
  thread, which also removes the pin. Slack only lets a bot delete its own
  messages, so people's replies stay in the thread under a "This message was
  deleted" placeholder. Luma then posts "@you untracked a task: *title*"
  in the external thread the task was tracked from.

Each command updates the root message and Luma confirms in the thread. The
mention works whatever the bot is named.

The task's details are stored as Slack message metadata on the root message,
so the Worker needs no database.

### Google Sheet

Slack's free plan only keeps recent history, so every task is also recorded
in a Google Sheet, with one tab per channel pair (for example **aura300** and
**test**). Filter the Status column to see completed tasks. See
[google-sheet/README.md](google-sheet/README.md) for the setup. Without
`SHEET_URL` and `SHEET_SECRET`, syncing is turned off.

### Channels

`CHANNEL_PAIRS` in `wrangler.toml` links each external channel to the channel
its tasks are posted to. Several pairs can run at once, so a pair of test
channels can sit alongside `#aura300-external` → `#aura300-dev`: tracking
from the test external channel creates tasks in the test tasks channel, and
the thread commands work in either tasks channel.

## Setup

See [SLACK_SETUP.md](SLACK_SETUP.md) for the Slack app settings, Worker
secrets and channel IDs, plus a checklist to confirm everything works.

## Development

```sh
npm install
npm test
npm run dev
```

`npm run dev` serves the Worker locally. To try it against Slack, expose it
with a tunnel and point the app's Interactivity, Events and Slash Command
request URLs at the tunnel.

## GitHub Actions deployment

The **Deploy to Cloudflare Workers** workflow runs on every push to `main` and
can also be started manually from the **Actions** tab. It installs
dependencies, runs the tests, and runs `wrangler deploy`.

In GitHub, open **Settings → Secrets and variables → Actions**. Add
`CLOUDFLARE_API_TOKEN` as a repository secret and `CLOUDFLARE_ACCOUNT_ID` as a
repository variable. The token needs **Account → Workers Scripts → Edit**
permission. The workflow does not set the Slack secrets; set those with
`wrangler secret put`.
