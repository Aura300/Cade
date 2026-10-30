#!/usr/bin/env node
// Adds a group to cade.config.json, or changes one, then uploads it (as npm
// run config does). See GETTING_STARTED.md.
//
//   npm run group                      asks for each setting, and can make
//                                      the group's Slack channels too
//   npm run group -- --name acme --tasks C…
//                    [--doc new | <address>] [--sheet new | <address>]
//
// --doc and --sheet link the group's Google Doc (for executive summaries)
// and Google Sheet (for its tasks): one you have, by its address, or `new`
// for one made by the Google web app (npm run google:create), owned by you,
// named "<name> executive summaries" and "<name> tasks". For a group already
// there, only what's given changes; `none` removes a setting.
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { callSlack } from "../src/slack.js";
import { checkZone, readConfig, uploadConfig } from "./config.mjs";
import { askHidden } from "./prompt.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_FILE = `${ROOT}cade.config.json`;
const SECRET_FILE = `${ROOT}google/Secret.gs`;

// Each kind of file: where its address names its ID, and what it's called.
const KINDS = {
  doc: { path: "document", noun: "Google Doc" },
  sheet: { path: "spreadsheets", noun: "Google Sheet" },
};

const FIELDS = ["tasks", "doc", "sheet"];

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
  "Use: npm run group -- --name acme --tasks C… [--doc new|<address>] [--sheet new|<address>]";

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
  // Groups have only their tasks channel now, so an old client or
  // incidents channel goes.
  delete group.external;
  delete group.incidents;
  // Settings in a steady order, as the file shows them, then those set by
  // hand, such as `suggestions` and `ai`.
  const ordered = Object.fromEntries(["name", ...FIELDS].filter((field) => group[field]).map((field) => [field, group[field]]));
  for (const [field, value] of Object.entries(group)) if (!(field in ordered) && !FIELDS.includes(field)) ordered[field] = value;
  const next = at === -1 ? [...channels, ordered] : channels.map((other, i) => (i === at ? ordered : other));
  return `${JSON.stringify({ ...config, channels: next }, null, 2)}\n`;
}

// The ID of a doc or spreadsheet (`kind`) in its address, or `value` itself
// if it is an ID already. Throws if it is neither.
export function fileIdIn(value, kind) {
  const { path, noun } = KINDS[kind];
  const match = new RegExp(`/${path}/d/([\\w-]{20,})`).exec(value) ?? /^([\w-]{20,})$/.exec(value);
  if (!match) throw new Error(`--${kind} should be new, none, or the ${noun}'s address: https://docs.google.com/${path}/d/…/edit.`);
  return match[1];
}

// A file's address, from `value`: `new` makes one through the web app.
async function fileAddress(kind, value, name, config) {
  if (value === "none") return value;
  const id = value === "new" ? await createFile(kind, config.googleUrl, NEW_TITLES[kind](name)) : fileIdIn(value, kind);
  return `https://docs.google.com/${KINDS[kind].path}/d/${id}/edit`;
}

// Asks the Google web app at `url` for a new doc or spreadsheet called
// `title`, and returns its ID. It answers as the Worker reads it: through
// the page it redirects to.
async function createFile(kind, url, title) {
  if (!url) throw new Error("The Google web app isn't set up yet: run npm run google:create first.");
  let secret;
  try {
    [, secret] = /const SECRET = "([0-9a-f]+)"/.exec(await readFile(SECRET_FILE, "utf8"));
  } catch {
    throw new Error("google/Secret.gs is missing, so I can't call the Google web app.");
  }
  console.log(`Making the ${KINDS[kind].noun} "${title}"…`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, action: `${kind}.create`, title }),
    redirect: "manual",
  });
  const reply = response.status === 302 ? await fetch(response.headers.get("location")) : response;
  const result = await reply.json().catch(() => ({ ok: false, error: `HTTP ${reply.status}` }));
  if (!result.ok) throw new Error(`The Google web app couldn't make it: ${result.error}. Has its script been approved (authorize)?`);
  return result.id;
}

// The config file as it is, or an empty one.
async function currentConfig() {
  try {
    return await readFile(CONFIG_FILE, "utf8");
  } catch {
    return '{\n  "channels": []\n}\n';
  }
}

