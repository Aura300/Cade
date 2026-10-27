# Getting started

Self-host Cade for your team: one Cloudflare Worker, one Slack app, and an
optional Google Sheet. There is no server to run; Cade keeps its tasks in
a Cloudflare D1 database that comes with the Worker, and shows them in Slack
(and your Sheet, if you add one).

Every step says what to run, what you should see, and what to do if it goes
wrong, so a person or an AI agent can follow it. Steps marked **(person)**
need someone to click in a browser; an agent should stop there and ask.

## Set up with an AI agent

An AI coding agent can take you through this guide one step at a time,
running the commands and stopping whenever you need to act. With [Claude
Code](https://claude.com/claude-code) installed, from this folder run:

```sh
npm run setup
```

It starts Claude Code with the setup prompt from
[`scripts/setup-prompt.md`](scripts/setup-prompt.md). With another agent,
open it in this folder and paste that prompt.

The agent never handles your tokens: the commands that need one ask for it
themselves, hidden, and the agent asks you to run those in your own
terminal. It only sees whether each step worked.

## What you need

- Node.js 20 or newer, and git.
- A Cloudflare account (the free plan is enough).
- A Slack workspace where you can create apps.
- Optional: a Google account, for the Sheet.

## Settings

Cade has two kinds of settings. **Config** is what you edit as your team
changes; it lives in `cade.config.json` on your machine (git ignores it) and
`npm run config` uploads it. **Secrets** give access to Slack or the Sheet;
they're set once with `npx wrangler secret put NAME` and live only in
Cloudflare, never in a file. Both take effect straight away and survive every
`npm run deploy`. `npx wrangler secret list` shows which are set (not their
values).

### Config: `cade.config.json`

| Key | Required? | What it is | How to get it |
| --- | --- | --- | --- |
| `channels` | **Required** | One entry per group: `{ "name", "tasks", "external", "incidents", "doc" }`. `name` is the group's name; `tasks` is the dev channel; `external` (optional) is the client's channel; `incidents` (optional) the incidents channel; `doc` (optional) the address of the group's Google Doc, where `/cade brief` writes its executive summaries; `sheet` (optional) the address of the group's own Google Sheet for its tasks (without it, its tasks aren't recorded in a Sheet); `suggestions` and `ai` (optional) the group's own, replacing the ones below for that group only. `npm run group` sets them for you. | `npm run group` (step 8), or in Slack: open each channel → click its name → **About** → **Channel ID** at the bottom (`C…`). |
| `timezone` | Optional (UTC) | The time zone for the Sheet's **Tracked at** and **Completed at** times, as an IANA name such as `Asia/Colombo`. With `ai` on, it's also how "Friday" or "tomorrow" in a message becomes a due date. | `npm run group` asks for it the first time (step 8). Your team's time zone; [the list of names](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). |
| `googleUrl` | Optional | The Google web app's URL (`https://script.google.com/…/exec`), one for every group's Sheet and Doc. Without it, nothing is written to Google, and `/cade brief` and `/cade debrief` don't work. | Set for you by `npm run google:create` (step 7). |
| `suggestions` | Optional (on) | For every group, unless a group in `channels` sets its own. **The proactive agent**: whether Cade reads messages in the threads it manages (requirement, incident and task threads) and offers, privately, to act on them. `true`, `false` for **commands only** (nothing is read from messages in threads; slash and `@Cade` commands, the task card's ⋯ menu, message shortcuts and emoji still work, and a message posted on its own in a channel is still asked about: start a requirement or task, report an incident, or move it to an existing thread), or a list of the kinds to keep: `pr-links` (a pasted PR link: link it, and pick a reviewer if there's none), `hand-offs` ("@mia can you review this?": a picker for that role, filled with who has it now), `started` ("on it": In progress), `progress` ("lgtm", "done": the next status) and `details` (with `ai` only: "this is urgent", "need it by Friday": the priority and due date, on the team's own tasks). Role and status suggestions come as one private message: a summary of what Cade read, with **Accept**, **Edit…** (the task's Edit form) and **Reject**. Without `ai`, a hand-off asks whoever the request names ("@mia can you review this?"), never someone only cc'd. | Edit by hand, then `npm run config`. |
| `ai` | Optional (off) | For every group, unless a group in `channels` sets its own, such as `{ "name": "acme", …, "ai": true }`. **AI suggestions**: the proactive agent reads messages in a task's thread with [Workers AI](https://developers.cloudflare.com/workers-ai/) instead of by their phrases, so one message can change several roles, the status, the priority and the due date. `true` for the default model (`@cf/zai-org/glm-4.7-flash`, the quickest and cheapest that read messages well in our tests), a Workers AI text model's name, or `false`. Needs `suggestions` on: with `suggestions` false it does nothing. Cade asks whoever wrote the message, privately, with what it read: **Confirm**, **Change…** (a form with every role, the status, priority and due date) or **Not now**. If the model fails or takes over 8 seconds, the message is read by its phrases instead. PR links are always read by their phrases. Uses the `AI` binding in `wrangler.toml`; Workers AI's usage beyond its free daily allowance is billed to your Cloudflare account. | Edit by hand, then `npm run config`. |
| `reactions` | Optional | The emoji that convert or move a message when someone adds them to it: `{ "convert": "ticket", "move": "twisted_rightwards_arrows" }`, by Slack name without colons. Those are the defaults. | Edit by hand, then `npm run config`. |

Start from `cade.config.example.json`. `npm run config` checks the file
(names, channel IDs, time zone and URL) and uploads nothing until it's right.

To add or change a group without editing the file, `npm run group` takes
you through it: the group's name, then each channel (a new one, which Cade
makes and is then in, or one that exists: a public one Cade joins itself, a
private one once you send `/invite @Cade` in it), people to add to them by
email or member ID, and, once the Google web app is set up (step 7), the
group's Doc and Sheet. It says what it will do before doing it, then saves
and uploads the file. It asks for Cade's bot token (or takes
`SLACK_BOT_TOKEN`), and needs the app's channel permissions (`npm run
slack:update`, then reinstall the app, if it was made before them).

Or give the settings at once:

```sh
npm run group -- --name acme --tasks C… --external C… --incidents C… --doc new --sheet new
```

`--external` and `--incidents` can be left out. `--doc` and `--sheet` take
`new` (made for you, named "acme executive summaries" and "acme tasks"),
the address of one you have, or `none` to unlink; leave them out to keep
what the group has. It checks and uploads the file, as `npm run config`
does.

### Secrets: in Cloudflare only

| Secret | Required? | What it is | How to get it |
| --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | **Required** | Lets Cade check that requests really come from Slack. | Set for you by `npm run slack:create` (step 5). Otherwise: the app's page at <https://api.slack.com/apps> → **Basic Information** → **App Credentials** → **Signing Secret**. |
| `SLACK_BOT_TOKEN` | **Required** | Lets Cade read and post as the app (`xoxb-…`). | After installing the app (step 6): its page → **OAuth & Permissions** → **Bot User OAuth Token**. `npm run slack:create` asks for it and stores it. |
| `GOOGLE_SECRET` | Only with `googleUrl` | Stops anyone else using your Google web app. | Generated and set for you by `npm run google:create` (step 7), which also puts it in `google/Secret.gs` for the script. |

### Used once during setup, never stored

| Credential | What it's for | How to get it |
| --- | --- | --- |
| Cloudflare login | Deploying, setting secrets and creating the database with `wrangler`. | `npx wrangler login` (step 2), or an API token with **Workers Scripts → Edit** and **D1 → Edit** in `CLOUDFLARE_API_TOKEN`. |
| Google login | Creating or updating the Google web app (`npm run google:create`, `google:update`). | `npx clasp login` (step 7). |
| App configuration token | Creating or updating the Slack app (`npm run slack:create`, `slack:update`), which ask for it, hidden. | <https://api.slack.com/apps> → **Your App Configuration Tokens** → **Generate Token** (`xoxe.xoxp-…`); it lasts 12 hours. Step 4. |

`npm run dev` (see [README.md](README.md)) uses the same config file and asks for the
secrets each time, without saving them.

## 1. Get the code

Copy Cade to your own GitHub account first (person): on its GitHub page,
click **Fork**, or **Use this template** for a copy without its history.
Your copy is what you deploy, and where you pull updates into later. Then:

```sh
git clone https://github.com/<you>/<your copy>.git cade
cd cade
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

