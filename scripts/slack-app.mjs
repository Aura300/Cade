#!/usr/bin/env node
// Creates the Slack app Luma runs as, or updates it, from slack/manifest.json,
// using Slack's app manifest API. See GETTING_STARTED.md.
//
//   npm run slack:create -- https://luma.example.workers.dev [--name Luma] [--command /luma]
//   npm run slack:update
//
// Both need an app configuration token for the workspace, from
// https://api.slack.com/apps ("Your App Configuration Tokens"). They ask for
// it, hidden, or read SLACK_CONFIG_TOKEN. It lasts 12 hours and is never stored.
//
// Creating stores the app's signing secret in the Worker with `wrangler secret
// put`, then asks for the bot token once the app is installed, which only a
// person can do. The app's ID and settings are saved to .slack-app.json, so
// later updates know which app to change.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { askHidden } from "./prompt.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = `${ROOT}slack/manifest.json`;
const APP_FILE = `${ROOT}.slack-app.json`;
const DEFAULTS = { name: "Luma", command: "/luma" };

// The manifest for an app called `name`, answering `command`, served by the
// Worker at `workerUrl`. Without `events`, it leaves out Event Subscriptions,
// whose URL Slack checks straight away: the Worker can only answer once it has
// the app's signing secret, which Slack only gives out once the app exists.
export function buildManifest(template, { workerUrl, name, command, events = true }) {
  const url = workerUrl.replace(/\/+$/, "");
  const filled = JSON.parse(
    JSON.stringify(template)
      .replaceAll("{{WORKER_URL}}", url)
      .replaceAll("{{APP_NAME}}", name)
      .replaceAll("{{COMMAND}}", command),
  );
  delete filled._comment;
  if (!events) delete filled.settings.event_subscriptions;
  return filled;
}

// Checks what slack:create is given, so mistakes are caught before Slack is.
export function checkSettings({ workerUrl, name, command }) {
  const problems = [];
  if (!/^https:\/\/[^/\s]+/.test(workerUrl ?? "")) problems.push("The Worker URL must start with https://.");
  if (!name || name.length > 35) problems.push("The app name must be 1 to 35 characters.");
  if (!/^\/[a-z0-9_-]{1,31}$/.test(command ?? "")) {
    problems.push("The command must be / and up to 31 lowercase letters, digits, - or _, such as /luma.");
  }
  return problems;
}

async function slack(method, token, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) {
    const details = (result.errors ?? []).map((error) => `\n  ${error.pointer ?? ""} ${error.message}`).join("");
    throw new Error(`Slack ${method} failed: ${result.error}${details}`);
  }
  return result;
}

// Stores a Worker secret with wrangler, which must be logged in.
function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "secret", "put", name], {
      cwd: ROOT,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler secret put ${name} failed`))));
    child.stdin.end(value);
  });
}

// The app configuration token: from SLACK_CONFIG_TOKEN, or asked for, hidden,
// so it never has to be typed into a command.
async function configToken() {
  if (process.env.SLACK_CONFIG_TOKEN) return process.env.SLACK_CONFIG_TOKEN;
  const where = "an app configuration token from https://api.slack.com/apps (Your App Configuration Tokens)";
  if (!process.stdin.isTTY) throw new Error(`Run this in a terminal to be asked for ${where}, or set SLACK_CONFIG_TOKEN.`);
  console.log(`This needs ${where}.`);
  const token = await askHidden("App configuration token (xoxe.xoxp-…, hidden): ");
  if (!token) throw new Error("No token given.");
  return token;
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

export async function create(args) {
  const settings = {
    workerUrl: args.find((arg) => arg.startsWith("https://")) ?? args[0],
    name: option(args, "name") ?? DEFAULTS.name,
    command: option(args, "command") ?? DEFAULTS.command,
  };
  const problems = checkSettings(settings);
  if (problems.length) throw new Error(problems.join("\n"));
  const token = await configToken();
  const template = JSON.parse(await readFile(MANIFEST, "utf8"));

  console.log(`Creating the Slack app "${settings.name}" for ${settings.workerUrl}…`);
  const created = await slack("apps.manifest.create", token, {
    manifest: JSON.stringify(buildManifest(template, { ...settings, events: false })),
  });
  const app = { appId: created.app_id, ...settings };
  await writeFile(APP_FILE, `${JSON.stringify(app, null, 2)}\n`);
  console.log(`Created app ${app.appId}; saved its settings to .slack-app.json.`);

  console.log("Storing its signing secret in the Worker…");
  await putSecret("SLACK_SIGNING_SECRET", created.credentials.signing_secret);

  console.log("Turning on Event Subscriptions…");
  await slack("apps.manifest.update", token, {
    app_id: app.appId,
    manifest: JSON.stringify(buildManifest(template, settings)),
  });

  const install = `https://api.slack.com/apps/${app.appId}/install-on-team`;
  console.log(`\nNow install the app (a person has to approve this):\n  ${install}`);
  console.log("Then copy the Bot User OAuth Token (xoxb-…) from OAuth & Permissions.");
  if (!process.stdin.isTTY || args.includes("--no-prompt")) {
    console.log("Store it with: npx wrangler secret put SLACK_BOT_TOKEN");
    return;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const botToken = (await prompt.question("Paste the bot token here (or press Enter to do it later): ")).trim();
  prompt.close();
  if (!botToken) {
    console.log("Store it later with: npx wrangler secret put SLACK_BOT_TOKEN");
    return;
  }
  if (!botToken.startsWith("xoxb-")) throw new Error("That isn't a bot token; it should start with xoxb-.");
  await putSecret("SLACK_BOT_TOKEN", botToken);
  console.log("Stored. Next: invite the app to your channels (see GETTING_STARTED.md).");
}

export async function update() {
  let app;
  try {
    app = JSON.parse(await readFile(APP_FILE, "utf8"));
  } catch {
    throw new Error("No .slack-app.json here: create the app with npm run slack:create first.");
  }
  const token = await configToken();
  const template = JSON.parse(await readFile(MANIFEST, "utf8"));
  await slack("apps.manifest.update", token, {
    app_id: app.appId,
    manifest: JSON.stringify(buildManifest(template, app)),
  });
  console.log(`Updated app ${app.appId}. If Slack asks, reinstall it from https://api.slack.com/apps/${app.appId}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [action, ...args] = process.argv.slice(2);
  const run = { create, update }[action];
  if (!run) {
    console.error("Use: node scripts/slack-app.mjs create <worker-url> [--name Luma] [--command /luma] | update");
    process.exit(1);
  }
  run(args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
