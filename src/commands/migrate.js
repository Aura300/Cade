import { roleOf, tasksChannelFor } from "../channels.js";
import { loadRequirement } from "../requirements.js";
import { callSlack, mentions, messageBody, mrkdwn, plainText, respondLater } from "../slack.js";
import {
  NOT_A_TASK,
  REQUESTS,
  ROLES,
  STARTED_NOTE,
  STATUSES,
  loadTask,
  noPeople,
  prLink,
  readTaskForm,
  saveTask,
  taskFormBlocks,
} from "../tasks.js";
import { firstLine, moveMessage } from "./move.js";
import { linkPullRequests, pullRequestsIn } from "./pr.js";
import { createRequirement } from "./requirement.js";
import { setStatus, statusOption } from "./status.js";
import { createTask } from "./track.js";

const THREADS_VIEW = "migrate:threads";
const DETAILS_VIEW = "migrate:details";
// The threads form's checkbox for linking the pull requests found.
const LINK_PRS = "link";
const SAVE_ACTION = "migrate:save";
const SKIP_SETUP_ACTION = "migrate:skip-setup";
// The setup question's menus, for the task's status and each role's people:
// a block and an action each. Picking only chooses; Save saves.
const FIELDS = ["status", ...Object.keys(ROLES)];
const PICK_ACTIONS = Object.fromEntries(FIELDS.map((field) => [field, `migrate:pick:${field}`]));
const fieldBlock = (field) => `migrate:${field}`;

// A message's link, from Copy link: …/archives/<channel>/p<ts without its
// dot>, with ?thread_ts=… when the message is a reply.
const MESSAGE_LINK = /^https?:\/\/[^/\s]+\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?\S*)?$/;

// A modal's private_metadata holds at most 3,000 characters, which the
// threads to move must fit in.
const METADATA_LIMIT = 3000;

