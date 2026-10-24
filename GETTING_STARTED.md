# Getting started

Self-host Luma for your team: one Cloudflare Worker, one Slack app, and an
optional Google Sheet. There is no server or database to run; Luma keeps
everything in your Slack messages (and your Sheet, if you add one).

Every step says what to run, what you should see, and what to do if it goes
wrong, so a person or an AI agent can follow it. Steps marked **(person)**
need someone to click in a browser; an agent should stop there and ask.

## What you need

- Node.js 20 or newer, and git.
- A Cloudflare account (the free plan is enough).
- A Slack workspace where you can create apps.
- Optional: a Google account, for the Sheet.

## Settings

Luma has two kinds of settings. **Config** is what you edit as your team
changes; it lives in `luma.config.json` on your machine (git ignores it) and
`npm run config` uploads it. **Secrets** give access to Slack or the Sheet;
they're set once with `npx wrangler secret put NAME` and live only in
Cloudflare, never in a file. Both take effect straight away and survive every
`npm run deploy`. `npx wrangler secret list` shows which are set (not their
values).

### Config: `luma.config.json`

| Key | Required? | What it is | How to get it |
| --- | --- | --- | --- |
| `channels` | **Required** | One entry per group: `{ "name", "external", "tasks", "incidents" }`. `name` is the group's name (its tab in the Sheet); `external` is the client's channel, `tasks` the dev channel, `incidents` (optional) the incidents channel. | In Slack, open each channel → click its name → **About** → **Channel ID** at the bottom (`C…`). Step 7. |
| `timezone` | Optional (UTC) | The time zone for the Sheet's **Tracked at** and **Completed at** times, as an IANA name such as `Asia/Colombo`. Nothing else uses it. | Your team's time zone; [the list of names](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). |
| `sheetUrl` | Optional | The Google Sheet's web app URL (`https://script.google.com/…/exec`). Without it, nothing is written to a Sheet. | Set for you by `npm run sheet:create` (step 8). |

Start from `luma.config.example.json`. `npm run config` checks the file
(names, channel IDs, time zone and URL) and uploads nothing until it's right.

### Secrets: in Cloudflare only

| Secret | Required? | What it is | How to get it |
| --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | **Required** | Lets Luma check that requests really come from Slack. | Set for you by `npm run slack:create` (step 5). Otherwise: the app's page at <https://api.slack.com/apps> → **Basic Information** → **App Credentials** → **Signing Secret**. |
| `SLACK_BOT_TOKEN` | **Required** | Lets Luma read and post as the app (`xoxb-…`). | After installing the app (step 6): its page → **OAuth & Permissions** → **Bot User OAuth Token**. `npm run slack:create` asks for it and stores it. |
| `SHEET_SECRET` | Only with `sheetUrl` | Stops anyone else writing to your Sheet. | Generated and set for you by `npm run sheet:create` (step 8), which also puts it in `google-sheet/Secret.gs` for the script. |

### Used once during setup, never stored

| Credential | What it's for | How to get it |
| --- | --- | --- |
| Cloudflare login | Deploying and setting secrets with `wrangler`. | `npx wrangler login` (step 2), or an API token with **Workers Scripts → Edit** in `CLOUDFLARE_API_TOKEN`. |
| Google login | Creating or updating the Sheet's script (`npm run sheet:create`, `sheet:update`). | `npx clasp login` (step 8). |
| `SLACK_CONFIG_TOKEN` | Creating or updating the Slack app (`npm run slack:create`, `slack:update`). Set only for that command. | <https://api.slack.com/apps> → **Your App Configuration Tokens** → **Generate Token** (`xoxe.xoxp-…`); it lasts 12 hours. Step 4. |

`npm run dev` (see [README.md](README.md)) uses the same config file and asks for the
secrets each time, without saving them.

## 1. Get the code

```sh
git clone <this repository> luma
cd luma
npm install
npm test
```

