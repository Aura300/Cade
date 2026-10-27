import { isQuestion, phraseTest } from "../intents.js";
import { clientStatus, loadRequirement, reflectOnRequirement } from "../requirements.js";
import { oneMessage, request, statusChanged } from "../notify.js";
import { CLOSE_ALL, acknowledge, callSlack, dismiss, escapeSlack, mrkdwn, plainText } from "../slack.js";
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

const SELECT_ACTION = "status:select";
const APPROVE_ACTION = "status:approve";
const REJECT_ACTION = "status:reject";
const ASK_ACTION = "status:ask";
const REVIEW_VIEW = "status:review";
const STATUS_VIEW = "status:form";
// The external thread only needs to hear when a task reaches one of these.
const CLOSED_STATUSES = ["CLIENT_REVIEW", "DONE"];

// `@Cade status` in a task thread replies with a menu of statuses; picking one
// updates the task and replaces the menu with a confirmation. A status can
// also be given directly, as `@Cade status IN_PROGRESS` or `@Cade status in
// progress`; then Cade just reacts ✅ to the message. Moving a task to DONE unpins it from the channel; moving it out
// of DONE pins it again. The same goes for the requirement it was tracked
// from, in the external channel.
//
// When a task reaches CLIENT_REVIEW or DONE, Cade tells the external thread
// it was tracked from, and the requirement it was tracked from always shows
// the current status.
//
// Only the dev channel sets statuses, and it can set Done directly. Client
// review is an optional step for work the client should check first, and
// the client decides whether that work is accepted. When a requirement's
// task moves to Client review, Cade's post in the requirement thread has
// Approve and Not approve buttons. Approve moves the task to Done; Not
// approve moves it back to In progress. Either way the task's thread is told,
// and nothing more is posted in the requirement thread, where the client just
// decided. Slack cannot tell the team
// from the client, so anyone in the external channel can click them.
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
  usage: "@Cade status",
  section: "thread",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const task = await loadTask(env, command.channel, command.threadTs);
    if (!task) return NOT_A_TASK;

    const input = command.text.trim();
    const status = parseStatus(input);
    if (!status) {
      const prompt = input
        ? `I don't know "${escapeSlack(input)}" as a status. Which one did you mean?`
        : "What's the new status?";
      return statusPicker(prompt, task.status);
    }

    const previous = task.status;
    const reached = await applyStatus(env, command.channel, command.threadTs, task, status);
    // A status typed in the command needs only a ✅, since the task card shows
    // it, plus a note when the requirement thread was told, and the testers'
    // request when it reached In testing.
    const { told } = await afterChange(
      env,
      command.channel,
      command.threadTs,
      task,
      status,
      command.user,
      reached,
    );
    const note = [told, testersAsked(task, previous)].filter(Boolean).join("\n");
    return acknowledge(note || undefined);
  },
  actions: {
    [SELECT_ACTION]: async (payload, context) => {
      context.waitUntil(selectStatus(payload, context.env));
    },
    [APPROVE_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, true));
    },
    [REJECT_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, false));
    },
    [ASK_ACTION]: (payload, { env }) => openApproverForm(payload, env),
  },
  views: { [REVIEW_VIEW]: submitApprover, [STATUS_VIEW]: submitStatus },
};

// The statuses a message about how the work is going could move a task in
// `status` to, given what `user` does on it and what they wrote, or []:
//   - a reviewer approving a task In review: In testing;
//   - a tester passing a task In testing, or anyone on the task (or whoever
//     tracked it) saying it's finished: Client review, for a requirement's
//     task or, in a group with a client (`hasClient`), the team's own, as
//     whoever handles the client may still show it to them; and Done.
// A task in Client review waits for the client, and a Done one is done.
export function progressOptions(task, user, message, hasClient = false) {
  const { developer, reviewer, tester } = task.people;
  if (task.status === "IN_REVIEW" && reviewer.includes(user) && APPROVED(message)) return ["IN_TESTING"];
  const finishing =
    (task.status === "IN_TESTING" && tester.includes(user) && (PASSED(message) || APPROVED(message))) ||
    ([...developer, ...reviewer, ...tester, task.createdBy].includes(user) && FINISHED(message));
  if (!finishing || ["CLIENT_REVIEW", "DONE"].includes(task.status)) return [];
  const forClient = task.source ? !task.source.incident : hasClient;
  return forClient ? ["CLIENT_REVIEW", "DONE"] : ["DONE"];
}

// Moves the task for `user` and tells its thread who did.
async function moveAndTell(env, channel, ts, status, user) {
  const text = await setStatus(env, channel, ts, status, user);
  await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...asMessage(text) });
}

