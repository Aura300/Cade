# Google Doc executive summaries

`/cade export` writes each group's executive summary into the group's Google
Doc, the one you go through with the client on calls, rather than posting
it in Slack. After the call, `/cade import` reads it back for what was added.
This folder's Apps Script is the web app the Worker does that through. It is
separate from the Google Sheet (`google-sheet/`), and works without it.

## The doc

Each group links its doc in `cade.config.json`:

```json
{ "name": "acme", "external": "C…", "tasks": "C…", "doc": "https://docs.google.com/document/d/…/edit" }
```

Cade writes in the doc's **Summary** tab, and adds the tab if the doc has
none (a new, empty doc's only tab is renamed instead). Each summary is a
section of its own, newest at the top: a heading with the day it was
written and the group, the period, then **Completed**, **Incidents** and
each health (**Blocked**, **Delayed**, **At risk**, **On track**). Every line
is a bullet whose title links to its Slack thread, with its notes as bullets
under it.

During the call, add to the section:

- **A bullet of its own, with no link**: a new requirement. Bullets under
  it are its details, which become its thread's first message.
- **Bullets (or lines) under a linked one**: points for that requirement's
  or task's thread.

`/cade import` suggests each, one at a time. Leave the section's heading as it
is: it's how Cade finds the section again (through a named range). Editing
or removing what Cade wrote is fine, but it isn't read back. Only what's new
is.

## Setup

1. `npx clasp login`, and turn on the Apps Script API at
   <https://script.google.com/home/usersettings>, as for the Sheet.
2. `npm run doc:create`. It creates a standalone script with `Code.gs`,
   generates `Secret.gs` (not committed), deploys it as a web app (running
   as you, reachable by anyone: the secret is what protects it), and gives
   the Worker its address (`docUrl` in `cade.config.json`, uploaded with
   `npm run config`) and the secret (`DOC_SECRET`). Its IDs are saved to
   `.doc-app.json` in the project root.
3. Open the script link it prints, choose `authorize`, click **Run**, and
   allow access to your Google Docs.
4. Add each group's `doc` to `cade.config.json`, then `npm run config`. You
   need to be able to edit each doc, since the script runs as you.

If `Code.gs` changes, `npm run doc:update` pushes it and redeploys the same
address.

## Troubleshooting

`/cade export` says it couldn't add the summary to the doc, and the Worker
logs `Could not add the executive summary to the doc` with the reason
(`npx wrangler tail`):

- `unauthorized`: `DOC_SECRET` doesn't match `SECRET` in `Secret.gs`.
- `No item with the given ID`, or access denied: the `doc` address is
  wrong, or you (who deployed the script) can't edit it.
- `Google Doc web app returned HTTP 404`: on some Google accounts the page
  holding the script's reply is missing. The Sheet can do without the
  reply; summaries can't. Check **Executions** in Apps Script: if `doPost`
  ran there, redeploy with `npm run doc:update` and try again.
- An "authorization required" error in **Executions**: step 3 is still to
  do. Run `authorize` again after `doc:update` if it asks for new access.
