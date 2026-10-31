#!/usr/bin/env node
// Uploads cade.config.json, the settings you edit, as Worker secrets, after
// checking it the way Cade reads it. Edit the file, then run `npm run config`;
// changes take effect without a deploy. See GETTING_STARTED.md.
//
//   projects  each project: its Slack channel, Doc, Sheet and  → PROJECTS
//             settings (below)
//   timezone  for times in the Google Sheet (optional)        → TIMEZONE
//   googleUrl the Google web app's address (optional), for     → GOOGLE_URL
//             every project's Sheet and Doc
//
// Everything else is set on each project, not at the top of the file:
//   name, channel (an ID) required
//   doc, sheet    the project's Google Doc, for executive summaries, and
//                 Google Sheet, for its tasks (addresses; without `sheet`
//                 its tasks aren't recorded in a Sheet)
//   taskStatusChangeDetection
//                 the proactive agent: Cade reading messages in the threads
//                 it manages and offering changes (optional, on): true, or
//                 false for commands only
//   aiSuggestions AI suggestions (optional, off): true to read people's
//                 words with Workers AI, false to read them by their
//                 phrases (see ai.js). Needs taskStatusChangeDetection on
//   aiModel       the Workers AI text model for `aiSuggestions` (optional): a name such
//                 as "@cf/google/gemma-4-26b-a4b-it"; the default model
//                 without it
//   newMessageTaskDetection
//                 whether Cade asks about a message posted on its own in the
//                 channel: track it as a task, report it as an incident or
//                 move it to a task (optional, on); false to leave such
//                 messages alone
//   activeTasksPinning
//                 whether open tasks are pinned in the channel (optional, off)
//   summaryCanvas whether the channel has a summary canvas of its tasks
//                 (optional, off)
//   exportOnDone  whether a task's thread is written to the project's Doc,
//                 under its Export tab, when the task is done (optional,
//                 on); false to export only from the card's menu or
//                 `/cade export`. Needs `doc`
// `npm run group` adds or changes a project here (see group.mjs). Older files
// with `channels`, each with its channel as `tasks`, and `suggestions` for
// taskStatusChangeDetection, are still read.
//
// The real secrets (the bot token, the signing secret and GOOGLE_SECRET,
// which the web app's address is useless without) are set once with
// `wrangler secret put` and kept out of files.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projects } from "../src/channels.js";
import { docId } from "../src/doc.js";
import { sheetId } from "../src/sheet.js";
import "./cloudflare.mjs";

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
  const known = ["projects", "timezone", "googleUrl"];
  // `channels` is the old name for `projects`.
  const unknown = Object.keys(config).find((key) => !known.includes(key) && key !== "channels");
  if (PROJECT_SETTINGS.includes(unknown)) {
    throw new Error(`cade.config.json has "${unknown}" at the top; set it on each project instead: { "name": "acme", "channel": "C…", "${unknown}": … }.`);
  }
  if (unknown) throw new Error(`cade.config.json has "${unknown}"; it takes ${known.join(" and ")}.`);

  const list = projects({ PROJECTS: config.projects ?? config.channels });
  const ids = list.map((project) => project.channel);
  const notId = ids.find((id) => !/^[CG][A-Z0-9]{8,}$/.test(id));
  if (notId) throw new Error(`"${notId}" doesn't look like a Slack channel ID (C… from the channel's About tab).`);
  const reused = ids.find((id, i) => ids.indexOf(id) !== i);
  if (reused) throw new Error(`${reused} is used twice; each channel belongs to one project.`);
  const badDoc = list.find((project) => project.doc !== undefined && !docId(project.doc));
  if (badDoc) throw new Error(`${badDoc.name}'s doc should be a Google Doc's address: https://docs.google.com/document/d/…/edit.`);
  const badSheet = list.find((project) => project.sheet !== undefined && !sheetId(project.sheet));
  if (badSheet) throw new Error(`${badSheet.name}'s sheet should be a Google Sheet's address: https://docs.google.com/spreadsheets/d/…/edit.`);

  for (const project of list) {
    try {
      // `suggestions` is the old name of taskStatusChangeDetection.
      if (project.suggestions !== undefined) {
        project.taskStatusChangeDetection ??= project.suggestions;
        delete project.suggestions;
      }
      // `aiSuggestions` was `ai`, which used to be a model's name too: that's
      // `aiModel` now.
      if (project.ai !== undefined) {
        project.aiSuggestions ??= project.ai;
        delete project.ai;
      }
      if (typeof project.aiSuggestions === "string") Object.assign(project, { aiSuggestions: true, aiModel: project.aiSuggestions });
      if (project.aiSuggestions !== undefined) project.aiSuggestions = checkAiSuggestions(project.aiSuggestions);
      if (project.aiModel !== undefined) project.aiModel = checkAiModel(project.aiModel);
      for (const key of SWITCHES) if (project[key] !== undefined) checkSwitch(key, project[key]);
    } catch (error) {
      throw new Error(`${project.name}'s ${error.message}`);
    }
  }

  const secrets = { PROJECTS: JSON.stringify(list) };
  if (config.timezone !== undefined) secrets.TIMEZONE = checkZone(config.timezone);
  if (config.googleUrl !== undefined) {
    if (!/^https:\/\/script\.google\.com\/\S+\/exec$/.test(config.googleUrl)) {
      throw new Error("googleUrl should be the web app URL from Apps Script: https://script.google.com/…/exec.");
    }
    secrets.GOOGLE_URL = config.googleUrl;
  }
  return secrets;
}

