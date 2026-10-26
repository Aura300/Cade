#!/usr/bin/env node
// Adds a group to cade.config.json, or changes one, then uploads it (as npm
// run config does). See GETTING_STARTED.md.
//
//   npm run group -- --name acme --tasks C… [--external C…] [--incidents C…]
//                    [--doc new | <address>] [--sheet new | <address>]
//
// --doc and --sheet link the group's Google Doc (for executive summaries)
// and Google Sheet (for its tasks): one you have, by its address, or `new`
// for one made by the web app (npm run doc:create, sheet:create), owned by
// you, named "<name> executive summaries" and "<name> tasks". For a group
// already there, only what's given changes; `none` removes a setting.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readConfig, uploadConfig } from "./config.mjs";
import { APPS, parentIdIn } from "./sheet-app.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_FILE = `${ROOT}cade.config.json`;

const FIELDS = ["tasks", "external", "incidents", "doc", "sheet"];

// What each file is called when `new` makes it.
const NEW_TITLES = { doc: (name) => `${name} executive summaries`, sheet: (name) => `${name} tasks` };

// The command line as { name, tasks, … }, each as given.
export function readArgs(args) {
  const found = {};
  for (let i = 0; i < args.length; i++) {
    const match = /^--([a-z]+)$/.exec(args[i]);
    if (!match || !["name", ...FIELDS].includes(match[1])) throw new Error(`I don't know "${args[i]}". ${USAGE}`);
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${match[1]} needs a value. ${USAGE}`);
    found[match[1]] = value;
  }
  if (!found.name) throw new Error(`Give the group a --name. ${USAGE}`);
  return found;
}

const USAGE =
  "Use: npm run group -- --name acme --tasks C… [--external C…] [--incidents C…] [--doc new|<address>] [--sheet new|<address>]";

// cade.config.json with the group `name` added or changed: `fields` are its
// settings, a value of "none" removing one. A new group needs `tasks`.
export function withGroup(configJson, name, fields) {
  const config = JSON.parse(configJson);
  const channels = config.channels ?? [];
  const at = channels.findIndex((group) => group.name === name);
  const group = { ...(at === -1 ? { name } : channels[at]) };
  for (const [field, value] of Object.entries(fields)) {
    if (value === "none") delete group[field];
    else group[field] = value;
  }
  if (!group.tasks) throw new Error(`${name} needs a --tasks channel.`);
  // Settings in a steady order, as the file shows them.
  const ordered = Object.fromEntries(["name", ...FIELDS].filter((field) => group[field]).map((field) => [field, group[field]]));
  const next = at === -1 ? [...channels, ordered] : channels.map((other, i) => (i === at ? ordered : other));
  return `${JSON.stringify({ ...config, channels: next }, null, 2)}\n`;
}

// A file's address, from `value`: `new` makes one through the app's web app.
async function fileAddress(field, value, name, config) {
  const app = APPS[field];
  if (value === "none") return value;
  const id = value === "new" ? await createFile(app, config[app.configKey], NEW_TITLES[field](name)) : parentIdIn(value, app);
  return `https://docs.google.com/${app.path}/d/${id}/edit`;
}

// Asks the web app at `url` for a new file called `title`, and returns its
// ID. It answers as the Worker reads it: through the page it redirects to.
async function createFile(app, url, title) {
  if (!url) throw new Error(`The ${app.noun} web app isn't set up yet: run npm run ${app.command}:create first.`);
  let secret;
  try {
    [, secret] = /const SECRET = "([0-9a-f]+)"/.exec(await readFile(`${app.dir}/Secret.gs`, "utf8"));
  } catch {
    throw new Error(`${app.dir.slice(ROOT.length)}/Secret.gs is missing, so I can't call the ${app.noun} web app.`);
  }
  console.log(`Making the ${app.noun} "${title}"…`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, action: "create", title }),
    redirect: "manual",
  });
  const reply = response.status === 302 ? await fetch(response.headers.get("location")) : response;
  const result = await reply.json().catch(() => ({ ok: false, error: `HTTP ${reply.status}` }));
  if (!result.ok) {
    throw new Error(`The ${app.noun} web app couldn't make it: ${result.error}. Has its script been updated (npm run ${app.command}:update) and approved?`);
  }
  return result.id;
}

export async function group(args) {
  const { name, ...given } = readArgs(args);
  let json;
  try {
    json = await readFile(CONFIG_FILE, "utf8");
  } catch {
    json = '{\n  "channels": []\n}\n';
  }
  const config = JSON.parse(json);
  const fields = { ...given };
  for (const field of ["doc", "sheet"]) {
    if (given[field]) fields[field] = await fileAddress(field, given[field], name, config);
  }
  const next = withGroup(json, name, fields);
  // Checked before it's saved, so a mistake leaves the file as it was.
  readConfig(next);
  await writeFile(CONFIG_FILE, next);
  console.log(`${config.channels?.some((other) => other.name === name) ? "Changed" : "Added"} ${name} in cade.config.json. Uploading…`);
  await uploadConfig();

  const saved = JSON.parse(next).channels.find((other) => other.name === name);
  const channels = ["external", "tasks", "incidents"].filter((field) => saved[field]).map((field) => `${field} ${saved[field]}`);
  console.log(`
Done. In Slack, invite Cade to each channel (${channels.join(", ")}) with /invite @Cade, if it isn't there.`);
  if (saved.doc) console.log(`Doc: ${saved.doc}\n  Share it with the client as Editor.`);
  if (saved.sheet) console.log(`Sheet: ${saved.sheet}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  group(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
