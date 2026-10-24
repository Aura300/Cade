import { roleOf } from "../channels.js";
import { callSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { NOT_A_TASK, ROLES, loadTask, parseRole, prLink, saveTask } from "../tasks.js";

const SUGGEST_ASSIGN_ACTION = "assign:suggest";
const SUGGEST_SKIP_ACTION = "assign:suggest-skip";

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// Phrases that hand a task to the people a message mentions, by role, in the
// order they are checked: "please review this fix" asks for a review, not
// for development.
const HANDOFFS = [
  ["reviewer", /\breview/i],
  ["tester", /\b(test|qa|verify)/i],
  [
    "developer",
    /\b(start(ed)? working|work(ing)? on|look(ing)? into|pick (this |it )?up|take (this|it)|handle (this|it)|fix (this|it))\b/i,
  ],
];

// What Luma asks of people when they are assigned to each role.
const REQUESTS = {
  developer: "please start working on this.",
  tester: "please test this.",
};

// `@LUMA assign developer @person [@person …]` in a task thread adds people
// to that role; `reviewer` and `tester` work the same way. The reply mentions
// them with what to do next.
//
// There is nothing to review until a pull request is linked, so reviewers
// can be added ahead of time: until then the reply names no one, so they are
// not notified, and `@LUMA pr add` asks them to review once there is a PR.
//
// People also hand tasks over in their own words, such as "@rex please look
// into this". Then Luma asks whoever wrote it, privately, whether to assign
// them (see suggestAssignment).
export default {
  name: "assign",
  description: "Assign a developer, reviewer or tester (in its thread)",
  usage: "@LUMA assign developer @person",
  channel: ["tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const role = parseRole(command.text);
    if (!role) {
      const examples = Object.keys(ROLES)
        .map((name) => `\`@LUMA assign ${name} @person\``)
        .join(", ");
      return `Say which role to assign: ${examples}.`;
    }
    if (!command.mentions.length) {
      return `Mention who to assign, for example \`@LUMA assign ${role} @person\`.`;
    }

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    task.people[role] = [...new Set([...task.people[role], ...command.mentions])];
    await saveTask(env, command.channel, command.threadTs, task);
    if (role === "reviewer") {
      if (!task.prs.length) {
        const count = command.mentions.length === 1 ? "a reviewer" : `${command.mentions.length} reviewers`;
        return `<@${command.user}> added ${count}. They'll be asked to review when a PR is linked.`;
      }
      return `${mentions(command.mentions)}, please review ${task.prs.map(prLink).join(", ")}.`;
    }
    return `${mentions(command.mentions)} ${REQUESTS[role]}`;
  },
  actions: {
    [SUGGEST_ASSIGN_ACTION]: async (payload, context) => {
      context.waitUntil(acceptAssignment(payload, context.env));
    },
    [SUGGEST_SKIP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};

// For a message in a task's thread that mentions people with a phrase that
// hands them the task, asks whoever wrote it, privately, whether to assign
// the ones not already in that role. Other messages are left alone.
export async function suggestAssignment(event, env, botUserId) {
  const inThread = event.thread_ts && event.thread_ts !== event.ts;
  if (!inThread || event.subtype || event.bot_id) return;
  const text = event.text ?? "";
  const [role] = HANDOFFS.find(([, phrase]) => phrase.test(text)) ?? [];
  if (!role) return;
  const mentioned = [...new Set([...text.matchAll(USER_MENTION)].map(([, id]) => id))].filter(
    (id) => id !== botUserId,
  );
  if (!mentioned.length) return;
  if (!["tasks", "incidents"].includes(roleOf(env, event.channel))) return;

  const task = await loadTask(env, event.channel, event.thread_ts);
  if (!task) return;
  const people = mentioned.filter((id) => !task.people[role].includes(id));
  if (!people.length) return;

  const label = ROLES[role].toLowerCase();
  const question = `You asked ${mentions(people)} to ${ASKED[role]}. Assign ${people.length === 1 ? "them" : "them all"} as ${label}?`;
  const value = JSON.stringify({ channel: event.channel, ts: event.thread_ts, role, people });
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
          {
            type: "button",
            action_id: SUGGEST_ASSIGN_ACTION,
            text: plainText(`Assign as ${label}`),
            style: "primary",
            value,
          },
          { type: "button", action_id: SUGGEST_SKIP_ACTION, text: plainText("Not now"), value },
        ],
      },
    ],
  });
}

// How the question describes what the message asked for.
const ASKED = {
  developer: "work on this",
  reviewer: "review this",
  tester: "test this",
};

// Assigns the suggested people, says so in the thread without mentioning
// them again (the message that asked them already did), and removes the
// private question. Reviewers are asked to review if a PR is linked, as
// `@LUMA assign reviewer` would.
async function acceptAssignment(payload, env) {
  const { channel, ts, role, people } = JSON.parse(payload.actions[0].value);
  const task = await loadTask(env, channel, ts);
  const added = task ? people.filter((id) => !task.people[role].includes(id)) : [];
  if (added.length) {
    task.people[role] = [...task.people[role], ...added];
    await saveTask(env, channel, ts, task);
    const label = ROLES[role].toLowerCase();
    let text = `<@${payload.user.id}> added ${added.length === 1 ? `a ${label}` : `${added.length} ${label}s`}.`;
    if (role === "reviewer" && task.prs.length) {
      text = `${text}\n${mentions(added)}, please review ${task.prs.map(prLink).join(", ")}.`;
    }
    await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
  }
  // An ephemeral message can only be changed through its response_url.
  await respondLater(payload.response_url, { delete_original: true });
}
