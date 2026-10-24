import { roleOf } from "../channels.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { clientStatus, loadRequirement, reflectOnRequirement } from "../requirements.js";
import {
  NOT_A_TASK,
  REQUESTS,
  ROLES,
  STATUSES,
  loadTask,
  parseRole,
  prLink,
  saveTask,
  statusName,
} from "../tasks.js";
import { TRACK_ASSIGN_ACTION } from "./track.js";

const SUGGEST_ASSIGN_ACTION = "assign:suggest";
// One people picker per role, each with its own action_id.
const PICK_ACTIONS = Object.fromEntries(Object.keys(ROLES).map((role) => [role, `assign:pick:${role}`]));
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

// `@LUMA assign developer @person [@person …]` in a task thread adds people
// to that role; `reviewer` and `tester` work the same way. The reply mentions
// them with what to do next. Without anyone mentioned, `@LUMA assign
// developer` replies with a people picker for that role, and `@LUMA assign`
// with one for each role.
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
  section: "thread",
  channel: ["tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const role = parseRole(command.text);
    // No one mentioned: people pickers, for the role named or for every role.
    if (!command.mentions.length) {
      const task = await loadTask(env, command.channel, command.threadTs);
      if (!task) return NOT_A_TASK;
      return peoplePickers(task, role ? [role] : Object.keys(ROLES));
    }
    if (!role) {
      const examples = Object.keys(ROLES)
        .map((name) => `\`@LUMA assign ${name} @person\``)
        .join(", ");
      return `Say which role to assign: ${examples}.`;
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
    ...Object.fromEntries(
      Object.entries(PICK_ACTIONS).map(([role, actionId]) => [
        actionId,
        async (payload, context) => {
          context.waitUntil(pickPeople(payload, context.env, role));
        },
      ]),
    ),
    [SUGGEST_ASSIGN_ACTION]: async (payload, context) => {
      context.waitUntil(acceptAssignment(payload, context.env));
    },
    [SUGGEST_SKIP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};

// A people picker per role, showing who is assigned now. Changing one sets
// that role to the people chosen; the message stays, so assignments can be
// changed again later.
function peoplePickers(task, roles) {
  const prompt = roles.length === 1 ? `Who should be the ${ROLES[roles[0]].toLowerCase()}?` : "Who works on this task?";
  return {
    text: prompt,
    blocks: [
      { type: "section", text: mrkdwn(prompt) },
      ...roles.map((role) => ({
        type: "section",
        block_id: role,
        text: mrkdwn(`*${ROLES[role]}*`),
        accessory: {
          type: "multi_users_select",
          action_id: PICK_ACTIONS[role],
          placeholder: plainText(`Choose ${ROLES[role].toLowerCase()}s`),
          ...(task.people[role].length && { initial_users: task.people[role] }),
        },
      })),
    ],
  };
}

// Sets a role to the people chosen in its picker. Those newly added are
// asked as `@LUMA assign` would ask them; those removed aren't told, since
// the task card shows it. The picker is a reply in the task's thread.
async function pickPeople(payload, env, role) {
  const channel = payload.channel.id;
  const ts = payload.message.thread_ts;
  const chosen = payload.actions[0].selected_users ?? [];
  const task = await loadTask(env, channel, ts);
  if (!task) return;

  const added = chosen.filter((id) => !task.people[role].includes(id));
  task.people[role] = chosen;
  await saveTask(env, channel, ts, task);

  let text = null;
  if (added.length && REQUESTS[role]) text = `${mentions(added)} ${REQUESTS[role]}`;
  if (added.length && role === "reviewer" && task.prs.length) {
    text = `${mentions(added)}, please review ${task.prs.map(prLink).join(", ")}.`;
  }
  if (text) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
}

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

  // In a task's thread the hand-off is about that task. In a requirement's
  // thread, asking someone to start working is about its task; before there
  // is one, Luma offers to track it with them as developers.
  let target = { channel: event.channel, ts: event.thread_ts };
  let of = "";
  const place = roleOf(env, event.channel);
  if (place === "external") {
    if (role !== "developer") return;
    const requirement = await loadRequirement(env, event.channel, event.thread_ts);
    if (!requirement) return;
    if (!requirement.task) return offerTracking(env, event, requirement, mentioned);
    target = { channel: requirement.task.channel, ts: requirement.task.ts };
    of = ` of <${requirement.task.link}|${escapeSlack(requirement.task.title)}>`;
  } else if (!["tasks", "incidents"].includes(place)) {
    return;
  }

  const task = await loadTask(env, target.channel, target.ts);
  if (!task) return;
  const people = mentioned.filter((id) => !task.people[role].includes(id));
  // Handing a task over moves it on, even when the people were assigned
  // ahead of time.
  const moveTo = nextStatus(role, task.status);
  if (!people.length && !moveTo) return;

  const label = ROLES[role].toLowerCase();
  const them = people.length > 1 ? "them all" : "them";
  const asked = `You asked ${mentions(people.length ? people : mentioned)} to ${ASKED[role]}.`;
  let question = `${asked} Assign ${them} as ${label}${of}?`;
  let button = `Assign as ${label}`;
  if (moveTo) {
    const status = STATUSES[moveTo];
    const name = statusName(moveTo);
    question = people.length
      ? `${asked} Assign ${them} as ${label}${of} and move the task to ${status}?`
      : `${asked} Move the task to ${status}?`;
    button = people.length ? `Assign and move to ${name}` : `Move to ${name}`;
  }
  // Asked from the requirement thread, the people may not be in it, so the
  // task's thread asks them too.
  const fromRequirement = place === "external";
  const value = JSON.stringify({ channel: target.channel, ts: target.ts, role, people, moveTo, fromRequirement });
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
            text: { ...plainText(button), emoji: true },
            style: "primary",
            value,
          },
          { type: "button", action_id: SUGGEST_SKIP_ACTION, text: plainText("Not now"), value },
        ],
      },
    ],
  });
}

