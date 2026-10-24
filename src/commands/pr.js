import { callSlack, escapeSlack, mentions, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, loadTask, parsePullRequest, prLink, saveTask } from "../tasks.js";

const REVIEWERS_ACTION = "pr:reviewers";

// Slack sends links as <https://…> or <https://…|label>; pasted text may also
// hold bare addresses.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

const HOW = "Use `@LUMA pr add <link>` or `@LUMA pr remove <link>`.";

// `@LUMA pr add <link> [<link> …]` in a task thread links pull requests to the
// task, shown on the task's message as reponame/number; `@LUMA pr remove
// <link> [<link> …]` unlinks them. GitHub, GitLab and Bitbucket links are
// recognised.
//
// Linking asks the task's reviewers to review it. With no reviewer yet, the
// reply asks who should review it, with a people picker; choosing assigns
// them as reviewers and asks them.
export default {
  name: "pr",
  description: "Link or unlink pull requests (in a task thread)",
  usage: "@LUMA pr add <link>",
  channel: ["tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const [action = ""] = command.text.split(/\s+/, 1);
    const adding = action.toLowerCase() === "add";
    if (!adding && action.toLowerCase() !== "remove") return HOW;

    const links = [...command.text.slice(action.length).matchAll(LINK)].map((match) => match[1] ?? match[2]);
    if (!links.length) return `Paste the pull request's link: ${HOW}`;
    const prs = links.map(parsePullRequest);
    const notPr = links.find((link, i) => !prs[i]);
    if (notPr) return `That's not a pull request link: ${escapeSlack(notPr)}`;
    // The same request linked twice in one message counts once.
    const urls = [...new Set(prs.map((pr) => pr.url))];

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;

    if (adding) {
      const added = urls.filter((url) => !task.prs.includes(url));
      if (!added.length) return "Those pull requests are already linked to this task.";
      task.prs = [...task.prs, ...added];
      await saveTask(env, command.channel, command.threadTs, task);
      const linked = `<@${command.user}> linked ${added.map(prLink).join(", ")}.`;
      const reviewers = task.people.reviewer;
      if (reviewers.length) return `${linked}\n${reviewRequest(reviewers, added)}`;
      return reviewerPicker(linked, added);
    }

    const removed = urls.filter((url) => task.prs.includes(url));
    if (!removed.length) return "Those pull requests aren't linked to this task.";
    task.prs = task.prs.filter((url) => !removed.includes(url));
    await saveTask(env, command.channel, command.threadTs, task);
    return `<@${command.user}> unlinked ${removed.map(prLink).join(", ")}.`;
  },
  actions: {
    [REVIEWERS_ACTION]: async (payload, context) => {
      context.waitUntil(chooseReviewers(payload, context.env));
    },
  },
};

function reviewRequest(reviewers, urls) {
  return `${mentions(reviewers)}, please review ${urls.map(prLink).join(", ")}.`;
}

function reviewerPicker(linked, urls) {
  const prompt = `${linked}\nThere's no reviewer yet. Who should review ${urls.length === 1 ? "it" : "them"}?`;
  return {
    text: prompt,
    blocks: [
      {
        type: "section",
        // The block carries which pull requests to ask about.
        block_id: JSON.stringify(urls).slice(0, 255),
        text: mrkdwn(prompt),
        accessory: {
          type: "multi_users_select",
          action_id: REVIEWERS_ACTION,
          placeholder: plainText("Choose reviewers"),
        },
      },
    ],
  };
}

// Assigns the chosen people as reviewers and replaces the picker with the
// request to review. The picker is a reply in the task's thread.
async function chooseReviewers(payload, env) {
  const channel = payload.channel.id;
  const ts = payload.message.thread_ts;
  const chosen = payload.actions[0].selected_users ?? [];
  if (!chosen.length) return;

  const task = await loadTask(env, channel, ts);
  let reply = NOT_A_TASK;
  if (task) {
    task.people.reviewer = [...new Set([...task.people.reviewer, ...chosen])];
    await saveTask(env, channel, ts, task);
    // The pull requests the picker asked about, or all of the task's when the
    // list did not fit in the block.
    let urls;
    try {
      urls = JSON.parse(payload.actions[0].block_id);
    } catch {
      urls = task.prs;
    }
    reply = `<@${payload.user.id}> chose the reviewers.\n${reviewRequest(chosen, urls)}`;
  }
  await callSlack(env, "chat.update", {
    channel,
    ts: payload.message.ts,
    text: reply,
    blocks: [{ type: "section", text: mrkdwn(reply) }],
  });
}
