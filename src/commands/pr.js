import { roleOf } from "../channels.js";
import { intent } from "../intents.js";
import { loadRequirement, onTheTeam, reflectOnRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { NOT_A_TASK, STATUSES, loadTask, parsePullRequest, prLink, saveTask } from "../tasks.js";

const REVIEWERS_ACTION = "pr:reviewers";
const SUGGEST_LINK_ACTION = "pr:suggest-link";
// Slack needs each button in a row to have its own action_id, so "Just link"
// has one too; its value says what to do, as for the other button.
const SUGGEST_LINK_ONLY_ACTION = "pr:suggest-link-only";
const SUGGEST_SKIP_ACTION = "pr:suggest-skip";

// Slack sends links as <https://…> or <https://…|label>; pasted text may also
// hold bare addresses.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

const HOW = "Try `@Cade pr add <link>` or `@Cade pr remove <link>`.";

// `@Cade pr add <link> [<link> …]` in a task thread links pull requests to the
// task, shown on the task's message as reponame/number; `@Cade pr remove
// <link> [<link> …]` unlinks them. GitHub, GitLab and Bitbucket links are
// recognised.
//
// Linking moves a task that is To do or In progress to In review, and asks
// the task's reviewers to review it. With no reviewer yet, the
// reply asks who should review it, with a people picker; choosing assigns
// them as reviewers and asks them.
//
// People also paste pull requests into a task's thread without `@Cade pr
// add`. Then Cade asks them, privately, whether to link them, with Link PRs
// and Not now buttons (see suggestPullRequests).
export default {
  name: "pr",
  description: "Link or unlink pull requests (in a task thread)",
  usage: "@Cade pr add <link>",
  section: "thread",
  channel: ["tasks", "incidents"],
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
      const status = linked.moved ? ` and moved the task to ${STATUSES.IN_REVIEW}` : "";
      const text = `<@${command.user}> linked ${linked.added.map(prLink).join(", ")}${status}.`;
      const reviewers = task.people.reviewer;
      if (reviewers.length) return `${text}\n${reviewRequest(reviewers, linked.added)}`;
      return reviewerPicker(text, linked.added);
    }

    const removed = urls.filter((url) => task.prs.includes(url));
    if (!removed.length) return "Hmm, those pull requests aren't linked to this task.";
    task.prs = task.prs.filter((url) => !removed.includes(url));
    await saveTask(env, command.channel, command.threadTs, task);
    await reflectOnRequirement(env, command.threadTs, task, {});
    return `<@${command.user}> unlinked ${removed.map(prLink).join(", ")}.`;
  },
  // Checked before hand-offs: a message with PR links gets only this question.
  intents: [
    intent({
      name: "pr-link",
      order: 10,
      needs: { thread: true },
      match: (message) => pullRequestsIn(message.text).length > 0,
      handle: (message, { env }) => suggestPullRequests(message, env),
    }),
  ],
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
  },
};

// Linking a pull request means the work is ready for review. Tasks further
// on (testing, client review, done) stay where they are.
const BEFORE_REVIEW = ["TODO", "IN_PROGRESS"];

// Links the pull requests that aren't linked yet, moving the task to In
// review if it hadn't got that far. Returns { added, moved }, or null when
// they were all linked already.
async function addPullRequests(env, channel, ts, task, urls) {
  const added = urls.filter((url) => !task.prs.includes(url));
  if (!added.length) return null;
  task.prs = [...task.prs, ...added];
  // The requirement it came from shows In progress either way; it is
  // updated only to show the new PRs.
  const moved = BEFORE_REVIEW.includes(task.status);
  if (moved) task.status = "IN_REVIEW";
  await saveTask(env, channel, ts, task);
  await reflectOnRequirement(env, ts, task, {});
  return { added, moved };
}

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

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

