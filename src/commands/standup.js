import { channelPairs, findPair } from "../channels.js";
import { userNames } from "../sheet.js";
import { callSlack, escapeSlack, mrkdwn, plainText, respondLater } from "../slack.js";
import { assigned, request } from "../notify.js";
import { STATUSES, loadTask, saveTask } from "../tasks.js";
import { setStatus, statusOption } from "./status.js";
import { OPEN, byUrgency, groupTasks, line } from "./tasks.js";

// Back and Next move to the step their value names. Slack wants each button
// in a block to have its own action_id, so they have one each.
const BACK_ACTION = "standup:back";
const NEXT_ACTION = "standup:next";
const END_ACTION = "standup:end";
// A step shows up to MAX_SHOWN tasks, each with its own menu, and Slack wants
// each menu's action_id to be different, so each place has its own.
const MAX_SHOWN = 20;
const STATUS_ACTIONS = Array.from({ length: MAX_SHOWN }, (_, i) => `standup:status:${i}`);
const ASSIGN_ACTIONS = Array.from({ length: MAX_SHOWN }, (_, i) => `standup:assign:${i}`);

// `/cade standup` in a group's tasks channel goes through the
// group's open tasks with whoever runs it, one developer at a time: you
// first, then everyone else by name, then the tasks with no developer. Each
// developer's step lists their tasks, most urgent first, each with a status
// menu that works as `@Cade status` does; the tasks with no developer each
// have a menu to pick one, which assigns them as `@Cade assign` does.
// Changes are posted in each task's thread, for the team to see.
//
// `/cade standup -unassigned` goes through just the tasks with no developer,
// one at a time, to pick each one's developer.
//
// Only whoever runs it sees it, so they can share their screen. Each step is
// read afresh from the database, so it shows changes made meanwhile. Its
// state (which walk, whose it is, which step) travels in its buttons and
// menus.
export default {
  name: "standup",
  description:
    "Go through the open tasks one developer at a time, only to you (`-unassigned` to give tasks a developer)",
  slashUsage: "/cade standup",
  section: "work",
  slashChannel: "tasks",
  async slash(command, context) {
    const option = command.text.trim();
    const unassigned = /^(?:--?|[—–])unassigned$/i.test(option);
    if (option && !unassigned) {
      return `I don't know "${escapeSlack(option)}" as an option. Send \`/cade standup\` to go through everyone's tasks, or \`/cade standup -unassigned\` for those with no developer.`;
    }
    const group = findPair(context.env, command.channel);
    const walk = { m: unassigned ? "unassigned" : "people", g: group.name, l: command.user, i: 0 };
    context.waitUntil((async () => respondLater(command.responseUrl, await render(context.env, walk)))());
  },
  actions: {
    ...Object.fromEntries(
      [BACK_ACTION, NEXT_ACTION].map((id) => [
        id,
        async (payload, context) => {
          context.waitUntil(show(payload, context.env, JSON.parse(payload.actions[0].value)));
        },
      ]),
    ),
    [END_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
    ...Object.fromEntries(
      STATUS_ACTIONS.map((id) => [
        id,
        async (payload, context) => {
          context.waitUntil(changeStatus(payload, context.env));
        },
      ]),
    ),
    ...Object.fromEntries(
      ASSIGN_ACTIONS.map((id) => [
        id,
        async (payload, context) => {
          context.waitUntil(assignDeveloper(payload, context.env));
        },
      ]),
    ),
  },
};

// Shows the walk's step `walk.i` in place of the message clicked.
async function show(payload, env, walk) {
  await respondLater(payload.response_url, { replace_original: true, ...(await render(env, walk)) });
}

// A task's status menu: sets it, tells its thread, and shows the step again.
async function changeStatus(payload, env) {
  const action = payload.actions[0];
  const { c: channel, t: ts, ...walk } = JSON.parse(action.block_id);
  const said = await setStatus(env, channel, ts, action.selected_option.value, payload.user.id);
  if (said) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: said });
  await show(payload, env, walk);
}

// A task's developer menu: assigns them, tells the task's thread and asks
// them to start, and shows the step again, where the task no longer is.
async function assignDeveloper(payload, env) {
  const action = payload.actions[0];
  const { c: channel, t: ts, ...walk } = JSON.parse(action.block_id);
  const developer = action.selected_user;
  const task = await loadTask(env, channel, ts);
  if (task && developer && !task.people.developer.includes(developer)) {
    task.people.developer = [...task.people.developer, developer];
    await saveTask(env, channel, ts, task);
    const user = payload.user.id;
    // Picking yourself needs no request.
    const asked = developer !== user && request([developer], "developer");
    const text = [assigned(user, [developer], "developer"), asked].filter(Boolean).join("\n");
    await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
  }
  await show(payload, env, walk);
}

