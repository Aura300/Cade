import { pairFor, roleOf } from "../channels.js";
import { intent, isQuestion, phraseTest, suggesting } from "../intents.js";
import { loadRequirement, onTheTeam } from "../requirements.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { REQUESTS, ROLES, STATUSES, loadTask, saveTask } from "../tasks.js";
import { teamChanges } from "./assign.js";
import { progressOptions, setStatus, soundsLikeProgress, statusOption } from "./status.js";

const SAVE_ACTION = "suggest:save";
const SKIP_ACTION = "suggest:skip";
// The pickers, each its own block, so Save reads them from the message's
// state; Slack needs each action_id in a message to differ.
const ROLE_PICKS = Object.fromEntries(Object.keys(ROLES).map((role) => [role, `suggest:role:${role}`]));
const STATUS_PICK = "suggest:status";

// People's own words in a task's thread often mean the task should change:
// "@mia can you review this?", "on it", "lgtm", "done". Cade reads the
// message for what it asks of each role and what it says about the work,
// then asks whoever wrote it, privately, with pickers to change the task:
// one per role asked for, filled in with who has it now, and the status the
// message suggests. They change what they like and Save; nothing changes
// until then, and the thread hears only what changed, credited to them.
//
// Who to assign is never read from the message, since its mentions may be
// for something else ("cc @rex"): the pickers start from the task's own
// people. Each kind can be turned off with `suggestions` in cade.config.json:
//   hand-offs  a request to develop, review or test it: a picker for that role
//   started    the work starting: In progress, and, for someone who isn't on
//              the task, the developers picker
//   progress   a reviewer approving, a tester passing it, or anyone on it
//              saying it's finished: the next status (see progressOptions)
//
// In the thread of a requirement or incident tracked as a task, the
// suggestions are for its task, and only the team gets them (see
// onTheTeam): development and the work starting, as the client's thread
// says nothing about review or testing.

// The words that ask for each role (see intents.js for how phrases match).
// Within a request they're checked in this order: "please review this fix"
// asks for a review, not for development.
const ROLE_REQUESTS = {
  reviewer: phraseTest(["review*"]),
  tester: phraseTest(["test*", "qa", "verify*"]),
  developer: phraseTest([
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
  ]),
};

// The words someone uses to say they've started on the task themselves:
// "okay, started working on this", "on it", "picking this up".
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

// The words that say others have started already: "@rex has started working
// on this", "@rex is on it". A request that says this reports work rather
// than asking for it: "@rex started working on the review comments" doesn't
// ask for a review.
const REPORTED = phraseTest([
  "started (working|work|on)",
  "(is|are|['’]s|['’]re) (already |now |still )?(working on|looking into)",
  "(is|are|['’]s|['’]re) (already )?on (this|it)",
  "(has|have|already|just) (picked|taken) (this |it )?(up|on)",
  "picked (this |it )?up",
  "took (this|it)( on| over)?",
  "(has|have) been working on",
]);

// Where one request in a message ends and the next starts. Punctuation stays
// with the request it ends, so a question can be told from a report.
const REQUEST_BREAK = /(?<=[.;!?\n])|,|\s+(?:and|then|also|&amp;)\s+/i;

// The statuses the work starting, or a tester being asked, moves a task from.
const MOVES_FROM = {
  IN_PROGRESS: ["TODO"],
  IN_TESTING: ["TODO", "IN_PROGRESS", "IN_REVIEW"],
};

const workIntent = intent({
  name: "work",
  order: 20,
  kinds: ["hand-offs", "started", "progress"],
  needs: { thread: true },
  match: (message) =>
    rolesAskedIn(message).length > 0 || STARTED(message) || REPORTED(message) || soundsLikeProgress(message),
  handle: (message, { env }) => suggestWork(message, env),
});

