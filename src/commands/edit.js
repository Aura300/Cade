import { oneMessage } from "../notify.js";
import { findDetails } from "../requirements.js";
import { CLOSE_ALL, callSlack, dismiss, mrkdwn, plainText } from "../slack.js";
import { PRIORITIES, ROLES, STATUSES, formatDueDate, parsePullRequest, pickerDate } from "../tasks.js";
import { applyChanges } from "./changes.js";
import { detailsChange } from "./details.js";
import { statusOption } from "./status.js";

const EDIT_VIEW = "task:edit";

// The Edit form: everything on a task or requirement in one place, its
// developers, reviewers and testers, status, priority and due date, and
// pull requests, showing only those that can be changed where it is opened
// (see editable). The ⋯ → Edit on a task's card (see menu.js) and on a
// requirement's opens it as it stands, and a suggestion's Edit filled in
// with what was suggested (see ai-suggest.js). Saving applies what changed
// as one change (see changes.js), so the thread hears it as one message.

// What the form shows for the thread `found` (see findDetails), and what
// to say about what it leaves out:
//   team     the people, status and pull requests: the team's, on a task
//   details  the priority and due date: on a task with no requirement, and
//            on a requirement, as the client sets them and its task follows
// An incident's priority and due date never change, so an incident's own
// card has nothing to edit.
function editable(found) {
  if (found.kind === "requirement") {
    return {
      team: false,
      details: true,
      note: found.task && "Its task follows these. The team sets who works on it, its status and its pull requests in the dev channel.",
    };
  }
  // Its task's thread; the incident's own has nothing to edit.
  if (found.kind === "incident" && found.item.people) {
    return { team: true, details: false, note: "Incidents are always :red_circle: Urgent and due Immediate." };
  }
  if (found.kind === "client") {
    return { team: true, details: false, note: "Its priority and due date come from its requirement, and are changed there." };
  }
  if (found.kind === "task") return { team: true, details: true };
  return { team: false, details: false };
}

