import { roleOf } from "../channels.js";
import { intent, isQuestion, phraseTest } from "../intents.js";
import { CLOSE_ALL, callSlack, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { clientStatus, loadRequirement, onTheTeam, reflectOnRequirement } from "../requirements.js";
import {
  NOT_A_TASK,
  REQUESTS,
  ROLES,
  STARTED_NOTE,
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
const TEAM_VIEW = "assign:team";
const SUGGEST_SKIP_ACTION = "assign:suggest-skip";
// "Choose developers and move to In progress", offered to someone saying the
// work has started who isn't its developer (see suggestStart).
const CHOOSE_START_ACTION = "assign:choose-start";
// "Hand it over", offered when someone in a role asks others to do it.
const HAND_OVER_ACTION = "assign:hand-over";

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
      "start on (this|it)",
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
      // "I can't take this, @mia can you?", "handing this over to @rex"
      "hand(ing|ed)? (this |it )?over",
      "take over",
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

// The words someone uses to say they've started on the task themselves:
// "okay, started working on this", "on it", "picking this up". Mentioning
// someone makes it a hand-off instead, so these only count without one.
const STARTED = phraseTest([
  "start(ed|ing)? (working|work)",
  "start(ed|ing)? on (this|it)",
  "^(ok(ay)?,? )?on it",
  "i['’]?m on (this|it)",
  "working on (this|it)",
  "pick(ed|ing) (this |it )?up",
  "i['’]?ll pick (this |it )?up",
  "taking (this|it)",
  "i['’]?ll take (this|it)",
  "looking into (this|it)",
  "i['’]?ll look into (this|it)",
]);

const startedIntent = intent({
  name: "started",
  order: 45,
  needs: { thread: true },
  match: (message) => !message.mentions.length && !isQuestion(message) && STARTED(message),
  handle: (message, { env }) => suggestStart(message, env),
});

// The words that say the people a message mentions have started already:
// "@rex has started working on this", "@rex is on it". Checked before
// developer hand-offs, which ask someone to start ("@rex please start working
// on this").
const REPORTED = phraseTest([
  "started (working|work|on (this|it))",
  "(is|are|['’]s|['’]re) (already )?(working on|looking into|on) (this|it)",
  "(has|have|already|just) (picked|taken) (this |it )?(up|on)",
  "picked (this |it )?up",
  "took (this|it)( on| over)?",
  "(has|have) been working on (this|it)",
]);

const reportedIntent = intent({
  name: "started:reported",
  order: 38,
  needs: { thread: true, mention: true },
  match: (message) => !isQuestion(message) && REPORTED(message),
  handle: (message, { env }) => suggestReported(message, env),
});

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
// them (see suggestAssignment). Assigning a developer leaves the task To do;
// it moves to In progress when someone says they've started, such as "okay,
// started working on this", and clicks to confirm (see suggestStart).
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
      return `Happy to! Which role should I assign them to? Try ${examples}.`;
    }

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    task.people[role] = [...new Set([...task.people[role], ...command.mentions])];
    await saveTask(env, command.channel, command.threadTs, task);
    if (role === "reviewer") {
      if (!task.prs.length) {
        const count = command.mentions.length === 1 ? "a reviewer" : `${command.mentions.length} reviewers`;
        return `<@${command.user}> added ${count}. I'll ask them to review once a PR is linked.`;
      }
      return `${mentions(command.mentions)}, could you review ${task.prs.map(prLink).join(", ")} when you get a chance? Thanks!`;
    }
    return `${mentions(command.mentions)} ${REQUESTS[role]}`;
  },
  intents: [...handOffIntents, reportedIntent, startedIntent],
  views: { [PEOPLE_VIEW]: savePeople, [TEAM_VIEW]: saveTeam },
  actions: {
    ...Object.fromEntries(
      Object.entries(CHOOSE_ACTIONS).map(([role, actionId]) => [
        actionId,
        // Opening a form must happen within Slack's three seconds of the click.
        // The buttons are a reply in the task's thread.
        (payload, { env }) =>
          openPeopleForm(env, payload.trigger_id, {
            channel: payload.channel.id,
            ts: payload.message.thread_ts,
            role,
            promptTs: payload.message.ts,
          }),
      ]),
    ),
    [CHOOSE_START_ACTION]: async (payload, { env }) => {
      const { channel, ts } = JSON.parse(payload.actions[0].value);
      await openPeopleForm(env, payload.trigger_id, { channel, ts, role: "developer", moveTo: "IN_PROGRESS" });
      await respondLater(payload.response_url, { delete_original: true });
    },
    [SUGGEST_ASSIGN_ACTION]: async (payload, context) => {
      context.waitUntil(acceptAssignment(payload, context.env));
    },
    [HAND_OVER_ACTION]: async (payload, context) => {
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
  const prompt = roles.length === 1 ? `Who should be the ${ROLES[roles[0]].toLowerCase()}?` : "Who's working on this task?";
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

// Opens the form for a role's people of the task at `channel`/`ts`, filled in
// with who's assigned now. `promptTs` is the message with the buttons that
// opened it, removed once it's saved. With `moveTo`, saving also moves the
// task there, for "Choose developers and move to In progress", so someone
// has to be chosen.
async function openPeopleForm(env, triggerId, { channel, ts, role, promptTs, moveTo }) {
  const task = await loadTask(env, channel, ts);
  if (!task) return;
  await callSlack(env, "views.open", {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: PEOPLE_VIEW,
      private_metadata: JSON.stringify({ channel, ts, role, promptTs, moveTo }),
      title: plainText(ROLES[role]),
      submit: plainText(moveTo ? `Save and move` : "Save"),
      close: plainText("Cancel"),
      blocks: [
        {
          type: "input",
          block_id: "people",
          // Saving with no one clears the role.
          optional: !moveTo,
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
// told they no longer need to do it. With `moveTo`, the task moves there too,
// if it still can, and those added are told the work has started instead.
function savePeople(payload, context) {
  const { channel, ts, role, promptTs, moveTo } = JSON.parse(payload.view.private_metadata);
  const chosen = payload.view.state.values.people.value.selected_users ?? [];
  context.waitUntil(
    (async () => {
      const { env } = context;
      const task = await loadTask(env, channel, ts);
      if (!task) return;
      const added = chosen.filter((id) => !task.people[role].includes(id));
      const removed = task.people[role].filter((id) => !chosen.includes(id));
      task.people[role] = chosen;
      const moved = Boolean(moveTo && canMove(moveTo, task.status));
      if (moved) task.status = moveTo;
      await saveTask(env, channel, ts, task);
      if (moved) await reflectOnRequirement(env, ts, task, { status: clientStatus(task.status) });

      const lines = [];
      const user = payload.user.id;
      if (moved) {
        const others = added.filter((id) => id !== user);
        if (others.length) lines.push(`${mentions(others)} ${STARTED_NOTE}`);
        lines.push(`<@${user}> moved the task to ${STATUSES[moveTo]}.`);
      } else if (added.length && REQUESTS[role]) lines.push(`${mentions(added)} ${REQUESTS[role]}`);
      if (added.length && role === "reviewer" && task.prs.length) {
        lines.push(`${mentions(added)}, could you review ${task.prs.map(prLink).join(", ")} when you get a chance? Thanks!`);
      }
      if (removed.length) lines.push(noLonger(removed, role));
      if (lines.length) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: lines.join("\n") });
      if (promptTs) await callSlack(env, "chat.delete", { channel, ts: promptTs });
    })(),
  );
}

// The task card menu's Assign people form (see menu.js): a people picker per
// role, filled in with who's assigned now, to add or remove people.
export function teamForm({ channel, ts }, task) {
  return {
    type: "modal",
    callback_id: TEAM_VIEW,
    private_metadata: JSON.stringify({ channel, ts }),
    title: plainText("Assign people"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: Object.entries(ROLES).map(([role, label]) => ({
      type: "input",
      block_id: role,
      // Saving a role with no one clears it.
      optional: true,
      label: plainText(`${label}s`),
      element: {
        type: "multi_users_select",
        action_id: "value",
        placeholder: plainText(`Choose ${label.toLowerCase()}s`),
        ...(task.people[role].length && { initial_users: task.people[role] }),
      },
    })),
  };
}

// Sets each role to the people saved, then tells the thread who changed what
// (see teamChanges). Saving it unchanged posts nothing.
function saveTeam(payload, context) {
  const { channel, ts } = JSON.parse(payload.view.private_metadata);
  const { values } = payload.view.state;
  const user = payload.user.id;
  context.waitUntil(
    (async () => {
      const { env } = context;
      const task = await loadTask(env, channel, ts);
      if (!task) {
        await callSlack(env, "chat.postEphemeral", { channel, user, text: NOT_A_TASK });
        return;
      }
      const changes = Object.keys(ROLES).map((role) => {
        const chosen = values[role]?.value.selected_users ?? [];
        const change = {
          role,
          added: chosen.filter((id) => !task.people[role].includes(id)),
          removed: task.people[role].filter((id) => !chosen.includes(id)),
        };
        task.people[role] = chosen;
        return change;
      });
      const lines = teamChanges(user, task, changes);
      if (!lines.length) return;
      await saveTask(env, channel, ts, task);
      await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: lines.join("\n") });
    })(),
  );
  return CLOSE_ALL;
}

// The thread's record of `user` changing who's on the task: those added are
// asked what `@Cade assign` asks them, and those removed told they no longer
// need to do it. Reviewers are only named once there's a PR to review.
// Shared with the Link PRs form, which sets reviewers too.
export function teamChanges(user, task, changes) {
  return changes.flatMap(({ role, added, removed }) => {
    const lines = [];
    if (added.length && role === "reviewer" && !task.prs.length) {
      const count = added.length === 1 ? "a reviewer" : `${added.length} reviewers`;
      lines.push(`<@${user}> added ${count}. I'll ask them to review once a PR is linked.`);
    } else if (added.length) {
      const ask =
        role === "reviewer"
          ? `could you review ${task.prs.map(prLink).join(", ")} when you get a chance? Thanks!`
          : REQUESTS[role];
      lines.push(`<@${user}> assigned ${mentions(added)} as ${role}: ${ask}`);
    }
    if (removed.length) {
      lines.push(`<@${user}> removed ${mentions(removed)} as ${role}, so there's no need to ${ASKED[role]} anymore. Thanks!`);
    }
    return lines;
  });
}

// Tells people removed from a role, or from every role (`role` null), that
// they no longer need to do it.
export function noLonger(people, role) {
  return `${mentions(people)}, you don't need to ${ASKED[role] ?? ASKED.developer} anymore. Thanks!`;
}

// A hand-off intent's handler: for a message handing the task to the people
// it mentions as `role`, asks whoever wrote it, privately, whether to assign
// the ones not already in that role (and move the task on).
async function suggestAssignment(message, env, role) {
  const mentioned = message.mentions;

  // In a task's thread the hand-off is about that task. In a requirement's
  // thread, asking someone to start working is about its task; before there
  // is one, Cade offers to track it with them as developers.
  if (roleOf(env, message.channel) === "external" && role !== "developer") return;
  const about = await threadTask(env, message);
  if (!about) return;
  if (about.requirement) return offerTracking(env, message, about.requirement, mentioned);
  const { target, of, task, place } = about;
  const people = mentioned.filter((id) => !task.people[role].includes(id));
  // Handing a task over moves it on, even when the people were assigned
  // ahead of time.
  const moveTo = nextStatus(role, task.status);
  if (!people.length && !moveTo) return;

  const label = ROLES[role].toLowerCase();
  const them = people.length > 1 ? "them all" : "them";
  const asked = `Looks like you asked ${mentions(people.length ? people : mentioned)} to ${ASKED[role]}.`;
  let question = `${asked} Should I assign ${them} as ${label}${of}?`;
  let button = `Assign as ${label}`;
  if (moveTo) {
    const status = STATUSES[moveTo];
    const name = statusName(moveTo);
    question = people.length
      ? `${asked} Should I assign ${them} as ${label}${of} and move the task to ${status}?`
      : `${asked} Should I move the task to ${status}?`;
    button = people.length ? `Assign and move to ${name}` : `Move to ${name}`;
  }
  // Asked from the requirement thread, the people may not be in it, so the
  // task's thread asks them too.
  const fromRequirement = place === "external";
  const fields = { channel: target.channel, ts: target.ts, role, people, moveTo, fromRequirement };
  const buttons = [assignButton(button, JSON.stringify(fields))];
  // Someone in the role asking others to do it may be handing it over: "I
  // can't take this, @mia can you?". Then Cade also offers to take them off.
  if (people.length && task.people[role].includes(message.user) && !mentioned.includes(message.user)) {
    question += ` Or hand it over to ${them}, so you're no longer the ${label}?`;
    buttons.push({
      type: "button",
      action_id: HAND_OVER_ACTION,
      text: { ...plainText(moveTo ? `Hand over and move to ${statusName(moveTo)}` : "Hand it over"), emoji: true },
      value: JSON.stringify({ ...fields, replace: message.user }),
    });
  }
  await askToAssign(env, message, question, buttons);
}

// The task a thread is about, for the suggestions above, or null when there
// is none: in a task's thread, that task; in a requirement's or incident's
// thread in the external channel, the task it was tracked as. There, Cade
// only makes the team's suggestions to the team (see onTheTeam). Returns {
// target, of, task, place } (`of` names the task, for a question asked in the
// requirement thread), or { requirement } for a requirement not tracked yet.
async function threadTask(env, message) {
  const place = roleOf(env, message.channel);
  let target = { channel: message.channel, ts: message.threadTs };
  let of = "";
  if (place === "external") {
    const requirement = await loadRequirement(env, message.channel, message.threadTs);
    if (!requirement || !(await onTheTeam(env, message.channel, message.user))) return null;
    if (!requirement.task) return { requirement };
    target = { channel: requirement.task.channel, ts: requirement.task.ts };
    of = ` of <${requirement.task.link}|${escapeSlack(requirement.task.title)}>`;
  } else if (!["tasks", "incidents"].includes(place)) {
    return null;
  }
  const task = await loadTask(env, target.channel, target.ts);
  return task ? { target, of, task, place } : null;
}

// The started intent's handler: for someone saying they've started on the
// work, in its task's thread or in the requirement or incident thread it was
// tracked from, asks them, privately, whether to move the task to In
// progress. A developer's word just moves it. Anyone else is offered to be
// assigned as developer too, or to choose its developers, either of which
// moves it if it's To do. A requirement that isn't tracked yet is offered to
// be tracked, In progress, the same two ways.
async function suggestStart(message, env) {
  const about = await threadTask(env, message);
  if (!about) return;
  if (about.requirement) return offerStartedTracking(env, message, about.requirement);
  const { target, of, task } = about;
  if (task.status === "DONE") return;
  const developer = task.people.developer.includes(message.user);
  const moveTo = canMove("IN_PROGRESS", task.status) ? "IN_PROGRESS" : null;
  if (developer && !moveTo) return;

  const status = STATUSES.IN_PROGRESS;
  const name = statusName("IN_PROGRESS");
  const value = (people) =>
    JSON.stringify({ ...target, role: "developer", people, moveTo, fromRequirement: false });
  if (developer) {
    const question = `Sounds like you've started on this. Should I move the task${of} to ${status}?`;
    return askToAssign(env, message, question, [assignButton(`Move to ${name}`, value([]))]);
  }
  if (!moveTo) {
    const question = `Sounds like you're working on this. Should I assign you as developer${of}?`;
    return askToAssign(env, message, question, [assignButton("Assign me as developer", value([message.user]))]);
  }
  const question = `Sounds like the work${of} has started. Should I move the task to ${status}, with you or others as developer?`;
  await askToAssign(env, message, question, [
    assignButton(`Assign me and move to ${name}`, value([message.user])),
    {
      type: "button",
      action_id: CHOOSE_START_ACTION,
      text: { ...plainText(`Choose developers and move to ${name}`), emoji: true },
      value: JSON.stringify(target),
    },
  ]);
}

// The started:reported intent's handler: for a message saying the people it
// mentions have started, asks whoever wrote it, privately, whether to assign
// them as developers and move the task to In progress, or to track a
// requirement that isn't tracked yet that way.
async function suggestReported(message, env) {
  const about = await threadTask(env, message);
  if (!about) return;
  const mentioned = message.mentions;
  if (about.requirement) return offerStartedTracking(env, message, about.requirement, mentioned);
  const { target, of, task, place } = about;
  if (task.status === "DONE") return;
  const people = mentioned.filter((id) => !task.people.developer.includes(id));
  const moveTo = canMove("IN_PROGRESS", task.status) ? "IN_PROGRESS" : null;
  if (!people.length && !moveTo) return;

  const them = people.length > 1 ? "them all" : "them";
  const assign = `assign ${them} as developer${of}`;
  const move = `move the task${people.length ? "" : of} to ${STATUSES.IN_PROGRESS}`;
  const should = people.length && moveTo ? `${assign} and ${move}` : people.length ? assign : move;
  const question = `Sounds like ${mentions(mentioned)} started on this. Should I ${should}?`;
  const name = statusName("IN_PROGRESS");
  const button = people.length && moveTo ? `Assign and move to ${name}` : people.length ? "Assign as developer" : `Move to ${name}`;
  // Asked from the requirement thread, the people may not be in the task's
  // thread, so it tells them.
  const value = JSON.stringify({ ...target, role: "developer", people, moveTo, fromRequirement: place === "external", started: true });
  await askToAssign(env, message, question, [assignButton(button, value)]);
}

// For someone saying the work on a requirement that isn't tracked yet has
// started: offers to track it, In progress, with them as developer, or with
// the developers chosen in the form. When the message says who started,
// `developers`, it offers to track it with them instead.
async function offerStartedTracking(env, message, requirement, developers) {
  const { title, priority, dueDate, incident } = requirement;
  const origin = {
    channel: message.channel,
    threadTs: message.threadTs,
    requirement: true,
    incident,
    title,
    priority,
    dueDate,
    started: true,
  };
  const track = (text, fields, style) => ({
    type: "button",
    action_id: TRACK_ASSIGN_ACTION,
    text: plainText(text),
    ...(style && { style }),
    value: JSON.stringify({ ...origin, ...fields }),
  });
  if (developers?.length) {
    const them = developers.length > 1 ? "them all" : "them";
    const question = `Sounds like ${mentions(developers)} started on this. Should I track it as a task, ${STATUSES.IN_PROGRESS}, and assign ${them} as developer?`;
    return askToAssign(env, message, question, [track(`Track and assign ${them}`, { developers }, "primary")]);
  }
  const question = `Sounds like the work has started. Should I track this as a task, ${STATUSES.IN_PROGRESS}?`;
  await askToAssign(env, message, question, [
    track("Track and assign me", { developers: [message.user] }, "primary"),
    track("Track and choose developers", { chooseDevelopers: true }),
  ]);
}

// The button that accepts an assignment (see acceptAssignment).
function assignButton(text, value) {
  return { type: "button", action_id: SUGGEST_ASSIGN_ACTION, text: { ...plainText(text), emoji: true }, style: "primary", value };
}

// Asks whoever wrote `message`, privately in its thread, `question`, with
// `buttons`, then Not now.
async function askToAssign(env, message, question, buttons) {
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
          { type: "button", action_id: SUGGEST_SKIP_ACTION, text: plainText("Not now"), value: buttons[0].value },
        ],
      },
    ],
  });
}

