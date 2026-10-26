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
| `channels` | **Required** | One entry per group: `{ "name", "tasks", "external", "incidents", "doc" }`. `name` is the group's name (its tab in the Sheet); `tasks` is the dev channel; `external` (optional) is the client's channel; `incidents` (optional) the incidents channel; `doc` (optional) the address of the group's Google Doc, where `/cade export` writes its executive summaries. | In Slack, open each channel → click its name → **About** → **Channel ID** at the bottom (`C…`). Step 7. |
| `timezone` | Optional (UTC) | The time zone for the Sheet's **Tracked at** and **Completed at** times, as an IANA name such as `Asia/Colombo`. Nothing else uses it. | Your team's time zone; [the list of names](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). |
| `sheetUrl` | Optional | The Google Sheet's web app URL (`https://script.google.com/…/exec`). Without it, nothing is written to a Sheet. | Set for you by `npm run sheet:create` (step 8). |
| `docUrl` | Optional | The Google Doc web app's URL (`https://script.google.com/…/exec`). Without it, `/cade export` and `/cade import` don't work. | Set for you by `npm run doc:create` (step 8b). |

Start from `cade.config.example.json`. `npm run config` checks the file
(names, channel IDs, time zone and URL) and uploads nothing until it's right.

### Secrets: in Cloudflare only

| Secret | Required? | What it is | How to get it |
| --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | **Required** | Lets Cade check that requests really come from Slack. | Set for you by `npm run slack:create` (step 5). Otherwise: the app's page at <https://api.slack.com/apps> → **Basic Information** → **App Credentials** → **Signing Secret**. |
| `SLACK_BOT_TOKEN` | **Required** | Lets Cade read and post as the app (`xoxb-…`). | After installing the app (step 6): its page → **OAuth & Permissions** → **Bot User OAuth Token**. `npm run slack:create` asks for it and stores it. |
| `SHEET_SECRET` | Only with `sheetUrl` | Stops anyone else writing to your Sheet. | Generated and set for you by `npm run sheet:create` (step 8), which also puts it in `google-sheet/Secret.gs` for the script. |
| `DOC_SECRET` | Only with `docUrl` | Stops anyone else using the Google Doc web app. | Generated and set for you by `npm run doc:create` (step 8b), which also puts it in `google-doc/Secret.gs`. |

### Used once during setup, never stored

| Credential | What it's for | How to get it |
| --- | --- | --- |
| Cloudflare login | Deploying, setting secrets and creating the database with `wrangler`. | `npx wrangler login` (step 2), or an API token with **Workers Scripts → Edit** and **D1 → Edit** in `CLOUDFLARE_API_TOKEN`. |
| Google login | Creating or updating the Sheet's or the Doc's script (`npm run sheet:create`, `doc:create` and their `:update`s). | `npx clasp login` (step 8). |
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

## 7. Set up the channels

For each team or project (a **group**), pick one of two setups:

- **Team only:** a **dev** channel (for example `#acme-dev`), where the team
  tracks its work with `/cade track`, setting each task's priority and due
  date. This is the simplest setup, and enough when no client works in
  Slack with you.
- **With a client:** the dev channel, plus an **external** channel shared
  with the client (`#acme-external`), where they start requirements and
  report incidents that the team tracks as tasks in the dev channel, and
  optionally an **incidents** channel (`#acme-incidents`) for incidents'
  tasks.

You can add the external channel to a group later.

Find each channel's ID: open the channel → click its name → **About** →
**Channel ID** at the bottom (it starts with `C`). Put them in
`cade.config.json`, starting from the example:

```sh
cp cade.config.example.json cade.config.json
```

```json
{
  "timezone": "UTC",
  "channels": [
    { "name": "acme", "tasks": "C…" },
    { "name": "globex", "external": "C…", "tasks": "C…", "incidents": "C…" }
  ]
}
```

Add one line to `channels` per group: `acme` is team only, `globex` has a
client. Each key is described under
[Settings](#settings); `timezone` and `sheetUrl` are optional.

`cade.config.json` stays on your machine (git ignores it). Upload it:

```sh
npm run config
```

It checks the file (every group has a name and real channel IDs, no channel
is used twice, the time zone exists), prints what it found, and stores it as
the Worker secrets `CHANNEL_PAIRS` and `TIMEZONE` in one go. Secrets take
effect straight away and survive every `npm run deploy`. To change anything
later, edit `cade.config.json` and run `npm run config` again.

The secrets aren't in this file; see [Settings](#settings).

Then invite the app to every channel:

```
/invite @Cade
```

**Expect:** `npx wrangler secret list` shows `CHANNEL_PAIRS`,
`SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. **If `npm run config`
stops**, it says what's wrong in `cade.config.json`; nothing is uploaded
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
   Worker gets its address (`sheetUrl`, added to `cade.config.json` and
   uploaded) and its secret (`SHEET_SECRET`).
3. **(person)** Open the script link it prints, choose `authorize`, click
   **Run** and allow it.

**If it fails** with the Apps Script API: turn it on (step 1) and run it
again. Details, doing it by hand, and troubleshooting are in
[google-sheet/README.md](google-sheet/README.md).

## 8b. Optional: the Google Doc, for executive summaries

`/cade export` writes each group's executive summary into the group's Google
Doc, to go through on calls with the client; `/cade import` reads back what
was added during the call. It's separate from the Sheet and works without
it.

1. **(person)** `npx clasp login` and the Apps Script API, as in step 8.
2. Create the web app:

   ```sh
   npm run doc:create
   ```

   **Expect:** a standalone script deployed as a web app; the Worker gets
   its address (`docUrl`) and its secret (`DOC_SECRET`).
3. **(person)** Open the script link it prints, choose `authorize`, click
   **Run** and allow it.
4. **(person)** For each group, make a Google Doc (or use the one you
   already share with the client), and add its address to the group in
   `cade.config.json` as `"doc"`. Then `npm run config`. The web app runs as
   you, so you must be able to edit the doc. Cade writes in its **Summary**
   tab, and adds the tab if it has none.

Details and troubleshooting are in
[google-doc/README.md](google-doc/README.md).

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
npm run sheet:update                        # only if google-sheet/Code.gs changed
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
- **The Google Sheet** has one tab per channel group. Filter its Status
  column to see completed tasks. See
  [google-sheet/README.md](google-sheet/README.md); without `sheetUrl`,
  nothing is written to a Sheet.

## Using Cade

Once it's set up, send `@Cade help` or `/cade help` in Slack for the short
list, and see the [commands guide](https://xteclk.github.io/Cade/commands.html)
for every command, where it works and what it does.
