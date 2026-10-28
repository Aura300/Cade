// Records the demo clips into docs/videos/ (see DEMO.md and docs/videos/README.md).
//   npm run demo:record -- 1        (one act)   |   npm run demo:record   (all)
// Needs ffmpeg on PATH and a session per person in .demo/sessions.json
// (npm run demo:login -- <name>). Every person's window is recorded: "you" is
// act-N-<slug>.mp4, the others act-N-<slug>-<name>.mp4 (private prompts show
// on the screen of whoever they were for).
//
// Acts build on each other (the Deposit task from Act 1 is used until Act 3),
// and need the seed from DEMO.md, so run them in order on a fresh workspace.
// Steps marked "unverified" use UI that hasn't been observed yet; they warn
// and carry on if it isn't as expected.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { Cast, loadConfig, attempt, pause } from "./lib.mjs";

const OUT = new URL("../../docs/videos/", import.meta.url).pathname;
const TMP = new URL("../../.demo/raw/", import.meta.url).pathname;

const DEPOSIT = "Deposit payments at booking";
const INCIDENT = "Card payments are failing";
const LOG_ROTATION = "Add log rotation to staging DB";
const NODE_TASK = "Upgrade Node to 22 on staging";
const UNASSIGNED_TASK = "Remove legacy coupon code";
const PR = (n) => `https://github.com/acme/booking-web/pull/${n}`;

// "Send for approval" modal (Release / deliver): tick the PR, note, approver.
async function sendForApproval(c, key, { pr, note, approver }) {
  const page = await c.as(key);
  await page.getByRole("checkbox", { name: new RegExp(pr) }).check();
  await page.getByLabel(/what this completes/i).fill(note);
  await c.pick(key, "Choose a person", new RegExp(c.name(approver)));
  await c.click(key, "Send");
  await pause(3000);
}

