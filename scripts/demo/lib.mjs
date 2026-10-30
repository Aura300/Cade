// Helpers for npm run demo:record: one logged-in Slack account per person in
// the story, each in its own browser window, opened the first time that
// person acts. Every window is recorded, so private prompts can be shown from
// the screen they appeared on.
import { readFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { chromium } from "playwright";

export const SESSION_DIR = new URL("../../.demo/", import.meta.url).pathname;
export const SESSIONS_FILE = `${SESSION_DIR}sessions.json`;
const CADE_CONFIG_FILE = new URL("../../cade.config.json", import.meta.url).pathname;

export const pause = (ms = 1200) => new Promise((r) => setTimeout(r, ms));
const capitalise = (s) => s[0].toUpperCase() + s.slice(1);

// One persistent Chrome profile per person in .demo/profiles/<key>/, filled by
// `npm run demo:login -- <key>` and reused by every recording, so a person
// signs in once. Keys are the people in DEMO.md (sarah, randil, rex, mia, tom).
// .demo/sessions.json (optional): { "<key>": { "name": "<Slack display name>" } }
// sets what Slack's @-picker searches for when it differs from the key.
export const PROFILE_DIR = `${SESSION_DIR}profiles/`;
export const profilePath = (key) => `${PROFILE_DIR}${key}`;
const VIEWPORT = { width: 1920, height: 1080 };

// Real Chrome, not Playwright's Chromium: Slack and Google show far fewer
// captchas to it. Each person is their own Chrome process with their own profile.
export const launchProfile = (key, options = {}) =>
  chromium.launchPersistentContext(profilePath(key), {
    channel: "chrome",
    headless: false,
    viewport: VIEWPORT,
    ...options,
  });

export function readSessions() {
  const names = existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) : {};
  const profiles = existsSync(PROFILE_DIR) ? readdirSync(PROFILE_DIR) : [];
  return Object.fromEntries(
    [...new Set([...Object.keys(names), ...profiles])].map((key) => [key, { name: names[key]?.name ?? capitalise(key) }]),
  );
}

// Channels come from cade.config.json: the dev channel is a group's tasks
// channel (DEMO_GROUP picks one by name; default is the first). Cade has no
// client channel, so sarah's client messages go in that same channel
// (DEMO_CLIENT_CHANNEL overrides it), and DEMO_LEAD_DM is the DM between sarah
// and you. DEMO_SHEET_URL (optional) is the Google Sheet for Act 6. The workspace is whichever the saved logins
// belong to; its team id is read from the URL once Slack loads.
export function loadConfig() {
  if (!existsSync(CADE_CONFIG_FILE)) throw new Error("cade.config.json is missing.");
  const groups = JSON.parse(readFileSync(CADE_CONFIG_FILE, "utf8")).channels ?? [];
  const group = groups.find((g) => g.name === process.env.DEMO_GROUP) ?? groups[0];
  return {
    workspaceUrl: "https://app.slack.com/client",
    team: null,
    sessions: readSessions(),
    channels: { dev: group?.tasks, client: process.env.DEMO_CLIENT_CHANNEL ?? group?.tasks },
    leadDm: process.env.DEMO_LEAD_DM,
    sheetUrl: process.env.DEMO_SHEET_URL,
  };
}

const buttonName = (label) => (typeof label === "string" ? { name: label, exact: true } : { name: label });

export class Cast {
  static async start(config, { videoDir } = {}) {
    return new Cast(config, videoDir);
  }

  constructor(config, videoDir) {
    this.config = config;
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
    if (!existsSync(profilePath(key))) throw new Error(`No profile for "${key}": run npm run demo:login -- ${key}`);
    const context = await launchProfile(key, this.videoDir ? { recordVideo: { dir: this.videoDir, size: VIEWPORT } } : {});
    const page = context.pages()[0] ?? (await context.newPage());
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
      // A persistent context has no browser to keep alive for saveAs(), so copy the file once it is flushed.
      if (video && this.videoDir) copyFileSync(await video.path(), (saved[key] = `${this.videoDir}${key}.webm`));
    }
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

  // Types into a composer. `@key` for a person with a profile becomes their
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
