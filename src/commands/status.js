import { isQuestion, phraseTest } from "../intents.js";
import { oneMessage, request, statusChanged, toAsk } from "../notify.js";
import { acknowledge, callSlack, dismiss, escapeSlack, mrkdwn, plainText } from "../slack.js";
import {
  NOT_A_TASK,
  STATUSES,
  approverBlock,
  loadTask,
  notTheApprover,
  prLink,
  readApprover,
  saveTask,
  setPinned,
  unsentPrs,
} from "../tasks.js";

const APPROVE_ACTION = "status:approve";
const REJECT_ACTION = "status:reject";
const ASK_ACTION = "status:ask";
const REVIEW_VIEW = "status:review";

// `@Cade status in progress` (or `IN_PROGRESS`, `in-progress`, `wip`) in a
// task thread sets the task's status, and Cade reacts ✅ to the message.
// Without a status it says which there are. Moving a task to DONE unpins it
// from the channel; moving it out of DONE pins it again.
//
// Done can be set directly. Client review is an optional step for work the
// client should check first: whoever moves a task there picks who approves
// it, and Cade asks them in the task's thread, with Approve and Not approve
// buttons that only they can click. Approve moves the task to Done; Not
// approve moves it back to In progress.

const STATUS_USAGE = "Try `@Cade status in review`: to do, in progress, in review, in testing, client review or done.";

// The words that say how the work is going (see soundsLikeProgress): a
// reviewer approving, a tester passing it, or anyone on the task finishing it.
// See intents.js for how phrases match.
const APPROVED = phraseTest(["lgtm", "approv(ed|ing)", "looks good", "review(ed)? (is )?done", "done review*", "ship it"]);
const PASSED = phraseTest([
  "qa (passed|done|ok)",
  "passed qa",
  "test(s|ing)? (passed|done)",
  "tested",
  "verified",
  "works (fine|well|as expected)",
  "all good",
  "no (issues|bugs) found",
]);
const FINISHED = phraseTest(["done", "finished", "complete(d)?", "merged", "deployed", "released", "shipped", "fixed"]);
// Words that put the progress off or in doubt: "not done yet", "almost
// finished", "once it's merged"; or say only part of it is: "finished the
// login subtask", "first part is done".
const HEDGED =
  /\b(not|almost|nearly|once|when|after|until|before|if|sub-?tasks?|parts?|partly|partial(ly)?|some of|one of|first|half|step)\b|n['’]t\b/i;

// Whether a message says, in so many words, that the work has moved on: an
// approval, a pass or it being finished, not asked and not hedged. Which
// status that means depends on who said it (see progressOptions); Cade
// suggests it in a task's thread (see suggest.js).
export function soundsLikeProgress(message) {
  return !isQuestion(message) && !HEDGED.test(message.text) && [APPROVED, PASSED, FINISHED].some((test) => test(message));
}

export default {
  name: "status",
  description: "Update the task's status (in its thread)",
  usage: "@Cade status in review",
  section: "thread",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;

    const input = command.text.trim();
    const status = parseStatus(input);
    if (!status) {
      const asked = input ? `I don't know "${escapeSlack(input)}" as a status.` : "Which status?";
      return `${asked} ${STATUS_USAGE}`;
    }

    const previous = task.status;
    await applyStatus(env, command.channel, command.threadTs, task, status);
    // A status typed in the command needs only a ✅, since the task card shows
    // it, plus the testers' request when it reached In testing.
    if (status === "CLIENT_REVIEW") await askApprover(env, command.channel, command.threadTs, command.user);
    return acknowledge(testersAsked(task, previous, command.user) ?? undefined);
  },
  actions: {
    [APPROVE_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, true));
    },
    [REJECT_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, false));
    },
    [ASK_ACTION]: (payload, { env }) => openApproverForm(payload, env),
  },
  views: { [REVIEW_VIEW]: submitApprover },
};

// The statuses a message about how the work is going could move a task in
// `status` to, given what `user` does on it and what they wrote, or []:
//   - a reviewer approving a task In review: In testing;
//   - a tester passing a task In testing, or anyone on the task (or whoever
//     tracked it) saying it's finished: Done.
// A task in Client review waits for the client, and a Done one is done.
export function progressOptions(task, user, message) {
  const { developer, reviewer, tester } = task.people;
  if (task.status === "IN_REVIEW" && reviewer.includes(user) && APPROVED(message)) return ["IN_TESTING"];
  const finishing =
    (task.status === "IN_TESTING" && tester.includes(user) && (PASSED(message) || APPROVED(message))) ||
    ([...developer, ...reviewer, ...tester, task.createdBy].includes(user) && FINISHED(message));
  if (!finishing || ["CLIENT_REVIEW", "DONE"].includes(task.status)) return [];
  return ["DONE"];
}