**Expect:** `npm test` ends with `fail 0`.

## 2. Log in to Cloudflare (person)

```sh
npx wrangler login
npx wrangler whoami
```

`wrangler login` opens a browser to approve access. **Expect:** `whoami`
prints your account name and ID. **If it fails:** run `npx wrangler login`
again; on a machine without a browser, use an API token instead
(`CLOUDFLARE_API_TOKEN`, with **Workers Scripts → Edit**).

## 3. Name and deploy the Worker

In `wrangler.toml`, set `name` (for example `luma`). It must be unique in
your Cloudflare account, and becomes part of the URL. All other settings are
Worker secrets, set in later steps, so nothing else in the file needs
changing.

```sh
npm run deploy
```

**Expect:** a URL such as `https://luma.<your-subdomain>.workers.dev`. Note
it: it's the **Worker URL**. On a new account, Wrangler first asks you to
choose your `workers.dev` subdomain.

## 4. Get a Slack app configuration token (person)

Open <https://api.slack.com/apps>, scroll to **Your App Configuration
Tokens**, and **Generate Token** for your workspace. Copy the **Access
Token** (`xoxe.xoxp-…`). It lasts 12 hours; generate a new one when needed.

## 5. Create the Slack app

```sh
SLACK_CONFIG_TOKEN=xoxe.xoxp-… npm run slack:create -- https://luma.<your-subdomain>.workers.dev
```

Options: `--name "Acme Luma"` (default `Luma`, up to 35 characters) and
`--command /acme` (default `/luma`).

The app's name doesn't need to be unique across Slack, since it isn't
published to the marketplace; every team can call theirs Luma. If you run two
copies in one workspace (say a test copy), give them different names and
commands, because a workspace can't have two `/luma` commands. Luma's help
text always says `/luma`, so keep the default unless you need two copies.

The script creates the app from `slack/manifest.json` (scopes, events,
Interactivity and the slash command, all pointing at your Worker), stores the
signing secret in the Worker, then turns on Event Subscriptions.

**Expect:** `Created app A…`, wrangler confirming the secret, then an install
link. The app's ID is saved in `.slack-app.json` (not committed).
**If it fails:**
- `invalid_auth` or `token_expired`: get a new token (step 4).
- Turning on Event Subscriptions fails: check `npm run deploy` succeeded,
  then run `SLACK_CONFIG_TOKEN=… npm run slack:update`.

## 6. Install the app and store the bot token (person)

Open the install link the script printed and **Allow**. Then, in the app's
**OAuth & Permissions** page, copy the **Bot User OAuth Token** (`xoxb-…`)
and paste it when the script asks. If you skipped that:

```sh
npx wrangler secret put SLACK_BOT_TOKEN
```

## 7. Set up the channels

For each team or project (a **group**), create in Slack:

- an **external** channel, where the client asks for work (for example
  `#acme-external`);
- a **dev** channel, where the team tracks it (`#acme-dev`);
- optionally an **incidents** channel (`#acme-incidents`).

Find each channel's ID: open the channel → click its name → **About** →
**Channel ID** at the bottom (it starts with `C`). Put them in
`luma.config.json`, starting from the example:

```sh
cp luma.config.example.json luma.config.json
```

```json
{
  "timezone": "UTC",
  "channels": [
    { "name": "acme", "external": "C…", "tasks": "C…", "incidents": "C…" }
  ]
}
```

