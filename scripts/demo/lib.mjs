// Helpers for npm run demo:record: one logged-in Slack account per person in
// the story, each in its own browser window, opened the first time that
// person acts. Every window is recorded, so private prompts can be shown from
// the screen they appeared on.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

export const SESSION_DIR = new URL("../../.demo/", import.meta.url).pathname;
export const SESSIONS_FILE = `${SESSION_DIR}sessions.json`;
const CADE_CONFIG_FILE = new URL("../../cade.config.json", import.meta.url).pathname;

export const pause = (ms = 1200) => new Promise((r) => setTimeout(r, ms));
const capitalise = (s) => s[0].toUpperCase() + s.slice(1);

// .demo/sessions.json: { "<key>": { "name": "<Slack display name>", "storageState": {...} | "file.json" } }
// Keys are the people in DEMO.md (sarah, you, rex, mia, tom); `name` is what
// Slack's @-picker searches for. storageState is a Playwright state object
// (what `npm run demo:login -- <key>` saves) or a path relative to .demo/.
export function readSessions() {
  return existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) : {};
}

export function saveSession(key, storageState) {
  const sessions = readSessions();
  sessions[key] = { name: sessions[key]?.name ?? capitalise(key), ...sessions[key], storageState };
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2) + "\n");
}

// Channels come from cade.config.json: the dev channel is a group's tasks
// channel (DEMO_GROUP picks one by name; default is the first). The client
// channel isn't one Cade is configured on, so it is DEMO_CLIENT_CHANNEL, and
// DEMO_LEAD_DM is the DM between sarah and you. DEMO_SHEET_URL (optional) is
// the Google Sheet for Act 6. The workspace is whichever the saved logins
// belong to; its team id is read from the URL once Slack loads.
export function loadConfig() {
  if (!existsSync(CADE_CONFIG_FILE)) throw new Error("cade.config.json is missing.");
  const groups = JSON.parse(readFileSync(CADE_CONFIG_FILE, "utf8")).channels ?? [];
  const group = groups.find((g) => g.name === process.env.DEMO_GROUP) ?? groups[0];
  return {
    workspaceUrl: "https://app.slack.com/client",
    team: null,
    sessions: readSessions(),
    channels: { dev: group?.tasks, client: process.env.DEMO_CLIENT_CHANNEL },
    leadDm: process.env.DEMO_LEAD_DM,
    sheetUrl: process.env.DEMO_SHEET_URL,
  };
}

const VIEWPORT = { width: 1920, height: 1080 };
const buttonName = (label) => (typeof label === "string" ? { name: label, exact: true } : { name: label });

export class Cast {
  static async start(config, { videoDir } = {}) {
    return new Cast(config, await chromium.launch({ headless: false }), videoDir);
  }

  constructor(config, browser, videoDir) {
    this.config = config;
    this.browser = browser;
    this.videoDir = videoDir;
    this.people = new Map();
  }

  // The name Slack's @-picker finds this person by.
  name(key) {
    return this.config.sessions[key]?.name ?? capitalise(key);
  }

  async as(key) {
    if (!this.people.has(key)) this.people.set(key, this.#open(key));
    return (await this.people.get(key)).page;
  }

  async #open(key) {
    const state = this.config.sessions[key]?.storageState;
    if (!state) throw new Error(`No session for "${key}": run npm run demo:login -- ${key} (see ${SESSIONS_FILE}).`);
    const context = await this.browser.newContext({
      storageState: typeof state === "string" ? path.resolve(SESSION_DIR, state) : state,
      viewport: VIEWPORT,
      ...(this.videoDir ? { recordVideo: { dir: this.videoDir, size: VIEWPORT } } : {}),
    });
    const page = await context.newPage();
    await page.goto(this.config.workspaceUrl);
    await page.waitForURL(/\/client\/T[A-Z0-9]+/);
    this.config.team ??= page.url().match(/\/client\/(T[A-Z0-9]+)/)[1];
    return { context, page };
  }

  // Closes every window (flushing its video) and returns { key: path to .webm }.
  async close() {
    const saved = {};
    for (const [key, opened] of this.people) {
      const { context, page } = await opened;
      const video = page.video();
      await context.close();
      if (video && this.videoDir) await video.saveAs((saved[key] = `${this.videoDir}${key}.webm`));
    }
    await this.browser.close();
    return saved;
  }

  channelUrl(channelId) {
    return `${this.config.workspaceUrl}/${this.config.team}/${channelId}`;
  }

  // Opens a channel (or reloads it with `fresh`, which also closes any thread panel).
  async open(page, channelId, { fresh = false } = {}) {
    if (fresh || !page.url().includes(`/${this.config.team}/${channelId}`)) {
      await page.goto(this.channelUrl(channelId));
      await page.getByRole("textbox", { name: /^Message/ }).waitFor();
      await pause(1500);
    }
  }

