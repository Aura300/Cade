import { assigned, request, toAsk } from "../notify.js";
import { acknowledge, callSlack, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { NOT_A_TASK, loadTask, parsePullRequest, prLink, saveTask } from "../tasks.js";

const REVIEWERS_ACTION = "pr:reviewers";
const SUGGEST_LINK_ACTION = "pr:suggest-link";
// Slack needs each button in a row to have its own action_id, so "Just link"
// has one too; its value says what to do, as for the other button.
const SUGGEST_LINK_ONLY_ACTION = "pr:suggest-link-only";
const SUGGEST_SKIP_ACTION = "pr:suggest-skip";
// The reviewer picker on the question, for a task with no reviewer yet; its
// choice is read when Link is pressed.
const SUGGEST_REVIEWERS_ACTION = "pr:suggest-reviewers";
const SUGGEST_REVIEWERS_BLOCK = "pr:suggest-reviewers";

// Slack sends links as <https://…> or <https://…|label>; pasted text may also
// hold bare addresses.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

const HOW = "Try `@Cade pr add <link>` or `@Cade pr remove <link>`.";

// `@Cade pr add <link> [<link> …]` in a task thread links pull requests to the
// task, shown on the task's message as reponame/number; `@Cade pr remove
// <link> [<link> …]` unlinks them. GitHub, GitLab and Bitbucket links are
// recognised.
//
// Linking reacts ✅ to the command and asks the task's reviewers to review it
// in a message of its own (see notify.js); the status is left to the suggestions. With
// no reviewer yet, the reply asks who should review it, with a people
// picker; choosing assigns them as reviewers and asks them.
//
// People also paste pull requests into a task's thread without `@Cade pr
// add`. Those are read with the other suggestions (see suggest.js), which ask
// privately; the buttons below are for questions posted before that.
export default {
  name: "pr",
  description: "Link or unlink pull requests (in a task thread)",
  usage: ["@Cade pr add <link>", "@Cade pr remove <link>"],
  section: "task",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const [action = ""] = command.text.split(/\s+/, 1);
    const adding = action.toLowerCase() === "add";
    if (!adding && action.toLowerCase() !== "remove") return HOW;

    const links = [...command.text.slice(action.length).matchAll(LINK)].map((match) => match[1] ?? match[2]);
    if (!links.length) return `Which pull request? Paste its link. ${HOW}`;
    const prs = links.map(parsePullRequest);
    const notPr = links.find((link, i) => !prs[i]);
    if (notPr) return `Hmm, that doesn't look like a pull request link: ${escapeSlack(notPr)}`;
    // The same request linked twice in one message counts once.
    const urls = [...new Set(prs.map((pr) => pr.url))];

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;

    if (adding) {
      const linked = await addPullRequests(env, command.channel, command.threadTs, task, urls);
      if (!linked) return "Those pull requests are already linked to this task, so we're all set.";
      // The task card shows the link, so a ✅ says it was linked; the reviewers
      // are still asked, or who should review.
      const reviewers = task.people.reviewer;
      if (!reviewers.length) return acknowledge(reviewerPicker("", linked.added));
      return acknowledge(request(reviewers, "reviewer", linked.added));
    }

    const removed = urls.filter((url) => task.prs.includes(url));
    if (!removed.length) return "Hmm, those pull requests aren't linked to this task.";
    task.prs = task.prs.filter((url) => !removed.includes(url));
    await saveTask(env, command.channel, command.threadTs, task);
    return acknowledge();
  },
  actions: {
    [REVIEWERS_ACTION]: async (payload, context) => {
      context.waitUntil(chooseReviewers(payload, context.env));
    },
    [SUGGEST_LINK_ACTION]: async (payload, context) => {
      context.waitUntil(acceptSuggestion(payload, context.env));
    },
    [SUGGEST_LINK_ONLY_ACTION]: async (payload, context) => {
      context.waitUntil(acceptSuggestion(payload, context.env));
    },
    [SUGGEST_SKIP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
    // Choosing reviewers only chooses; Link links.
    [SUGGEST_REVIEWERS_ACTION]: async () => {},
  },
};

// Links the pull requests that aren't linked yet. Returns { added }, or null
// when they were all linked already.
async function addPullRequests(env, channel, ts, task, urls) {
  const added = urls.filter((url) => !task.prs.includes(url));
  if (!added.length) return null;
  task.prs = [...task.prs, ...added];
  await saveTask(env, channel, ts, task);
  return { added };
}

// The pull requests linked in a message's text, each once.
export function pullRequestsIn(text) {
  return [
    ...new Set(
      [...(text ?? "").matchAll(LINK)]
        .map((match) => parsePullRequest(match[1] ?? match[2])?.url)
        .filter(Boolean),
    ),
  ];
}

// Applies the chosen suggestion of an earlier question, adding the reviewers and linking the pull
// requests, and removes the private question. The thread only hears what's
// new to it: a review request for reviewers
// the message didn't mention, or, with no reviewer at all, who should
// review.
async function acceptSuggestion(payload, env) {
  const { channel, ts, urls = [], mentioned = [], ...fields } = JSON.parse(payload.actions[0].value);
  // Reviewers chosen on the question's picker, when it had one.
  const picked = payload.state?.values?.[SUGGEST_REVIEWERS_BLOCK]?.[SUGGEST_REVIEWERS_ACTION]?.selected_users;
  const reviewers = picked ?? fields.reviewers ?? [];
  const user = payload.user.id;
  const task = await loadTask(env, channel, ts);
  let reply = null;
  if (task) {
    const added = reviewers.filter((id) => !task.people.reviewer.includes(id));
    task.people.reviewer = [...task.people.reviewer, ...added];
    const linked = await addPullRequests(env, channel, ts, task, urls);
    // Linking saves the task; adding only reviewers needs its own save.
    if (!linked && added.length) await saveTask(env, channel, ts, task);

    const lines = [];
    // Not those the message mentioned, nor whoever wrote it.
    const unasked = toAsk(task.people.reviewer, user, Object.fromEntries(mentioned.map((id) => [id, null])));
    if (linked && unasked.length) lines.push(request(unasked, "reviewer", linked.added));
    if (linked && !task.people.reviewer.length) reply = reviewerPicker(lines.join("\n"), linked.added);
    else if (lines.length) reply = lines.join("\n");
  }
  if (reply) {
    await callSlack(env, "chat.postMessage", {
      channel,
      thread_ts: ts,
      ...(typeof reply === "string" ? { text: reply } : reply),
    });
  }
  // An ephemeral message can only be changed through its response_url.
  await respondLater(payload.response_url, { delete_original: true });
}

// Asks who should review the pull requests, after `lead` (what happened, if
// anything worth saying).
function reviewerPicker(lead, urls) {
  const them = urls.length === 1 ? urls.map(prLink).join("") : "them";
  const question = `There's no reviewer yet. Who should review ${lead ? (urls.length === 1 ? "it" : "them") : them}?`;
  const prompt = lead ? `${lead}\n${question}` : question;
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

// Assigns the chosen people as reviewers, and posts who did with the request
// to review, as a new reply, since an edited message notifies no one. The
// picker keeps what happened before its question, or goes if there was
// nothing. It is a reply in the task's thread.
async function chooseReviewers(payload, env) {
  const channel = payload.channel.id;
  const ts = payload.message.thread_ts;
  const chosen = payload.actions[0].selected_users ?? [];
  if (!chosen.length) return;

  const task = await loadTask(env, channel, ts);
  if (!task) {
    await callSlack(env, "chat.update", { channel, ts: payload.message.ts, ...asSection(NOT_A_TASK) });
    return;
  }
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
  const lead = (payload.message.text ?? "").split("\n").slice(0, -1).join("\n");
  if (lead) await callSlack(env, "chat.update", { channel, ts: payload.message.ts, ...asSection(lead) });
  else await callSlack(env, "chat.delete", { channel, ts: payload.message.ts });
  // Whoever picked themselves isn't asked.
  const others = chosen.filter((id) => id !== payload.user.id);
  const text = [assigned(payload.user.id, chosen, "reviewer"), others.length && request(others, "reviewer", urls)].filter(Boolean).join("\n");
  await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
}

// chat.update keeps a message's old blocks unless new ones are sent.
function asSection(text) {
  return { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
}