Add one line to `channels` per group. Each key is described under
[Settings](#settings); `timezone` and `sheetUrl` are optional.

`luma.config.json` stays on your machine (git ignores it). Upload it:

```sh
npm run config
```

It checks the file (every group has a name and real channel IDs, no channel
is used twice, the time zone exists), prints what it found, and stores it as
the Worker secrets `CHANNEL_PAIRS` and `TIMEZONE` in one go. Secrets take
effect straight away and survive every `npm run deploy`. To change anything
later, edit `luma.config.json` and run `npm run config` again.

The secrets aren't in this file; see [Settings](#settings).

Then invite the app to every channel:

```
/invite @Luma
```

**Expect:** `npx wrangler secret list` shows `CHANNEL_PAIRS`,
`SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. **If `npm run config`
stops**, it says what's wrong in `luma.config.json`; nothing is uploaded
until the file is right.

## 8. Optional: the Google Sheet

Slack's free plan keeps 90 days of history; the Sheet keeps a record of every
task. It needs a Google account.

1. **(person)** `npx clasp login`, and turn on the Apps Script API at
   <https://script.google.com/home/usersettings> (once per account).
2. Create it:

   ```sh
   npm run sheet:create
   ```

   **Expect:** a new spreadsheet with its script, deployed as a web app; the
   Worker gets its address (`sheetUrl`, added to `luma.config.json` and
   uploaded) and its secret (`SHEET_SECRET`).
3. **(person)** Open the script link it prints, choose `authorize`, click
   **Run** and allow it.

**If it fails** with the Apps Script API: turn it on (step 1) and run it
again. Details, doing it by hand, and troubleshooting are in
[google-sheet/README.md](google-sheet/README.md).

## 9. Check it works

1. In any channel: `/luma help` → only you see the command list.
2. In the external channel: `/luma requirement` → a form; submitting posts a
   **Requirement:** message.
3. In its thread: `@Luma track` → a **Track task** button; tracking posts
   the task in the dev channel.
4. In the task's thread: `@Luma status in progress` → ✅ on your message.

**If nothing answers:** run `npx wrangler tail` and try again.
`Invalid signature` means the signing secret is wrong (rerun step 5 or
`wrangler secret put SLACK_SIGNING_SECRET` with the one under **Basic
Information**); `not_in_channel` means the app isn't invited;
`missing_scope` means the app needs reinstalling (step 6).

## Updating

```sh
git pull
npm install
npm test
npm run deploy
SLACK_CONFIG_TOKEN=… npm run slack:update   # only if slack/manifest.json changed
npm run sheet:update                        # only if google-sheet/Code.gs changed
```

If Slack says the app needs reinstalling after an update, reinstall it from
the app's page (step 6); the bot token usually stays the same.

## Limits to know

- Slack's free plan hides messages older than 90 days, including old tasks.
- Cloudflare's free plan allows 50 Slack calls per request, which `/luma
  tasks` can reach with around 45 open tasks in one group.
- Open tasks are the pinned ones: a task unpinned by hand drops out of
  `/luma tasks`.
- Luma can only delete its own messages; people's replies stay.

## Using Luma

How Luma works in Slack once it's set up: tracking tasks, requirements and
incidents, the commands in a task's thread, and who can change what. Send
`@LUMA help` or `/luma help` in Slack for the short list.

### Tracking tasks

Each channel has one way to track a task:

- **Client work:** start it with **`/luma requirement`** in
  `#acme-external` (see [Requirements](#requirements)), then send
  **`@LUMA track`** in the requirement's thread. `@LUMA track` works only
  there; anywhere else Luma explains where to use it. A requirement has one
  task, so a tracked requirement can't be tracked again.
- **The team's own work:** send **`/luma track`** in `#acme-dev`. It
  opens a form for the **task title**, an optional **due date** (picked from
  a calendar and shown as DD/MM/YYYY) and the **priority** (Urgent, High,
  Medium, Low). The task has no external thread, so it shows only "Tracked
  by @you", and status changes and deletion are not shared anywhere else.

Either way, Luma posts the task to `#acme-dev` and pins it. The task
message shows the title; then the status, priority and due date; then the
developer, reviewer and tester ("Unassigned" until someone is assigned);
then who tracked it, with a link back to the requirement thread if there is
one. From a requirement thread, Luma replies with a **Track task** button
(Slack only opens forms from a click) and, once the task is created, turns
that message into "@you tracked this as a task: *title*", linking to it.

### Requirements

**`/luma requirement`** in `#acme-external` opens the same form as a
task: the requirement's **name**, an optional **due date** and the
**priority**. Luma then posts it as a new message to discuss in its thread. The
message shows:

1. "**Requirement:**" and the requirement name, so it can be told apart from
   incidents in the same channel,
2. its status, priority and due date, and
3. in small text, who started it and who tracked it, linking to the task
   thread ("Not tracked yet" until there is one), the same way a task
   links back to its requirement thread.

The message always shows the current status, priority and due date. Who
changes what follows who knows it:

- **Priority and due date are the client's.** They are changed only in the
  requirement's thread, with `@LUMA priority` and `@LUMA due` (below),
  before and after a task is tracked. Once there is a task, the task
  changes with them and Luma notes the change in the task's thread for the
  team. In the task's thread Luma refuses to change them and links to the
  requirement thread.
- **Status is the team's.** It is changed only in `#acme-dev`, with
  `@LUMA status`. The requirement shows it as the client sees it: **In
  discussion** until a task is tracked, then 🔵 **In progress** while the
  task is To do, In progress, In review or In testing, then **Client
  review** and **Done**. When the task reaches Client review or Done, Luma
  also posts it in the requirement thread, without asking.
- **The client can accept work, if the team asks.** The team can set a task
  to Done directly. Client review is an optional step for work the client
  should check first: when the dev channel moves a requirement's task to
  Client review, Luma posts in the requirement thread straight away,
  mentioning whoever started the requirement so they are notified, listing
  the task's linked PRs for them to look at, with **Approve** and **Not
  approve** buttons. **Approve** moves the task to Done; **Not
  approve** moves it back to In progress, and the client explains what
  needs to change in the thread. Either way Luma tells the task's thread in
  `#acme-dev`. The buttons do nothing once the team has moved the task
  on, and Slack can't tell the team from the client, so anyone in the
  external channel can click them.

When it's agreed, send **`@LUMA track`** in the requirement's thread. The
form asks only for the task title, starting with the requirement's name, and
shows the priority and due date the task will take from the requirement.
The requirement then links to the task. The two stay together: removing
the requirement removes its task (see below), and the task can't be
removed from the dev channel on its own.

Asking a developer to start in the requirement thread works too: write
"@rex please start working on this" there, and Luma asks you, in a message
only you see:

- before the requirement is tracked, **Track and assign** opens the track
  form; the task starts with @rex as developer and 🔵 In progress, and
  Luma posts "@you tracked this as a task" with its link;
- once it's tracked, **Assign as developer** (or **Assign and move to In
  progress**) assigns them to its task, as in the task's thread.