// The task card menu's Change status form (see menu.js).
export function statusForm({ channel, ts }, task) {
  return {
    type: "modal",
    callback_id: STATUS_VIEW,
    private_metadata: JSON.stringify({ channel, ts }),
    title: plainText("Change status"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "status",
        label: plainText(`Status of ${task.title}`.slice(0, 2000)),
        element: {
          type: "static_select",
          action_id: "value",
          options: Object.keys(STATUSES).map(statusOption),
          initial_option: statusOption(task.status),
        },
      },
    ],
  };
}

// Saving the form moves the task as the status menu would, and tells its
// thread who did. Saving it unchanged posts nothing.
function submitStatus(payload, context) {
  const { channel, ts } = JSON.parse(payload.view.private_metadata);
  const status = payload.view.state.values.status.value.selected_option.value;
  const user = payload.user.id;
  context.waitUntil(
    (async () => {
      const { env } = context;
      const task = await loadTask(env, channel, ts);
      if (!task) {
        await callSlack(env, "chat.postEphemeral", { channel, user, text: NOT_A_TASK });
        return;
      }
      if (task.status !== status) await moveAndTell(env, channel, ts, status, user);
    })(),
  );
  return CLOSE_ALL;
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

function statusPicker(prompt, current) {
  const option = statusOption;
  return {
    text: prompt,
    blocks: [
      {
        type: "section",
        text: mrkdwn(prompt),
        accessory: {
          type: "static_select",
          action_id: SELECT_ACTION,
          placeholder: plainText("Select a status"),
          options: Object.keys(STATUSES).map(option),
          initial_option: option(current),
        },
      },
    ],
  };
}

// The picker is a reply in the task's thread, so the thread identifies the
// task. It becomes what happened; but an edited message notifies no one, so
// when the testers are asked, it goes and the thread gets a new reply.
async function selectStatus(payload, env) {
  const channel = payload.channel.id;
  const ts = payload.message.thread_ts;
  const status = payload.actions[0].selected_option.value;
  const change = await statusChange(env, channel, ts, status, payload.user.id);
  const reply = change ? oneMessage(change) : NOT_A_TASK;
  if (change?.notes.length) {
    await callSlack(env, "chat.delete", { channel, ts: payload.message.ts });
    await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...asMessage(reply) });
    return;
  }
  await callSlack(env, "chat.update", {
    channel,
    ts: payload.message.ts,
    ...asMessage(reply),
  });
}

// Sets the task's status as the picker does, for `user`, and returns what
// the thread then hears, as one message (see statusChange). Null if it isn't
// a task. Shared with `/cade standup`.
export async function setStatus(env, channel, ts, status, user) {
  const change = await statusChange(env, channel, ts, status, user);
  return change && oneMessage(change);
}

// Sets the task's status for `user`, and returns what the thread hears as {
// log, notes } (see oneMessage): who set it and whether the requirement
// thread was told, and, when it reached In testing, the request to its
// testers. Null if it isn't a task. Shared with suggestions.
export async function statusChange(env, channel, ts, status, user) {
  const task = await loadTask(env, channel, ts);
  if (!task) return null;
  const previous = task.status;
  const reached = await applyStatus(env, channel, ts, task, status);
  const { text, told } = await afterChange(env, channel, ts, task, status, user, reached);
  const ask = testersAsked(task, previous);
  return { log: [text, told].filter(Boolean), notes: ask ? [ask] : [] };
}

// The request to a task's testers when it has just reached In testing from
// `previous`, or null. Testers assigned once it's In testing are asked then
// (see notify.js).
function testersAsked(task, previous) {
  const { tester } = task.people;
  return task.status === "IN_TESTING" && previous !== "IN_TESTING" && tester.length ? request(tester, "tester") : null;
}

// Saves the new status and returns whether the task just reached a status
// the external thread hears about.
async function applyStatus(env, channel, ts, task, status) {
  const previous = task.status;
  task.status = status;
  if (status !== "DONE") task.completedAt = "";
  else if (previous !== "DONE") task.completedAt = new Date().toISOString();
  await saveTask(env, channel, ts, task);
  await reflectOnRequirement(env, ts, task, { status: clientStatus(status) });
  if ((previous === "DONE") !== (status === "DONE")) {
    await setPinned(env, channel, ts, status !== "DONE");
    // The requirement it was tracked from is pinned until it is Done too.
    if (task.source) {
      await setPinned(env, task.source.channel, task.source.threadTs, status !== "DONE");
    }
  }
  return status !== previous && CLOSED_STATUSES.includes(status);
}

