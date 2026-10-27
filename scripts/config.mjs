#!/usr/bin/env node
// Uploads cade.config.json, the settings you edit, as Worker secrets, after
// checking it the way Cade reads it. Edit the file, then run `npm run config`;
// changes take effect without a deploy. See GETTING_STARTED.md.
//
//   channels  each group's Slack channels                    → CHANNEL_PAIRS
//   timezone  for times in the Google Sheet (optional)        → TIMEZONE
//   googleUrl the Google web app's address (optional), for     → GOOGLE_URL
//             each group's Sheet and Doc
//   suggestions the proactive agent: Cade reading messages in the → SUGGESTIONS
//             threads it manages and offering changes (optional,
//             on): true, false for commands only, or a list of the
//             kinds to keep, from SUGGESTION_KINDS (intents.js).
//             Messages posted on their own are asked about either way
//   ai        AI suggestions: the proactive agent reads people's → AI_MODEL
//             words with Workers AI (optional, off): true for the
//             default model, a model name such as
//             "@cf/google/gemma-4-26b-a4b-it", or false to read
//             them by their phrases (see ai.js). Needs suggestions on.
//   reactions the emoji that convert or move a message when    → REACTIONS
//             added to it (optional): { "convert": "ticket",
//             "move": "twisted_rightwards_arrows" }, by Slack name
//
// Each group in `channels` can link its Google Doc, for executive summaries,
// with `doc`, and its own Google Sheet, for its tasks, with `sheet`: their
// addresses. A group without `sheet` isn't recorded in a Sheet. `npm run
// group` adds or changes a group here (see group.mjs).
//
// The real secrets (the bot token, the signing secret and GOOGLE_SECRET,
// which the web app's address is useless without) are set once with
// `wrangler secret put` and kept out of files.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { channelPairs } from "../src/channels.js";
import { docId } from "../src/doc.js";
import { SUGGESTION_KINDS } from "../src/intents.js";
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
  const known = ["channels", "timezone", "googleUrl", "suggestions", "ai", "reactions"];
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
  if (config.googleUrl !== undefined) {
    if (!/^https:\/\/script\.google\.com\/\S+\/exec$/.test(config.googleUrl)) {
      throw new Error("googleUrl should be the web app URL from Apps Script: https://script.google.com/…/exec.");
    }
    secrets.GOOGLE_URL = config.googleUrl;
  }
  if (config.suggestions !== undefined) secrets.SUGGESTIONS = JSON.stringify(checkSuggestions(config.suggestions));
  if (config.reactions !== undefined) secrets.REACTIONS = JSON.stringify(checkReactions(config.reactions));
  if (config.ai !== undefined) secrets.AI_MODEL = checkAi(config.ai);
  return secrets;
}

// AI_MODEL for `ai`: "on" for the default model, the model's name, or "off"
// (so turning it off replaces the secret, which a missing key wouldn't).
export function checkAi(ai) {
  if (typeof ai === "boolean") return ai ? "on" : "off";
  if (typeof ai === "string" && /^@(cf|hf)\/\S+$/.test(ai)) return ai;
  throw new Error(`ai is true, false or a Workers AI text model's name, such as "@cf/google/gemma-4-26b-a4b-it".`);
}

// Returns `suggestions` if it's true, false or a list of known kinds; else
// throws.
export function checkSuggestions(suggestions) {
  if (typeof suggestions === "boolean") return suggestions;
  // "new-threads" was a kind until messages posted on their own were always
  // asked about; a config listing it still reads.
  if (Array.isArray(suggestions)) suggestions = suggestions.filter((kind) => kind !== "new-threads");
  const kinds = SUGGESTION_KINDS;
  const unknown = Array.isArray(suggestions) ? suggestions.find((kind) => !kinds.includes(kind)) : suggestions;
  if (unknown !== undefined) {
    throw new Error(`suggestions is true, false or a list of: ${kinds.join(", ")}. "${unknown}" isn't one of them.`);
  }
  return suggestions;
}

// Returns `reactions` if it names emoji for convert and move only, as Slack
// names them (without colons), and two different ones; else throws. Cade's
// own reactions, ✅ and 📤, would set Cade off itself, so they're refused.
export function checkReactions(reactions) {
  const keys = Object.keys(reactions ?? {});
  const unknown = keys.find((key) => !["convert", "move"].includes(key));
  if (unknown || typeof reactions !== "object") throw new Error(`reactions takes "convert" and "move", each an emoji's Slack name.`);
  const names = Object.values(reactions);
  const bad = names.find((name) => typeof name !== "string" || !/^[a-z0-9_+'-]+$/.test(name));
  if (bad !== undefined) throw new Error(`"${bad}" isn't an emoji's Slack name: write it without colons, as in "ticket".`);
  const taken = names.find((name) => ["white_check_mark", "outbox_tray"].includes(name));
  if (taken) throw new Error(`"${taken}" is one Cade adds itself, so it can't be a trigger.`);
  if (names.length === 2 && names[0] === names[1]) throw new Error("reactions needs a different emoji for convert and move.");
  return reactions;
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
  if (secrets.GOOGLE_URL) console.log(`googleUrl: ${secrets.GOOGLE_URL}`);
  if (secrets.SUGGESTIONS) console.log(`suggestions: ${secrets.SUGGESTIONS}`);
  if (secrets.REACTIONS) console.log(`reactions: ${secrets.REACTIONS}`);
  if (secrets.AI_MODEL) {
    const idle = secrets.AI_MODEL !== "off" && secrets.SUGGESTIONS === "false";
    console.log(`ai: ${secrets.AI_MODEL}${idle ? " (does nothing while suggestions is false)" : ""}`);
  }

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
