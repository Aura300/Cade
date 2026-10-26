#!/usr/bin/env node
// Uploads cade.config.json, the settings you edit, as Worker secrets, after
// checking it the way Cade reads it. Edit the file, then run `npm run config`;
// changes take effect without a deploy. See GETTING_STARTED.md.
//
//   channels  each group's Slack channels                    → CHANNEL_PAIRS
//   timezone  for times in the Google Sheet (optional)        → TIMEZONE
//   sheetUrl  the Google Sheet's web app address (optional)   → SHEET_URL
//   docUrl    the Google Doc web app's address (optional)     → DOC_URL
//
// Each group in `channels` can link its Google Doc, for executive summaries,
// with `doc`, and its own Google Sheet, for its tasks, with `sheet`: their
// addresses. A group without `sheet` isn't recorded in a Sheet. `npm run
// group` adds or changes a group here (see group.mjs).
//
// The real secrets (the bot token, the signing secret, and SHEET_SECRET and
// DOC_SECRET, which the web apps' addresses are useless without) are set once
// with `wrangler secret put` and kept out of files.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { channelPairs } from "../src/channels.js";
import { docId } from "../src/doc.js";
import { sheetId } from "../src/sheet.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = `${ROOT}cade.config.json`;

// Returns the Worker secrets `json` sets, or throws saying what's wrong.
export function readConfig(json) {
  let config;
  try {
    config = JSON.parse(json);
  } catch {
    throw new Error("cade.config.json is not valid JSON.");
  }
  const known = ["channels", "timezone", "sheetUrl", "docUrl"];
  const unknown = Object.keys(config).find((key) => !known.includes(key));
  if (unknown) throw new Error(`cade.config.json has "${unknown}"; it takes ${known.join(" and ")}.`);

  const pairs = channelPairs({ CHANNEL_PAIRS: config.channels });
  const ids = pairs.flatMap((pair) => [pair.external, pair.tasks, pair.incidents].filter(Boolean));
  const notId = ids.find((id) => !/^[CG][A-Z0-9]{8,}$/.test(id));
  if (notId) throw new Error(`"${notId}" doesn't look like a Slack channel ID (C… from the channel's About tab).`);
  const reused = ids.find((id, i) => ids.indexOf(id) !== i);
  if (reused) throw new Error(`${reused} is used twice; each channel belongs to one group, in one role.`);
  const badDoc = pairs.find((pair) => pair.doc !== undefined && !docId(pair.doc));
  if (badDoc) throw new Error(`${badDoc.name}'s doc should be a Google Doc's address: https://docs.google.com/document/d/…/edit.`);
  const badSheet = pairs.find((pair) => pair.sheet !== undefined && !sheetId(pair.sheet));
  if (badSheet) throw new Error(`${badSheet.name}'s sheet should be a Google Sheet's address: https://docs.google.com/spreadsheets/d/…/edit.`);

  const secrets = { CHANNEL_PAIRS: JSON.stringify(pairs) };
  if (config.timezone !== undefined) secrets.TIMEZONE = checkZone(config.timezone);
  if (config.sheetUrl !== undefined) {
    if (!/^https:\/\/script\.google\.com\/\S+\/exec$/.test(config.sheetUrl)) {
      throw new Error("sheetUrl should be the web app URL from Apps Script: https://script.google.com/…/exec.");
    }
    secrets.SHEET_URL = config.sheetUrl;
  }
  if (config.docUrl !== undefined) {
    if (!/^https:\/\/script\.google\.com\/\S+\/exec$/.test(config.docUrl)) {
      throw new Error("docUrl should be the web app URL from Apps Script: https://script.google.com/…/exec.");
    }
    secrets.DOC_URL = config.docUrl;
  }
  return secrets;
}

// Returns `zone` if it's a time zone Intl knows (an IANA name), else throws.
export function checkZone(zone) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    throw new Error(`"${zone}" isn't a time zone; use an IANA name such as Asia/Colombo or Europe/London.`);
  }
}

// Checks cade.config.json and uploads it as Worker secrets. Throws, having
// uploaded nothing, if the file is missing or wrong.
export async function uploadConfig() {
  let json;
  try {
    json = await readFile(FILE, "utf8");
  } catch {
    throw new Error("No cade.config.json: copy cade.config.example.json to cade.config.json and fill it in.");
  }
  const secrets = readConfig(json);
  for (const pair of JSON.parse(secrets.CHANNEL_PAIRS)) {
    const incidents = pair.incidents ? `, incidents ${pair.incidents}` : "";
    const external = pair.external ? `external ${pair.external} → ` : "";
    const doc = pair.doc ? `, doc ${pair.doc}` : "";
    const sheet = pair.sheet ? `, sheet ${pair.sheet}` : "";
    console.log(`${pair.name}: ${external}tasks ${pair.tasks}${incidents}${doc}${sheet}`);
  }
  if (secrets.TIMEZONE) console.log(`timezone: ${secrets.TIMEZONE}`);
  if (secrets.SHEET_URL) console.log(`sheetUrl: ${secrets.SHEET_URL}`);
  if (secrets.DOC_URL) console.log(`docUrl: ${secrets.DOC_URL}`);

  // `wrangler secret bulk` reads them from a file; it's removed straight after.
  const dir = await mkdtemp(join(tmpdir(), "cade-config-"));
  try {
    const file = join(dir, "secrets.json");
    await writeFile(file, JSON.stringify(secrets));
    const code = await new Promise((resolve) => {
      spawn("npx", ["wrangler", "secret", "bulk", file], { cwd: ROOT, stdio: "inherit" }).on("exit", resolve);
    });
    if (code !== 0) throw new Error("wrangler secret bulk failed.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  uploadConfig().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