// Features with `true` or `false`, set on each project: activeTasksPinning and summaryCanvas
// are off unless turned on; taskStatusChangeDetection and
// newMessageTaskDetection and exportOnDone are on unless turned off.
const SWITCHES = ["taskStatusChangeDetection", "activeTasksPinning", "summaryCanvas", "newMessageTaskDetection", "exportOnDone"];

// What a project can set, which used to be allowed at the top of the file.
const PROJECT_SETTINGS = ["aiSuggestions", "aiModel", ...SWITCHES];

function checkSwitch(key, value) {
  if (typeof value !== "boolean") throw new Error(`${key} is true or false.`);
  return value;
}

// `aiSuggestions` if it's true or false, else throws.
export function checkAiSuggestions(aiSuggestions) {
  if (typeof aiSuggestions === "boolean") return aiSuggestions;
  throw new Error("aiSuggestions is true or false; name a model with aiModel.");
}

// `aiModel` if it's a Workers AI text model's name, else throws.
export function checkAiModel(model) {
  if (typeof model === "string" && /^@(cf|hf)\/\S+$/.test(model)) return model;
  throw new Error(`aiModel is a Workers AI text model's name, such as "@cf/google/gemma-4-26b-a4b-it".`);
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
    throw new Error("No cade.config.json: copy cade.config.sample.json to cade.config.json and fill it in.");
  }
  const secrets = readConfig(json);
  for (const project of JSON.parse(secrets.PROJECTS)) {
    const own = ["taskStatusChangeDetection", "aiSuggestions", "aiModel", "newMessageTaskDetection", "activeTasksPinning", "summaryCanvas", "exportOnDone"].filter((key) => project[key] !== undefined).map((key) => `, ${key} ${JSON.stringify(project[key])}`).join("");
    const doc = project.doc ? `, doc ${project.doc}` : "";
    const sheet = project.sheet ? `, sheet ${project.sheet}` : "";
    console.log(`${project.name}: channel ${project.channel}${doc}${sheet}${own}`);
  }
  if (secrets.TIMEZONE) console.log(`timezone: ${secrets.TIMEZONE}`);
  if (secrets.GOOGLE_URL) console.log(`googleUrl: ${secrets.GOOGLE_URL}`);

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
