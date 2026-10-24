#!/usr/bin/env node
// Starts Claude Code in this folder with the setup prompt, so it takes you
// through GETTING_STARTED.md one step at a time. Extra arguments go to
// `claude`, as in `npm run setup -- --model opus`.
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const installed = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
if (!installed) {
  console.error(`Claude Code isn't installed. Install it from https://claude.com/claude-code,
then run npm run setup again. With another AI agent, open it in this folder
and paste the prompt in scripts/setup-prompt.md.`);
  process.exit(1);
}

const prompt = await readFile(`${ROOT}scripts/setup-prompt.md`, "utf8");
const child = spawn("claude", [...process.argv.slice(2), prompt.trim()], { cwd: ROOT, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
