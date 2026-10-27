import { aiModel, checkChanges } from "../ai.js";
import { roleOf } from "../channels.js";
import { intent, isQuestion, phraseTest, suggesting } from "../intents.js";
import { dismiss, respondLater } from "../slack.js";
import { ROLES, loadTask } from "../tasks.js";
import { askToChange, suggestWithAi } from "./ai-suggest.js";
import { applyChanges } from "./changes.js";
import { progressOptions, soundsLikeProgress } from "./status.js";

// Suggestions by phrases used to come with pickers, Save and Not now; those
// already posted are still answered (see save).
const SAVE_ACTION = "suggest:save";
const SKIP_ACTION = "suggest:skip";
const ROLE_PICKS = Object.fromEntries(Object.keys(ROLES).map((role) => [role, `suggest:role:${role}`]));
const STATUS_PICK = "suggest:status";

// People's own words in a task's thread often mean the task should change.
// With AI on (`ai` in cade.config.json), the message is read with AI, which
// can tell more: see ai-suggest.js. Otherwise, or if AI fails, it's read by
// its phrases, as below; both apply changes the same way (see changes.js).
//
// By phrases:
// "@mia can you review this?", "on it", "lgtm", "done". Cade reads the
// message a request at a time for who it asks to take each role, and what it
// says about the work, then asks whoever wrote it, privately, with the same
// summary AI suggestions give: Accept, Edit… or Reject (see askToChange in
// ai-suggest.js). Nothing changes until then, and the thread hears only what
// changed, credited to them.
//
// Who is asked is whoever the request names ("@rex, can you review this?"),
// so a mention that only informs ("cc @rex") asks no one, and neither does
// the author's own plan ("I'll test it"). Each kind can be turned off with
// `suggestions` in cade.config.json:
//   hand-offs  a request to develop, review or test it: a picker for that role
//   started    the work starting: In progress, and, for someone who isn't on
//              the task, the owners picker
//   progress   a reviewer approving, a tester passing it, or anyone on it
//              saying it's finished: the next status (see progressOptions)
//   details    with AI only: the priority and due date, but not an
//              incident's