// The walk's steps, read afresh: for a standup, { person, name, entries } per
// developer, whoever runs it first, then { entries } for the tasks with no
// developer; for -unassigned, { entries } with one task each.
async function steps(env, walk, url) {
  const group = channelPairs(env).find((pair) => pair.name === walk.g);
  const tasks = group ? await groupTasks(env, group, OPEN, url) : [];
  const unassigned = tasks.filter((entry) => !entry.task.people.developer.length).sort(byUrgency);
  if (walk.m === "unassigned") return unassigned.map((entry) => ({ entries: [entry] }));

  const developers = [...new Set(tasks.flatMap((entry) => entry.task.people.developer))];
  const names = Object.fromEntries(
    await Promise.all(developers.map(async (id) => [id, await userNames(env, [id])])),
  );
  // Whoever runs it goes first.
  const order = (id) => (id === walk.l ? 0 : 1);
  developers.sort((a, b) => order(a) - order(b) || names[a].localeCompare(names[b]));
  const people = developers.map((person) => ({
    person,
    name: names[person],
    entries: tasks.filter((entry) => entry.task.people.developer.includes(person)).sort(byUrgency),
  }));
  return unassigned.length ? [...people, { entries: unassigned }] : people;
}

// The message for step `walk.i`: its heading, its tasks with their menus, and
// Back, Next and End.
async function render(env, walk) {
  // Links are built from the workspace's address.
  const { url } = await callSlack(env, "auth.test", {});
  const all = await steps(env, walk, url);
  if (walk.i >= all.length) {
    const text = walk.m === "unassigned"
      ? `Every open ${walk.g} task has a developer. Nice!`
      : all.length ? "That's everyone. Thanks, all!" : `No one has open ${walk.g} tasks right now.`;
    return { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
  }

  const step = all[walk.i];
  const of = `${walk.i + 1} of ${all.length}`;
  let title;
  if (step.person) title = `*Standup: <@${step.person}>*  ·  ${of}`;
  else if (walk.m === "people") title = `*Standup: no developer yet*  ·  ${of}`;
  else title = `*Unassigned ${walk.g} tasks*  ·  ${of}`;
  const count = step.entries.length === 1 ? "1 open task" : `${step.entries.length} open tasks`;
  const blocks = [
    { type: "section", text: mrkdwn(title) },
    { type: "context", elements: [mrkdwn(`${count}  ·  ${walk.g}`)] },
  ];

  step.entries.slice(0, MAX_SHOWN).forEach((entry, place) => {
    const block_id = JSON.stringify({ ...walk, c: entry.channel, t: entry.ts });
    const accessory = step.person
      ? {
          type: "static_select",
          action_id: STATUS_ACTIONS[place],
          options: Object.keys(STATUSES).map(statusOption),
          initial_option: statusOption(entry.task.status),
        }
      : {
          type: "users_select",
          action_id: ASSIGN_ACTIONS[place],
          placeholder: plainText("Pick a developer"),
        };
    blocks.push({ type: "section", block_id, text: mrkdwn(line(entry)), accessory });
  });
  if (step.entries.length > MAX_SHOWN) {
    const more = step.entries.length - MAX_SHOWN;
    blocks.push({ type: "context", elements: [mrkdwn(`_…and ${more} more, after these._`)] });
  }

  const go = (action_id, i, text, style) => ({
    type: "button",
    action_id,
    text: plainText(text),
    value: JSON.stringify({ ...walk, i }),
    ...(style && { style }),
  });
  const buttons = [];
  if (walk.i > 0) buttons.push(go(BACK_ACTION, walk.i - 1, "◀ Back"));
  const next = all[walk.i + 1];
  if (next) {
    const label = walk.m === "unassigned" ? "Skip" : `Next: ${next.name ?? "No developer"}`;
    buttons.push(go(NEXT_ACTION, walk.i + 1, `${label} ▶`.slice(0, 75), "primary"));
  }
  buttons.push({
    type: "button",
    action_id: END_ACTION,
    text: plainText(next ? "End" : "Finish"),
    value: "end",
    ...(!next && { style: "primary" }),
  });
  blocks.push({ type: "actions", elements: buttons });
  return { text: `Standup: ${of}`, blocks };
}