// Saves the group with `fields` in cade.config.json, and `settings` (such
// as the time zone) with it, checked first so a mistake leaves the file as
// it was, and uploads it. Returns the group as saved.
async function saveGroup(json, name, fields, settings = {}) {
  const next = withGroup(JSON.stringify({ ...JSON.parse(json), ...settings }), name, fields);
  readConfig(next);
  await writeFile(CONFIG_FILE, next);
  const known = JSON.parse(json).channels?.some((other) => other.name === name);
  console.log(`${known ? "Changed" : "Added"} ${name} in cade.config.json. Uploading…`);
  await uploadConfig();
  return JSON.parse(next).channels.find((other) => other.name === name);
}

export async function group(args) {
  const { name, ...given } = readArgs(args);
  const json = await currentConfig();
  const config = JSON.parse(json);
  const fields = { ...given };
  for (const field of ["doc", "sheet"]) {
    if (given[field]) fields[field] = await fileAddress(field, given[field], name, config);
  }
  const saved = await saveGroup(json, name, fields);
  console.log(`
Done. In Slack, invite Cade to the tasks channel (${saved.tasks}) with /invite @Cade, if it isn't there.`);
  if (saved.doc) console.log(`Doc: ${saved.doc}\n  Share it with the client as Editor.`);
  if (saved.sheet) console.log(`Sheet: ${saved.sheet}`);
}

// The group's channels, as the guided setup asks for them.
const ROLES = [
  { field: "tasks", what: "Dev channel, where the team tracks its tasks and incidents", suffix: "dev", required: true },
];

