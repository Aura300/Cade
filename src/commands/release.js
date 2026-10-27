import { decideRelease, insertRelease } from "../db.js";
import { callSlack, dismiss, escapeSlack, mentions, mrkdwn, plainText } from "../slack.js";
import {
  NOT_A_TASK,
  approverBlock,
  loadTask,
  notTheApprover,
  parsePullRequest,
  prLink,
  readApprover,
  taskMessage,
  unsentPrs,
} from "../tasks.js";

const OPEN_ACTION = "release:open";
const APPROVE_ACTION = "release:approve";
const REJECT_ACTION = "release:reject";
const RELEASE_VIEW = "release";

// Slack shows up to 10 checkboxes; more pull requests are offered in a menu.
const MAX_CHECKBOXES = 10;

const NO_PRS = "There aren't any PRs to send yet. Link them first with `@Cade pr add <link>`.";
const ALL_SENT = "All of this task's PRs are already with the client.";

// `@Cade release` (or `@Cade deliver`) in a task thread sends some of the
// task's PRs to the client before the whole task is done. It shows whoever
// sent it, privately, a Choose PRs button, since only a click carries the
// trigger_id a modal needs. The form lists the PRs not sent yet, and asks
// what they complete and who approves them: the client, or whoever handles
// them.
//
// Submitting removes the private button and posts the PRs and what they
// complete in the task's thread, with Approve and Not approve buttons,
// mentioning the approver, who alone can click them. The release is stored
// with the task (in the releases table), and the task's message shows each
// PR pending, pending approval or approved. Approving
// marks the release APPROVED. Not approving marks it NOT_APPROVED, kept but
// no longer shown, so its PRs are pending again and can be sent again. Either
// way the task's thread hears it, mentioning its developers. The task's
// status doesn't change: the rest of the work goes on, and Client review
// sends what's left (see status.js).
export default {
  name: "release",
  aliases: ["deliver"],
  description: "Send some of the task's PRs to the client to approve (in its thread)",
  usage: "@Cade release",
  section: "thread",
  channel: "tasks",
  inThread: true,
  async run(command, { env }) {
    const found = await findRelease(env, command.channel, command.threadTs);
    if (found.problem) return found.problem;
    const value = JSON.stringify({ channel: command.channel, ts: command.threadTs });
    await callSlack(env, "chat.postEphemeral", {
      channel: command.channel,
      thread_ts: command.threadTs,
      user: command.user,
      text: "Send PRs for approval",
      blocks: [
        {
          type: "actions",
          elements: [
            { type: "button", action_id: OPEN_ACTION, text: plainText("Choose PRs"), style: "primary", value },
          ],
        },
      ],
    });
  },
  actions: {
    [OPEN_ACTION]: async (payload, { env }) => {
      const { channel, ts } = JSON.parse(payload.actions[0].value);
      const found = await findRelease(env, channel, ts);
      if (found.problem) {
        await callSlack(env, "chat.postEphemeral", { channel, thread_ts: ts, user: payload.user.id, text: found.problem });
        return;
      }
      // The private button goes once the form is sent, through the click's
      // response_url, the only way to change a private message.
      await callSlack(env, "views.open", {
        trigger_id: payload.trigger_id,
        view: releaseView({ channel, ts, responseUrl: payload.response_url }, found.unsent),
      });
    },
    [APPROVE_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, true));
    },
    [REJECT_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, false));
    },
  },
  views: { [RELEASE_VIEW]: submit },
};

// The task in the thread and the PRs not sent yet, as { task, unsent }, or
// { problem } saying why none can be sent.
async function findRelease(env, channel, ts) {
  const task = await loadTask(env, channel, ts);
  if (!task) return { problem: NOT_A_TASK };
  if (!task.prs.length) return { problem: NO_PRS };
  const unsent = unsentPrs(task);
  if (!unsent.length) return { problem: ALL_SENT };
  return { task, unsent };
}

// The task card menu's Send PRs for approval form (see menu.js) as { view },
// or { problem } saying why none can be sent.
export async function releaseForm(env, { channel, ts }) {
  const found = await findRelease(env, channel, ts);
  if (found.problem) return { problem: found.problem };
  return { view: releaseView({ channel, ts }, found.unsent) };
}

function releaseView(origin, prs) {
  // Each PR as reponame/number; option text holds up to 75 characters.
  const option = (url) => {
    const pr = parsePullRequest(url);
    return { text: plainText((pr ? `${pr.repo}/${pr.number}` : url).slice(0, 75)), value: url };
  };
  const options = prs.map(option);
  return {
    type: "modal",
    callback_id: RELEASE_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("Send for approval"),
    submit: plainText("Send"),
    close: plainText("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "prs",
        label: plainText("PRs to send to the client"),
        // All of them, unless some aren't ready.
        element:
          options.length <= MAX_CHECKBOXES
            ? { type: "checkboxes", action_id: "value", options, initial_options: options }
            : { type: "multi_static_select", action_id: "value", options, initial_options: options },
      },
      {
        type: "input",
        block_id: "note",
        label: plainText("What this completes"),
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          max_length: 300,
          placeholder: plainText("e.g. Login and sign-up. Password reset is still in progress."),
        },
      },
      approverBlock(),
      {
        type: "context",
        elements: [mrkdwn("They approve them in this thread. If they don't, you can send them again.")],
      },
    ],
  };
}

