// Records the demo clips into docs/videos/ (see DEMO.md and docs/videos/README.md).
//   npm run demo:record -- 1        (one act)   |   npm run demo:record   (all)
// Needs ffmpeg on PATH.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { openAccounts, loadConfig, actAs, post, messageAction, pause } from "./lib.mjs";

const OUT = new URL("../../docs/videos/", import.meta.url).pathname;
const TMP = new URL("../../.demo/raw/", import.meta.url).pathname;

const ACTS = {
  1: {
    file: "act-1-message-to-task",
    async run({ config, lead, guest }) {
      // 1. The client asks, in their channel.
      await actAs(config, guest, "Sarah");
      await post(guest.page, config.channels.client,
        "Can guests pay a deposit when they book, instead of the full amount upfront? We'd like 20% at booking and the rest 7 days before check-in.");
      // You: ⋯ → More actions → New task.
      await lead.page.goto(`${new URL(lead.page.url()).origin}/client/${config.channels.client}`);
      await pause(2000);
      await messageAction(lead.page, "Can guests pay a deposit", /new task/i);
      // The form: title, priority, then Create.
      const title = lead.page.getByLabel(/title/i);
      await title.fill("Deposit payments at booking");
      await lead.page.getByLabel(/priority/i).click();
      await lead.page.getByRole("option", { name: /high/i }).click();
      await pause();
      await lead.page.getByRole("button", { name: /^create$/i }).click();
      await pause(3000);
      // 2. A follow-up in a DM → Move to existing.
      await post(guest.page, config.leadDm,
        "Also — the deposit % should be configurable per property, some owners want 30%.");
      await lead.page.goto(`${new URL(lead.page.url()).origin}/client/${config.leadDm}`);
      await pause(2000);
      await messageAction(lead.page, "configurable per property", /move to existing/i);
      await lead.page.getByRole("option", { name: /deposit payments at booking/i }).click();
      await lead.page.getByRole("button", { name: /^move$/i }).click();
      await pause(3000);
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
  const accounts = await openAccounts(config, { videoDir: TMP });
  try {
    await act.run({ config, ...accounts });
  } finally {
    await accounts.lead.context.close(); // flushes the video
    await accounts.browser.close();
  }
  const raw = `${TMP}${readdirSync(TMP).find((f) => f.endsWith(".webm"))}`;
  const mp4 = `${OUT}${act.file}.mp4`;
  execFileSync("ffmpeg", ["-y", "-i", raw, "-vf", "scale=1600:-2", "-c:v", "libx264", "-crf", "26",
    "-preset", "slow", "-an", "-movflags", "+faststart", mp4], { stdio: "inherit" });
  execFileSync("ffmpeg", ["-y", "-sseof", "-3", "-i", mp4, "-frames:v", "1", `${OUT}${act.file}.jpg`], { stdio: "inherit" });
  console.log(`Wrote ${mp4}`);
}
