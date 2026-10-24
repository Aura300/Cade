# Slack app setup for LUMA

These steps configure the existing **LUMA** Slack app to work with the
`project-helper` Worker. All settings are in the app's pages at
<https://api.slack.com/apps> → **LUMA**.

Throughout this guide, `WORKER` means the Worker's address, for example:

```
https://project-helper.<your-subdomain>.workers.dev
```

The address appears in the output of `npm run deploy` and in the Cloudflare
dashboard under **Workers & Pages → project-helper**.

## Before you start

Slack checks some request URLs as soon as you enter them, so the Worker must
be deployed and have its secrets set first.

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

3. Set the channel IDs in `wrangler.toml`:

   ```toml
   [vars]
   EXTERNAL_CHANNEL_ID = "C…" # #aura300-external
   TASK_CHANNEL_ID = "C…" # #aura300-dev
   ```

   In Slack, open each channel → click the channel name → **About** tab; the
   **Channel ID** is at the bottom.
4. Deploy with `npm run deploy` (or push to `main` to deploy through GitHub
   Actions).

## 1. OAuth & Permissions

Under **Scopes → Bot Token Scopes**, add each of these. Keep any scopes the
app already has.

| Scope | Used for |
| --- | --- |
| `commands` | The `/luma` slash command |
| `chat:write` | Posting tasks, replies and announcements; editing and deleting Luma's messages |
| `channels:history` | Reading messages in public channels (thread commands, task details) |
| `groups:history` | The same for private channels |
| `pins:write` | Pinning open tasks and unpinning done ones |

## 2. Slash Commands

Click **Create New Command**. If `/luma` already exists, edit it with the
pencil icon.

| Field | Value |
| --- | --- |
| Command | `/luma` |
| Request URL | `WORKER/slack/commands` |
| Short Description | `Track tasks and manage assignments` |
| Usage Hint | `[track \| help]` |
| Escape channels, users, and links sent to your app | Leave unticked |

Click **Save**. Slack shows the description and usage hint in its
autocomplete list when someone types `/luma`.

## 3. Interactivity & Shortcuts

1. Turn **Interactivity** on.
2. Set **Request URL** to `WORKER/slack/interactions`.
3. Click **Save Changes**.

This is needed for the task form, the **Track task** button and the
**Delete task** / **Cancel** buttons.

## 4. Event Subscriptions

1. Turn **Enable Events** on.
2. Set **Request URL** to `WORKER/slack/events`. Slack sends a test request,
   and the field should show **Verified**. If it doesn't, check that the
   Worker is deployed and `SLACK_SIGNING_SECRET` is set, then click
   **Retry**.
3. Under **Subscribe to bot events**, click **Add Bot User Event** and add:
   - `message.channels`
   - `message.groups`
4. Click **Save Changes**.

This lets Luma see thread commands such as `luma assign @person`.

> A Slack app has only one Interactivity Request URL and one Events Request
> URL. If either was already set to another service, that service will stop
> receiving them once you change it.

## 5. Reinstall the app

Go to **Install App → Reinstall to Workspace** and approve the new
permissions. Slack also shows a yellow banner asking for this after the
changes above. New scopes and events take effect only after reinstalling.

The bot token normally stays the same. If **OAuth & Permissions** shows a
different one after reinstalling, update the Worker secret:

```sh
npx wrangler secret put SLACK_BOT_TOKEN
```

## 6. Invite LUMA to the channels

In both `#aura300-external` and `#aura300-dev`, type:

```
/invite @LUMA
```

## 7. Check that it works

| Try | Expected result |
| --- | --- |
| Type `/luma` in any channel | Autocomplete shows `/luma [track \| help]` |
| `/luma help` | A private list of all commands |
| `/luma track` in `#aura300-external` | The **Track task** form opens |
| Submit the form | The task appears and is pinned in `#aura300-dev`; `#aura300-external` gets "@you tracked a task" with a link |
| In the task's thread: `luma assign @someone` | The task message shows them under **Assigned** |
| `luma status` | A status menu appears; picking **In progress** changes **Status** to 🔵 In progress |
| `luma status done` | Status changes to ✅ Done and the task is unpinned |
| `luma delete` | **Delete task** / **Cancel** buttons; confirming deletes the task |

If something doesn't respond, open **Workers & Pages → project-helper →
Logs** in Cloudflare. Errors such as `missing_scope` or `not_in_channel`
mean a scope from step 1 or the invite from step 6 is missing.