const ACTS = {
  1: {
    file: "act-1-message-to-task",
    async run(c, { channels, leadDm }) {
      // 1. The client asks, in their channel.
      await c.say("sarah", channels.client,
        "Can guests pay a deposit when they book, instead of the full amount upfront? We'd like 20% at booking and the rest 7 days before check-in.");
      // You: ⋯ → Connect to apps → New task, then the form (one group, so no Project picker).
      await c.messageAction("you", channels.client, "Can guests pay a deposit", /^New task/);
      await c.newTask("you", { title: DEPOSIT, priority: "High" });
      // 2. A follow-up in a DM → Move to existing.
      await c.say("sarah", leadDm, "Also — the deposit % should be configurable per property, some owners want 30%.");
      await c.messageAction("you", leadDm, "configurable per property", /^Move to existing/);
      await c.pick("you", "Choose a task", new RegExp(DEPOSIT));
      await c.click("you", /^move$/i);
      await pause(3000);
    },
  },

  2: {
    file: "act-2-team-picks-it-up",
    async run(c, { channels: { dev } }) {
      // 3. Hand it to its owner.
      await c.openTask("you", dev, DEPOSIT);
      await c.reply("you", "@rex please start working on this — first cut by Friday?");
      await c.prompt("you", "Accept");
      // 4. The owner says they've started.
      await c.openTask("rex", dev, DEPOSIT);
      await c.reply("rex", "Okay, started working on this");
      await c.prompt("rex", "Accept");
      // 5. The team owns priority and due date.
      await c.reply("you", "@Cade priority urgent");
      await pause(4000);
      await c.reply("you", "@Cade due 14/11/2026");
      await pause(4000);
    },
  },

  3: {
    file: "act-3-build-review-ship",
    async run(c, { channels: { dev } }) {
      // 6. Paste a PR, mention a reviewer → Cade offers both. (The first pasted
      // github.com link makes Slackbot ask to install the GitHub app: click
      // "No, thanks" once per account before recording.)
      await c.openTask("rex", dev, DEPOSIT);
      await c.reply("rex", `First pass is up: ${PR(128)} — @mia can you review this?`);
      await c.prompt("rex", "Accept");
      // 7. Explicit commands for PRs.
      await c.reply("rex", `@Cade pr add ${PR(131)}`);
      await pause(5000);
      await c.reply("rex", `@Cade pr add ${PR(999)}`);
      await pause(5000);
      await c.reply("rex", `@Cade pr remove ${PR(999)}`);
      await pause(5000);
      // 8. Hand-off to QA in plain words.
      await c.openTask("mia", dev, DEPOSIT);
      await c.reply("mia", "Approved ✅ small nit on rounding, fixed in a follow-up. @tom please test this on staging");
      await c.prompt("mia", "Accept");
      // 9. Handing work on.
      await c.openTask("tom", dev, DEPOSIT);
      await c.reply("tom", "I'm out tomorrow — @mia can you test this instead?");
      await c.prompt("tom", "Accept");
      // 10. Explicit assign / unassign, and Edit.
      await c.reply("you", "@Cade assign reviewer @rex");
      await pause(5000);
      await c.reply("you", "@Cade unassign reviewer @rex");
      await pause(5000);
      await c.cardMenu("you", dev, DEPOSIT, "Edit");
      await pause(4000);
      await c.click("you", "Cancel");
      // 13. Progress in plain words, with the task put back in review first;
      // Done is offered and declined, as the release below still needs the task.
      await c.openTask("you", dev, DEPOSIT);
      await c.reply("you", "@Cade status in review");
      await pause(6000);
      await c.openTask("mia", dev, DEPOSIT);
      await c.reply("mia", "LGTM");
      await c.prompt("mia", "Accept");
      await c.openTask("tom", dev, DEPOSIT);
      await c.reply("tom", "QA passed on staging");
      await c.prompt("tom", "Reject");
      // 11. Ship part of it early → partial release. Unverified: the second
      // round, `@Cade deliver`, and the exact modal fields.
      await c.cardMenu("rex", dev, DEPOSIT, "Release");
      await sendForApproval(c, "rex", { pr: "128", note: "Deposit checkout flow (20% default)", approver: "you" });
      await c.openTask("you", dev, DEPOSIT);
      await c.click("you", "Not approve");
      await pause(5000);
      await c.openTask("rex", dev, DEPOSIT);
      await attempt("deliver", async () => {
        await c.reply("rex", "@Cade deliver");
        await sendForApproval(c, "rex", { pr: "128", note: "Deposit checkout flow (20% default)", approver: "you" });
      });
      await c.openTask("you", dev, DEPOSIT);
      await c.click("you", "Approve");
      await pause(5000);
      // 12. Status. Unverified: the private "Ask for approval" step.
      await c.openTask("tom", dev, DEPOSIT);
      await c.reply("tom", "@Cade status client review");
      await attempt("ask for approval", async () => {
        await c.prompt("tom", /ask for approval/i);
        await c.pick("tom", "Choose a person", new RegExp(c.name("you")));
        await c.click("tom", /^(send|ask)/i);
        await pause(4000);
      });
      // 14. The client decides: Not approve once, then Approve.
      await c.openTask("you", dev, DEPOSIT);
      await c.click("you", "Not approve");
      await pause(6000);
      await c.openTask("tom", dev, DEPOSIT);
      await c.reply("tom", "@Cade status client review");
      await attempt("ask for approval (2)", async () => {
        await c.prompt("tom", /ask for approval/i);
        await c.pick("tom", "Choose a person", new RegExp(c.name("you")));
        await c.click("tom", /^(send|ask)/i);
        await pause(4000);
      });
      await c.openTask("you", dev, DEPOSIT);
      await c.click("you", "Approve");
      await pause(5000);
    },
  },

  4: {
    file: "act-4-incident",
    async run(c, { channels: { client, dev } }) {
      // 15. Report an incident from the client's message.
      await c.say("sarah", client, "Card payments are failing at checkout for EU customers!");
      await c.messageAction("you", client, INCIDENT, /^New incident/);
      await c.click("you", "Report");
      await pause(4000);
      // Incidents are always Urgent and due Immediate.
      await c.openTask("rex", dev, INCIDENT);
      await c.reply("rex", "@Cade priority low");
      await pause(5000);
      await c.cardMenu("rex", dev, INCIDENT, "Edit");
      await pause(4000);
      await c.click("rex", "Cancel");
      // 16. Work the incident.
      await c.openTask("you", dev, INCIDENT);
      await c.reply("you", "@rex please look into this ASAP, Stripe dashboard shows 3DS failures.");
      await c.prompt("you", "Accept");
      await c.openTask("rex", dev, INCIDENT);
      await c.reply("rex", "on it");
      await c.prompt("rex", "Accept");
      await c.reply("rex", "@Cade status done");
      await pause(5000);
    },
  },

  5: {
    file: "act-5-teams-own-work",
    async run(c, { channels: { dev } }) {
      // 17. A dev message becomes a task.
      await c.say("rex", dev, "Staging DB is running out of disk again — we should add log rotation before the release.");
      await c.prompt("rex", "New task", { wait: 40000 });
      await c.newTask("rex", { title: LOG_ROTATION, priority: "Medium" });
      // 18. Move to an existing task.
      await c.say("mia", dev, "FYI the Node 22 upgrade also needs the Docker base image bumped.");
      await c.prompt("mia", "Move to existing", { wait: 40000 });
      await c.pick("mia", "Choose a task", new RegExp(NODE_TASK));
      await c.click("mia", /^move$/i);
      await pause(4000);
      // 19. Track an older message: the seeded "Flaky test…" one (prompt already dismissed).
      const page = await c.as("you");
      await c.open(page, dev, { fresh: true });
      const row = page.getByRole("listitem").filter({ hasText: "Flaky test" }).last();
      await row.hover();
      await row.getByRole("button", { name: /reply in thread/i }).click();
      await page.getByRole("textbox", { name: /^Reply/ }).waitFor();
      await c.reply("you", "@Cade task");
      await attempt("@Cade task", async () => {
        await c.prompt("you", "New task");
        await c.click("you", /^create$/i);
        await pause(3000);
      });
      await c.reply("you", "@Cade move");
      await pause(5000);
      // 20. Archive the log rotation card. Unverified: /cade remove's second
      // confirm and the link format (built from the card's message ts).
      await c.cardMenu("you", dev, LOG_ROTATION, "Archive");
      await pause(4000);
      await attempt("/cade remove", async () => {
        const ts = await c.card(page, LOG_ROTATION).evaluate((el) =>
          (el.closest('[id^="message-list_"]') ?? el.querySelector('[id^="message-list_"]')).id.replace("message-list_", ""));
        await c.slash("you", dev, `/cade remove https://app.slack.com/archives/${dev}/p${ts.replace(".", "")}`);
        await c.click("you", /delete task/i);
        await pause(1500);
        await c.click("you", /delete|confirm/i);
        await pause(4000);
      });
    },
  },

  6: {
    file: "act-6-everyones-view",
    async run(c, { channels: { dev }, sheetUrl }) {
      // 21. My tasks, with filters. Unverified: how the `@Mia` and `<@tomorrow`
      // in these are taken when typed rather than picked from the @-menu.
      for (const cmd of [
        "/cade tasks",
        "/cade tasks -all",
        "/cade tasks -unassigned",
        `/cade tasks review @${c.name("mia")}`,
        "/cade tasks -status=in-progress,in-testing -due<@tomorrow",
      ]) {
        await c.slash("you", dev, cmd);
        await pause(2000);
      }
      // 22. Standup: Next through each owner, then the unassigned ones.
      await c.slash("you", dev, "/cade standup");
      await attempt("standup next", async () => {
        await c.click("you", /^next/i);
        await pause(2500);
        await c.click("you", /^end$/i);
      });
      await c.slash("you", dev, "/cade standup -unassigned");
      await pause(3000);
      await attempt("standup end", () => c.click("you", /^end$/i));
      await c.openTask("rex", dev, UNASSIGNED_TASK);
      await c.reply("rex", "@Cade assign owner @rex");
      await pause(5000);
      // 23. The Google Sheet.
      if (sheetUrl) {
        const page = await c.as("you");
        await page.goto(sheetUrl);
        await pause(6000);
      }
      // 24. Help.
      await c.say("you", dev, "@Cade help");
      await pause(6000);
    },
  },
};

const wanted = process.argv.slice(2).filter((a) => ACTS[a]);
const acts = wanted.length ? wanted : Object.keys(ACTS);
const config = loadConfig();
mkdirSync(OUT, { recursive: true });

for (const n of acts) {
  const act = ACTS[n];
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const cast = await Cast.start(config, { videoDir: TMP });
  let videos = {};
  try {
    await act.run(cast, config);
  } finally {
    videos = await cast.close(); // flushes the videos
  }
  for (const [key, raw] of Object.entries(videos)) {
    const base = key === "you" ? act.file : `${act.file}-${key}`;
    const mp4 = `${OUT}${base}.mp4`;
    execFileSync("ffmpeg", ["-y", "-i", raw, "-vf", "scale=1600:-2", "-c:v", "libx264", "-crf", "26",
      "-preset", "slow", "-an", "-movflags", "+faststart", mp4], { stdio: "inherit" });
    if (key === "you") {
      execFileSync("ffmpeg", ["-y", "-sseof", "-3", "-i", mp4, "-frames:v", "1", `${OUT}${base}.jpg`], { stdio: "inherit" });
    }
    console.log(`Wrote ${mp4}`);
  }
}