// The form for the task or requirement at `channel`/`ts`, `item`, with
// `changes` (as changes.js takes them) already applied to what it shows, or
// why it can't be edited. `responseUrl` is the private suggestion to remove
// once it's saved.
export async function editForm(env, { channel, ts }, item, { changes = {}, responseUrl } = {}) {
  const found = await findDetails(env, channel, ts);
  const { team, details, note } = found ? editable(found) : {};
  if (!team && !details) return "There's nothing here I can change.";
  const isTask = Boolean(item.people);
  const peopleAfter = (role) => {
    const { add = [], remove = [] } = changes.people?.[role] ?? {};
    return [...item.people[role].filter((id) => !remove.includes(id)), ...add];
  };
  const priorityOption = (name) => ({ text: { ...plainText(`${PRIORITIES[name]} ${name}`), emoji: true }, value: name });
  const status = changes.status ?? item.status;
  const priority = changes.priority ?? item.priority;
  const dueDate = "dueDate" in changes ? changes.dueDate : item.dueDate;
  return {
    type: "modal",
    callback_id: EDIT_VIEW,
    // `opened` is the status as it was, so one left alone isn't applied over
    // a move linking a PR makes (see applyChanges).
    private_metadata: JSON.stringify({ channel, ts, team, details, opened: item.status, responseUrl }),
    title: plainText(isTask ? "Edit task" : "Edit requirement"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [
      ...(team
        ? Object.keys(ROLES).map((role) => {
            const chosen = peopleAfter(role);
            return {
              type: "input",
              block_id: role,
              // Saving a role with no one clears it.
              optional: true,
              label: plainText(`${ROLES[role]}s`),
              element: {
                type: "multi_users_select",
                action_id: "value",
                placeholder: plainText(`Choose ${ROLES[role].toLowerCase()}s`),
                ...(chosen.length && { initial_users: chosen }),
              },
            };
          })
        : []),
      ...(team
        ? [
            {
              type: "input",
              block_id: "status",
              label: plainText("Status"),
              element: {
                type: "static_select",
                action_id: "value",
                options: Object.keys(STATUSES).map(statusOption),
                initial_option: statusOption(status),
              },
            },
          ]
        : []),
      ...(details
        ? [
            {
              type: "input",
              block_id: "priority",
              label: plainText("Priority"),
              element: {
                type: "static_select",
                action_id: "value",
                options: Object.keys(PRIORITIES).map(priorityOption),
                ...(PRIORITIES[priority] && { initial_option: priorityOption(priority) }),
              },
            },
            {
              type: "input",
              block_id: "due_date",
              // Saving with no date removes it.
              optional: true,
              label: plainText("Due date"),
              element: {
                type: "datepicker",
                action_id: "value",
                placeholder: plainText("Select a date"),
                ...(pickerDate(dueDate) && { initial_date: pickerDate(dueDate) }),
              },
            },
          ]
        : []),
      ...(team
        ? [
            {
              type: "input",
              block_id: "prs",
              // Saving with none unlinks them all.
              optional: true,
              label: plainText("Pull requests, one link per line"),
              element: {
                type: "plain_text_input",
                action_id: "value",
                multiline: true,
                placeholder: plainText("https://github.com/acme/web/pull/12"),
                initial_value: item.prs.join("\n") || undefined,
              },
            },
          ]
        : []),
      ...(note ? [{ type: "context", elements: [mrkdwn(note)] }] : []),
    ],
  };
}

// Saves the form as the changes from the task or requirement as it is now,
// having removed the private suggestion it came from, if any. A task's
// changes go through applyChanges; a requirement's priority and due date as
// `@Cade priority` and `@Cade due` change them, noted in its task's thread,
// with who changed what told in its own. Saving it unchanged posts nothing.
function saveEdit(payload, context) {
  const { channel, ts, opened, responseUrl, ...shown } = JSON.parse(payload.view.private_metadata);
  // Forms opened before the requirement's Edit always showed the team's
  // fields, and the priority and due date as `details` says.
  const team = shown.team ?? true;
  const details = shown.details;
  const { values } = payload.view.state;
  const lines = (values.prs?.value.value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const urls = lines.map((line) => parsePullRequest(line.replace(/^<|[|>].*$/g, ""))?.url);
  const wrong = lines.find((line, i) => !urls[i]);
  if (wrong) {
    return { response_action: "errors", errors: { prs: `That doesn't look like a pull request link: ${wrong}`.slice(0, 150) } };
  }
  context.waitUntil(
    (async () => {
      const { env } = context;
      const user = payload.user.id;
      await dismiss(responseUrl);
      const found = await findDetails(env, channel, ts);
      if (!found) return;
      const changes = {};
      if (details) {
        changes.priority = values.priority.value.selected_option?.value ?? found.item.priority;
        changes.dueDate = formatDueDate(values.due_date.value.selected_date);
      }
      if (!team) {
        const changed = await detailsChange(env, channel, ts, changes, user);
        const text = changed && oneMessage(changed);
        if (text) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
        return;
      }
      const task = found.item;
      changes.people = {};
      for (const role of Object.keys(ROLES)) {
        const chosen = values[role]?.value.selected_users ?? [];
        changes.people[role] = {
          add: chosen.filter((id) => !task.people[role].includes(id)),
          remove: task.people[role].filter((id) => !chosen.includes(id)),
        };
      }
      const status = values.status.value.selected_option.value;
      if (status !== opened) changes.status = status;
      const wanted = [...new Set(urls)];
      changes.prs = { add: wanted.filter((url) => !task.prs.includes(url)), remove: task.prs.filter((url) => !wanted.includes(url)) };
      await applyChanges(env, { channel, ts }, changes, user);
    })(),
  );
  return CLOSE_ALL;
}

export default {
  views: { [EDIT_VIEW]: saveEdit },
};
