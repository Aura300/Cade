#!/usr/bin/env node
// Creates the Google Doc web app executive summaries are kept with
// (google-doc/Code.gs), a standalone script serving every group's doc, or
// updates it, as sheet-app.mjs does for the Sheet. Each group links its doc
// as `doc` in cade.config.json. See GETTING_STARTED.md.
//
//   npm run doc:create [-- --group acme --doc <address>] [--title "Cade Doc"]
//   npm run doc:update
import { fileURLToPath } from "node:url";
import { APPS, main } from "./sheet-app.mjs";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(APPS.doc, "doc-app.mjs");