Either way the task's thread in `#acme-dev` gets "@rex please start
working on this.", as `@LUMA assign developer` would post, since developers
aren't always in the client's channel. Only developer hand-offs are offered
there; reviews and testing are asked for in the task's thread.

To remove a requirement, send **`@LUMA remove`** (or `@LUMA delete`) in its
thread. It asks for confirmation the same way as deleting a task, then
deletes the requirement message and Luma's replies. If it has been
tracked, its task goes too: the question names the task, and confirming
deletes the task in `#acme-dev` first (like `@LUMA delete` there), then
the requirement.

Assign and unassign are for tasks only, and only tracked tasks are recorded
in the Google Sheet.

### Your tasks

**`/luma tasks`** in any channel shows you, and only you, the open tasks
you're assigned to, grouped by what you do on each:

- **Developing**, **Reviewing** and **Testing**, in that order, with
  "Nothing assigned" for a role you have no tasks in;
- incidents first in each group, labelled **Incident:**, then by priority
  and the soonest due date;
- each linking to its task's thread, with its status, priority and due date.

**`/luma tasks development`** (or `dev`), **`/luma tasks review`** and
**`/luma tasks testing`** (or `test`) show just that role.

The channel decides the group: in a group's channel (its external, dev or
incidents channel) the list covers that group, its dev and incidents tasks.
In any other channel it shows every group, one after the other. Slack
doesn't allow slash commands in threads, so use it from the channel.

