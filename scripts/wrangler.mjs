#!/usr/bin/env node
// Runs wrangler with the account in .cloudflare.json (see cloudflare.mjs), for
// the npm scripts that run it directly: `node scripts/wrangler.mjs deploy`.
import { spawn } from "node:child_process";
import "./cloudflare.mjs";

spawn("npx", ["wrangler", ...process.argv.slice(2)], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 1));