// After a change: Done is told to the requirement thread, if the task has
// one. Client review asks whoever set it, privately, who approves it (see
// askApprover); the request follows once they're chosen. Setting Client
// review again asks again, since a private message is easily lost. Returns
// the confirmation for the task's thread, `text`, and `told`, the line
// saying the requirement thread was told, when it was.
async function afterChange(env, channel, ts, task, status, user, reached) {
  const text = statusChanged(user, status);
  if (status === "CLIENT_REVIEW") {
    await askApprover(env, channel, ts, user);
    return { text, told: null };
  }
  if (!reached) return { text, told: null };
  if (!task.source) return { text, told: null };
  await callSlack(env, "chat.postMessage", {
    channel: task.source.channel,
    thread_ts: task.source.threadTs,
    ...asMessage(`Great news! <@${user}> marked this as ${STATUSES.DONE}.`),
  });
  return { text, told: `I've let ${requirementThread(task)} know it's ${STATUSES.DONE}.` };
}

function requirementThread(task) {
  return task.source.link ? `<${task.source.link}|the requirement thread>` : "the requirement thread";
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

// The Ask for approval button opens the form, with whoever started the
// requirement picked to begin with.
async function openApproverForm(payload, env) {
  const { channel, ts } = JSON.parse(payload.actions[0].value);
  const task = await loadTask(env, channel, ts);
  if (task?.status !== "CLIENT_REVIEW") {
    await callSlack(env, "chat.postEphemeral", { channel, thread_ts: ts, user: payload.user.id, text: notInReview(task) });
    return;
  }
  const requirement = task.source && (await loadRequirement(env, task.source.channel, task.source.threadTs));
  const where = requirement ? "in the requirement thread" : "in this thread";
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
      blocks: [
        approverBlock(requirement?.createdBy),
        { type: "context", elements: [mrkdwn(`They approve it ${where}.`)] },
      ],
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

// Asks the approver to review the task, with its PRs and the Approve and
// Not approve buttons, in the requirement thread, and tells the task's
// thread who was asked; or, with no requirement thread, in the task's own.
async function requestReview(env, origin, approver, user) {
  const { channel, ts, responseUrl } = origin;
  const task = await loadTask(env, channel, ts);
  if (task?.status !== "CLIENT_REVIEW") {
    await callSlack(env, "chat.postEphemeral", { channel, thread_ts: ts, user, text: notInReview(task) });
    return;
  }
  const requirement = task.source && (await loadRequirement(env, task.source.channel, task.source.threadTs));
  const ready = `Good news! <@${user}> says this is ready for review.`;
  const { body, remaining } = reviewPrompt(ready, channel, ts, task, approver);
  await dismiss(responseUrl);
  if (!requirement) {
    await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...body });
    return;
  }
  await callSlack(env, "chat.postMessage", { channel: task.source.channel, thread_ts: task.source.threadTs, ...body });
  const what = remaining ? `the remaining PRs, ${remaining.map(prLink).join(", ")},` : "it";
  await callSlack(env, "chat.postMessage", {
    channel,
    thread_ts: ts,
    ...asMessage(`<@${user}> asked <@${approver}> to review ${what} in ${requirementThread(task)}.`),
  });
}

// The request with the task's linked pull requests (only those not sent
// with `@Cade release`, if some were), and the approver's Approve and Not
// approve buttons, mentioning them so they are notified. The buttons carry
// the request, PRs included, to keep it when they are replaced, and who may
// click them. Returns { body, remaining }, `remaining` being the PRs not sent
// before, when some were.
function reviewPrompt(text, channel, ts, task, approver) {
  const request = `<@${approver}>, could you take a look and approve it, or let us know what needs to change?`;
  const remaining = task.releases?.length ? unsentPrs(task) : null;
  const prs = remaining ?? task.prs;
  const label = remaining ? "Remaining PRs" : "PRs";
  const announced = prs.length ? `${text}\n*${label}:* ${prs.map(prLink).join(", ")}` : text;
  const value = JSON.stringify({ channel, ts, text: announced, approver });
  const body = {
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
  return { body, remaining: remaining?.length ? remaining : null };
}

// Applies the approver's decision on a task in Client review, then replaces
// the buttons with the decision and tells the task's thread, linking to the
// requirement thread when it was made there.
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
    let where = "";
    if (payload.channel.id !== request.channel) {
      const { permalink } = await callSlack(env, "chat.getPermalink", {
        channel: payload.channel.id,
        message_ts: payload.message.ts,
      });
      where = ` in <${permalink}|the requirement thread>`;
    }
    const text = approved
      ? `<@${user}> approved this${where}, so it's now ${STATUSES.DONE}. Nice work!`
      : `<@${user}> didn't approve this${where}, so it's back to ${STATUSES.IN_PROGRESS}. Have a look at the thread for what needs to change.`;
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
