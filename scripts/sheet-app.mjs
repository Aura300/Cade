#!/usr/bin/env node
// Creates the Google Sheet Cade records tasks in, with its Apps Script web
// app, or updates the script, using clasp (Google's Apps Script command line).
// The Google Doc executive summaries are kept in is made the same way, by
// doc-app.mjs: a doc for a group, with the script attached, linked to the
// group as its `doc`. See GETTING_STARTED.md.
//
//   npm run sheet:create [-- --title "Cade tasks"] [--sheet <address>]
//   npm run sheet:update
//   npm run doc:create [-- --group acme] [--title "acme executive summaries"] [--doc <address>]
//   npm run doc:update
//
// With --sheet or --doc, the script is attached to that spreadsheet or doc,
// one you have already, rather than a new one.
//
// Both need `npx clasp login`, and the Apps Script API turned on for your
// Google account (https://script.google.com/home/usersettings).
//
// Creating makes a new spreadsheet with google-sheet/Code.gs attached,
// generates the shared secret into google-sheet/Secret.gs (not committed),
// deploys the web app, then gives the Worker its address (sheetUrl in
// cade.config.json, uploaded with npm run config) and the secret
// (SHEET_SECRET). The script's IDs are saved to .sheet-app.json, so updates
// redeploy to the same address.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_FILE = `${ROOT}cade.config.json`;

// Each web app: its folder, the file its IDs are saved in, the Worker secret
// and cade.config.json setting it gives the Worker, what clasp makes, and
// what it's called.
export const APPS = {
  sheet: {
    dir: `${ROOT}google-sheet`,
    appFile: `${ROOT}.sheet-app.json`,
    secretName: "SHEET_SECRET",
    configKey: "sheetUrl",
    type: "sheets",
    path: "spreadsheets",
    title: "Cade tasks",
    command: "sheet",
    noun: "Sheet",
  },
  doc: {
    dir: `${ROOT}google-doc`,
    appFile: `${ROOT}.doc-app.json`,
    secretName: "DOC_SECRET",
    configKey: "docUrl",
    type: "docs",
    path: "document",
    title: "executive summaries",
    command: "doc",
    noun: "Google Doc",
  },
};