// Where a hand-off moves a task, and the statuses it moves it from: starting
// work moves a task that's To do to In progress, and testing moves one that
// isn't being tested yet to In testing. Reviews move with linked PRs instead
// (see pr.js). Assigning with `@LUMA assign` moves nothing, so people can be
// added ahead of time.
const MOVES = {
  developer: { to: "IN_PROGRESS", from: ["TODO"] },
  tester: { to: "IN_TESTING", from: ["TODO", "IN_PROGRESS", "IN_REVIEW"] },
};

// The status a hand-off to `role` moves a task in `status` to, or null.
function nextStatus(role, status) {
  const move = MOVES[role];
  return move?.from.includes(status) ? move.to : null;
}

// Asks whoever wrote it, privately, whether to track the requirement now with
// the people asked to start working on it as developers.
async function offerTracking(env, event, requirement, developers) {
  const them = developers.length > 1 ? "them all" : "them";
  const question = `You asked ${mentions(developers)} to work on this. Track it as a task and assign ${them} as developer?`;
  const { title, priority, dueDate, incident } = requirement;
  const origin = {
    channel: event.channel,
    threadTs: event.thread_ts,
    requirement: true,
    incident,
    title,
    priority,
    dueDate,
    developers,
  };
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
            action_id: TRACK_ASSIGN_ACTION,
            text: plainText("Track and assign"),
            style: "primary",
            value: JSON.stringify(origin),
          },
          {
            type: "button",
            action_id: SUGGEST_SKIP_ACTION,
            text: plainText("Not now"),
            value: JSON.stringify({ channel: event.channel }),
          },
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

// Assigns the suggested people and moves the task on as the question said,
// and removes the private question. In the task's thread, the person
// clicking wrote the message that asked them, so the thread only hears about
// a status change; the task card shows who was assigned. Asked from the
// requirement thread, the task's thread asks them as `@LUMA assign` would.
async function acceptAssignment(payload, env) {
  const { channel, ts, role, people, moveTo, fromRequirement } = JSON.parse(payload.actions[0].value);
  const task = await loadTask(env, channel, ts);
  const added = task ? people.filter((id) => !task.people[role].includes(id)) : [];
  // The task may have moved on since the question was asked.
  const moved = Boolean(task && moveTo && nextStatus(role, task.status) === moveTo);
  if (added.length || moved) {
    task.people[role] = [...task.people[role], ...added];
    if (moved) task.status = moveTo;
    await saveTask(env, channel, ts, task);
    // Clients see both as In progress, which the requirement shows already;
    // this keeps it right if that ever changes.
    if (moved) await reflectOnRequirement(env, ts, task, { status: clientStatus(task.status) });

    const lines = [];
    if (fromRequirement && added.length && REQUESTS[role]) lines.push(`${mentions(added)} ${REQUESTS[role]}`);
    if (moved) lines.push(`<@${payload.user.id}> moved the task to ${STATUSES[moveTo]}.`);
    if (lines.length) {
      await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: lines.join("\n") });
    }
  }
  // An ephemeral message can only be changed through its response_url.
  await respondLater(payload.response_url, { delete_original: true });
}
