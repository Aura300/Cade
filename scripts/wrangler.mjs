#!/usr/bin/env node
// Runs wrangler with the account in .cade/cloudflare.json (see cloudflare.mjs), for
// the npm scripts that run it directly: `node scripts/wrangler.mjs deploy`. A
// deploy also goes to the custom domain saved there, if any, so a deploy never
// leaves it out.
import { spawn } from "node:child_process";
import { domain } from "./cloudflare.mjs";

const args = process.argv.slice(2);
if (args[0] === "deploy" && domain && !args.includes("--domain")) args.push("--domain", domain);

spawn("npx", ["wrangler", ...args], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 1));
