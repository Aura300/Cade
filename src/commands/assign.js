import { CLOSE_ALL, callSlack, dismiss, mentions, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, REQUESTS, ROLES, loadTask, parseRole, prLink, saveTask } from "../tasks.js";

// A button per role opens a form to choose that role's people.
const CHOOSE_ACTIONS = Object.fromEntries(Object.keys(ROLES).map((role) => [role, `assign:choose:${role}`]));
const PEOPLE_VIEW = "assign:people";
const TEAM_VIEW = "assign:team";
const TEAM_ACTION = "assign:open-team";

// `@Cade assign developer @person [@person …]` in a task thread adds people
// to that role; `reviewer` and `tester` work the same way, and short words
// do too: `dev`, `review`, `test` or `qa`. The reply mentions them with what
// to do next. Without anyone mentioned, `@Cade assign` asks privately, with
// a button that opens the form with every role, filled in with who's
// assigned now, to add or remove people.
//
// There is nothing to review until a pull request is linked, so reviewers
// can be added ahead of time: until then the reply names no one, so they are
// not notified, and `@Cade pr add` asks them to review once there is a PR.
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
        lines.push(`${mentions(added)}, could you review ${task.prs.map(prLink).join(", ")} when you get a chance? Thanks!`);
      }
      if (removed.length) lines.push(noLonger(removed, role));
      if (lines.length) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: lines.join("\n") });
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

// What each role does, for questions about a hand-off and for telling people
// they no longer need to.
export const ASKED = {
  developer: "work on this",
  reviewer: "review this",
  tester: "test this",
};