// The words that ask for each role (see intents.js for how phrases match).
// Within a request they're checked in this order: "please review this fix"
// asks for a review, not for development.
const ROLE_REQUESTS = {
  reviewer: phraseTest(["review*"]),
  tester: phraseTest(["test*", "qa", "verify*"]),
  owner: phraseTest([
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
    "implement*",
    "build (this|it)",
    "develop (this|it)",
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
const REQUEST_BREAK = /(?<=[.;!?\n])|,|\s+(?:and|then|also|while|but|&amp;)\s+/i;

// A request about the author's own part: "I'll test it", "while I try ways
// to test this". The role it names is theirs.
const OWN_PART = /^\s*(i|i['’](ll|m|d)|we|we['’](ll|re))\b/i;

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// The statuses the work starting, or a tester being asked, moves a task from.
const MOVES_FROM = {
  IN_PROGRESS: ["TODO"],
  IN_TESTING: ["TODO", "IN_PROGRESS", "IN_REVIEW"],
};

// Messages that might change a task, beyond what the phrases catch, for AI
// to read: any mentioning someone, or words about status, priority or dates.
// Without AI, the phrases decide, and these come to nothing.
const MIGHT_CHANGE = phraseTest([
  "urgent",
  "asap",
  "block(er|ing|ed)",
  "critical",
  "priority",
  "due",
  "deadline",
  "by (today|tonight|tomorrow|eod|eow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|end of)",
  "tomorrow",
  "\\d{1,2}(st|nd|rd|th)",
  "\\d{1,2}/\\d{1,2}",
  "lgtm",
  "approv*",
  "merged",
  "deployed",
  "done",
  "finished",
  "review*",
  "test*",
  "qa",
  "started",
  "in progress",
  "wip",
]);

const workIntent = intent({
  name: "work",
  order: 20,
  kinds: ["hand-offs", "started", "progress", "details"],
  needs: { thread: true },
  match: (message) =>
    message.mentions.length > 0 ||
    MIGHT_CHANGE(message) ||
    rolesAskedIn(message).length > 0 ||
    STARTED(message) ||
    REPORTED(message) ||
    soundsLikeProgress(message),
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

// Who a message asks to take each role, as { [role]: ids }, read a request
// at a time (see REQUEST_BREAK). Asking is done by name: a request asks
// whoever it mentions, or whoever the last request did ("@rex, can you
// review this?"). One reporting work already started asks nothing, unless
// it's a question ("@rex have you started on this?"). One about the author's
// own part (see OWN_PART), alongside a request of someone else, gives the
// author that role: "@udara can you implement this while I test it".
// Returns the roles taken by the author alone as `own`, a list.
export function handOffsIn(message) {
  const asked = {};
  const own = [];
  if (!message.mentions?.length) return Object.defineProperty(asked, "own", { value: own });
  let named = [];
  for (const request of message.text.split(REQUEST_BREAK)) {
    const text = { text: request };
    const mentioned = [...request.matchAll(USER_MENTION)].map((match) => match[1]);
    const theirs = !mentioned.length && OWN_PART.test(request);
    if (mentioned.length) named = mentioned;
    if (REPORTED(text) && !/\?\s*$/.test(request)) continue;
    const role = Object.keys(ROLE_REQUESTS).find((name) => ROLE_REQUESTS[name](text));
    const who = theirs ? [message.user] : named;
    if (!role || !who.length) continue;
    asked[role] = [...new Set([...(asked[role] ?? []), ...who])];
    if (theirs) own.push(role);
  }
  return Object.defineProperty(asked, "own", { value: own });
}

// The roles a message asks someone to take, in ROLES' order.
export function rolesAskedIn(message) {
  const asked = handOffsIn(message);
  return Object.keys(ROLES).filter((role) => asked[role]);
}

// What a message suggests for `task`, as { roles, people, status }: the
// roles it asks for, who to add to each ({ [role]: ids }), and the status to
// suggest, or null. Only the kinds turned on are read.
export function suggestionsFor(env, message, task) {
  const roles = new Set();
  const people = {};
  let status = null;
  const asked = suggesting(env, "hand-offs", message.channel) ? handOffsIn(message) : {};
  for (const [role, ids] of Object.entries(asked)) {
    roles.add(role);
    people[role] = ids;
  }
  const ownTesting = asked.own?.includes("tester") && people.tester?.every((id) => id === message.user);

  if (suggesting(env, "progress", message.channel) && soundsLikeProgress(message)) {
    status = progressOptions(task, message.user, message)[0] ?? null;
  }
  const working = (STARTED(message) && !message.mentions.length) || (REPORTED(message) && message.mentions.length);
  if (!status && suggesting(env, "started", message.channel) && working && !isQuestion(message) && task.status !== "DONE") {
    const { reviewer, tester, owner } = task.people;
    // A reviewer or tester starting on their part isn't the work starting.
    const theirPart = !message.mentions.length && [...reviewer, ...tester].includes(message.user);
    if (!theirPart) {
      if (MOVES_FROM.IN_PROGRESS.includes(task.status)) status = "IN_PROGRESS";
      // Someone saying they've started who isn't an owner may want to be one.
      if (!message.mentions.length && !owner.includes(message.user)) {
        roles.add("owner");
        people.owner = [message.user];
      }
    }
  }
  // Asking someone to test it is the work moving to testing, unless it asks
  // for someone to develop it too; the author saying they'll test it isn't.
  const testing = roles.has("tester") && !roles.has("owner") && !ownTesting;
  if (!status && testing && MOVES_FROM.IN_TESTING.includes(task.status)) status = "IN_TESTING";
  return { roles: Object.keys(ROLES).filter((role) => roles.has(role)), people, status };
}

// The work intent's handler: asks whoever wrote the message, privately, with
// the pickers for what it suggests, if anything.
async function suggestWork(message, env) {
  const about = await threadTask(env, message);
  if (!about || about.task.status === "DONE") return;
  if (aiModel(env, message.channel)) {
    try {
      return await suggestWithAi(env, message, about);
    } catch (error) {
      console.warn("AI couldn't read the message, so its phrases are read instead", { error: error.message });
    }
  }
  const { task } = about;
  const { people, status } = suggestionsFor(env, message, task);
  // Checked as AI's are, so only real changes are suggested.
  const read = { status: status ?? "" };
  for (const role of Object.keys(ROLES)) read[role] = { add: people[role] ?? [], remove: [] };
  const allowed = { roles: Object.keys(ROLES), status: true, details: false };
  const changes = checkChanges(read, { task, message, allowed });
  if (changes) await askToChange(env, message, about, changes);
}

// The task a thread in a dev channel is about, as { target, task }, or null
// when it is not a task's.
async function threadTask(env, message) {
  if (roleOf(env, message.channel) !== "tasks") return null;
  const target = { channel: message.channel, ts: message.threadTs };
  const task = await loadTask(env, target.channel, target.ts);
  return task ? { target, task } : null;
}

// For a suggestion posted with pickers: saves what they show: each role set to the people chosen, and the
// status chosen, as one change (see changes.js), and removes the question. A
// status left as suggested isn't applied if the task has moved since the
// question was asked.
async function save(payload, env) {
  const { channel, ts, people = {}, status: suggested, from } = JSON.parse(payload.actions[0].value);
  const values = payload.state?.values ?? {};
  // The question goes first, so the click shows at once.
  await dismiss(payload.response_url);
  const task = await loadTask(env, channel, ts);
  if (task) {
    const changes = { people: {} };
    for (const [role, before] of Object.entries(people)) {
      const pick = ROLE_PICKS[role];
      const chosen = values[pick]?.[pick]?.selected_users ?? before;
      changes.people[role] = {
        add: chosen.filter((id) => !task.people[role].includes(id)),
        remove: task.people[role].filter((id) => !chosen.includes(id)),
      };
    }
    const status = values[STATUS_PICK]?.[STATUS_PICK]?.selected_option?.value ?? suggested;
    if (status) changes.status = status;
    await applyChanges(env, { channel, ts }, changes, payload.user.id, { from: status === suggested ? from : undefined });
  }
}
