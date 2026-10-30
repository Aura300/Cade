# Google Sheets and Docs

Each group can have its own **Google Sheet**, a record of its
tasks (Slack's free plan only keeps recent history), and its own **Google
Doc**, where `/cade brief` writes its executive summaries to go through
with the client and `/cade debrief` reads back what was added. A free Google
account is enough.

The Worker reaches both through one Apps Script web app, this folder:
`Code.gs` takes each request and runs its `action`, `Sheet.gs` keeps the
spreadsheets and `Doc.gs` the docs. It's a standalone script, in no
spreadsheet or doc, serving every group, and runs as you, so you must be
able to edit each group's files. Any of them can be deleted without
affecting the others.

## Linking a group's files

```sh
npm run group -- --name acme --sheet new --doc new
npm run group -- --name acme --sheet https://docs.google.com/spreadsheets/d/…/edit --doc https://docs.google.com/document/d/…/edit
```

`new` has the web app make the file (yours, named "acme tasks" and "acme
executive summaries"); an address links one you have; `none` unlinks.
They're saved on the group in `cade.config.json` as `sheet` and `doc`, and
uploaded. A group without `sheet` isn't recorded in a Sheet; without `doc`,
`/cade brief` and `/cade debrief` say how to link one. Share the doc with
the client as **Editor**.

## The Sheet

Cade keeps a **Tasks** tab in the group's spreadsheet, made on the first
update (a new spreadsheet's empty first tab is removed then). A tab named
after the group, as older versions made, is renamed Tasks, rows and all. Every
task has one row, updated on every change:

Title, Status, Priority, Due date, Owner, Reviewer, Tester, Tracked by,
Tracked at, Completed at, Task link, Request link, Task ID

Deleted tasks stay, with the status "Deleted". To see completed tasks,
filter the **Status** column to "Done" (**Data → Create a filter**).
**Completed at** is the first time the task was set to Done; it's cleared if
the task is reopened. **Task ID** is the dev thread's ID
(`channel:timestamp`): each update finds the task's row by it and overwrites
it, so you can sort and filter freely, but don't edit or delete that column.
Times are in `TIMEZONE` (UTC if unset). Tasks that existed before the
spreadsheet was linked appear the next time they change; to move rows from
another spreadsheet, copy them into the tab under its header row.

## The Doc

Cade writes in the doc's **Summary** tab, and adds the tab if the doc has
none. A group's summaries cover its tasks, incidents first. Each summary is
a section of its own, newest at the top: a heading
with the day it was written and the group, the period, then **Completed**,
**Incidents** and each health (**Blocked**, **Delayed**, **At risk**, **On
track**). Every line is a bullet whose title links to its Slack thread, with
its notes as bullets under it.

During the call, add to the section:

- **A bullet of its own, with no link**: a new task in the dev channel.
  Bullets under it are its details, which become its thread's first message.
- **Bullets (or lines) under a linked one**: points for that task's thread.

`/cade debrief` suggests each, one at a time. Leave the section's heading as
it is: it's how Cade finds the section again (through a named range).
Editing or removing what Cade wrote is fine, but it isn't read back. Only
what's new is.

## Setup

1. **Log in to Google (person).** `npx clasp login` opens a browser to
   allow clasp, Google's Apps Script command line, to manage your scripts.
2. **Turn on the Apps Script API (person, once per Google account)** at
   <https://script.google.com/home/usersettings>.
3. **Create the web app:** `npm run google:create`. It creates the
   standalone script "Cade", generates a random secret into `Secret.gs`
   (not committed), deploys it as a web app (running as you, reachable by
   anyone: the secret is what protects it), then gives the Worker its
   address (`googleUrl` in `cade.config.json`, uploaded with `npm run
   config`) and the secret (`GOOGLE_SECRET`). Its IDs are saved to
   `.cade/google-app.json`.
4. **Approve the script (person).** Open the script link it prints, choose
   `authorize` at the top, click **Run**, and allow access to your
   spreadsheets and docs. Until then, the web app can't use them.
5. **Link each group's files** with `npm run group`, as above.

If the scripts here change, `npm run google:update` pushes them and
redeploys the same address. By hand: paste the new files, then **Deploy →
Manage deployments → Edit → Version: New version → Deploy**. Run
`authorize` again if it asks for new access.

## Troubleshooting

The Worker logs `Could not sync task to sheet` or `Could not add the
executive summary to the doc` with the reason in `npx wrangler tail`:

- `unauthorized`: `GOOGLE_SECRET` doesn't match `SECRET` in `Secret.gs`.
- `HTTP 401/403`: the web app's access isn't set to **Anyone**.
- `You do not have permission`, or a file that can't be found: the group's
  `sheet` or `doc` address is wrong, or you (who deployed the script) can't
  edit it.
- No log at all for a task: `googleUrl` isn't set, or the group has no
  `sheet`, so syncing is off.
- `HTTP 404` from the doc: on some Google accounts the page holding the
  script's reply is missing. Sheet rows can do without the reply (so a wrong
  secret may not show in the logs there); summaries can't. Check
  **Executions** in Apps Script: every request shows as a `doPost` **Web
  App** run, with its error.
- "Authorization required" in **Executions**: step 4 is still to do.
