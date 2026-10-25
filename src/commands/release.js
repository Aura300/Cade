import { decideRelease, insertRelease } from "../db.js";
import { loadRequirement, reflectOnRequirement } from "../requirements.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText } from "../slack.js";
import { NOT_A_TASK, loadTask, parsePullRequest, prLink, taskMessage, unsentPrs } from "../tasks.js";

const OPEN_ACTION = "release:open";
const APPROVE_ACTION = "release:approve";
const REJECT_ACTION = "release:reject";
const RELEASE_VIEW = "release";

// Slack shows up to 10 checkboxes; more pull requests are offered in a menu.
const MAX_CHECKBOXES = 10;

const NOT_FOR_OWN_WORK =
  "Only tasks tracked from a requirement or incident can be released to the client: there's no client thread to send this one to.";
const NO_PRS = "Link the PRs to release first, with `@Cade pr add <link>`.";
const ALL_SENT = "All of this task's PRs have been sent to the client already.";

// `@Cade release` (or `@Cade deliver`) in a task thread sends some of the
// task's PRs to the client before the whole requirement is done. It replies
// with a Choose PRs button, since only a click carries the trigger_id a
// modal needs. The form lists the PRs not sent yet, and asks what they
// complete.
//
// Submitting posts the PRs and what they complete in the requirement thread,
// mentioning whoever started the requirement, with Approve and Not approve
// buttons, and says so in the task's thread. The release is stored with the
// task (in the releases table), and the task's message and the
// requirement's show each PR pending, pending approval or approved. Approving
// marks the release APPROVED. Not approving marks it NOT_APPROVED, kept but
// no longer shown, so its PRs are pending again and can be sent again. Either way both threads hear it,
// the task's mentioning its developers. The task's status doesn't change:
// the rest of the work goes on, and Client review sends what's left (see
// status.js).
export default {
  name: "release",
  aliases: ["deliver"],
  description: "Send some of the task's PRs to the client to approve (in its thread)",
  usage: "@Cade release",
  section: "thread",
  channel: ["tasks", "incidents"],
  inThread: true,
  async run(command, { env }) {
    const found = await findRelease(env, command.channel, command.threadTs);
    if (found.problem) return found.problem;
    const value = JSON.stringify({ channel: command.channel, ts: command.threadTs });
    return {
      text: "Send PRs to the client",
      blocks: [
        {
          type: "actions",
          elements: [
            { type: "button", action_id: OPEN_ACTION, text: plainText("Choose PRs"), style: "primary", value },
          ],
        },
      ],
    };
  },
  actions: {
    [OPEN_ACTION]: async (payload, { env }) => {
      const { channel, ts } = JSON.parse(payload.actions[0].value);
      const found = await findRelease(env, channel, ts);
      if (found.problem) {
        await callSlack(env, "chat.postEphemeral", { channel, thread_ts: ts, user: payload.user.id, text: found.problem });
        return;
      }
      // The button's own message is replaced by the announcement later.
      await callSlack(env, "views.open", {
        trigger_id: payload.trigger_id,
        view: releaseView({ channel, ts, promptTs: payload.message.ts }, found.unsent),
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

// The task in the thread, its requirement and the PRs not sent yet, as
// { task, requirement, unsent }, or { problem } saying why none can be sent.
async function findRelease(env, channel, ts) {
  const task = await loadTask(env, channel, ts);
  if (!task) return { problem: NOT_A_TASK };
  if (!task.source) return { problem: NOT_FOR_OWN_WORK };
  if (!task.prs.length) return { problem: NO_PRS };
  const requirement = await loadRequirement(env, task.source.channel, task.source.threadTs);
  if (!requirement) return { problem: NOT_FOR_OWN_WORK };
  const unsent = unsentPrs(task);
  if (!unsent.length) return { problem: ALL_SENT };
  return { task, requirement, unsent };
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
      {
        type: "context",
        elements: [mrkdwn("The client approves them in the requirement thread. If they don't, the PRs can be sent again.")],
      },
    ],
  };
}

async function submit(payload, context) {
  const values = payload.view.state.values;
  const prs = (values.prs.value.selected_options ?? []).map((option) => option.value);
  const note = values.note.value.value?.trim() ?? "";
  const errors = {};
  if (!prs.length) errors.prs = "Choose at least one PR.";
  if (!note) errors.note = "Say what these PRs complete.";
  if (Object.keys(errors).length) return { response_action: "errors", errors };

  const origin = JSON.parse(payload.view.private_metadata || "{}");
  context.waitUntil(send(context.env, origin, prs, note, payload.user.id));
  return { response_action: "clear" };
}

// Records the release on the task, asks the client to approve it in
// the requirement thread, and tells the task's thread.
async function send(env, origin, chosen, note, user) {
  const found = await findRelease(env, origin.channel, origin.ts);
  // Someone else may have sent some of them while the form was open.
  const prs = found.problem ? [] : chosen.filter((url) => found.unsent.includes(url));
  if (!prs.length) {
    const text = found.problem ?? "Those PRs have been sent to the client already.";
    await callSlack(env, "chat.postEphemeral", { channel: origin.channel, thread_ts: origin.ts, user, text });
    return;
  }
  const { task, requirement } = found;
  const { channel, threadTs } = task.source;
  const release = { prs, note, status: "PENDING_APPROVAL", sentBy: user };
  const id = await insertRelease(env, origin.channel, origin.ts, release);
  task.releases = [...task.releases, { id, ...release }];
  await showReleases(env, origin.channel, origin.ts, task);
  console.log("Release sent", { ts: origin.ts, id, prs: prs.length });

  const list = prs.map(prLink).join(", ");
  const sent = `<@${user}> sent these PRs for approval: ${list}\n*Completes:* ${escapeSlack(note)}`;
  const request = `<@${requirement.createdBy}>, please review them and approve them, or say what needs to change.`;
  // The buttons carry the task's thread, which holds the release.
  const value = JSON.stringify({ channel: origin.channel, ts: origin.ts, id });
  const posted = await callSlack(env, "chat.postMessage", {
    channel,
    thread_ts: threadTs,
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
  });

  const where = await threadLink(env, channel, posted.ts ?? threadTs);
  const text = `<@${user}> sent ${list} to the client for approval ${where}.\n*Completes:* ${escapeSlack(note)}`;
  const body = { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
  if (origin.promptTs) {
    await callSlack(env, "chat.update", { channel: origin.channel, ts: origin.promptTs, ...body });
  } else {
    await callSlack(env, "chat.postMessage", { channel: origin.channel, thread_ts: origin.ts, ...body });
  }
}

// Shows the task's releases on its message and its requirement's.
async function showReleases(env, channel, ts, task) {
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
  await reflectOnRequirement(env, ts, task, {});
}

// "in the requirement thread", linking to `ts` there when Slack gives a link.
async function threadLink(env, channel, ts) {
  try {
    const { permalink } = await callSlack(env, "chat.getPermalink", { channel, message_ts: ts });
    return `in <${permalink}|the requirement thread>`;
  } catch (error) {
    console.warn("Could not link the requirement thread", { ts, error: error.message });
    return "in the requirement thread";
  }
}

// Applies the client's decision on a release, then replaces the request and
// its buttons with the decision and tells the task's thread, mentioning its
// developers.
async function review(payload, env, approved) {
  const { channel, ts, id } = JSON.parse(payload.actions[0].value);
  const user = payload.user.id;
  const task = await loadTask(env, channel, ts);
  const release = task?.releases.find((item) => item.id === id);
  // What was sent stays above the decision.
  const sent = payload.message.blocks?.[0]?.text?.text ?? "";

  let outcome;
  if (!release) {
    // Not approved already, or its task was deleted.
    outcome = "These PRs are no longer waiting for approval.";
  } else if (release.status === "APPROVED") {
    outcome = "These PRs are approved already.";
  } else if (!(await decideRelease(env, id, approved ? "APPROVED" : "NOT_APPROVED", user))) {
    // Someone else clicked first.
    outcome = "Someone has already decided on these PRs.";
  } else {
    const list = release.prs.map(prLink).join(", ");
    if (approved) Object.assign(release, { status: "APPROVED", decidedBy: user });
    else task.releases = task.releases.filter((item) => item !== release);
    await showReleases(env, channel, ts, task);
    console.log("Release reviewed", { ts, id, approved });

    outcome = approved
      ? `<@${user}> approved them. Thanks, <@${release.sentBy}>.`
      : `<@${user}> did not approve them. <@${release.sentBy}>, see this thread for what needs to change.`;
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

async function tellTask(env, channel, ts, task, payload, release, list, approved) {
  const where = await threadLink(env, payload.channel.id, payload.message.ts);
  const people = [...new Set([release.sentBy, ...task.people.developer])];
  const text = approved
    ? `${mentions(people)}: <@${payload.user.id}> approved ${list} ${where}.`
    : `${mentions(people)}: <@${payload.user.id}> did not approve ${list} ${where}. See the thread for what needs to change, then send them again with \`@Cade release\`.`;
  await callSlack(env, "chat.postMessage", {
    channel,
    thread_ts: ts,
    text,
    blocks: [{ type: "section", text: mrkdwn(text) }],
  });
}
