import { roleOf } from "../channels.js";
import { intent } from "../intents.js";
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
// A button per role opens a form to choose that role's people.
const CHOOSE_ACTIONS = Object.fromEntries(Object.keys(ROLES).map((role) => [role, `assign:choose:${role}`]));
const PEOPLE_VIEW = "assign:people";
const SUGGEST_SKIP_ACTION = "assign:suggest-skip";

// The words that hand a task to the people a message mentions, by role (see
// intents.js for how phrases match). They're checked in `order`: "please
// review this fix" asks for a review, not for development.
const HANDOFFS = {
  reviewer: { order: 20, phrases: ["review*"] },
  tester: { order: 30, phrases: ["test*", "qa", "verify*"] },
  developer: {
    order: 40,
    phrases: [
      "start(ed)? working",
      "work(ing)? on",
      "look(ing)? into",
      "pick (this |it )?up",
      "take (this|it)",
      "take care of",
      "handle (this|it)",
      "fix (this|it)",
      // "assigned this to you", "assigning it to @rex"
      "assign(ed|ing)? (this|it)( task)? to",
      "over to you",
    ],
  },
};

const handOffIntents = Object.entries(HANDOFFS).map(([role, { order, phrases }]) =>
  intent({
    name: `hand-off:${role}`,
    order,
    phrases,
    needs: { thread: true, mention: true },
    handle: (message, { env }) => suggestAssignment(message, env, role),
  }),
);