// `/cade migrate` brings work discussed before Cade into it. In an external
// channel, a form asks for links to the old requirement threads in that
// channel and the dev threads for them in the pair's tasks channel. A second
// form then asks for the requirement's name, priority and due date, named
// from the oldest requirement thread's first line. Submitting starts the
// requirement, as `/cade requirement` would, and moves each old requirement
// thread into it, oldest first, as `@Cade move` would; then tracks its task
// with the same name, as `@Cade track` would, and moves the dev threads into
// the task's thread.
//
// Work with only dev threads is migrated as the team's own task, as `/cade
// track` would track it: from a tasks channel the form asks only for dev
// threads, and from an external channel the requirement threads can be left
// out. The second form is then the task's, named from the oldest dev thread.
//
// Whoever migrated it then gets, privately in the task's thread, what was
// moved, and a question where the task is at and who's on it, with menus for
// its status and, if there are any yet, its developers, reviewers and
// testers. Unless the threads form's "Link the PRs" box was unticked, the
// pull requests linked anywhere in the old threads are linked to the task
// first, as `@Cade pr add` would. From then on it is an ordinary task.
export default {
  name: "migrate",
  description: "Bring old requirement and dev threads into a new requirement and its task",
  slashUsage: "/cade migrate",
  section: "start",
  channel: ["external", "tasks"],
  async slash(command, { env }) {
    await callSlack(env, "views.open", {
      trigger_id: command.triggerId,
      view: threadsView(command.channel, roleOf(env, command.channel) === "external"),
    });
  },
  views: { [THREADS_VIEW]: chooseThreads, [DETAILS_VIEW]: submit },
  actions: {
    ...Object.fromEntries(Object.values(PICK_ACTIONS).map((actionId) => [actionId, async () => {}])),
    [SAVE_ACTION]: async (payload, context) => {
      context.waitUntil(saveSetup(context.env, payload));
    },
    [SKIP_SETUP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
};

function threadsView(channel, external) {
  const links = (block_id, label, hint, optional) => ({
    type: "input",
    block_id,
    optional,
    label: plainText(label),
    hint: plainText(hint),
    element: { type: "plain_text_input", action_id: "value", multiline: true },
  });
  const intro = external
    ? "I'll start a requirement and move the old threads about it into its thread, then track its task and move the old dev threads into the task's thread. With only dev threads, I'll just track the task."
    : "I'll track a task and move the old threads about it into its thread.";
  const copy = "one per line. Use Copy link on each message.";
  return {
    type: "modal",
    callback_id: THREADS_VIEW,
    private_metadata: JSON.stringify({ channel }),
    title: plainText("Migrate"),
    submit: plainText("Next"),
    close: plainText("Cancel"),
    blocks: [
      { type: "section", text: mrkdwn(intro) },
      ...(external
        ? [
            links("requirements", "Requirement threads", `Links to the messages in this channel, ${copy}`, true),
            links("dev", "Dev threads", `Links to the messages in the dev channel, ${copy}`, true),
          ]
        : [links("dev", "Dev threads", `Links to the messages in this channel, ${copy}`, false)]),
      {
        type: "input",
        block_id: "prs",
        optional: true,
        label: plainText("Pull requests"),
        element: { type: "checkboxes", action_id: "value", options: [linkPrsOption], initial_options: [linkPrsOption] },
      },
    ],
  };
}

const linkPrsOption = {
  text: plainText("Link the PRs found in the old threads to the task"),
  value: LINK_PRS,
};

// Reads the links in the first form and opens the second, or says what's
// wrong with them. It answers Slack's submission, so it reads only the
// database and the oldest thread, to name the requirement or task.
async function chooseThreads(payload, { env }) {
  const { channel } = JSON.parse(payload.view.private_metadata);
  const { values } = payload.view.state;
  const external = roleOf(env, channel) === "external";
  const tasksChannel = tasksChannelFor(env, channel);
  const errors = {};
  const read = async (block, inChannel, where) => {
    const found = threadsIn(values[block]?.value.value ?? "", inChannel, where);
    if (typeof found === "string") errors[block] = found;
    else errors[block] = (await alreadyThreads(env, inChannel, found)) ?? undefined;
    return Array.isArray(found) ? found : [];
  };
  const requirements = external ? await read("requirements", channel, "this channel") : [];
  const dev = await read("dev", tasksChannel, external ? "the dev channel" : "this channel");

  // Named from the oldest requirement thread, or with none, the oldest dev
  // thread.
  const [block, oldest] = requirements.length ? ["requirements", [channel, requirements[0]]] : ["dev", [tasksChannel, dev[0]]];
  let title = "";
  if (errors.requirements || errors.dev) {
    // Said already.
  } else if (!oldest[1]) {
    errors[external ? "requirements" : "dev"] = "Please paste a link to at least one message.";
  } else {
    const root = await rootMessage(env, ...oldest).catch((error) => {
      console.warn("Could not read the oldest thread", { ts: oldest[1], error: error.message });
      return {};
    });
    if (!root) errors[block] = "I can't find the first of those messages. Has it been deleted?";
    else title = firstLine(root.text ?? "");
  }

  // Ticked unless unticked.
  const linkPrs = values.prs ? (values.prs.value.selected_options ?? []).some((option) => option.value === LINK_PRS) : true;
  const migration = { channel, requirements, dev, linkPrs };
  if (JSON.stringify(migration).length > METADATA_LIMIT - 200) {
    errors[block] = "That's more threads than I can move at once. Try fewer, then `@Cade move` the rest.";
  }
  const problems = Object.fromEntries(Object.entries(errors).filter(([, error]) => error));
  if (Object.keys(problems).length) return { response_action: "errors", errors: problems };
  return { response_action: "update", view: detailsView({ ...migration, title }) };
}

// The thread root timestamps linked in `text`, each once and oldest first,
// or why they can't be moved. A link to a reply stands for its thread.
function threadsIn(text, channel, where) {
  const timestamps = new Set();
  for (const word of text.split(/\s+/).filter(Boolean)) {
    // Pasted with Slack's formatting, a link may be <link> or <link|label>.
    const url = word.replace(/^<|>$/g, "").split("|")[0];
    const match = MESSAGE_LINK.exec(url);
    if (!match) return `That doesn't look like a link to a Slack message: ${word.slice(0, 100)}`;
    if (match[1] !== channel) return `That message isn't in ${where}: ${word.slice(0, 100)}`;
    timestamps.add(new URL(url).searchParams.get("thread_ts") ?? `${match[2]}.${match[3]}`);
  }
  return [...timestamps].sort((a, b) => Number(a) - Number(b));
}

// Why threads can't be moved because Cade already follows them, or null.
async function alreadyThreads(env, channel, timestamps) {
  for (const ts of timestamps) {
    if (await loadRequirement(env, channel, ts)) return "One of those is already a requirement thread.";
    if (await loadTask(env, channel, ts)) return "One of those is already a task thread.";
  }
  return null;
}

// The requirement's form, or with no requirement threads, the task's.
function detailsView({ title, ...migration }) {
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const dev = count(migration.dev.length, "dev thread");
  const plan = migration.requirements.length
    ? `I'll start the requirement with ${count(migration.requirements.length, "old thread")} moved into it, and track its task with the same name${
        migration.dev.length ? `, then move ${dev} into its thread` : ""
      }.`
    : `I'll track the task and move ${dev} into its thread.`;
  return {
    type: "modal",
    callback_id: DETAILS_VIEW,
    private_metadata: JSON.stringify(migration),
    title: plainText("Migrate"),
    submit: plainText("Migrate"),
    close: plainText("Cancel"),
    blocks: [
      ...taskFormBlocks(migration.requirements.length ? "Requirement name" : "Task title", { title }),
      { type: "context", elements: [mrkdwn(plan)] },
    ],
  };
}

async function submit(payload, context) {
  const migration = JSON.parse(payload.view.private_metadata);
  const { title, dueDate, priority, errors } = readTaskForm(
    payload.view.state.values,
    migration.requirements.length ? "Please give the requirement a name." : "Please give the task a title.",
  );
  if (errors) return { response_action: "errors", errors };
  context.waitUntil(migrate(context.env, migration, { title, priority, dueDate }, payload.user.id));
  return { response_action: "clear" };
}

// Starts the requirement, if there are requirement threads, moves them, tracks
// the task, moves the dev threads and tells `user` what's next. If Slack
// refuses to post the requirement or the task, it is posted later (see
// retry.js), but the rest is left to `@Cade move`.
async function migrate(env, { channel, requirements, dev, linkPrs }, { title, priority, dueDate }, user) {
  const tasksChannel = tasksChannelFor(env, channel);
  const found = { prs: new Set(), problems: [] };
  const task = { title, priority, status: "TODO", dueDate, people: noPeople(), createdBy: user };
  let requirement = null;
  let movedRequirements = 0;
  let taskTs;
  if (requirements.length) {
    const requirementTs = await createRequirement(env, channel, {
      title,
      status: "DISCUSSION",
      priority,
      dueDate,
      createdBy: user,
    });
    if (!requirementTs) return tellLater(env, { channel }, user, "requirement");
    requirement = { channel, ts: requirementTs };
    movedRequirements = await moveThreads(env, channel, requirements, requirementTs, user, found);
    taskTs = await createTask(env, task, { channel, threadTs: requirementTs, requirement: true, priority, dueDate });
  } else {
    // The team's own task, as `/cade track` in the tasks channel tracks it.
    taskTs = await createTask(env, task, { channel: tasksChannel });
  }
  if (!taskTs) return tellLater(env, requirement ?? { channel }, user, "task");

  const movedDev = await moveThreads(env, tasksChannel, dev, taskTs, user, found);
  if (linkPrs && found.prs.size) await linkFound(env, tasksChannel, taskTs, [...found.prs], user);
  console.log("Migrated", { channel, requirement: requirement?.ts, taskTs, movedRequirements, movedDev, user });
  await offerNext(env, {
    task: { channel: tasksChannel, ts: taskTs },
    requirement,
    // With no requirement, where the migration was started from.
    fallback: requirement ?? { channel },
    moved: [movedRequirements, movedDev],
    found,
    user,
  });
}

async function tellLater(env, place, user, noun) {
  await callSlack(env, "chat.postEphemeral", {
    channel: place.channel,
    thread_ts: place.ts,
    user,
    text: `I couldn't move the old threads, since the ${noun} isn't posted yet. Once it is, reply \`@Cade move\` in each old thread to bring it in.`,
  }).catch(() => {});
}

// Moves the root of each old thread in `channel` into the thread at
// `targetTs`, in order, and returns how many moved. The pull requests linked
// anywhere in them are added to `found.prs`, and why any didn't move to
// `found.problems`.
async function moveThreads(env, channel, timestamps, targetTs, user, found) {
  let moved = 0;
  for (const ts of timestamps) {
    let problem;
    try {
      const messages = await threadMessages(env, channel, ts);
      if (!messages) problem = "it has been deleted.";
      else if (messages[0].bot_id) problem = "I can only move people's messages.";
      else {
        for (const message of messages) for (const url of pullRequestsIn(message.text)) found.prs.add(url);
        problem = await moveMessage(env, { channel, ts, targetTs, user });
      }
    } catch (error) {
      console.warn("Could not migrate the thread", { ts, error: error.message });
      problem = "something went wrong.";
    }
    if (problem) found.problems.push({ channel, ts, problem });
    else moved += 1;
  }
  return moved;
}

// The thread's messages, root first, or null if the root is gone.
async function threadMessages(env, channel, ts) {
  const messages = [];
  let cursor;
  try {
    do {
      const page = await callSlack(env, "conversations.replies", { channel, ts, limit: 200, cursor });
      messages.push(...(page.messages ?? []));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    if (/message_not_found|thread_not_found/.test(error.message)) return null;
    throw error;
  }
  const [root] = messages;
  if (!root || root.ts !== ts || root.subtype === "tombstone") return null;
  return messages;
}

async function rootMessage(env, channel, ts) {
  const messages = await threadMessages(env, channel, ts);
  return messages?.[0] ?? null;
}

// Tells whoever migrated it, privately in the task's thread, what moved and
// what didn't; then asks where the task is at and who's on it (see
// setupQuestion). If they can't see the tasks channel, they're told at
// `fallback`.
async function offerNext(env, { task, requirement, fallback, moved, found, user }) {
  const link = async ({ channel, ts }, label) => {
    const permalink = await callSlack(env, "chat.getPermalink", { channel, message_ts: ts })
      .then((result) => result.permalink)
      .catch(() => null);
    return permalink ? `<${permalink}|${label}>` : label;
  };
  const threads = (n) => `${n} old thread${n === 1 ? "" : "s"}`;
  const into = [
    requirement && `${threads(moved[0])} into ${await link(requirement, "the requirement thread")}`,
    `${threads(moved[1])} into ${await link(task, "the task thread")}`,
  ].filter(Boolean);
  const lines = [`Migrated! I moved ${into.join(" and ")}.`];
  if (found.problems.length) {
    lines.push("These didn't move:");
    for (const { problem, ...thread } of found.problems) lines.push(`• ${await link(thread, "This thread")}: ${problem}`);
  }
  const text = lines.join("\n");
  const summary = { text, blocks: [{ type: "section", text: mrkdwn(text) }] };

  const tell = (place, body) =>
    callSlack(env, "chat.postEphemeral", { channel: place.channel, thread_ts: place.ts, user, ...body });
  let place = task;
  try {
    await tell(place, summary);
  } catch (error) {
    console.warn("Could not tell them in the task thread", { error: error.message });
    place = fallback;
    await tell(place, summary);
  }
  // Linking the PRs may have moved it on.
  const { status } = (await loadTask(env, task.channel, task.ts)) ?? { status: "TODO" };
  await tell(place, setupQuestion(task, status));
}

// Asks where the migrated task is at and who's working on it: a menu for its
// status, starting at `status`, and one for each role's people, any of which
// can be left empty. The task is new, so Save applies only what was chosen.
function setupQuestion(task, status) {
  const question = "Where's this task at, and who's on it? Leave out anyone you don't know yet.";
  const field = (name, label, menu) => ({
    type: "section",
    block_id: fieldBlock(name),
    text: mrkdwn(`*${label}*`),
    accessory: { action_id: PICK_ACTIONS[name], ...menu },
  });
  const value = JSON.stringify({ ...task, status });
  return {
    text: question,
    blocks: [
      { type: "section", text: mrkdwn(question) },
      field("status", "Status", {
        type: "static_select",
        options: Object.keys(STATUSES).map(statusOption),
        initial_option: statusOption(status),
      }),
      ...Object.entries(ROLES).map(([role, label]) =>
        field(role, `${label}s`, { type: "multi_users_select", placeholder: plainText(`Choose ${label.toLowerCase()}s`) }),
      ),
      {
        type: "actions",
        elements: [
          { type: "button", action_id: SAVE_ACTION, text: plainText("Save"), style: "primary", value },
          { type: "button", action_id: SKIP_SETUP_ACTION, text: plainText("Not now"), value },
        ],
      },
    ],
  };
}

// Adds the people chosen on the setup question and sets the status, if it
// was changed from what the menu started at, as `@Cade status` would, then
// removes the question.
// The thread hears the new status, and the people added are asked as `@Cade
// assign` asks them. Only additions are made, so people assigned in the
// thread meanwhile stay, and a status the task moved to meanwhile stays
// unless another was chosen.
async function saveSetup(env, payload) {
  const { channel, ts, status: initial } = JSON.parse(payload.actions[0].value);
  const values = payload.state?.values ?? {};
  const picked = (field) => values[fieldBlock(field)]?.[PICK_ACTIONS[field]];
  const user = payload.user.id;
  const task = await loadTask(env, channel, ts);
  if (!task) {
    await respondLater(payload.response_url, { replace_original: true, text: NOT_A_TASK });
    return;
  }

  const added = Object.fromEntries(
    Object.keys(ROLES).map((role) => [role, (picked(role)?.selected_users ?? []).filter((id) => !task.people[role].includes(id))]),
  );
  for (const role of Object.keys(ROLES)) task.people[role] = [...task.people[role], ...added[role]];
  if (Object.values(added).some((people) => people.length)) await saveTask(env, channel, ts, task);

  const lines = [];
  const status = picked("status")?.selected_option?.value;
  if (STATUSES[status] && status !== (initial ?? "TODO") && status !== task.status) {
    lines.push(await setStatus(env, channel, ts, status, user));
    task.status = status;
  }
  // Developers of work under way are only told; to do, they're asked to
  // pick it up. Further on, the card shows them.
  const developers = { TODO: REQUESTS.developer, IN_PROGRESS: STARTED_NOTE }[task.status];
  if (added.developer.length && developers) lines.push(`${mentions(added.developer)} ${developers}`);
  if (added.reviewer.length && task.prs.length) {
    lines.push(`${mentions(added.reviewer)}, could you review ${task.prs.map(prLink).join(", ")} when you get a chance? Thanks!`);
  }
  if (added.tester.length) lines.push(`${mentions(added.tester)} ${REQUESTS.tester}`);
  if (lines.length) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: lines.join("\n") });
  await respondLater(payload.response_url, { delete_original: true });
}

// Links the pull requests found in the old threads, as `@Cade pr add` would,
// as `user`. The setup question asks for reviewers, so the thread isn't
// asked as well. Linking is a convenience, so the migration goes on without.
async function linkFound(env, channel, ts, urls, user) {
  try {
    const task = await loadTask(env, channel, ts);
    const reply = task && (await linkPullRequests(env, channel, ts, task, urls, user, { askReviewers: false }));
    if (reply) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...messageBody(reply) });
  } catch (error) {
    console.warn("Could not link the PRs found", { ts, error: error.message });
  }
}
