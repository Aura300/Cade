#!/usr/bin/env node
// Runs Cade on this machine with `wrangler dev`. The channels and time zone
// come from cade.config.json; the secrets are asked for each time, unless
// they are already set in the environment, and are never saved: they reach
// Wrangler through a temporary file, removed when it stops. Extra arguments
// go to `wrangler dev`, as in `npm run dev -- --port 8788`.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.mjs";
import { askHidden } from "./prompt.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The secrets asked for, in order. An optional one can be skipped with Enter;
// `when` says whether to ask at all, given the answers so far.
export const SECRETS = [
  { name: "SLACK_BOT_TOKEN", hint: "xoxb-…", check: (value) => value.startsWith("xoxb-") },
  { name: "SLACK_SIGNING_SECRET" },
  // Asked only when cade.config.json has the Sheet's address.
  { name: "SHEET_SECRET", when: (settings) => Boolean(settings.SHEET_URL) },
];

// The .env file Wrangler reads: values in single quotes, so JSON such as
// CHANNEL_PAIRS is taken as it is.
export function envFile(settings) {
  return Object.entries(settings)
    .filter(([, value]) => value)
    .map(([name, value]) => {
      if (/['\n]/.test(value)) throw new Error(`${name} can't contain a quote or a line break.`);
      return `${name}='${value}'`;
    })
    .join("\n");
}

// A secret set in the environment, even to nothing (to skip an optional
// one), isn't asked for. Without a terminal, only the required ones that
// aren't set are a problem.
async function askSecrets(config) {
  const answers = {};
  const required = SECRETS.filter((secret) => !secret.optional && !secret.when);
  const missing = required.filter(({ name }) => !process.env[name]);
  if (missing.length && !process.stdin.isTTY) {
    throw new Error(`Set ${missing.map(({ name }) => name).join(", ")} in the environment, or run this in a terminal.`);
  }
  let told = false;
  for (const secret of SECRETS) {
    if (secret.name in process.env) {
      if (process.env[secret.name]) answers[secret.name] = process.env[secret.name];
      continue;
    }
    if (secret.when && !secret.when({ ...config, ...answers })) continue;
    if (!process.stdin.isTTY) continue;
    if (!told) console.log("Settings for this session (not saved):");
    told = true;
    const label = secret.optional ? "optional, Enter to skip" : secret.hint;
    const value = await askHidden(`  ${secret.name}${label ? ` (${label})` : ""}: `);
    if (!value && !secret.optional) throw new Error(`${secret.name} is needed.`);
    if (value && secret.check && !secret.check(value)) throw new Error(`That isn't a valid ${secret.name}.`);
    if (value) answers[secret.name] = value;
  }
  return answers;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let dir;
  try {
    let json;
    try {
      json = await readFile(`${ROOT}cade.config.json`, "utf8");
    } catch {
      throw new Error("No cade.config.json: copy cade.config.example.json to cade.config.json and fill it in.");
    }
    const config = readConfig(json);
    const secrets = await askSecrets(config);
    const groups = JSON.parse(config.CHANNEL_PAIRS).map((pair) => pair.name).join(", ");
    console.log(`Using cade.config.json: ${groups}${config.TIMEZONE ? `; timezone ${config.TIMEZONE}` : ""}`);

    dir = await mkdtemp(join(tmpdir(), "cade-dev-"));
    const file = join(dir, ".env");
    await writeFile(file, envFile({ ...config, ...secrets }), { mode: 0o600 });
    const child = spawn("npx", ["wrangler", "dev", "--env-file", file, ...process.argv.slice(2)], {
      cwd: ROOT,
      stdio: "inherit",
    });
    // Ctrl+C reaches Wrangler too; this waits for it to stop, then tidies up.
    process.on("SIGINT", () => {});
    const code = await new Promise((resolve) => child.on("exit", resolve));
    process.exitCode = code ?? 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
