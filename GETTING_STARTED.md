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
| `sheetUrl` | Optional | The Google Sheet's web app URL (`https://script.google.com/…/exec`). Without it, nothing is written to a Sheet. | Deploying the Sheet's Apps Script as a web app: [google-sheet/README.md](google-sheet/README.md) step 4. |

Start from `luma.config.example.json`. `npm run config` checks the file
(names, channel IDs, time zone and URL) and uploads nothing until it's right.

### Secrets: in Cloudflare only

| Secret | Required? | What it is | How to get it |
| --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | **Required** | Lets Luma check that requests really come from Slack. | Set for you by `npm run slack:create` (step 5). Otherwise: the app's page at <https://api.slack.com/apps> → **Basic Information** → **App Credentials** → **Signing Secret**. |
| `SLACK_BOT_TOKEN` | **Required** | Lets Luma read and post as the app (`xoxb-…`). | After installing the app (step 6): its page → **OAuth & Permissions** → **Bot User OAuth Token**. `npm run slack:create` asks for it and stores it. |
| `SHEET_SECRET` | Only with `sheetUrl` | Stops anyone else writing to your Sheet. | A random value you make, such as `openssl rand -hex 32`, set both here and as the `SECRET` script property in Apps Script: [google-sheet/README.md](google-sheet/README.md) step 3. |

### Used once during setup, never stored

| Credential | What it's for | How to get it |
| --- | --- | --- |
| Cloudflare login | Deploying and setting secrets with `wrangler`. | `npx wrangler login` (step 2), or an API token with **Workers Scripts → Edit** in `CLOUDFLARE_API_TOKEN`. |
| `SLACK_CONFIG_TOKEN` | Creating or updating the Slack app (`npm run slack:create`, `slack:update`). Set only for that command. | <https://api.slack.com/apps> → **Your App Configuration Tokens** → **Generate Token** (`xoxe.xoxp-…`); it lasts 12 hours. Step 4. |

`npm run dev` (see the README) uses the same config file and asks for the
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
task. Follow [google-sheet/README.md](google-sheet/README.md), then add its
web app URL to `luma.config.json`:

```json
{
  "timezone": "Asia/Colombo",
  "sheetUrl": "https://script.google.com/macros/s/…/exec",
  "channels": [ … ]
}
```

and upload it, then store the secret, which stays out of the file:

```sh
npm run config
npx wrangler secret put SHEET_SECRET
```

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
