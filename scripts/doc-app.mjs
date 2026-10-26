#!/usr/bin/env node
// Creates the Google Doc web app executive summaries are kept with
// (google-doc/Code.gs), or updates its script, as sheet-app.mjs does for the
// Sheet. It is a standalone script that edits each group's doc, linked with
// `doc` in cade.config.json. See GETTING_STARTED.md.
//
//   npm run doc:create [-- --title "Cade executive summaries"]
//   npm run doc:update
import { fileURLToPath } from "node:url";
import { APPS, main } from "./sheet-app.mjs";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(APPS.doc, "doc-app.mjs");
