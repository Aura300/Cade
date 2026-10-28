// One-time: log in to each demo account and save the session to .demo/.
//   node scripts/demo/login.mjs lead|guest
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { loadConfig, SESSION_DIR, sessionFile } from "./lib.mjs";

const account = process.argv[2];
if (!["lead", "guest"].includes(account)) throw new Error("Usage: login.mjs lead|guest");
const config = loadConfig();
mkdirSync(SESSION_DIR, { recursive: true });
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(config.workspaceUrl);
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question(`Log in as the ${account} account, then press Enter here… `);
rl.close();
await context.storageState({ path: sessionFile(account) });
await browser.close();
console.log(`Saved ${sessionFile(account)}`);
