import { roleOf } from "../channels.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { NOT_A_TASK, STATUSES, loadTask, parsePullRequest, prLink, saveTask } from "../tasks.js";

const REVIEWERS_ACTION = "pr:reviewers";
const SUGGEST_LINK_ACTION = "pr:suggest-link";
const SUGGEST_SKIP_ACTION = "pr:suggest-skip";

// Slack sends links as <https://…> or <https://…|label>; pasted text may also
// hold bare addresses.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

const HOW = "Use `@LUMA pr add <link>` or `@LUMA pr remove <link>`.";

// `@LUMA pr add <link> [<link> …]` in a task thread links pull requests to the
// task, shown on the task's message as reponame/number; `@LUMA pr remove
// <link> [<link> …]` unlinks them. GitHub, GitLab and Bitbucket links are
// recognised.
//
// Linking moves a task that is To do or In progress to In review, and asks
// the task's reviewers to review it. With no reviewer yet, the
// reply asks who should review it, with a people picker; choosing assigns
// them as reviewers and asks them.
//
// People also paste pull requests into a task's thread without `@LUMA pr
// add`. Then Luma asks them, privately, whether to link them, with Link PRs
// and Not now buttons (see suggestPullRequests).
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
      const reply = await linkPullRequests(env, command.channel, command.threadTs, task, urls, command.user);
      return reply ?? "Those pull requests are already linked to this task.";
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
    [SUGGEST_LINK_ACTION]: async (payload, context) => {
      context.waitUntil(acceptSuggestion(payload, context.env));
    },
    [SUGGEST_SKIP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};

// Linking a pull request means the work is ready for review. Tasks further
// on (testing, client review, done) stay where they are.
const BEFORE_REVIEW = ["TODO", "IN_PROGRESS"];

// Links the pull requests that aren't linked yet and returns the reply for
// the task's thread, or null when they all were.
async function linkPullRequests(env, channel, ts, task, urls, user) {
  const added = urls.filter((url) => !task.prs.includes(url));
  if (!added.length) return null;
  task.prs = [...task.prs, ...added];
  // The requirement it came from shows In progress either way, so it needs
  // no update.
  const moved = BEFORE_REVIEW.includes(task.status);
  if (moved) task.status = "IN_REVIEW";
  await saveTask(env, channel, ts, task);
  const status = moved ? ` and moved the task to ${STATUSES.IN_REVIEW}` : "";
  const linked = `<@${user}> linked ${added.map(prLink).join(", ")}${status}.`;
  const reviewers = task.people.reviewer;
  if (reviewers.length) return `${linked}\n${reviewRequest(reviewers, added)}`;
  return reviewerPicker(linked, added);
}

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// For a message in a task's thread that holds pull request links but is not
// a command, asks whoever posted it, privately, whether to link the ones not
// linked yet, and whether to add the people it mentions who aren't reviewers
// yet as reviewers. Mentions in a message only one person sees notify no one.
export async function suggestPullRequests(event, env, botUserId) {
  const inThread = event.thread_ts && event.thread_ts !== event.ts;
  if (!inThread || event.subtype || event.bot_id) return;
  const text = event.text ?? "";
  const urls = [
    ...new Set(
      [...text.matchAll(LINK)]
        .map((match) => parsePullRequest(match[1] ?? match[2])?.url)
        .filter(Boolean),
    ),
  ];
  if (!urls.length) return;
  if (!["tasks", "incidents"].includes(roleOf(env, event.channel))) return;

  const task = await loadTask(env, event.channel, event.thread_ts);
  if (!task) return;
  const unlinked = urls.filter((url) => !task.prs.includes(url));
  const mentioned = [...new Set([...text.matchAll(USER_MENTION)].map(([, id]) => id))];
  const reviewers = mentioned.filter((id) => id !== botUserId && !task.people.reviewer.includes(id));
  if (!unlinked.length && !reviewers.length) return;

  const question = suggestion(unlinked, urls, reviewers);
  const base = { channel: event.channel, ts: event.thread_ts };
  const button = (label, fields, style) => ({
    type: "button",
    action_id: SUGGEST_LINK_ACTION,
    text: plainText(label),
    ...(style && { style }),
    value: JSON.stringify({ ...base, urls: [], reviewers: [], ...fields }),
  });
  const prs = unlinked.length === 1 ? "PR" : "PRs";
  const buttons = !unlinked.length
    ? [button(reviewers.length === 1 ? "Add reviewer" : "Add reviewers", { reviewers }, "primary")]
    : reviewers.length
      ? [
          button(reviewers.length === 1 ? "Link and add reviewer" : "Link and add reviewers", { urls: unlinked, reviewers }, "primary"),
          button("Just link", { urls: unlinked }),
        ]
      : [button(`Link ${prs}`, { urls: unlinked }, "primary")];

  await callSlack(env, "chat.postEphemeral", {
    channel: event.channel,
    thread_ts: event.thread_ts,
    user: event.user,
    text: question,
    blocks: [
      { type: "section", text: mrkdwn(question) },
      {
        type: "actions",
        elements: [
          ...buttons,
          { type: "button", action_id: SUGGEST_SKIP_ACTION, text: plainText("Not now"), value: JSON.stringify(base) },
        ],
      },
    ],
  });
}

function suggestion(unlinked, urls, reviewers) {
  const people = mentions(reviewers);
  const as = reviewers.length === 1 ? "as reviewer" : "as reviewers";
  if (!unlinked.length) return `Add ${people} ${as} of ${urls.map(prLink).join(", ")}?`;
  const them = unlinked.length === 1 ? "it" : "them";
  const posted = `You posted ${unlinked.map(prLink).join(", ")}`;
  if (!reviewers.length) return `${posted}. Link ${them} to this task?`;
  return `${posted} and mentioned ${people}. Link ${them} to this task and add ${people} ${as}?`;
}

// Applies the chosen suggestion: adds the reviewers, links the pull requests,
// says so in the task's thread as `@LUMA pr add` and `@LUMA assign reviewer`
// would, and removes the private question.
async function acceptSuggestion(payload, env) {
  const { channel, ts, urls = [], reviewers = [] } = JSON.parse(payload.actions[0].value);
  const user = payload.user.id;
  const task = await loadTask(env, channel, ts);
  let reply = null;
  if (task) {
    // Reviewers first, so linking asks them to review.
    const added = reviewers.filter((id) => !task.people.reviewer.includes(id));
    task.people.reviewer = [...task.people.reviewer, ...added];
    reply = await linkPullRequests(env, channel, ts, task, urls, user);
    if (!reply && added.length) {
      await saveTask(env, channel, ts, task);
      reply = `<@${user}> added ${mentions(added)} as ${added.length === 1 ? "reviewer" : "reviewers"}.`;
      if (task.prs.length) reply += `\n${reviewRequest(added, task.prs)}`;
    }
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