async function submit(payload, context) {
  const values = payload.view.state.values;
  const prs = (values.prs.value.selected_options ?? []).map((option) => option.value);
  const note = values.note.value.value?.trim() ?? "";
  const approver = readApprover(values);
  const errors = {};
  if (!prs.length) errors.prs = "Please choose at least one PR.";
  if (!note) errors.note = "Please say what these PRs complete.";
  if (!approver) errors.approver = "Please choose who approves them.";
  if (Object.keys(errors).length) return { response_action: "errors", errors };

  const origin = JSON.parse(payload.view.private_metadata || "{}");
  context.waitUntil(send(context.env, origin, prs, note, approver, payload.user.id));
  return { response_action: "clear" };
}

// Records the release on the task and asks the approver in its thread.
async function send(env, origin, chosen, note, approver, user) {
  const found = await findRelease(env, origin.channel, origin.ts);
  // Someone else may have sent some of them while the form was open.
  const prs = found.problem ? [] : chosen.filter((url) => found.unsent.includes(url));
  if (!prs.length) {
    const text = found.problem ?? "Those PRs are already with the client.";
    await callSlack(env, "chat.postEphemeral", { channel: origin.channel, thread_ts: origin.ts, user, text });
    return;
  }
  const { task } = found;
  const release = { prs, note, status: "PENDING_APPROVAL", sentBy: user };
  const id = await insertRelease(env, origin.channel, origin.ts, release);
  task.releases = [...task.releases, { id, ...release }];
  await callSlack(env, "chat.update", { channel: origin.channel, ts: origin.ts, ...taskMessage(task) });
  console.log("Release sent", { ts: origin.ts, id, prs: prs.length });

  const list = prs.map(prLink).join(", ");
  const completes = `*Completes:* ${escapeSlack(note)}`;
  const sent = `<@${user}> sent these PRs for approval: ${list}\n${completes}`;
  const request = `<@${approver}>, could you take a look and approve them, or let us know what needs to change?`;
  // The buttons carry the task's thread, which holds the release, and who
  // may click them.
  const value = JSON.stringify({ channel: origin.channel, ts: origin.ts, id, approver });
  const ask = {
    text: `${sent}\n${request}`,
    blocks: [
      // The decision replaces the request and the buttons, so `sent` is a
      // block of its own.
      { type: "section", text: mrkdwn(sent) },
      { type: "section", text: mrkdwn(request) },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: APPROVE_ACTION, text: plainText("Approve"), style: "primary", value },
          { type: "button", action_id: REJECT_ACTION, text: plainText("Not approve"), value },
        ],
      },
    ],
  };

  await dismiss(origin.responseUrl);
  await callSlack(env, "chat.postMessage", { channel: origin.channel, thread_ts: origin.ts, ...ask });
}

// Applies the approver's decision on a release, then replaces the request
// and its buttons with the decision and tells the task's thread, mentioning
// its developers.
async function review(payload, env, approved) {
  const { channel, ts, id, approver } = JSON.parse(payload.actions[0].value);
  if (await notTheApprover(env, payload, approver)) return;
  const user = payload.user.id;
  const task = await loadTask(env, channel, ts);
  const release = task?.releases.find((item) => item.id === id);
  // What was sent stays above the decision.
  const sent = payload.message.blocks?.[0]?.text?.text ?? "";

  let outcome;
  if (!release) {
    // Not approved already, or its task was deleted.
    outcome = "These PRs aren't waiting for approval anymore.";
  } else if (release.status === "APPROVED") {
    outcome = "These PRs are already approved.";
  } else if (!(await decideRelease(env, id, approved ? "APPROVED" : "NOT_APPROVED", user))) {
    // Someone else clicked first.
    outcome = "Someone's already decided on these PRs.";
  } else {
    const list = release.prs.map(prLink).join(", ");
    if (approved) Object.assign(release, { status: "APPROVED", decidedBy: user });
    else task.releases = task.releases.filter((item) => item !== release);
    await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
    console.log("Release reviewed", { ts, id, approved });

    outcome = approved
      ? `<@${user}> approved them. Thanks, <@${release.sentBy}>!`
      : `<@${user}> didn't approve them. <@${release.sentBy}>, have a look at this thread for what needs to change.`;
    await tellTask(env, channel, ts, task, payload, release, list, approved);
  }
  const text = sent ? `${sent}\n${outcome}` : outcome;
  await callSlack(env, "chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    text,
    blocks: [{ type: "section", text: mrkdwn(text) }],
  });
}

// Tells the task's thread the decision, as a new reply, since mentions in an
// edited message notify no one.
async function tellTask(env, channel, ts, task, payload, release, list, approved) {
  const people = [...new Set([release.sentBy, ...task.people.developer])];
  const text = approved
    ? `${mentions(people)}, good news! <@${payload.user.id}> approved ${list}.`
    : `${mentions(people)}, <@${payload.user.id}> didn't approve ${list}. Have a look at the thread for what needs to change, then send them again with \`@Cade release\`.`;
  await callSlack(env, "chat.postMessage", {
    channel,
    thread_ts: ts,
    text,
    blocks: [{ type: "section", text: mrkdwn(text) }],
  });
}
