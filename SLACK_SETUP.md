# Slack app setup for LUMA

These steps configure the existing **LUMA** Slack app to work with the
`project-helper` Worker. All settings are in the app's pages at
<https://api.slack.com/apps> → **LUMA**.

The Worker's address is:

```
https://project-helper.aura300.workers.dev
```

It's also shown in the output of `npm run deploy` and in the Cloudflare
dashboard under **Workers & Pages → project-helper**.

Everything in LUMA is a message that starts with `@LUMA`, so the app needs
**Event Subscriptions** (to receive those messages) and **Interactivity** (for
the task form, buttons and status menu). It does not use slash commands.

## Before you start

Slack checks the Events Request URL as soon as you enter it, so the Worker
must be deployed and have its secrets set first.

1. Get the two values the Worker needs from the Slack app:
   - **Bot token:** **OAuth & Permissions → OAuth Tokens → Bot User OAuth
     Token** (starts with `xoxb-`).
   - **Signing secret:** **Basic Information → App Credentials → Signing
     Secret** (click **Show**).
2. Store them as Worker secrets from the project directory:

   ```sh
   npx wrangler secret put SLACK_BOT_TOKEN
   npx wrangler secret put SLACK_SIGNING_SECRET
   ```

3. Set the channel pairs in `wrangler.toml`. Each pair links an external
   channel, where `@LUMA track` is used, to the channel its tasks go to. Add
   a second pair for test channels to try LUMA without touching the real
   ones; both pairs work at the same time.

   ```toml
   [vars]
   CHANNEL_PAIRS = [
     { external = "C…", tasks = "C…" }, # #aura300-external → #aura300-dev
     { external = "C…", tasks = "C…" }, # test external → test dev
   ]
   ```

   In Slack, open each channel → click the channel name → **About** tab; the
   **Channel ID** is at the bottom.
4. Deploy with `npm run deploy` (or push to `main` to deploy through GitHub
   Actions).

## 1. Turn off Socket Mode

Open **Socket Mode** in the sidebar and make sure **Enable Socket Mode** is
off. While it is on, Slack sends everything over a connection held open by a
running program instead of to request URLs, and it hides the Request URL
fields on the pages below. The Worker can only receive request URLs.

If another program uses this app through Socket Mode, it stops receiving
events once Socket Mode is off. In that case, use a separate Slack app for
LUMA.

## 2. OAuth & Permissions

Under **Scopes → Bot Token Scopes**, add each of these. Keep any scopes the
app already uses for other purposes.

| Scope | Used for |
| --- | --- |
| `chat:write` | Posting tasks, replies and announcements; editing and deleting Luma's messages |
| `channels:history` | Reading messages in public channels (`@LUMA` commands, task details) |
| `groups:history` | The same for private channels |
| `pins:write` | Pinning open tasks and unpinning done ones |

If the app has the `commands` scope only because of an earlier `/luma` slash
command, you can remove it.

## 3. Interactivity & Shortcuts

1. Turn **Interactivity** on.
2. Set **Request URL** to
   `https://project-helper.aura300.workers.dev/slack/interactions`.
3. Click **Save Changes**.

Keep this on. The task form, the **Track task** button, the status menu and
the **Delete task** / **Cancel** buttons all use it.

## 4. Event Subscriptions

1. Turn **Enable Events** on.
2. Set **Request URL** to
   `https://project-helper.aura300.workers.dev/slack/events`. Slack sends a
   test request, and the field should show **Verified**. If it doesn't, check
   that the Worker is deployed and `SLACK_SIGNING_SECRET` matches the app's
   signing secret, then click **Retry**.
3. Under **Subscribe to bot events**, click **Add Bot User Event** and add:
   - `message.channels`
   - `message.groups`
4. Click **Save Changes**.

This is how Luma receives `@LUMA` commands.

> A Slack app has only one Interactivity Request URL and one Events Request
> URL. If either was already set to another service, that service will stop
> receiving them once you change it.

## 5. Remove the slash command

LUMA doesn't use slash commands. If **Slash Commands** lists `/luma`, delete
it so people aren't shown a command that doesn't work.

## 6. Reinstall the app

Go to **Install App → Reinstall to Workspace** and approve the permissions.
Slack also shows a yellow banner asking for this after the changes above. New
scopes and events take effect only after reinstalling.

The bot token normally stays the same. If **OAuth & Permissions** shows a
different one after reinstalling, update the Worker secret:

```sh
npx wrangler secret put SLACK_BOT_TOKEN
```

## 7. Invite LUMA to the channels

In every channel listed in `CHANNEL_PAIRS` (for example `#aura300-external`,
`#aura300-dev` and both test channels), type:

```
/invite @LUMA
```

## 8. Check that it works

Try these in the test channels first.

| Try | Expected result |
| --- | --- |
| `@LUMA help` in either channel | A reply listing all commands |
| `@LUMA track` in a thread in `#aura300-external` | Luma replies with a **Track task** button; clicking it opens the form |
| Submit the form | The task appears and is pinned in `#aura300-dev`; the button reply becomes "@you tracked a task" with a link |
| In the task's thread: `@LUMA assign @someone` | The task message shows them under **Assigned** |
| `@LUMA status` | A status menu appears; picking **In progress** changes **Status** to 🔵 In progress |
| `@LUMA status done` | Status changes to ✅ Done and the task is unpinned |
| `@LUMA delete` | **Delete task** / **Cancel** buttons; confirming deletes the task and posts "untracked" in the original external thread |

If something doesn't respond, open **Workers & Pages → project-helper →
Logs** in Cloudflare. Errors such as `missing_scope` or `not_in_channel`
mean a scope from step 2 or the invite from step 7 is missing.