  // Types into a composer. `@key` for a person in sessions.json becomes their
  // name; every @mention (those and @Cade) is accepted with Tab, since typing
  // the whole text straight in doesn't create a real mention.
  async compose(page, box, text) {
    await box.click();
    for (const part of text.split(/(@\w+)/)) {
      if (/^@\w+$/.test(part)) {
        const key = part.slice(1).toLowerCase();
        await box.pressSequentially(this.config.sessions[key] ? `@${this.name(key)}` : part, { delay: 35 });
        await pause(1200);
        await page.keyboard.press("Tab");
      } else if (part) {
        await box.pressSequentially(part, { delay: 35 });
      }
    }
    await page.keyboard.press("Enter");
    await pause();
  }

  // Top-level message in a channel or DM.
  async say(key, channelId, text) {
    const page = await this.as(key);
    await this.open(page, channelId);
    await this.compose(page, page.getByRole("textbox", { name: /^Message/ }), text);
  }

  // Reply in the thread panel that is currently open for this person.
  async reply(key, text) {
    const page = await this.as(key);
    await this.compose(page, page.getByRole("textbox", { name: /^Reply/ }), text);
  }

  // /cade ...: the first Enter accepts the autocomplete, the second sends.
  // Output is private and lands at the bottom of the channel.
  async slash(key, channelId, command) {
    const page = await this.as(key);
    await this.open(page, channelId);
    const box = page.getByRole("textbox", { name: /^Message/ });
    await box.click();
    await box.pressSequentially(command, { delay: 35 });
    await pause(1500);
    await page.keyboard.press("Enter");
    await pause(500);
    await page.keyboard.press("Enter");
    await pause(5000);
  }

  // The task card (or any bot message with replies) whose text contains `title`.
  card(page, title) {
    return page.getByRole("listitem")
      .filter({ hasText: title })
      .filter({ has: page.getByRole("button", { name: /repl/i }) })
      .last();
  }

  // Opens a task card's thread in the right-hand panel.
  async openTask(key, channelId, title) {
    const page = await this.as(key);
    await this.open(page, channelId, { fresh: true });
    await this.card(page, title).getByRole("button", { name: /\d+ repl/i }).click();
    await page.getByRole("textbox", { name: /^Reply/ }).waitFor();
    await pause();
  }

  // Card ⋯ → `item`. Uses the card in the channel list: the copy at the top of
  // the thread panel has its own ⋯ and Release fails there.
  async cardMenu(key, channelId, title, item) {
    const page = await this.as(key);
    await this.open(page, channelId, { fresh: true });
    const card = this.card(page, title);
    await card.hover();
    await card.getByRole("button", { name: "More options" }).click();
    await page.getByRole("menuitem", { name: item }).click();
    await pause();
  }

  // Hover the message, ⋯ (More actions) → Connect to apps → `action` (Cade's
  // shortcuts live in that submenu). The submenu opens only on real mouse
  // movement and closes when the pointer leaves it, so move across, then click.
  async messageAction(key, channelId, text, action) {
    const page = await this.as(key);
    await this.open(page, channelId, { fresh: true });
    const row = page.getByRole("listitem").filter({ hasText: text }).last();
    await row.hover();
    await row.getByRole("button", { name: "More actions" }).click();
    const parent = page.getByRole("menuitem", { name: "Connect to apps" });
    const from = await parent.boundingBox();
    await page.mouse.move(from.x + 20, from.y + from.height / 2, { steps: 5 });
    const target = page.getByRole("menuitem", { name: action });
    await target.waitFor();
    const to = await target.boundingBox();
    await page.mouse.move(from.x - 5, from.y + from.height / 2, { steps: 8 });
    await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 });
    await pause(600);
    await page.mouse.click(to.x + 40, to.y + to.height / 2);
    await pause();
  }

  // Waits for one of Cade's private prompts (they take a few seconds to
  // appear) and clicks a button on it. Pauses after, so the next message isn't
  // judged against a status that hasn't been updated yet.
  async prompt(key, label, { wait = 25000, after = 6000 } = {}) {
    const page = await this.as(key);
    const button = page.getByRole("button", buttonName(label)).last();
    await button.waitFor({ timeout: wait });
    await pause(2000); // let the viewer read it
    await button.click();
    await pause(after);
  }

  // A combobox in one of Cade's modals: they don't match role + name, so click
  // the field by its placeholder, then the option.
  async pick(key, placeholder, option) {
    const page = await this.as(key);
    await page.getByText(placeholder).click();
    await page.getByRole("option", { name: option }).click();
    await pause();
  }

  async click(key, label) {
    const page = await this.as(key);
    await page.getByRole("button", buttonName(label)).last().click();
    await pause();
  }

  // The "New task" modal, as opened from a shortcut or a prompt.
  async newTask(key, { title, priority }) {
    const page = await this.as(key);
    if (title) await page.getByLabel("Task title").fill(title);
    await this.pick(key, "Select a priority", new RegExp(priority));
    await this.click(key, /^create$/i);
    await pause(3000);
  }
}

// For steps whose UI hasn't been observed yet: a miss is reported, and the
// recording carries on rather than dying halfway through an act.
export async function attempt(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.warn(`! ${label}: ${err.message.split("\n")[0]}`);
  }
}