**If `whoami` lists several accounts**, give the one for Cade once, with any
npm script: `CLOUDFLARE_ACCOUNT_ID=<its ID> npm run deploy`. It's saved to
`.cloudflare.json` (kept out of git), and every npm script uses it from then
on.

## 3. Name and deploy the Worker

In `wrangler.toml`, set `name` (for example `cade`). It must be unique in
your Cloudflare account, and becomes part of the URL.

All other settings are Worker secrets, set in later steps, so nothing else
in the file needs changing.

```sh
npm run deploy
```

The first deploy also creates the database Cade keeps its tasks in, named
after the Worker (`cade-db`), then its tables; there's nothing to copy into
`wrangler.toml`. Wrangler asks you to confirm before creating the tables.

**Expect:** a URL such as `https://cade.<your-subdomain>.workers.dev`, then
`0001_tasks_and_requirements.sql` listed with ✅. Note the URL: it's the
**Worker URL**. On a new account, Wrangler first asks you to choose your
`workers.dev` subdomain. **If the tables step fails** (for example, the
connection drops), run `npm run db:migrate`.

## 4. Get a Slack app configuration token (person)

Open <https://api.slack.com/apps>, scroll to **Your App Configuration
Tokens**, and **Generate Token** for your workspace. Copy the **Access
Token** (`xoxe.xoxp-…`). It lasts 12 hours; generate a new one when needed.