export default {
  intents: [workIntent],
  actions: {
    [SAVE_ACTION]: async (payload, context) => {
      context.waitUntil(save(payload, context.env));
    },
    [SKIP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
    // Picking only chooses; Save saves.
    ...Object.fromEntries([...Object.values(ROLE_PICKS), STATUS_PICK].map((id) => [id, async () => {}])),
  },
};

// The roles a message asks someone to do, read a request at a time (see
// REQUEST_BREAK), in ROLES' order. A request only counts in a message that
// mentions someone, as asking is done by name, though who is never read
// from it; and one reporting work already started asks nothing, unless it's
// a question ("@rex have you started on this?").
export function rolesAskedIn(message) {
  if (!message.mentions?.length) return [];
  const asked = new Set();
  for (const request of message.text.split(REQUEST_BREAK)) {
    const text = { text: request };
    if (REPORTED(text) && !/\?\s*$/.test(request)) continue;
    const role = Object.keys(ROLE_REQUESTS).find((name) => ROLE_REQUESTS[name](text));
    if (role) asked.add(role);
  }
  return Object.keys(ROLES).filter((role) => asked.has(role));
}

// What a message suggests for `task`, as { roles, status }: the roles to
// show pickers for, and the status to suggest, or null. Only the kinds
// turned on are read.
export function suggestionsFor(env, message, task, { place, hasClient }) {
  const roles = new Set();
  let status = null;
  const external = place === "external";
  const asked = suggesting(env, "hand-offs") ? rolesAskedIn(message) : [];
  for (const role of asked) if (!external || role === "developer") roles.add(role);

  if (suggesting(env, "progress") && !external && soundsLikeProgress(message)) {
    status = progressOptions(task, message.user, message, hasClient)[0] ?? null;
  }
  const working = (STARTED(message) && !message.mentions.length) || (REPORTED(message) && message.mentions.length);
  if (!status && suggesting(env, "started") && working && !isQuestion(message) && task.status !== "DONE") {
    const { reviewer, tester, developer } = task.people;
    // A reviewer or tester starting on their part isn't the work starting.
    const theirPart = !message.mentions.length && [...reviewer, ...tester].includes(message.user);
    if (!theirPart) {
      if (MOVES_FROM.IN_PROGRESS.includes(task.status)) status = "IN_PROGRESS";
      // Someone saying they've started who isn't a developer may want to be one.
      if (!message.mentions.length && !developer.includes(message.user)) roles.add("developer");
    }
  }
  // Asking someone to test it is the work moving to testing, unless it asks
  // for someone to develop it too.
  const testing = roles.has("tester") && !roles.has("developer");
  if (!status && testing && MOVES_FROM.IN_TESTING.includes(task.status)) status = "IN_TESTING";
  return { roles: Object.keys(ROLES).filter((role) => roles.has(role)), status };
}

// The work intent's handler: asks whoever wrote the message, privately, with
// the pickers for what it suggests, if anything.
async function suggestWork(message, env) {
  const about = await threadTask(env, message);
  if (!about) return;
  const { target, of, task, place } = about;
  const hasClient = Boolean(pairFor(env, target.channel)?.external);
  const { roles, status } = suggestionsFor(env, message, task, { place, hasClient });
  if (!roles.length && !status) return;

  const question = `Should I update the task${of}? I've filled this in from your message: change anything, then Save.`;
  const picker = (blockId, label, element) => ({
    type: "section",
    block_id: blockId,
    text: mrkdwn(`*${label}*`),
    accessory: { action_id: blockId, ...element },
  });
  const blocks = [
    { type: "section", text: mrkdwn(question) },
    ...roles.map((role) =>
      picker(ROLE_PICKS[role], `${ROLES[role]}s`, {
        type: "multi_users_select",
        placeholder: plainText(`Choose ${ROLES[role].toLowerCase()}s`),
        ...(task.people[role].length && { initial_users: task.people[role] }),
      }),
    ),
    ...(status
      ? [
          picker(STATUS_PICK, "Status", {
            type: "static_select",
            options: Object.keys(STATUSES).map(statusOption),
            initial_option: statusOption(status),
          }),
        ]
      : []),
  ];
  // The button carries what the pickers started with, as Slack may leave
  // pickers no one touched out of the state Save gets.
  const people = Object.fromEntries(roles.map((role) => [role, task.people[role]]));
  const value = JSON.stringify({ ...target, people, status, from: task.status });
  await callSlack(env, "chat.postEphemeral", {
    channel: message.channel,
    thread_ts: message.threadTs,
    user: message.user,
    text: question,
    blocks: [
      ...blocks,
      {
        type: "actions",
        elements: [
          { type: "button", action_id: SAVE_ACTION, text: plainText("Save"), style: "primary", value },
          { type: "button", action_id: SKIP_ACTION, text: plainText("Not now"), value: "{}" },
        ],
      },
    ],
  });
}

// The task a thread is about, or null when there is none: in a task's
// thread, that task; in the thread of a requirement or incident tracked as a
// task, that task, for the team only (see onTheTeam). Returns { target, of,
// task, place }, `of` naming the task for a question asked in the
// requirement's thread.
async function threadTask(env, message) {
  const place = roleOf(env, message.channel);
  let target = { channel: message.channel, ts: message.threadTs };
  let of = "";
  if (place === "external") {
    const requirement = await loadRequirement(env, message.channel, message.threadTs);
    if (!requirement?.task || !(await onTheTeam(env, message.channel, message.user))) return null;
    target = { channel: requirement.task.channel, ts: requirement.task.ts };
    of = ` <${requirement.task.link}|${escapeSlack(requirement.task.title)}>`;
  } else if (!["tasks", "incidents"].includes(place)) {
    return null;
  }
  const task = await loadTask(env, target.channel, target.ts);
  return task ? { target, of, task, place } : null;
}

// Saves what the pickers show: each role set to the people chosen, and the
// status chosen, then tells the task's thread what changed, credited to
// whoever saved it, and removes the question. A status left as suggested
// isn't applied if the task has moved since the question was asked.
async function save(payload, env) {
  const { channel, ts, people = {}, status: suggested, from } = JSON.parse(payload.actions[0].value);
  const values = payload.state?.values ?? {};
  const user = payload.user.id;
  const task = await loadTask(env, channel, ts);
  if (task) {
    const changes = Object.entries(people).map(([role, before]) => {
      const pick = ROLE_PICKS[role];
      const chosen = values[pick]?.[pick]?.selected_users ?? before;
      const change = {
        role,
        added: chosen.filter((id) => !task.people[role].includes(id)),
        removed: task.people[role].filter((id) => !chosen.includes(id)),
      };
      task.people[role] = chosen;
      return change;
    });
    const lines = teamChanges(user, task, changes);
    if (lines.length) await saveTask(env, channel, ts, task);

    const status = values[STATUS_PICK]?.[STATUS_PICK]?.selected_option?.value ?? suggested;
    const stale = status === suggested && task.status !== from;
    if (status && status !== task.status && !stale) {
      lines.push(await setStatus(env, channel, ts, status, user));
      // Testers just added were asked already.
      const added = changes.find((change) => change.role === "tester")?.added ?? [];
      const testers = task.people.tester.filter((id) => !added.includes(id));
      if (status === "IN_TESTING" && testers.length) lines.push(`${mentions(testers)} ${REQUESTS.tester}`);
    }
    if (lines.length) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: lines.join("\n") });
  }
  // An ephemeral message can only be changed through its response_url.
  await respondLater(payload.response_url, { delete_original: true });
}