// The pr-link intent's handler: for a message in a task's thread with pull
// request links, asks whoever posted it, privately, whether to link the ones not
// linked yet, and whether to add the people it mentions who aren't reviewers
// yet as reviewers. Mentions in a message only one person sees notify no one.
//
// Pasted in the thread of a tracked requirement or incident, the links are
// for its task, and only the team is asked (see onTheTeam); people mentioned
// there aren't offered as reviewers, since the client may be among them.
//
// The person clicking wrote the message, so accepting adds little to the
// thread: only a status change, and a review request for reviewers the
// message didn't mention.
async function suggestPullRequests(message, env) {
  const { text, botUserId } = message;
  const urls = pullRequestsIn(text);
  const place = roleOf(env, message.channel);
  let target = { channel: message.channel, ts: message.threadTs };
  if (place === "external") {
    const requirement = await loadRequirement(env, message.channel, message.threadTs);
    if (!requirement?.task || !(await onTheTeam(env, message.channel, message.user))) return;
    target = { channel: requirement.task.channel, ts: requirement.task.ts };
  } else if (!["tasks", "incidents"].includes(place)) {
    return;
  }

  const task = await loadTask(env, target.channel, target.ts);
  if (!task) return;
  const unlinked = urls.filter((url) => !task.prs.includes(url));
  // Those mentioned in the task's own thread; the requirement thread's
  // mentions notified people there, not in the task's thread.
  const mentioned = place === "external" ? [] : [...new Set([...text.matchAll(USER_MENTION)].map(([, id]) => id))];
  const reviewers = mentioned.filter((id) => id !== botUserId && !task.people.reviewer.includes(id));
  if (!unlinked.length && !reviewers.length) return;

  const question = suggestion(unlinked, urls, reviewers);
  // Who the message mentioned, so they aren't asked again.
  const base = { ...target, mentioned };
  const button = (label, fields, style, actionId = SUGGEST_LINK_ACTION) => ({
    type: "button",
    action_id: actionId,
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
          button("Just link", { urls: unlinked }, undefined, SUGGEST_LINK_ONLY_ACTION),
        ]
      : [button(`Link ${prs}`, { urls: unlinked }, "primary")];

  await callSlack(env, "chat.postEphemeral", {
    channel: message.channel,
    thread_ts: message.threadTs,
    user: message.user,
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
  if (!unlinked.length) return `Should I add ${people} ${as} of ${urls.map(prLink).join(", ")}?`;
  const them = unlinked.length === 1 ? "it" : "them";
  const posted = `I see you posted ${unlinked.map(prLink).join(", ")}`;
  if (!reviewers.length) return `${posted}. Should I link ${them} to this task?`;
  return `${posted} and mentioned ${people}. Should I link ${them} to this task and add ${people} ${as}?`;
}

// Applies the chosen suggestion, adding the reviewers and linking the pull
// requests, and removes the private question. The thread only hears what's
// new to it: the task moving to In review, a review request for reviewers
// the message didn't mention, or, with no reviewer at all, who should review.
async function acceptSuggestion(payload, env) {
  const { channel, ts, urls = [], reviewers = [], mentioned = [] } = JSON.parse(payload.actions[0].value);
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
    if (linked?.moved) lines.push(`<@${user}> moved the task to ${STATUSES.IN_REVIEW}.`);
    const unasked = task.people.reviewer.filter((id) => !mentioned.includes(id));
    if (linked && unasked.length) lines.push(reviewRequest(unasked, linked.added));
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

function reviewRequest(reviewers, urls) {
  return `${mentions(reviewers)}, could you review ${urls.map(prLink).join(", ")} when you get a chance? Thanks!`;
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
    // Whoever chose them sees the picker become the request.
    reply = reviewRequest(chosen, urls);
  }
  await callSlack(env, "chat.update", {
    channel,
    ts: payload.message.ts,
    text: reply,
    blocks: [{ type: "section", text: mrkdwn(reply) }],
  });
}
