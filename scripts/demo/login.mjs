// One-time per person: sign in to Slack in a real Chrome window. The session
// stays in .demo/profiles/<name>/ and is reused by record.mjs.
//   node scripts/demo/login.mjs sarah|randil|rex|mia|tom   (any key works)
import { createInterface } from "node:readline/promises";
import { loadConfig, launchProfile, profilePath } from "./lib.mjs";

const key = process.argv[2]?.toLowerCase();
if (!key) throw new Error("Usage: login.mjs <name>, e.g. rex");
const config = loadConfig();
// A normal maximized window: the recorder's fixed 1080p viewport can be larger than the screen.
const context = await launchProfile(key, { viewport: null, args: ["--start-maximized"] });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(config.workspaceUrl);
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question(`Log in as ${key}, then press Enter here… `);
rl.close();
await context.close();
console.log(`Saved ${key} to ${profilePath(key)}`);
