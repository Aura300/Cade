import { projects, findProject } from "../channels.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { PRIORITIES, ROLES, STATUSES, prLines } from "../tasks.js";
import { OPEN, byUrgency, groupTasks } from "./tasks.js";

// First, Previous, Next and Last move to the task their value names. Slack
// wants each button in a block to have its own action_id, so they have one
// each.
const MOVES = ["first", "previous", "next", "last"].map((name) => `syncup:${name}`);
const END_ACTION = "syncup:end";

// `/cade syncup` in a group's dev channel goes through its open tasks with
// whoever runs it, one at a time, in the summary's order: incidents first,
// then by priority, then the soonest due date. Each step shows the task, its
// title linking to its thread, so clicking it opens the thread beside the
// walk; then its status, priority, due date, people and pull requests.
// First, Previous, Next and Last move through the tasks, and End closes it.
//
// Only whoever runs it sees it. Each step is read afresh from the database,
// so it shows changes made in the threads meanwhile; a task closed since
// drops out, and the walk stays within the tasks still open. Its state (the
// group and which task) travels in its buttons.
export default {
  name: "syncup",
  description: "Go through the open tasks one at a time, each linking to its thread, only to you",
  slashUsage: "/cade syncup",
  section: "work",
  slashChannel: "channel",
  async slash(command, context) {
    const walk = { g: findProject(context.env, command.channel).name, i: 0 };
    context.waitUntil((async () => respondLater(command.responseUrl, await render(context.env, walk)))());
  },
  actions: {
    ...Object.fromEntries(
      MOVES.map((id) => [
        id,
        async (payload, context) => {
          const walk = JSON.parse(payload.actions[0].value);
          context.waitUntil(
            (async () => respondLater(payload.response_url, { replace_original: true, ...(await render(context.env, walk)) }))(),
          );
        },
      ]),
    ),
    [END_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};

// The message for the walk's task `walk.i`, or the last one if fewer are
// open now: its heading, the task, and the buttons to move on.
async function render(env, walk) {
  // Links are built from the workspace's address.
  const { url } = await callSlack(env, "auth.test", {});
  const group = projects(env).find((pair) => pair.name === walk.g);
  const tasks = (group ? await groupTasks(env, group, OPEN, url) : []).sort(byUrgency);
  if (!tasks.length) {
    const text = `There are no open ${walk.g} tasks right now.`;
    return { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
  }

  const i = Math.min(walk.i, tasks.length - 1);
  const { task, link, incident } = tasks[i];
  const of = `${i + 1} of ${tasks.length}`;
  const people = Object.entries(ROLES)
    .filter(([role]) => task.people[role].length)
    .map(([role, name]) => `${name}s ${mentions(task.people[role])}`);
  const details = [
    [STATUSES[task.status], `${PRIORITIES[task.priority]} ${task.priority}`, `Due ${task.dueDate || "_none_"}`].join("  ·  "),
    people.length ? people.join("  ·  ") : "_Unassigned_",
    ...prLines(task),
  ];

  const go = (action_id, to, text, style) => ({
    type: "button",
    action_id,
    text: plainText(text),
    value: JSON.stringify({ ...walk, i: to }),
    ...(style && { style }),
  });
  const last = tasks.length - 1;
  const buttons = [
    ...(i > 0 ? [go(MOVES[0], 0, "⏮ First"), go(MOVES[1], i - 1, "◀ Previous")] : []),
    ...(i < last ? [go(MOVES[2], i + 1, "Next ▶", "primary"), go(MOVES[3], last, "Last ⏭")] : []),
    { type: "button", action_id: END_ACTION, text: plainText("End"), value: "end", ...(i === last && { style: "primary" }) },
  ];
  return {
    text: `Syncup: ${of}`,
    blocks: [
      { type: "context", elements: [mrkdwn(`*Syncup: ${escapeSlack(walk.g)}*  ·  ${of}`)] },
      { type: "section", text: mrkdwn(`${incident ? "*Incident:* " : ""}*<${link}|${escapeSlack(task.title)}>*`) },
      { type: "context", elements: [mrkdwn(details.join("\n").slice(0, 3000))] },
      { type: "actions", elements: buttons },
    ],
  };
}
