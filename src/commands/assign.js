import { CLOSE_ALL, callSlack, dismiss, mrkdwn, plainText } from "../slack.js";
import { assigned, noLongerIfDue, oneMessage, requestIfDue, unassigned } from "../notify.js";
import { NOT_A_TASK, ROLES, loadTask, parseRole, saveTask } from "../tasks.js";

// A button per role opens a form to choose that role's people.
const CHOOSE_ACTIONS = Object.fromEntries(Object.keys(ROLES).map((role) => [role, `assign:choose:${role}`]));
const PEOPLE_VIEW = "assign:people";
const TEAM_VIEW = "assign:team";
const TEAM_ACTION = "assign:open-team";

// `@Cade assign developer @person [@person …]` in a task thread adds people
// to that role; `reviewer` and `tester` work the same way, and short words
// do too: `dev`, `review`, `test` or `qa`. The thread hears who assigned
// whom, and on the next line asks them to do their part.
// Without anyone mentioned, `@Cade assign` asks privately, with a button
// that opens the form with every role, filled in with who's assigned now,
// to add or remove people.
//
// People are only asked when there's something for them to do: reviewers
// added ahead of a PR are asked by `@Cade pr add` once there is one, and
// testers when the task moves to In testing (see notify.js).
//
// People also ask for roles in their own words, such as "@mia can you
// review this?". Then Cade asks whoever wrote it, privately, with a picker
// for that role (see suggest.js).
export default {
  name: "assign",
  description: "Assign a developer, reviewer or tester (in its thread)",
  usage: "@Cade assign dev @person",
  section: "thread",
  channel: ["tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const { channel, threadTs, user } = command;
    const role = parseRole(command.text);
    // No one mentioned: a private button that opens the form with every role.
    if (!command.mentions.length) return askTeam(env, command);
    if (!role) {
      const examples = ["dev", "review", "test"].map((name) => `\`@Cade assign ${name} @person\``).join(", ");
      return `Happy to! Which role should I assign them to? Try ${examples}.`;
    }

    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;
    task.people[role] = [...new Set([...task.people[role], ...command.mentions])];
    await saveTask(env, channel, threadTs, task);
    return oneMessage(teamChanges(user, task, [{ role, added: command.mentions, removed: [] }]));
  },
  views: { [PEOPLE_VIEW]: savePeople, [TEAM_VIEW]: saveTeam },
  actions: {
    // Opening a form must happen within Slack's three seconds of the click.
    [TEAM_ACTION]: async (payload, { env }) => {
      const { channel, ts } = JSON.parse(payload.actions[0].value);
      const task = await loadTask(env, channel, ts);
      if (!task) return;
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: teamForm({ channel, ts }, task) });
      // The private button has done its job once the form is open.
      await dismiss(payload.response_url);
    },
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
// opened it, removed once it's saved.
async function openPeopleForm(env, triggerId, { channel, ts, role, promptTs }) {
  const task = await loadTask(env, channel, ts);
  if (!task) return;
  await callSlack(env, "views.open", {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: PEOPLE_VIEW,
      private_metadata: JSON.stringify({ channel, ts, role, promptTs }),
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

// Sets the role to the people saved, tells the thread as the Assign people
// form does (see teamChanges), then removes the buttons.
function savePeople(payload, context) {
  const { channel, ts, role, promptTs } = JSON.parse(payload.view.private_metadata);
  const chosen = payload.view.state.values.people.value.selected_users ?? [];
  const user = payload.user.id;
  context.waitUntil(
    (async () => {
      const { env } = context;
      const task = await loadTask(env, channel, ts);
      if (!task) return;
      const added = chosen.filter((id) => !task.people[role].includes(id));
      const removed = task.people[role].filter((id) => !chosen.includes(id));
      task.people[role] = chosen;
      await saveTask(env, channel, ts, task);

      const text = oneMessage(teamChanges(user, task, [{ role, added, removed }]));
      if (text) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
      if (promptTs) await callSlack(env, "chat.delete", { channel, ts: promptTs });
    })(),
  );
}

// `@Cade assign` with no one mentioned asks whoever sent it, privately, with
// a button that opens the Assign people form; only a click carries the
// trigger_id a form needs.
async function askTeam(env, command) {
  const task = await loadTask(env, command.channel, command.threadTs);
  if (!task) return NOT_A_TASK;
  const text = "Who's working on this task?";
  await callSlack(env, "chat.postEphemeral", {
    channel: command.channel,
    thread_ts: command.threadTs,
    user: command.user,
    text,
    blocks: [
      { type: "section", text: mrkdwn(text) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: TEAM_ACTION,
            text: plainText("Assign people"),
            style: "primary",
            value: JSON.stringify({ channel: command.channel, ts: command.threadTs }),
          },
        ],
      },
    ],
  });
}

// The Assign people form, from the task card's menu (see menu.js) or `@Cade
// assign`: a people picker per role, filled in with who's assigned now, to
// add or remove people. `origin` is { channel, ts }.
export function teamForm(origin, task) {
  return {
    type: "modal",
    callback_id: TEAM_VIEW,
    private_metadata: JSON.stringify(origin),
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
      const text = oneMessage(teamChanges(user, task, changes));
      if (!text) return;
      await saveTask(env, channel, ts, task);
      await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
    })(),
  );
  return CLOSE_ALL;
}

// The thread's record of `user` changing who's on the task, as { log,
// notes } for oneMessage: the change log, a line per role for who was
// assigned and who was removed, and what it means for them, a line each,
// only when there's something for them to do now (see notify.js). Shared
// with `@Cade assign`, the Link PRs form, which sets reviewers too, and
// suggestions.
export function teamChanges(user, task, changes) {
  const log = [];
  const notes = [];
  for (const { role, added, removed } of changes) {
    if (added.length) log.push(assigned(user, added, role));
    if (removed.length) log.push(unassigned(user, removed, role));
    notes.push(added.length && requestIfDue(task, added, role), removed.length && noLongerIfDue(task, removed, role));
  }
  return { log, notes: notes.filter(Boolean) };
}
