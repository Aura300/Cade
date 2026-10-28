// Helpers for npm run demo:record: two logged-in Slack accounts driven in
// parallel browser windows, with the display name of the second account
// switched to whoever is speaking (see DEMO.md, "Before you record").
import { readFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";

export const SESSION_DIR = new URL("../../.demo/", import.meta.url).pathname;
export const CONFIG_FILE = new URL("../../demo.config.json", import.meta.url).pathname;

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error("demo.config.json is missing: copy scripts/demo/demo.config.example.json to it.");
  }
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

export const sessionFile = (account) => `${SESSION_DIR}${account}.json`;
export const pause = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

// Opens one window per account, each with its saved Slack login. Only the
// "lead" window is recorded, at 1080p; the other is for posting.
export async function openAccounts(config, { videoDir } = {}) {
  const browser = await chromium.launch({ headless: false });
  const size = { width: 1920, height: 1080 };
  const make = async (account, record) => {
    const context = await browser.newContext({
      storageState: sessionFile(account),
      viewport: size,
      ...(record && videoDir ? { recordVideo: { dir: videoDir, size } } : {}),
    });
    const page = await context.newPage();
    await page.goto(config.workspaceUrl);
    return { context, page };
  };
  return { browser, lead: await make("lead", true), guest: await make("guest", false) };
}

// Sets the guest account's display name to the speaker ("Sarah", "Rex"...),
// then reloads so Slack shows it. Needs a user token (users.profile:write).
export async function actAs(config, guest, name) {
  const res = await fetch("https://slack.com/api/users.profile.set", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.guestUserToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ profile: { display_name: name, real_name: name } }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`users.profile.set failed: ${body.error}`);
  await guest.page.reload();
}

// Opens a channel by ID and posts a message as that window's account.
export async function post(page, channelId, text) {
  await page.goto(`${new URL(page.url()).origin}/client/${channelId}`);
  const box = page.locator('[data-qa="message_input"] [contenteditable="true"]').first();
  await box.click();
  await box.pressSequentially(text, { delay: 35 });
  await page.keyboard.press("Enter");
  await pause();
}

// ⋯ on a message containing `text` → More actions → `action`.
export async function messageAction(page, text, action) {
  const msg = page.locator('[data-qa="message_container"]', { hasText: text }).last();
  await msg.hover();
  await msg.locator('[data-qa="more_message_actions"]').click();
  await pause(600);
  await page.getByRole("menuitem", { name: /more (message )?actions/i }).click();
  await page.getByRole("menuitem", { name: action }).click();
  await pause();
}
