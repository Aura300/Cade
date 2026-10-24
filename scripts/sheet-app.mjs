#!/usr/bin/env node
// Creates the Google Sheet Luma records tasks in, with its Apps Script web
// app, or updates the script, using clasp (Google's Apps Script command line).
// See GETTING_STARTED.md.
//
//   npm run sheet:create [-- --title "Luma tasks"]
//   npm run sheet:update
//
// Both need `npx clasp login`, and the Apps Script API turned on for your
// Google account (https://script.google.com/home/usersettings).
//
// Creating makes a new spreadsheet with google-sheet/Code.gs attached,
// generates the shared secret into google-sheet/Secret.gs (not committed),
// deploys the web app, then gives the Worker its address (sheetUrl in
// luma.config.json, uploaded with npm run config) and the secret
// (SHEET_SECRET). The script's IDs are saved to .sheet-app.json, so updates
// redeploy to the same address.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHEET_DIR = `${ROOT}google-sheet`;
const SECRET_FILE = `${SHEET_DIR}/Secret.gs`;
const MANIFEST_FILE = `${SHEET_DIR}/appsscript.json`;
const APP_FILE = `${ROOT}.sheet-app.json`;
const CONFIG_FILE = `${ROOT}luma.config.json`;

// Secret.gs, defining the SECRET Code.gs checks requests against.
export function secretFile(secret) {
  if (!/^[0-9a-f]{32,}$/.test(secret)) throw new Error("The secret should be long and hex.");
  return `// Made by npm run sheet:create. Not committed: it must match the Worker's SHEET_SECRET.\nconst SECRET = "${secret}";\n`;
}

// The web app's address, from the deployment clasp made.
export function webAppUrl(deploymentId) {
  return `https://script.google.com/macros/s/${deploymentId}/exec`;
}

// The deployment ID in what `clasp create-deployment` printed. A project's
// HEAD deployment, which serves the latest code without a version, isn't the
// one wanted.
export function deploymentIdIn(output) {
  const ids = [...output.matchAll(/\b(AKfy[\w-]{20,})\b(?!\s*@HEAD)/g)].map(([, id]) => id);
  return ids.at(-1);
}

// luma.config.json with `sheetUrl` set, keeping everything else in it.
export function withSheetUrl(configJson, url) {
  const config = JSON.parse(configJson);
  return `${JSON.stringify({ ...config, sheetUrl: url }, null, 2)}\n`;
}

// Runs a command in `cwd`, showing its output, and returns that output.
function run(command, args, { cwd = ROOT, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
        (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
      });
    }
    if (input !== undefined) child.stdin.end(input);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve(output);
      const hint = /Apps Script API/i.test(output)
        ? "\nTurn on the Apps Script API at https://script.google.com/home/usersettings, then try again."
        : /login|credential|unauthenticated/i.test(output)
          ? "\nLog in first: npx clasp login"
          : "";
      reject(new Error(`${command} ${args.join(" ")} failed.${hint}`));
    });
  });
}

const clasp = (...args) => run("npx", ["clasp", ...args], { cwd: SHEET_DIR });

async function exists(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}

// clasp may replace appsscript.json with Google's default; this keeps ours,
// which makes the script a web app anyone can reach, running as you.
async function pushScript(manifest) {
  await writeFile(MANIFEST_FILE, manifest);
  await clasp("push", "--force");
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

async function create(args) {
  if (await exists(APP_FILE)) {
    throw new Error("A Sheet is already set up (.sheet-app.json). Use npm run sheet:update to change its script.");
  }
  const title = option(args, "title") ?? "Luma tasks";
  const manifest = await readFile(MANIFEST_FILE, "utf8");

  console.log(`Creating the spreadsheet "${title}" with its script…`);
  await clasp("create-script", "--type", "sheets", "--title", title, "--rootDir", ".");
  const project = JSON.parse(await readFile(`${SHEET_DIR}/.clasp.json`, "utf8"));

  const secret = randomBytes(32).toString("hex");
  await writeFile(SECRET_FILE, secretFile(secret));
  await pushScript(manifest);

  console.log("Deploying the web app…");
  const deployment = await clasp("create-deployment", "--description", "Luma");
  const deploymentId = deploymentIdIn(deployment);
  if (!deploymentId) throw new Error("Couldn't find the deployment ID in clasp's output; see npx clasp list-deployments.");
  const url = webAppUrl(deploymentId);
  const app = { scriptId: project.scriptId, spreadsheetId: project.parentId ?? "", deploymentId, url };
  await writeFile(APP_FILE, `${JSON.stringify(app, null, 2)}\n`);

  console.log("Giving the Worker the secret and the address…");
  await run("npx", ["wrangler", "secret", "put", "SHEET_SECRET"], { input: secret });
  if (await exists(CONFIG_FILE)) {
    await writeFile(CONFIG_FILE, withSheetUrl(await readFile(CONFIG_FILE, "utf8"), url));
    await run("node", ["scripts/config.mjs"]);
  } else {
    await copyFile(`${ROOT}luma.config.example.json`, CONFIG_FILE);
    await writeFile(CONFIG_FILE, withSheetUrl(await readFile(CONFIG_FILE, "utf8"), url));
    console.log("Made luma.config.json with sheetUrl; fill in your channels, then run npm run config.");
  }

  const sheet = app.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${app.spreadsheetId}` : "";
  console.log(`
Done. One step is left, which only you can do: approve the script's access
to the spreadsheet. Open the script, choose the "authorize" function, click
Run, and allow it:
  https://script.google.com/d/${app.scriptId}/edit
${sheet ? `\nThe spreadsheet: ${sheet}\n` : ""}`);
}

async function update() {
  let app;
  try {
    app = JSON.parse(await readFile(APP_FILE, "utf8"));
  } catch {
    throw new Error("No .sheet-app.json here: create the Sheet with npm run sheet:create first.");
  }
  if (!(await exists(SECRET_FILE))) {
    throw new Error("google-sheet/Secret.gs is missing, and the script can't work without it. Restore it, or set up a new Sheet.");
  }
  await pushScript(await readFile(MANIFEST_FILE, "utf8"));
  // Same deployment, so the address doesn't change.
  await clasp("update-deployment", app.deploymentId, "--description", "Luma");
  console.log(`Updated the script at ${app.url}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [action, ...args] = process.argv.slice(2);
  const actions = { create, update };
  if (!actions[action]) {
    console.error("Use: node scripts/sheet-app.mjs create [--title \"Luma tasks\"] | update");
    process.exit(1);
  }
  actions[action](args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