// `@Cade assign developer @person [@person …]` in a task thread adds people
// to that role; `reviewer` and `tester` work the same way. The reply mentions
// them with what to do next. Without anyone mentioned, `@Cade assign`
// replies with a button per role (or just the one named), which opens a form
// with that role's people filled in, to add or remove people.
//
// There is nothing to review until a pull request is linked, so reviewers
// can be added ahead of time: until then the reply names no one, so they are
// not notified, and `@Cade pr add` asks them to review once there is a PR.
//
// People also hand tasks over in their own words, such as "@rex please look
// into this". Then Cade asks whoever wrote it, privately, whether to assign
// them (see suggestAssignment).
export default {
  name: "assign",
  description: "Assign a developer, reviewer or tester (in its thread)",
  usage: "@Cade assign developer @person",
  section: "thread",
  channel: ["tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const role = parseRole(command.text);
    // No one mentioned: a button for the role named, or for each role, that
    // opens a form to choose its people.
    if (!command.mentions.length) return roleButtons(role ? [role] : Object.keys(ROLES));
    if (!role) {
      const examples = Object.keys(ROLES)
        .map((name) => `\`@Cade assign ${name} @person\``)
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
  intents: handOffIntents,
  views: { [PEOPLE_VIEW]: savePeople },
  actions: {
    ...Object.fromEntries(
      Object.entries(CHOOSE_ACTIONS).map(([role, actionId]) => [
        actionId,
        // Opening a form must happen within Slack's three seconds of the click.
        (payload, { env }) => openPeopleForm(payload, env, role),
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

// Shared with `@Cade unassign`, whose form is the same: it shows who's
// assigned, to remove people as well as add them.
export function roleButtons(roles) {
  const prompt = roles.length === 1 ? `Who should be the ${ROLES[roles[0]].toLowerCase()}?` : "Who works on this task?";
  return {
    text: prompt,
    blocks: [
      { type: "section", text: mrkdwn(prompt) },
      {
        type: "actions",
        elements: roles.map((role) => ({
          type: "button",
          action_id: CHOOSE_ACTIONS[role],
          text: plainText(ROLES[role]),
          value: role,
        })),
      },
    ],
  };
}

// Opens the form for a role's people, filled in with who's assigned now. The
// buttons are a reply in the task's thread.
async function openPeopleForm(payload, env, role) {
  const channel = payload.channel.id;
  const ts = payload.message.thread_ts;
  const task = await loadTask(env, channel, ts);
  if (!task) return;
  await callSlack(env, "views.open", {
    trigger_id: payload.trigger_id,
    view: {
      type: "modal",
      callback_id: PEOPLE_VIEW,
      private_metadata: JSON.stringify({ channel, ts, role, promptTs: payload.message.ts }),
      title: plainText(ROLES[role]),
      submit: plainText("Save"),
      close: plainText("Cancel"),
      blocks: [
        {
          type: "input",
          block_id: "people",
          // Saving with no one clears the role.
          optional: true,
          label: plainText(`${ROLES[role]}s for ${task.title}`.slice(0, 2000)),
          element: {
            type: "multi_users_select",
            action_id: "value",
            placeholder: plainText(`Choose ${ROLES[role].toLowerCase()}s`),
            ...(task.people[role].length && { initial_users: task.people[role] }),
          },
        },
      ],
    },
  });
}

// Sets the role to the people saved, then removes the buttons. Those newly
// added are asked as `@Cade assign` would ask them, and those removed are
// told they no longer need to do it.
function savePeople(payload, context) {
  const { channel, ts, role, promptTs } = JSON.parse(payload.view.private_metadata);
  const chosen = payload.view.state.values.people.value.selected_users ?? [];
  context.waitUntil(
    (async () => {
      const { env } = context;
      const task = await loadTask(env, channel, ts);
      if (!task) return;
      const added = chosen.filter((id) => !task.people[role].includes(id));
      const removed = task.people[role].filter((id) => !chosen.includes(id));
      task.people[role] = chosen;
      await saveTask(env, channel, ts, task);

      const lines = [];
      if (added.length && REQUESTS[role]) lines.push(`${mentions(added)} ${REQUESTS[role]}`);
      if (added.length && role === "reviewer" && task.prs.length) {
        lines.push(`${mentions(added)}, please review ${task.prs.map(prLink).join(", ")}.`);
      }
      if (removed.length) lines.push(noLonger(removed, role));
      if (lines.length) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: lines.join("\n") });
      await callSlack(env, "chat.delete", { channel, ts: promptTs });
    })(),
  );
}

// Tells people removed from a role, or from every role (`role` null), that
// they no longer need to do it.
export function noLonger(people, role) {
  return `${mentions(people)}, you no longer need to ${ASKED[role] ?? ASKED.developer}.`;
}

// A hand-off intent's handler: for a message handing the task to the people
// it mentions as `role`, asks whoever wrote it, privately, whether to assign
// the ones not already in that role (and move the task on).
async function suggestAssignment(message, env, role) {
  const mentioned = message.mentions;

  // In a task's thread the hand-off is about that task. In a requirement's
  // thread, asking someone to start working is about its task; before there
  // is one, Cade offers to track it with them as developers.
  let target = { channel: message.channel, ts: message.threadTs };
  let of = "";
  const place = roleOf(env, message.channel);
  if (place === "external") {
    if (role !== "developer") return;
    const requirement = await loadRequirement(env, message.channel, message.threadTs);
    if (!requirement) return;
    if (!requirement.task) return offerTracking(env, message, requirement, mentioned);
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
    channel: message.channel,
    thread_ts: message.threadTs,
    user: message.user,
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
// (see pr.js). Assigning with `@Cade assign` moves nothing, so people can be
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
async function offerTracking(env, message, requirement, developers) {
  const them = developers.length > 1 ? "them all" : "them";
  const question = `You asked ${mentions(developers)} to work on this. Track it as a task and assign ${them} as developer?`;
  const { title, priority, dueDate, incident } = requirement;
  const origin = {
    channel: message.channel,
    threadTs: message.threadTs,
    requirement: true,
    incident,
    title,
    priority,
    dueDate,
    developers,
  };
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
            value: JSON.stringify({ channel: message.channel }),
          },
        ],
      },
    ],
  });
}

// What each role does, for questions about a hand-off and for telling people
// they no longer need to.
export const ASKED = {
  developer: "work on this",
  reviewer: "review this",
  tester: "test this",
};

// Assigns the suggested people and moves the task on as the question said,
// and removes the private question. In the task's thread, the person
// clicking wrote the message that asked them, so the thread only hears about
// a status change; the task card shows who was assigned. Asked from the
// requirement thread, the task's thread asks them as `@Cade assign` would.
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