// The statuses a suggestion can move a task to, and the statuses it moves it
// from: starting work moves a task that's To do to In progress, and testing
// moves one that isn't being tested yet to In testing.
const MOVES_FROM = {
  IN_PROGRESS: ["TODO"],
  IN_TESTING: ["TODO", "IN_PROGRESS", "IN_REVIEW"],
};

// Where a hand-off moves a task: a hand-off to a tester moves it to In
// testing. Handing it to a developer moves nothing, since the work only
// starts when they say so (see suggestStart), and reviews move with linked
// PRs instead (see pr.js). Assigning with `@Cade assign` moves nothing
// either, so people can be added ahead of time.
const HANDOFF_MOVES = { tester: "IN_TESTING" };

function canMove(to, status) {
  return Boolean(MOVES_FROM[to]?.includes(status));
}

// The status a hand-off to `role` moves a task in `status` to, or null.
function nextStatus(role, status) {
  const to = HANDOFF_MOVES[role];
  return to && canMove(to, status) ? to : null;
}

// Asks whoever wrote it, privately, whether to track the requirement now with
// the people asked to start working on it as developers.
async function offerTracking(env, message, requirement, developers) {
  const them = developers.length > 1 ? "them all" : "them";
  const question = `Looks like you asked ${mentions(developers)} to work on this. Should I track it as a task and assign ${them} as developer?`;
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
// requirement thread, the task's thread asks them as `@Cade assign` would,
// or, when they've started already, tells them. Handing it over (`replace`)
// also takes whoever handed it over off the role.
async function acceptAssignment(payload, env) {
  const { channel, ts, role, people, moveTo, fromRequirement, started, replace } = JSON.parse(payload.actions[0].value);
  const task = await loadTask(env, channel, ts);
  const added = task ? people.filter((id) => !task.people[role].includes(id)) : [];
  const removed = Boolean(task && replace && task.people[role].includes(replace));
  // The task may have moved on since the question was asked.
  const moved = Boolean(task && moveTo && canMove(moveTo, task.status));
  if (added.length || moved || removed) {
    task.people[role] = [...task.people[role], ...added].filter((id) => id !== replace);
    if (moved) task.status = moveTo;
    await saveTask(env, channel, ts, task);
    // Clients see both as In progress, which the requirement shows already;
    // this keeps it right if that ever changes.
    if (moved) await reflectOnRequirement(env, ts, task, { status: clientStatus(task.status) });

    const lines = [];
    const note = started ? STARTED_NOTE : REQUESTS[role];
    if (fromRequirement && added.length && note) lines.push(`${mentions(added)} ${note}`);
    if (moved) lines.push(`<@${payload.user.id}> moved the task to ${STATUSES[moveTo]}.`);
    if (lines.length) {
      await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: lines.join("\n") });
    }
  }
  // An ephemeral message can only be changed through its response_url.
  await respondLater(payload.response_url, { delete_original: true });
}