The list isn't posted or kept anywhere: ask again for a fresh one. Done
tasks are left out. Open tasks are the pinned ones (Luma unpins a task when
it is Done), so Luma reads only the pins of the dev and incidents channels.
A task someone unpins by hand won't appear until it is pinned again.

### Incidents

Incidents come in through the external channel too, but are tracked in the
pair's own incidents channel (set `incidents` in `CHANNEL_PAIRS`).

**`/luma incident`** in `#acme-external` opens a form that asks only what
the incident is. Incidents are always 🔴 **Urgent** and due **Immediate**,
and need no discussion first, so on submit Luma:

1. posts "**Incident:** *title*" in the external channel, like a
   requirement message but "Reported by" whoever reported it, and
2. tracks it straight away as a task in the incidents channel, pinned, and
   links the two, so the incident shows 🔵 In progress.

From then on it works like a tracked requirement: the task commands below
work in the incidents channel, the incident message always shows the
current status, and Client review asks the reporter to approve. The only
difference is that an incident's priority and due date can't be changed,
in either thread. Incident tasks are recorded in the pair's sheet tab with
the other tasks.

### Task commands

In a task's thread in `#acme-dev` or the incidents channel:

- **Just say it.** The main way to assign is to write it in the thread as
  you normally would. A reply that mentions people with a hand-off phrase
  makes Luma ask you, in a message only you see, whether to assign them,
  with **Assign as
  developer** (or reviewer, tester) and **Not now**:
  - **developer:** "start working", "work on", "look into", "pick this up",
    "take this", "take care of", "handle this", "fix this", "assigned this
    to you", "over to you";
  - **reviewer:** "review";
  - **tester:** "test", "QA", "verify".

  If a message matches more than one, reviewer comes before tester, and
  tester before developer. People already in that role aren't asked about.
  A hand-off also moves the task on: to a developer, a task that's To do
  moves to 🔵 In progress; to a tester, a task that's To do, In progress or
  In review moves to 🟠 In testing (**Assign and move to …**). When the
  people were assigned ahead of time, Luma offers just **Move to …**.
  Reviews move with linked PRs instead. `@LUMA assign` never changes the
  status, so people can be added in advance.
  Assigning posts nothing in the thread, since your message already asked
  them and the task card shows who it is; only a status change is posted,
  as "@you moved the task to 🔵 In progress". A message with a PR link gets
  the PR question below instead.
- `@LUMA assign` without anyone mentioned replies with **Developer**,
  **Reviewer** and **Tester** buttons (`@LUMA assign developer` shows just
  that one). A button opens a form with that role's people filled in, to
  add or remove people. **Save** sets the role and removes the buttons:
  those added are asked as below, and those removed are told "you no
  longer need to work on this" (or review, test).
- `@LUMA assign developer @person [@person …]`, for exact control, adds
  people as developers;
  `@LUMA assign reviewer @person` and `@LUMA assign tester @person` work the
  same way. Each role can have several people. Developers and testers are
  asked to start straight away. Reviewers can be added ahead of time: until
  a PR is linked, Luma doesn't name them, so they aren't notified.
- `@LUMA unassign developer @person` removes people from that role;
  `@LUMA unassign @person` removes them from every role. Either way
  they're told they no longer need to work on it. Without anyone
  mentioned, `@LUMA unassign` shows the same role buttons and form as
  `@LUMA assign`.
