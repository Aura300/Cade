# Google Sheet task record

Slack's free plan only keeps recent message history, so the Worker also
records every task in a Google Sheet. A free Google account is enough.

Each channel pair (group) has its own spreadsheet, linked with
`"sheet": "<spreadsheet address>"` on its group in `cade.config.json` (then
`npm run config`), so each client's tasks can be shared on their own. A
group without one isn't recorded. Cade keeps a tab named after the group
(for example **acme**) in it, made on the first update; a new spreadsheet's
empty first tab is removed then. One standalone script, in no spreadsheet,
serves every group, running as you, so you must be able to edit each
spreadsheet; any of them can be deleted without affecting the others. Every
task has one row, updated on every change:

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
3. **Create the web app:**

   ```sh
   npm run sheet:create
   npm run sheet:create -- --sheet https://docs.google.com/spreadsheets/d/…/edit   # and link it to your only group
   npm run sheet:create -- --group acme --sheet https://docs.google.com/spreadsheets/d/…/edit
   ```

   It creates a standalone script, "Cade Sheet", from `Code.gs`, generates
   a random secret into `Secret.gs` next to it, deploys it as a web app
   (running as you, reachable by anyone: the secret is what protects it),
   then gives the Worker the web app's address (`sheetUrl` in
   `cade.config.json`, uploaded with `npm run config`) and the secret
   (`SHEET_SECRET`). With `--sheet`, it links that spreadsheet to the group
   too. `Secret.gs` stays out of git; it's only in your Apps Script project
   and this folder. The script's IDs are saved to `.sheet-app.json` in the
   project root.
4. **Approve the script (person).** Open the script link it prints, choose
   the `authorize` function at the top, click **Run**, and allow access to
   your spreadsheets. Until then, the web app can't write to them.
5. **Link each group's spreadsheet (person).** Make one in Google Sheets
   (blank is fine), add its address to the group as `"sheet"` in
   `cade.config.json`, and run `npm run config`.

Then create or update a task in a test channel; its row should appear in
the group's tab within a few seconds. People's names need the Slack scope
`users:read`, which the app made by `npm run slack:create` has; without it
the sheet shows user IDs such as `U0BUKTZA8VB`.

### By hand

At <https://script.google.com/home>, create a **New project**. Replace
`Code.gs` with this folder's [`Code.gs`](Code.gs), and add
a file `Secret.gs` containing `const SECRET = "…";` with a random value
(such as from `openssl rand -hex 32`). Under **Project Settings**, tick
**Show "appsscript.json"** and replace it with this folder's
[`appsscript.json`](appsscript.json). Run `authorize` once, then **Deploy →
New deployment → Web app** and copy its URL (ending `/exec`). Put the URL in
`cade.config.json` as `sheetUrl`, link each group's spreadsheet as `sheet`,
run `npm run config`, and store the same secret with `npx wrangler secret
put SHEET_SECRET`.

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
- No log at all: `SHEET_URL` or `SHEET_SECRET` isn't set, or the group has
  no `sheet`, so syncing is off.
- `missing spreadsheetId`: the Worker is older than the script; deploy it.
- `You do not have permission`, or a file that can't be found: the group's
  `sheet` address is wrong, or you (who deployed the script) can't edit it.

On some Google accounts, the page holding the script's reply returns 404
even though the script ran. The Worker counts the request as delivered in
that case, so a wrong secret may not appear in its logs. If rows don't
appear, open **Executions** in Apps Script: each update shows as a `doPost`
**Web App** run, and the sheet only changes when `SECRET` matches
`SHEET_SECRET`. An "authorization required" error there means step 4 is
still to do.

Tasks that existed before the sheet was set up appear the next time they
change.