## 5. Create the Slack app

```sh
npm run slack:create -- https://cade.<your-subdomain>.workers.dev
```

Options: `--name "Acme Cade"` (default `Cade`, up to 35 characters) and
`--command /acme` (default `/cade`).

The app's name doesn't need to be unique across Slack, since it isn't
published to the marketplace; every team can call theirs Cade. If you run two
copies in one workspace (say a test copy), give them different names and
commands, because a workspace can't have two `/cade` commands. Cade's help
text always says `/cade`, so keep the default unless you need two copies.

The script creates the app from `slack/manifest.json` (scopes, events,
Interactivity and the slash command, all pointing at your Worker), stores the
signing secret in the Worker, then turns on Event Subscriptions.

**Expect:** `Created app A…`, wrangler confirming the secret, then an install
link. The app's ID is saved in `.slack-app.json` (not committed).
**If it fails:**
- `invalid_auth` or `token_expired`: get a new token (step 4).
- Turning on Event Subscriptions fails: check `npm run deploy` succeeded,
  then run `npm run slack:update`.

## 6. Install the app and store the bot token (person)

Open the install link the script printed and **Allow**. Then, in the app's
**OAuth & Permissions** page, copy the **Bot User OAuth Token** (`xoxb-…`)
and paste it when the script asks. If you skipped that:

```sh
npx wrangler secret put SLACK_BOT_TOKEN
```

## 7. Optional: Google Sheets and Docs

Each group can have its own Google Sheet, a record of every task (Slack's
free plan keeps 90 days of history), and its own Google Doc, where `/cade
brief` writes executive summaries to go through with the client and
`/cade debrief` reads back what was added. One web app serves them all. It
needs a Google account.

1. **(person)** `npx clasp login`, and turn on the Apps Script API at
   <https://script.google.com/home/usersettings> (once per account).
2. Create the web app:

   ```sh
   npm run google:create
   ```

   **Expect:** a standalone script, "Cade", deployed as a web app; the
   Worker gets its address (`googleUrl`, in `cade.config.json` and
   uploaded) and its secret (`GOOGLE_SECRET`).
3. **(person)** Open the script link it prints, choose `authorize`, click
   **Run** and allow it.

Each group's Doc and Sheet are made or linked when you set the group up
(step 8). Skip this step for now and add them later with `npm run group`.

**If it fails** with the Apps Script API: turn it on (step 1) and run it
again. Details, doing it by hand, and troubleshooting are in
[google/README.md](google/README.md).

## 8. Set up your first group (person)

A **group** is a team or project, with its own channels:

- **Team only:** a **dev** channel (for example `#acme-dev`), where the team
  tracks its work with `/cade track`, setting each task's priority and due
  date. This is the simplest setup, and enough when no client works in
  Slack with you.
- **With a client:** the dev channel, plus a **client** (external) channel
  shared with the client (`#acme-client`), where they start requirements and
  report incidents that the team tracks as tasks in the dev channel, and
  optionally an **incidents** channel (`#acme-incidents`) for incidents'
  tasks.