// Secret.gs, defining the SECRET Code.gs checks requests against.
export function secretFile(secret, app = APPS.sheet) {
  if (!/^[0-9a-f]{32,}$/.test(secret)) throw new Error("The secret should be long and hex.");
  return `// Made by npm run ${app.command}:create. Not committed: it must match the Worker's ${app.secretName}.\nconst SECRET = "${secret}";\n`;
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

// cade.config.json with `sheetUrl` (or the app's own setting) set, keeping
// everything else in it.
export function withSheetUrl(configJson, url, key = "sheetUrl") {
  const config = JSON.parse(configJson);
  return `${JSON.stringify({ ...config, [key]: url }, null, 2)}\n`;
}

// cade.config.json with the Doc's web app address set, and `docAddress`
// linked to the group `name` as its doc, keeping everything else in it.
export function withDocLink(configJson, url, name, docAddress) {
  const config = JSON.parse(withSheetUrl(configJson, url, "docUrl"));
  config.channels = config.channels.map((group) => (group.name === name ? { ...group, doc: docAddress } : group));
  return `${JSON.stringify(config, null, 2)}\n`;
}

// The ID of an existing spreadsheet or doc (by `app.path`) in its address,
// or `value` itself if it is an ID already. Throws if it is neither.
export function parentIdIn(value, app) {
  const match = new RegExp(`/${app.path}/d/([\\w-]{20,})`).exec(value) ?? /^([\w-]{20,})$/.exec(value);
  if (!match) throw new Error(`--${app.command} should be the ${app.noun}'s address: https://docs.google.com/${app.path}/d/…/edit.`);
  return match[1];
}

// The group a doc is made for: the one named with --group, or the only one
// in cade.config.json.
export function docGroup(configJson, named) {
  const groups = JSON.parse(configJson).channels ?? [];
  const names = groups.map((group) => group.name).join(", ");
  if (named) {
    if (!groups.some((group) => group.name === named)) throw new Error(`cade.config.json has no group called "${named}"; it has ${names}.`);
    return named;
  }
  if (groups.length === 1) return groups[0].name;
  throw new Error(`Which group is the doc for? Add --group with one of ${names}: npm run doc:create -- --group <name>.`);
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

const clasp = (app, ...args) => run("npx", ["clasp", ...args], { cwd: app.dir });

async function exists(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}

// clasp may replace appsscript.json with Google's default; this keeps ours,
// which makes the script a web app anyone can reach, running as you.
async function pushScript(app, manifest) {
  await writeFile(`${app.dir}/appsscript.json`, manifest);
  await clasp(app, "push", "--force");
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

export async function create(args, app = APPS.sheet) {
  const appFile = app.appFile.slice(ROOT.length);
  if (await exists(app.appFile)) {
    throw new Error(`A ${app.noun} is already set up (${appFile}). Use npm run ${app.command}:update to change its script.`);
  }
  // A doc is for a group, so cade.config.json must be there first.
  let group;
  if (app.type === "docs") {
    if (!(await exists(CONFIG_FILE))) throw new Error("No cade.config.json: set up your channels first (npm run config).");
    group = docGroup(await readFile(CONFIG_FILE, "utf8"), option(args, "group"));
  }
  const title = option(args, "title") ?? (group ? `${group} ${app.title}` : app.title);
  const existing = option(args, app.command) && parentIdIn(option(args, app.command), app);
  const manifest = await readFile(`${app.dir}/appsscript.json`, "utf8");

  const kind = app.type === "sheets" ? "spreadsheet" : "doc";
  if (existing) {
    console.log(`Attaching the script "${title}" to your ${kind}…`);
    await clasp(app, "create-script", "--parentId", existing, "--title", title, "--rootDir", ".");
  } else {
    console.log(`Creating the ${kind} "${title}" with its script…`);
    await clasp(app, "create-script", "--type", app.type, "--title", title, "--rootDir", ".");
  }
  const project = JSON.parse(await readFile(`${app.dir}/.clasp.json`, "utf8"));
  project.parentId ??= existing;

  const secret = randomBytes(32).toString("hex");
  await writeFile(`${app.dir}/Secret.gs`, secretFile(secret, app));
  await pushScript(app, manifest);

  console.log("Deploying the web app…");
  const deployment = await clasp(app, "create-deployment", "--description", "Cade");
  const deploymentId = deploymentIdIn(deployment);
  if (!deploymentId) throw new Error("Couldn't find the deployment ID in clasp's output; see npx clasp list-deployments.");
  const url = webAppUrl(deploymentId);
  const parent = app.type === "sheets" ? { spreadsheetId: project.parentId ?? "" } : { documentId: project.parentId ?? "", group };
  const saved = { scriptId: project.scriptId, ...parent, deploymentId, url };
  await writeFile(app.appFile, `${JSON.stringify(saved, null, 2)}\n`);

  console.log("Giving the Worker the secret and the address…");
  await run("npx", ["wrangler", "secret", "put", app.secretName], { input: secret });
  const doc = saved.documentId ? `https://docs.google.com/document/d/${saved.documentId}/edit` : "";
  if (group) {
    if (!doc) throw new Error("clasp didn't say which doc it made; see npx clasp open-container, and add it to the group in cade.config.json as \"doc\".");
    await writeFile(CONFIG_FILE, withDocLink(await readFile(CONFIG_FILE, "utf8"), url, group, doc));
    await run("node", ["scripts/config.mjs"]);
  } else if (await exists(CONFIG_FILE)) {
    await writeFile(CONFIG_FILE, withSheetUrl(await readFile(CONFIG_FILE, "utf8"), url, app.configKey));
    await run("node", ["scripts/config.mjs"]);
  } else {
    await copyFile(`${ROOT}cade.config.example.json`, CONFIG_FILE);
    await writeFile(CONFIG_FILE, withSheetUrl(await readFile(CONFIG_FILE, "utf8"), url, app.configKey));
    console.log(`Made cade.config.json with ${app.configKey}; fill in your channels, then run npm run config.`);
  }

  const sheet = saved.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${saved.spreadsheetId}` : "";
  const what = app.type === "sheets" ? "to the spreadsheet" : "to the doc";
  console.log(`
Done. One step is left, which only you can do: approve the script's access
${what}. Open the script, choose the "authorize" function, click Run, and
allow it:
  https://script.google.com/d/${saved.scriptId}/edit
${sheet ? `\nThe spreadsheet: ${sheet}\n` : ""}${doc ? `\nThe doc, linked to ${group}; share it with the client: ${doc}\n` : ""}`);
}

export async function update(args, app = APPS.sheet) {
  const appFile = app.appFile.slice(ROOT.length);
  let saved;
  try {
    saved = JSON.parse(await readFile(app.appFile, "utf8"));
  } catch {
    throw new Error(`No ${appFile} here: create the ${app.noun} with npm run ${app.command}:create first.`);
  }
  if (!(await exists(`${app.dir}/Secret.gs`))) {
    throw new Error(`${app.dir.slice(ROOT.length)}/Secret.gs is missing, and the script can't work without it. Restore it, or set up a new ${app.noun}.`);
  }
  await pushScript(app, await readFile(`${app.dir}/appsscript.json`, "utf8"));
  // Same deployment, so the address doesn't change.
  await clasp(app, "update-deployment", saved.deploymentId, "--description", "Cade");
  console.log(`Updated the script at ${saved.url}`);
}

// Runs `create` or `update`, as the command line asks, for `app`.
export function main(app, script) {
  const [action, ...args] = process.argv.slice(2);
  const actions = { create, update };
  if (!actions[action]) {
    console.error(`Use: node scripts/${script} create [--title "${app.title}"] | update`);
    process.exit(1);
  }
  actions[action](args, app).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(APPS.sheet, "sheet-app.mjs");
