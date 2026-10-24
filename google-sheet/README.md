# Google Sheet task record

Slack's free plan only keeps recent message history, so the Worker also
records every task in a Google Sheet. A free Google account is enough.

Each channel pair in `CHANNEL_PAIRS` (a Worker secret) gets its own tab,
named after the pair (for example **acme** and **test**), created
automatically on the first update. Every task has one row, updated on every
change:

Title, Status, Priority, Due date, Developer, Reviewer, Tester, Tracked by,
Tracked at, Completed at, Task link, Request link, Task ID

Deleted tasks stay, with the status "Deleted". To see completed tasks,
filter the **Status** column to "Done" (**Data → Create a filter**).
**Completed at** is the first time the task was set to Done; it's cleared if
the task is reopened.

**Task ID** is the dev thread's ID (`channel:timestamp`). Each update finds
the task's row by this ID and overwrites it, so a task never appears twice.
You can sort and filter the tabs freely, but don't edit or delete the Task ID
column. Times are in `TIMEZONE` (a Worker secret; UTC if unset).

## Setup

From the project directory:

1. **Log in to Google (person).** `npx clasp login` opens a browser to
   allow clasp, Google's Apps Script command line, to manage your scripts.
2. **Turn on the Apps Script API (person, once per Google account)** at
   <https://script.google.com/home/usersettings>.
3. **Create the Sheet:**

   ```sh
   npm run sheet:create                        # titled "Luma tasks"
   npm run sheet:create -- --title "Acme tasks"
   ```

   It creates a spreadsheet with `Code.gs` attached, generates a random
   secret into `Secret.gs` next to it, deploys the script as a web app
   (running as you, reachable by anyone: the secret is what protects it),
   then gives the Worker the web app's address (`sheetUrl` in
   `luma.config.json`, uploaded with `npm run config`) and the secret
   (`SHEET_SECRET`). `Secret.gs` stays out of git; it's only in your Apps
   Script project and this folder. The script's IDs are saved to
   `.sheet-app.json` in the project root.
4. **Approve the script (person).** Open the script link it prints, choose
   the `authorize` function at the top, click **Run**, and allow access to
   the spreadsheet. Until then, the web app can't write to it.

Then create or update a task in a test channel; its row should appear in
the group's tab within a few seconds. People's names need the Slack scope
`users:read`, which the app made by `npm run slack:create` has; without it
the sheet shows user IDs such as `U0BUKTZA8VB`.

### By hand

In Google Sheets, create a spreadsheet and open **Extensions → Apps
Script**. Replace `Code.gs` with this folder's [`Code.gs`](Code.gs), and add
a file `Secret.gs` containing `const SECRET = "…";` with a random value
(such as from `openssl rand -hex 32`). Under **Project Settings**, tick
**Show "appsscript.json"** and replace it with this folder's
[`appsscript.json`](appsscript.json). Run `authorize` once, then **Deploy →
New deployment → Web app** and copy its URL (ending `/exec`). Put the URL in
`luma.config.json` as `sheetUrl`, run `npm run config`, and store the same
secret with `npx wrangler secret put SHEET_SECRET`.

## Updating the script

If `Code.gs` changes:

```sh
npm run sheet:update
```

It pushes the script and redeploys the same deployment, so the address, and
the Worker, stay as they are. By hand: paste the new `Code.gs`, then
**Deploy → Manage deployments → Edit → Version: New version → Deploy**.

## Troubleshooting

The Worker logs `Could not sync task to sheet` with the reason in
`npx wrangler tail` (or **Workers & Pages → your Worker → Logs**):

- `unauthorized`: `SHEET_SECRET` doesn't match `SECRET` in `Secret.gs`.
- `Sheet returned HTTP 401/403`: the web app's access isn't set to
  **Anyone**.
- No log at all: `SHEET_URL` or `SHEET_SECRET` isn't set, so syncing is off.

On some Google accounts, the page holding the script's reply returns 404
even though the script ran. The Worker counts the request as delivered in
that case, so a wrong secret may not appear in its logs. If rows don't
appear, open **Executions** in Apps Script: each update shows as a `doPost`
**Web App** run, and the sheet only changes when `SECRET` matches
`SHEET_SECRET`. An "authorization required" error there means step 4 is
still to do.

Tasks that existed before the sheet was set up appear the next time they
change.