// Short names people type for each status, besides its own name ("in
// progress", "IN_PROGRESS"), in `@Cade status`.
const STATUS_NAMES = {
  TODO: ["to do", "todo", "open"],
  IN_PROGRESS: ["progress", "started", "doing", "wip"],
  IN_REVIEW: ["review", "code review"],
  IN_TESTING: ["testing", "test", "qa"],
  CLIENT_REVIEW: ["client", "approval", "uat"],
  DONE: ["complete", "completed", "finished", "closed"],
};

// The status `input` names, or undefined.
export function parseStatus(input) {
  const key = input.toUpperCase().replace(/[\s-]+/g, "_");
  if (STATUSES[key]) return key;
  const words = input.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  return Object.keys(STATUS_NAMES).find((status) => STATUS_NAMES[status].includes(words));
}

// A status menu's option.
export function statusOption(status) {
  return { text: { ...plainText(STATUSES[status]), emoji: true }, value: status };
}

// Sets the task's status for `user`, and returns what the thread then
// hears, as one message (see statusChange). Null if it isn't a task. For
// `/cade standup`.
export async function setStatus(env, channel, ts, status, user) {
  const change = await statusChange(env, channel, ts, status, user);
  return change && oneMessage(change);
}

// Sets the task's status for `user`, and returns what the thread hears as {
// log, notes } (see oneMessage): who set it, and, when it reached In
// testing, the request to its testers. Client review asks whoever set it,
// privately, who approves it (see askApprover); setting it again asks
// again, since a private message is easily lost. Null if it isn't a task.
// Shared with suggestions.
export async function statusChange(env, channel, ts, status, user, told) {
  const task = await loadTask(env, channel, ts);
  if (!task) return null;
  const previous = task.status;
  await applyStatus(env, channel, ts, task, status);
  if (status === "CLIENT_REVIEW") await askApprover(env, channel, ts, user);
  const ask = testersAsked(task, previous, user, told);
  return { log: [statusChanged(user, status)], notes: ask ? [ask] : [] };
}

// The request to a task's testers when `user` has just moved it to In
// testing from `previous`, or null. A tester who moved it isn't asked, nor
// one `told` already by the message it came from. Testers assigned once
// it's In testing are asked then (see notify.js).
function testersAsked(task, previous, user, told) {
  const tester = toAsk(task.people.tester, user, told);
  return task.status === "IN_TESTING" && previous !== "IN_TESTING" && tester.length ? request(tester, "tester") : null;
}

// Saves the new status, pinning or unpinning the task as it leaves or
// reaches Done.
async function applyStatus(env, channel, ts, task, status) {
  const previous = task.status;
  task.status = status;
  if (status !== "DONE") task.completedAt = "";
  else if (previous !== "DONE") task.completedAt = new Date().toISOString();
  await saveTask(env, channel, ts, task);
  if ((previous === "DONE") !== (status === "DONE")) await setPinned(env, channel, ts, status !== "DONE");
}

// A task reaching Client review asks whoever moved it, privately, who
// approves it: the client, or whoever handles them. Only a click carries the
// trigger_id the form needs, so it is a button.
async function askApprover(env, channel, ts, user) {
  const text = "Who should approve this? Choose them, and I'll ask.";
  await callSlack(env, "chat.postEphemeral", {
    channel,
    thread_ts: ts,
    user,
    text,
    blocks: [
      { type: "section", text: mrkdwn(text) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ASK_ACTION,
            text: plainText("Ask for approval"),
            style: "primary",
            value: JSON.stringify({ channel, ts }),
          },
        ],
      },
    ],
  });
}

const notInReview = (task) =>
  task ? `This task is ${STATUSES[task.status]} now, so there's nothing to approve.` : NOT_A_TASK;

