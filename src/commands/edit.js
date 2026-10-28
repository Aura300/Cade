import { CLOSE_ALL, dismiss, mrkdwn, plainText } from "../slack.js";
import { PRIORITIES, ROLES, STATUSES, formatDueDate, loadTask, parsePullRequest, pickerDate } from "../tasks.js";
import { applyChanges, prsAfter, statusAfter } from "./changes.js";
import { statusOption } from "./status.js";

const EDIT_VIEW = "task:edit";

// The Edit form: everything on a task in one place, its owners,
// reviewers and testers, status, priority and due date, and pull requests.
// An incident's priority and due date never change, so its form leaves them
// out. The task card's ⋯ → Edit opens it as the task stands (see menu.js),
// and a suggestion's Edit filled in with what was suggested (see
// ai-suggest.js). Saving applies what changed as one change (see
// changes.js), so the thread hears it as one message.

// The form for the task at `channel`/`ts`, with `changes` (as changes.js
// takes them) already applied to what it shows. `responseUrl` is the private
// suggestion to remove once it's saved, and `told` who its message
// mentioned, so saving doesn't notify them again (see applyChanges).
export function editForm({ channel, ts }, task, { changes = {}, told, responseUrl } = {}) {
  const details = !task.incident;
  const peopleAfter = (role) => {
    const { add = [], remove = [] } = changes.people?.[role] ?? {};
    return [...task.people[role].filter((id) => !remove.includes(id)), ...add];
  };
  const priorityOption = (name) => ({ text: { ...plainText(`${PRIORITIES[name]} ${name}`), emoji: true }, value: name });
  const status = statusAfter(task, changes);
  const priority = changes.priority ?? task.priority;
  const dueDate = "dueDate" in changes ? changes.dueDate : task.dueDate;
  return {
    type: "modal",
    callback_id: EDIT_VIEW,
    // `opened` is the status as it was, so one left alone isn't applied over
    // a move linking a PR makes (see applyChanges).
    private_metadata: JSON.stringify({ channel, ts, details, opened: task.status, responseUrl, told }),
    title: plainText("Edit task"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [
      ...Object.keys(ROLES).map((role) => {
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
      }),
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
        : [{ type: "context", elements: [mrkdwn("Incidents are always :red_circle: Urgent and due Immediate.")] }]),
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
          initial_value: prsAfter(task, changes).join("\n") || undefined,
        },
      },
    ],
  };
}

// Saves the form as the changes from the task as it is now, having removed
// the private suggestion it came from, if any.
function saveEdit(payload, context) {
  const { channel, ts, details, opened, responseUrl, told } = JSON.parse(payload.view.private_metadata);
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
      await dismiss(responseUrl);
      const task = await loadTask(env, channel, ts);
      if (!task) return;
      const changes = { people: {} };
      for (const role of Object.keys(ROLES)) {
        const chosen = values[role]?.value.selected_users ?? [];
        changes.people[role] = {
          add: chosen.filter((id) => !task.people[role].includes(id)),
          remove: task.people[role].filter((id) => !chosen.includes(id)),
        };
      }
      const status = values.status.value.selected_option.value;
      if (status !== opened) changes.status = status;
      if (details) {
        changes.priority = values.priority.value.selected_option?.value ?? task.priority;
        changes.dueDate = formatDueDate(values.due_date.value.selected_date);
      }
      const wanted = [...new Set(urls)];
      changes.prs = { add: wanted.filter((url) => !task.prs.includes(url)), remove: task.prs.filter((url) => !wanted.includes(url)) };
      await applyChanges(env, { channel, ts }, changes, payload.user.id, { told });
    })(),
  );
  return CLOSE_ALL;
}

export default {
  views: { [EDIT_VIEW]: saveEdit },
};