`npm run group` takes you through it. It asks questions, so run it in a
terminal window of your own, in this folder:

```sh
npm run group
```

1. Cade's bot token, hidden: the `xoxb-…` token from step 6 (or set
   `SLACK_BOT_TOKEN` first, to skip the question).
2. The group's name, then your team's time zone (the first time only).
3. For each channel, **existing or new**: an existing channel by its ID
   (the channel's name → **About** → **Channel ID**, `C…`), which Cade joins
   if it's public, or waits for `/invite @Cade` in it if it's private; or a
   new one by name, which Cade makes, public or private, and is then in.
   The client and incidents channels can be left out (`-`), and added later.
4. People to add to the channels, by email or Slack member ID.
5. With the Google web app (step 7), the group's Doc and Sheet: `new`, the
   address of one you have, or none.
6. What it will do, to confirm. It then does it, saves the group in
   `cade.config.json` (git ignores it) and uploads it as the Worker secrets
   `CHANNEL_PAIRS` and `TIMEZONE`.

**Expect:** "Done", with each channel's link. Then, in Slack, share the
client channel with the client (channel name → **Share channel**), and the
group's Doc with them as **Editor**.

Run `npm run group` again for every other group, or to change one: Enter
keeps what it has. To set the first group up later, skip this step and run
it when you're ready. Editing `cade.config.json` by hand and running `npm
run config` works too (see [Settings](#settings)).

## 9. Check it works

1. In any channel: `/cade help` → only you see the command list.
2. In the dev channel: `/cade track` → a form; submitting posts the task.
3. In the task's thread: `@Cade status in progress` → ✅ on your message.
4. With a client channel, in it: `/cade requirement` → a form; submitting
   posts a **Requirement** card. In its thread, `@Cade track` → a **Track
   task** button; tracking posts the task in the dev channel.

**If nothing answers:** run `npx wrangler tail` and try again.
`Invalid signature` means the signing secret is wrong (rerun step 5 or
`wrangler secret put SLACK_SIGNING_SECRET` with the one under **Basic
Information**); `not_in_channel` means the app isn't invited;
`missing_scope` means the app needs reinstalling (step 6).

## Updating

Bring Cade's changes into your copy with **Sync fork** on its GitHub page
(or `git pull https://github.com/XTECLK/Cade.git main`), then:

```sh
git pull
npm install
npm test
npm run deploy                              # also applies new files in migrations/
npm run slack:update                        # only if slack/manifest.json changed
npm run google:update                       # only if google/ changed
```

If Slack says the app needs reinstalling after an update, reinstall it from
the app's page (step 6); the bot token usually stays the same.

Cade now reads who's in the team's channels (`channels:read` and
`groups:read`), so that suggestions in a requirement thread only go to the
team. After updating, run `npm run slack:update` and reinstall the app.
Until then, everyone in the requirement thread gets them, as before.

## Limits to know

- Slack's free plan hides messages older than 90 days, including old tasks'
  threads. The tasks themselves stay in the database (and the Sheet).
- D1's free plan allows 100,000 row writes a day and 500 MB per database;
  each change to a task is a single row write.
- If Slack won't take a new task, requirement or incident (for example
  while it is rate limiting), Cade keeps it and tries again every five
  minutes, five times in all, telling whoever made it the first time and if
  it gives up.
- Cade can only delete its own messages; people's replies stay.

## Good to know

- **The app icon.** Slack's manifest can't set an icon, so upload
  `slack/icon.png` (drawn from `slack/icon.svg`) under **Basic Information →
  Display Information** on the app's page at <https://api.slack.com/apps>.
- **Test channels.** Several channel groups can run at once (see
  [Settings](#settings)), so a pair of test channels can sit alongside the
  real ones: work tracked from the test external channel goes to the test
  dev channel.
- **Google Sheets and Docs**: each group's own spreadsheet records its
  tasks (filter its Status column to see completed ones), and its own doc
  holds its executive summaries. See [google/README.md](google/README.md);
  a group without `sheet` isn't recorded in a Sheet.

## Using Cade

Once it's set up, send `@Cade help` or `/cade help` in Slack for the short
list, and see the [commands guide](https://xteclk.github.io/Cade/commands.html)
for every command, where it works and what it does.