// The Ask for approval button opens the form.
async function openApproverForm(payload, env) {
  const { channel, ts } = JSON.parse(payload.actions[0].value);
  const task = await loadTask(env, channel, ts);
  if (task?.status !== "CLIENT_REVIEW") {
    await callSlack(env, "chat.postEphemeral", { channel, thread_ts: ts, user: payload.user.id, text: notInReview(task) });
    return;
  }
  await callSlack(env, "views.open", {
    trigger_id: payload.trigger_id,
    view: {
      type: "modal",
      callback_id: REVIEW_VIEW,
      // The private button goes once the form is sent (see dismiss).
      private_metadata: JSON.stringify({ channel, ts, responseUrl: payload.response_url }),
      title: plainText("Ask for approval"),
      submit: plainText("Ask"),
      close: plainText("Cancel"),
      blocks: [approverBlock(), { type: "context", elements: [mrkdwn("They approve it in this thread.")] }],
    },
  });
}

function submitApprover(payload, context) {
  const approver = readApprover(payload.view.state.values);
  if (!approver) return { response_action: "errors", errors: { approver: "Please choose who approves it." } };
  const origin = JSON.parse(payload.view.private_metadata || "{}");
  context.waitUntil(requestReview(context.env, origin, approver, payload.user.id));
  return { response_action: "clear" };
}

// Asks the approver to review the task, in its thread, with its PRs and the
// Approve and Not approve buttons.
async function requestReview(env, origin, approver, user) {
  const { channel, ts, responseUrl } = origin;
  const task = await loadTask(env, channel, ts);
  if (task?.status !== "CLIENT_REVIEW") {
    await callSlack(env, "chat.postEphemeral", { channel, thread_ts: ts, user, text: notInReview(task) });
    return;
  }
  const ready = `Good news! <@${user}> says this is ready for review.`;
  await dismiss(responseUrl);
  await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...reviewPrompt(ready, channel, ts, task, approver) });
}

// The request with the task's linked pull requests (only those not sent
// with `@Cade release`, if some were), and the approver's Approve and Not
// approve buttons, mentioning them so they are notified. The buttons carry
// the request, PRs included, to keep it when they are replaced, and who may
// click them.
function reviewPrompt(text, channel, ts, task, approver) {
  const request = `<@${approver}>, could you take a look and approve it, or let us know what needs to change?`;
  const remaining = task.releases?.length ? unsentPrs(task) : null;
  const prs = remaining ?? task.prs;
  const label = remaining ? "Remaining PRs" : "PRs";
  const announced = prs.length ? `${text}\n*${label}:* ${prs.map(prLink).join(", ")}` : text;
  const value = JSON.stringify({ channel, ts, text: announced, approver });
  return {
    // The mention is in the notification text too.
    text: `${announced}\n${request}`,
    blocks: [
      { type: "section", text: mrkdwn(`${announced}\n${request}`) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: APPROVE_ACTION,
            text: plainText("Approve"),
            style: "primary",
            value,
          },
          {
            type: "button",
            action_id: REJECT_ACTION,
            text: plainText("Not approve"),
            value,
          },
        ],
      },
    ],
  };
}

// Applies the approver's decision on a task in Client review, then replaces
// the buttons with the decision and tells the task's thread.
async function review(payload, env, approved) {
  const request = JSON.parse(payload.actions[0].value);
  if (await notTheApprover(env, payload, request.approver)) return;
  const user = payload.user.id;
  const task = await loadTask(env, request.channel, request.ts);

  let outcome;
  if (!task) {
    outcome = "Hmm, this task doesn't exist anymore.";
  } else if (task.status !== "CLIENT_REVIEW") {
    // The team moved the task on before anyone clicked.
    outcome = `I didn't change anything: the task has since moved to ${STATUSES[task.status]}.`;
  } else {
    const status = approved ? "DONE" : "IN_PROGRESS";
    await applyStatus(env, request.channel, request.ts, task, status);
    const text = approved
      ? `<@${user}> approved this, so it's now ${STATUSES.DONE}. Nice work!`
      : `<@${user}> didn't approve this, so it's back to ${STATUSES.IN_PROGRESS}. Have a look at the thread for what needs to change.`;
    await callSlack(env, "chat.postMessage", {
      channel: request.channel,
      thread_ts: request.ts,
      ...asMessage(text),
    });
    outcome = approved
      ? `<@${user}> approved it. Thanks!`
      : `<@${user}> didn't approve it, so the team will pick it up again. Thanks for letting us know!`;
  }
  await callSlack(env, "chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    ...asMessage(`${request.text}\n${outcome}`),
  });
}

// chat.update keeps a message's old blocks unless new ones are sent, so text
// replies are wrapped in a section.
function asMessage(reply) {
  return typeof reply === "string"
    ? { text: reply, blocks: [{ type: "section", text: mrkdwn(reply) }] }
    : reply;
}
