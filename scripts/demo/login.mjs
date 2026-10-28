// One-time per person: log in and save the session to .demo/sessions.json.
//   node scripts/demo/login.mjs sarah|you|rex|mia|tom   (any key works)
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { loadConfig, saveSession, SESSIONS_FILE } from "./lib.mjs";

const key = process.argv[2]?.toLowerCase();
if (!key) throw new Error("Usage: login.mjs <name>, e.g. rex");
const config = loadConfig();
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(config.workspaceUrl);
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question(`Log in as ${key}, then press Enter here… `);
rl.close();
saveSession(key, await context.storageState());
await browser.close();
console.log(`Saved ${key} to ${SESSIONS_FILE}`);