// A channel name as Slack keeps it: no #, lower case.
export function channelName(input) {
  return input.trim().replace(/^#/, "").toLowerCase();
}

// Whether Slack takes `name` for a new channel.
export function validChannelName(name) {
  return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(name);
}

// The channel `input` names, by ID or name, among those Cade can see, as
// { id, name, isPrivate, isMember }, or null. Cade sees every public channel,
// and only the private ones it's in. `slack(method, args)` calls Slack.
export async function findChannel(slack, input) {
  const channel = (found) => ({ id: found.id, name: found.name, isPrivate: Boolean(found.is_private), isMember: Boolean(found.is_member) });
  const id = input.trim();
  if (/^[CG][A-Z0-9]{8,}$/.test(id)) {
    try {
      return channel((await slack("conversations.info", { channel: id })).channel);
    } catch {
      return null;
    }
  }
  const name = channelName(input);
  let cursor;
  do {
    const page = await slack("conversations.list", { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", cursor });
    const found = page.channels.find((other) => other.name === name);
    if (found) return channel(found);
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return null;
}

// People named by email or Slack member ID, as member IDs.
export async function memberIds(slack, input) {
  const ids = [];
  for (const who of input.split(/[\s,]+/).filter(Boolean)) {
    if (/^[UW][A-Z0-9]{8,}$/.test(who)) ids.push(who);
    else if (who.includes("@")) {
      try {
        ids.push((await slack("users.lookupByEmail", { email: who })).user.id);
      } catch {
        throw new Error(`No one in this Slack workspace has the email ${who}.`);
      }
    } else throw new Error(`"${who}" isn't an email or a Slack member ID (U…, from their profile → ⋮ → Copy member ID).`);
  }
  return ids;
}

// What to do for one of the group's channels, asked: an existing channel,
// by its ID, which Cade joins if it's public, or waits to be invited to if
// it's private (it can't see a private one before); or a new one, by name,
// which Cade makes, and is then in. `current` is the channel the group has,
// kept with Enter. Returns null for none.
export async function channelPlan(slack, ask, role, group, options, current) {
  while (true) {
    const choice = (await ask(`  Existing or new? (${options.join(", ")}): `)).toLowerCase();
    if (!choice && current) return { field: role.field, action: "keep", id: current };
    if (choice === "-" && !role.required) return current ? { field: role.field, action: "remove" } : null;
    if (choice === "e" || choice === "existing") {
      const id = await ask("  Its channel ID (in Slack: the channel's name → About → Channel ID, C…): ");
      if (!/^[CG][A-Z0-9]{8,}$/.test(id)) {
        console.log("  That isn't a channel ID; they start with C and are about 11 characters.");
        continue;
      }
      let found = await findChannel(slack, id);
      while (!found) {
        const next = await ask(`  I can't see ${id}. If it's private, send /invite @Cade in it, then press Enter to look again; or type back: `);
        if (/^back$/i.test(next)) break;
        found = await findChannel(slack, id);
      }
      if (found) return { field: role.field, action: found.isMember ? "use" : "join", ...found };
      continue;
    }
    if (choice === "n" || choice === "new") {
      const suggested = `${group}-${role.suffix}`.toLowerCase();
      const wanted = channelName(await ask(`  Its name [${suggested}]: `, suggested));
      if (!validChannelName(wanted)) {
        console.log("  Channel names are lower case letters, numbers, - and _, up to 80.");
        continue;
      }
      if (await findChannel(slack, wanted)) {
        console.log(`  #${wanted} exists already; choose e and give its ID to use it, or another name.`);
        continue;
      }
      const isPrivate = /^y/i.test(await ask(`  Make #${wanted} private? (y/N): `));
      return { field: role.field, action: "create", name: wanted, isPrivate };
    }
  }
}

// The Slack app's OAuth & Permissions page, where its bot token is: straight
// to it with the app's ID from .cade/slack-app.json (see slack-app.mjs), or the
// list of apps without it.
async function tokenPage() {
  try {
    const { appId } = JSON.parse(await readFile(`${ROOT}.cade/slack-app.json`, "utf8"));
    if (appId) return `https://api.slack.com/apps/${appId}/oauth`;
  } catch {}
  return "https://api.slack.com/apps (open Cade → OAuth & Permissions)";
}

// `npm run group` with no options: asks for each setting in turn, says what
// it will do, and does it once confirmed. For each channel it makes a new
// one or links an existing one (see channelPlan), adds people to all of
// them (those already in are skipped), makes or links the group's Google
// Doc and Sheet, and saves and uploads the group.
async function guided() {
  if (!process.stdin.isTTY) throw new Error(`Run it in a terminal to be asked for each setting, or give them: ${USAGE}`);
  console.log("Setting up a group: its Slack channels, then its Google Doc and Sheet. Nothing changes until you confirm.\n");
  let token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.log(`Cade's bot token is under Bot User OAuth Token at ${await tokenPage()}\n`);
    token = await askHidden("Cade's Slack bot token (xoxb-…): ");
  }
  if (!token.startsWith("xoxb-")) throw new Error("That isn't a bot token; it starts with xoxb-.");
  const slack = (method, args = {}) => callSlack({ SLACK_BOT_TOKEN: token }, method, args);
  const { team, url } = await slack("auth.test");
  console.log(`Cade in ${team}.\n`);

  const json = await currentConfig();
  const config = JSON.parse(json);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question, fallback = "") => (await prompt.question(question)).trim() || fallback;
  try {
    let name;
    while (!name) {
      name = await ask("Group name (such as the client's, letters, numbers, - and _): ");
      if (!/^[\w-]+$/.test(name)) {
        console.log("  Use letters, numbers, - and _.");
        name = "";
      }
    }
    const current = config.channels?.find((other) => other.name === name) ?? {};
    if (current.name) console.log(`  ${name} is set up already; what you give changes it, and Enter keeps what it has.`);

    // The first group, at setup, also sets the time zone.
    const settings = {};
    if (!config.timezone) {
      const local = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      while (!settings.timezone) {
        const zone = await ask(`\nYour team's time zone, for times in the Sheet (an IANA name such as Asia/Colombo) [${local}]: `, local);
        try {
          settings.timezone = checkZone(zone);
        } catch (error) {
          console.log(`  ${error.message}`);
        }
      }
    }

    // Each channel: { field, action: "create" | "join" | "use" | "keep" |
    // "remove", id?, name?, isPrivate? }.
    const plans = [];
    for (const role of ROLES) {
      console.log(`\n${role.what}.`);
      const options = ["e for an existing one", "n to make a new one"];
      if (current[role.field]) options.push(`Enter to keep ${current[role.field]}`);
      if (!role.required) options.push(current[role.field] ? "- to remove it" : "- for none");
      const plan = await channelPlan(slack, ask, role, name, options, current[role.field]);
      if (plan) plans.push(plan);
    }
    const channels = plans.filter((plan) => plan.id || plan.action === "create");
    const people = channels.length
      ? await ask("\nPeople to add to these channels: emails or Slack member IDs, separated by commas [none]: ")
      : "";
    const ids = people ? await memberIds(slack, people) : [];

    const files = {};
    if (config.googleUrl) {
      for (const [field, what] of [["doc", "Google Doc for executive summaries"], ["sheet", "Google Sheet for its tasks"]]) {
        const keep = current[field] ? "Enter to keep it, - to unlink" : "Enter for none";
        const answer = await ask(`\n${what}: new, or an existing one's address [${keep}]: `);
        if (answer === "-") files[field] = "none";
        else if (answer) files[field] = answer === "new" ? "new" : `https://docs.google.com/${KINDS[field].path}/d/${fileIdIn(answer, field)}/edit`;
      }
    } else {
      console.log("\nThe Google web app isn't set up (npm run google:create), so I'll skip the group's Doc and Sheet.");
    }

    console.log(`\nFor ${name}, I'll:`);
    for (const plan of plans) {
      const role = ROLES.find(({ field }) => field === plan.field).what.split(",")[0];
      const line = {
        create: `make ${plan.isPrivate ? "private" : "public"} #${plan.name}`,
        join: `join #${plan.name} (public, so I can join it myself)`,
        use: `use #${plan.name}, which I'm in`,
        keep: `keep ${plan.id}`,
        remove: "unlink it",
      }[plan.action];
      console.log(`  ${role}: ${line}`);
    }
    if (ids.length) console.log(`  add ${ids.length === 1 ? "1 person" : `${ids.length} people`} to the channels`);
    for (const [field, value] of Object.entries(files)) {
      const what = field === "doc" ? "Google Doc" : "Google Sheet";
      console.log(`  ${what}: ${value === "new" ? `make "${NEW_TITLES[field](name)}"` : value === "none" ? "unlink it" : `link ${value}`}`);
    }
    if (settings.timezone) console.log(`  set the time zone to ${settings.timezone}`);
    console.log("  save the group in cade.config.json and upload it");
    if (/^n/i.test(await ask("Go ahead? (Y/n): "))) {
      console.log("Nothing changed.");
      return;
    }

    const fields = {};
    for (const plan of plans) {
      if (plan.action === "remove") fields[plan.field] = "none";
      else if (plan.action === "create") {
        try {
          plan.id = (await slack("conversations.create", { name: plan.name, is_private: String(plan.isPrivate) })).channel.id;
        } catch (error) {
          if (/name_taken/.test(error.message)) {
            throw new Error(`There's already a #${plan.name} I can't see: it's private. Send /invite @Cade in it, then run this again.`);
          }
          throw error;
        }
        console.log(`Made #${plan.name}.`);
      } else if (plan.action === "join") {
        await slack("conversations.join", { channel: plan.id });
        console.log(`Joined #${plan.name}.`);
      }
      if (plan.id) fields[plan.field] = plan.id;
    }
    for (const plan of channels) {
      if (!ids.length) break;
      try {
        await slack("conversations.invite", { channel: plan.id, users: ids.join(","), force: "true" });
      } catch (error) {
        if (!/already_in_channel|cant_invite_self/.test(error.message)) throw error;
      }
    }
    if (ids.length) console.log("Added the people to the channels.");
    for (const [field, value] of Object.entries(files)) fields[field] = await fileAddress(field, value, name, config);

    const saved = await saveGroup(json, name, fields, settings);
    console.log(`\nDone. ${name}'s channels:`);
    for (const role of ROLES) {
      if (saved[role.field]) console.log(`  ${role.what.split(",")[0]}: ${url}archives/${saved[role.field]}`);
    }
    if (saved.doc) console.log(`Doc: ${saved.doc}\n  Share it with the client as Editor.`);
    if (saved.sheet) console.log(`Sheet: ${saved.sheet}`);
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  (args.length ? group(args) : guided()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
