#!/usr/bin/env node
// Creates the Google Doc a group's executive summaries are kept in, with
// its Apps Script web app (google-doc/Code.gs) attached, as sheet-app.mjs
// does for the Sheet, and links it to the group as its `doc` in
// cade.config.json; or updates the script. The web app can edit any doc you
// can, so other groups link docs of their own with `doc`. See
// GETTING_STARTED.md.
//
//   npm run doc:create [-- --group acme] [--title "acme executive summaries"]
//   npm run doc:update
import { fileURLToPath } from "node:url";
import { APPS, main } from "./sheet-app.mjs";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(APPS.doc, "doc-app.mjs");