- `@LUMA status` replies with a menu of statuses (To do, In progress, In
  review, In testing, Client review, Done), starting at the current one.
  Picking one updates the task and replaces the menu with a confirmation.
  You can also skip the menu with `@LUMA status done` or
  `@LUMA status in progress`; then Luma just reacts ✅ to your message,
  since the task card shows the change. New tasks start as `TODO`. Setting `DONE`
  unpins the task; moving it from `DONE` to any other status pins it again,
  so the channel's pins list shows the open tasks. A requirement or
  incident is pinned in the external channel the same way: from when it is
  posted until its task is Done, and again if the task is reopened. When a
  task reaches Done, Luma posts "@you marked this as ✅ Done." in the
  requirement thread straight away; Client review posts "@you marked this
  as ready to review." with the task's PRs and the client's Approve
  buttons. Neither links to the task, which is the team's. When the client
  approves, nothing more is posted there.
- `@LUMA priority high` changes the priority (Urgent, High, Medium, Low);
  `@LUMA priority` replies with a menu. `@LUMA due 30/11/2026` changes the
  due date (YYYY-MM-DD also works), `@LUMA due none` removes it, and
  `@LUMA due` replies with a date picker. Given a value, Luma just reacts
  ✅; with the menu or picker, the menu becomes the confirmation. These work
  in the thread of a requirement, and in the thread of a task with no
  requirement. For a task
  tracked from a requirement, they are changed in the requirement thread
  instead (see [Requirements](#requirements)).
- `@LUMA pr add <link>` links a pull request to the task (several links
  work too); `@LUMA pr remove <link>` unlinks it. Linked PRs show on the
  task message on one line, as *reponame/number* linking to each PR, just
  above who tracked it. GitHub, GitLab and Bitbucket links are recognised.
  Linking moves a task that's To do or In progress to 🟣 In review (tasks
  further on stay where they are), and asks the task's reviewers to review
  it. With no reviewer yet,
  Luma asks who should review it, with a people picker; choosing people
  assigns them as reviewers and asks them. A reviewer assigned after a PR
  is linked is asked straight away.
- PR links pasted into a task's thread without `@LUMA pr add` aren't lost:
  Luma asks whoever posted them, in a message only they can see, whether to
  link them, with **Link PRs** and **Not now**; either button removes the
  question. PRs already linked aren't asked about. If the message also
  mentions people who aren't reviewers yet, Luma offers to add them as
  reviewers too (**Link and add reviewer** or **Just link**; or just **Add
  reviewer** when the PRs are already linked). Since you wrote the message,
  Luma posts only what's new: the task moving to 🟣 In review, a review
  request for reviewers your message didn't mention, or, with no reviewer
  at all, who should review.
- `@LUMA delete` (or `@LUMA remove`) is for the team's own tasks, from
  `/luma track`. A task tracked from a requirement or incident is removed
  from its requirement or incident thread instead, which removes both;
  here Luma replies with a link to that thread. For the team's own task,
  it replies with a prominent **Cancel**
  button and a plain **Delete task** button. **Delete task** opens a second "Delete task?" dialog,
  and only the person who sent `@LUMA delete` can confirm or cancel. Once
  confirmed, Luma deletes the task message and all of its own replies in the
  thread, which also removes the pin. Slack only lets a bot delete its own
  messages, so people's replies stay in the thread under a "This message was
  deleted" placeholder.

Each command updates the root message and Luma confirms in the thread. The
mention works whatever the bot is named.

The task's details are stored as Slack message metadata on the root message,
so the Worker needs no database.

### Google Sheet

Slack's free plan only keeps recent history, so every task is also recorded
in a Google Sheet, with one tab per channel pair (for example **acme** and
**test**). Filter the Status column to see completed tasks. See
[google-sheet/README.md](google-sheet/README.md) for the setup. Without
`SHEET_URL` and `SHEET_SECRET`, syncing is turned off.

### Channels

`CHANNEL_PAIRS` (see [Settings](#settings)) links each external channel to the channel
its tasks are posted to. Several pairs can run at once, so a pair of test
channels can sit alongside `#acme-external` → `#acme-dev`: tracking
from the test external channel creates tasks in the test tasks channel, and
the thread commands work in either tasks channel.
