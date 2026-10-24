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

1. **Create the sheet.** In Google Sheets, create a new spreadsheet, for
   example "LUMA tasks".
2. **Add the script.** In the sheet, open **Extensions → Apps Script**.
   Replace the contents of `Code.gs` with the contents of
   [`Code.gs`](Code.gs) from this folder, then click **Save**. You don't need
   to create any tabs; the script adds one per channel pair (for example
   **acme** and **test**) the first time it writes to it.

   If you created the script separately at script.google.com instead, it
   isn't attached to the sheet. Add a script property `SPREADSHEET_ID` (in
   step 3) set to the sheet's ID, the long part of its URL between `/d/` and
   `/edit`.
3. **Choose a secret.** This stops anyone else from writing to the sheet.
   Generate a random value, for example:

   ```sh
   openssl rand -hex 32
   ```

   In Apps Script, open **Project Settings** (gear icon) → **Script
   Properties** → **Add script property**. Set **Property** to `SECRET` and
   **Value** to the generated value, then click **Save script properties**.
4. **Deploy the web app.** Click **Deploy → New deployment**, click the gear
   next to **Select type** and choose **Web app**, then set:
   - **Execute as:** Me
   - **Who has access:** Anyone

   Click **Deploy**, approve the permissions Google asks for, and copy the
   **Web app URL** (it ends in `/exec`). "Anyone" lets the Worker reach the
   URL without a Google login; the secret is what protects it.
5. **Give the Worker the URL and secret** from the project directory. Add
   the Web app URL to `luma.config.json` as `"sheetUrl"` and upload it, and
   store the secret, which stays out of the file:

   ```sh
   npm run config                        # uploads sheetUrl as SHEET_URL
   npx wrangler secret put SHEET_SECRET  # the same value as the SECRET property
   ```

6. **Let LUMA read names.** The Slack app made by `npm run slack:create`
   already has the `users:read` scope it needs. Without it the
   sheet shows user IDs such as `U0BUKTZA8VB` instead of names.

Then create or update a task in a test channel; its row should appear in
the **test** tab within a few seconds.

## Updating the script

If `Code.gs` changes, paste the new version in Apps Script, then use
**Deploy → Manage deployments → Edit (pencil) → Version: New version →
Deploy**. This keeps the same URL, so the Worker needs no change.

## Troubleshooting

The Worker logs `Could not sync task to sheet` with the reason in
**Workers & Pages → project-helper → Logs**:

- `unauthorized`: `SHEET_SECRET` doesn't match the `SECRET` script property.
- `Sheet returned HTTP 401/403`: the web app's access isn't set to
  **Anyone**.
- No log at all: `SHEET_URL` or `SHEET_SECRET` isn't set, so syncing is off.

On some Google accounts, the page holding the script's reply returns 404
even though the script ran. The Worker counts the request as delivered in
that case, so a wrong secret may not appear in its logs. If rows don't
appear, open **Executions** in Apps Script: each update shows as a `doPost`
**Web App** run, and the sheet only changes when `SECRET` matches
`SHEET_SECRET`.

Tasks that existed before the sheet was set up appear the next time they
change.
