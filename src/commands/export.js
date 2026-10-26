import { channelPairs, findPair } from "../channels.js";
import {
  claimExport,
  exportItems,
  getExport,
  getTask,
  insertExport,
  lastExport,
  postedRequirements,
  putExportItem,
  recordExportDoc,
  releaseExport,
  setExportPeriod,
} from "../db.js";
import { docId, docsEnabled, writeSection } from "../doc.js";
import { REQUIREMENT_STATUSES } from "../requirements.js";
import { formatTime } from "../sheet.js";
import { callSlack, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.js";
import { PRIORITIES, ROLES, STATUSES, statusName } from "../tasks.js";
import { byUrgency, groupTasks, threadLink, todayIn } from "./tasks.js";

// Back, Next and Post carry the summary's id and the step to show; Slack
// wants each button in a block to have its own action_id.
const BACK_ACTION = "export:back";
const NEXT_ACTION = "export:next";
const POST_ACTION = "export:post";
const CANCEL_ACTION = "export:cancel";
const PEEK_ACTION = "export:peek";
// A step of completed work shows up to MAX_SHOWN, each with its own
// checkbox, and Slack wants each one's action_id to be different.
const MAX_SHOWN = 20;
const DONE_ACTIONS = Array.from({ length: MAX_SHOWN }, (_, i) => `export:done:${i}`);

// The first summary of a group covers the past week, to today.
const FIRST_PERIOD_DAYS = 7;

// Peek shows each thread's latest replies, each cut to PEEK_LENGTH
// characters.
const PEEK_REPLIES = 10;
const PEEK_LENGTH = 600;

// How active work is going, as the summary says it, worst first: the
// summary lists it in this order.
export const HEALTH = {
  BLOCKED: ":no_entry: Blocked",
  DELAYED: ":hourglass_flowing_sand: Delayed",
  AT_RISK: ":warning: At risk",
  ON_TRACK: ":thumbsup: On track",
};
// The menu lists them best first, as most work is on track.
const HEALTH_MENU = ["ON_TRACK", "AT_RISK", "DELAYED", "BLOCKED"];

// `/cade export` writes an executive summary of a group with whoever runs it,
// one step at a time, shown only to them, and posts it in the channel it was
// run in. The group is the channel's own, the only one, or the one named:
// `/cade export acme`. It goes through the group's work as the client sees
// it, its requirements and incidents, then the team's own tasks, those with
// no requirement:
//   0. the period it covers, from one day to another, counted in TIMEZONE:
//      from the day after the last summary's period (the past week, for
//      the first) to today, unless changed;
//   1. what was completed in the period, from the start of its first day
//      to the end of its last, each ticked to be mentioned as done;
//   2. each requirement or incident not done, most urgent first, then each
//      such task, to say how it's going (on track, at risk, delayed or
//      blocked), its progress, such as 3/5, and any notes; health and
//      progress start as the last summary had them. Peek at threads shows
//      the latest messages of its requirement thread and its task thread;
//   3. the summary as it will read, to add to the group's Google Doc.
// What's chosen is saved as a draft (see migrations/0007) whenever a step
// is left, so Back shows it again. Nothing about the work itself changes.
//
// The summary isn't posted in Slack: it goes at the top of the Summary tab
// of the group's Google Doc (its `doc` in CHANNEL_PAIRS), as a section of
// its own, which is gone through with the client on a call. `/cade import`
// then reads the section back for what the call added to it (see import.js).
// So `/cade export` only works for a group with a doc.
export default {
  name: "export",
  description: "Write an executive summary step by step, then add it to the group's Google Doc: what's done since the last one, then how each requirement and task is going",
  slashUsage: "/cade export",
  section: "work",
  async slash(command, context) {
    const { env } = context;
    const group = pickGroup(env, command.text, command.channel, "/cade export");
    if (typeof group === "string") return group;
    const noDoc = docProblem(env, group);
    if (noDoc) return noDoc;
    context.waitUntil(
      (async () => {
        const last = await lastExport(env, group.name);
        const to = todayIn(env);
        let from = addDays(to, -FIRST_PERIOD_DAYS);
        if (last) from = addDays(todayIn(env, new Date(last.until)), 1);
        if (from > to) from = to;
        const id = await insertExport(env, {
          group: group.name,
          createdBy: command.user,
          since: dayBoundary(env, from),
          until: dayBoundary(env, to, { end: true }),
        });
        await respondLater(command.responseUrl, await render(env, { s: id, i: 0 }));
      })(),
    );
  },
  actions: {
    ...Object.fromEntries(
      [BACK_ACTION, NEXT_ACTION].map((id) => [
        id,
        async (payload, context) => {
          context.waitUntil(move(payload, context.env, JSON.parse(payload.actions[0].value)));
        },
      ]),
    ),
    [POST_ACTION]: async (payload, context) => {
      context.waitUntil(post(payload, context.env, JSON.parse(payload.actions[0].value)));
    },
    [CANCEL_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
    // A modal must be opened within three seconds of the click, so it opens
    // at once and the messages follow.
    [PEEK_ACTION]: async (payload, context) => {
      const threads = JSON.parse(payload.actions[0].value);
      const { view } = await callSlack(context.env, "views.open", {
        trigger_id: payload.trigger_id,
        view: peekView([{ type: "section", text: mrkdwn("_Reading the threads…_") }]),
      });
      context.waitUntil(fillPeek(context.env, view.id, threads));
    },
    // Ticking is saved straight away, and again when the step is left.
    ...Object.fromEntries(
      DONE_ACTIONS.map((id) => [
        id,
        async (payload, context) => {
          const { s } = JSON.parse(payload.actions[0].block_id);
          context.waitUntil(saveStep(context.env, s, payload.state?.values));
        },
      ]),
    ),
  },
};

// Why the group's summaries can't be written in its Google Doc, if they
// can't: the doc's web app isn't set up, or the group has no doc.
export function docProblem(env, group) {
  if (!docsEnabled(env)) {
    return "Executive summaries are kept in a Google Doc, and its web app isn't set up yet: run `npm run doc:create` (see GETTING_STARTED.md).";
  }
  if (!docId(group.doc)) {
    return `${group.name} has no Google Doc linked. Add the doc's address as \`"doc"\` to its group in cade.config.json, then run \`npm run config\`.`;
  }
  return undefined;
}

// The doc's address, for links to it.
function docLink(group) {
  return `https://docs.google.com/document/d/${docId(group.doc)}/edit`;
}

// The group a command run in `channel` is for: the one `text` names, the
// channel's own, or the only one. Otherwise, what to tell whoever sent it,
// suggesting `usage` with each group's name.
export function pickGroup(env, text, channel, usage) {
  const groups = channelPairs(env);
  const named = text.trim().toLowerCase();
  if (named) {
    const group = groups.find((pair) => pair.name.toLowerCase() === named);
    return group ?? `I don't know a group called "${escapeSlack(text.trim())}". Try ${groupNames(groups, usage)}.`;
  }
  const own = findPair(env, channel);
  if (own) return own;
  if (groups.length === 1) return groups[0];
  return `Which group? Try ${groupNames(groups, usage)}.`;
}

function groupNames(groups, usage) {
  return groups.map((pair) => `\`${usage} ${pair.name}\``).join(" or ");
}

// Saves the step being left, then shows step `at.i`.
async function move(payload, env, at) {
  await saveStep(env, at.s, payload.state?.values);
  await respondLater(payload.response_url, { replace_original: true, ...(await render(env, at)) });
}

// The group's requirements and incidents, then its tasks with no
// requirement, as entries for the walk: { kind, channel, ts, title,
// incident, link, done, completedAt, status, priority, dueDate, people,
// threads }. A requirement's people and status are its tracked task's, and
// it is completed when that task is. `threads` are the threads to peek at,
// as { c, t, n } (channel, ts, name). `task` holds the priority and due date
// byUrgency sorts by.
async function entries(env, group, url) {
  const requirements = await Promise.all(
    (group.external ? await postedRequirements(env, group.external) : []).map(async ({ ts, requirement, updatedAt }) => {
      const tracked = requirement.task;
      const task = tracked ? await getTask(env, tracked.channel, tracked.ts) : null;
      const noun = requirement.incident ? "Incident" : "Requirement";
      const threads = [{ c: group.external, t: ts, n: `${noun} thread` }];
      if (task) threads.push({ c: tracked.channel, t: tracked.ts, n: tracked.channel === group.incidents ? "Incidents channel thread" : "Dev thread" });
      return {
        kind: "requirement",
        channel: group.external,
        ts,
        title: requirement.title,
        incident: requirement.incident,
        link: threadLink(url, group.external, ts),
        done: requirement.status === "DONE",
        completedAt: task?.completedAt || isoTime(updatedAt),
        status: task ? statusName(task.status) : label(REQUIREMENT_STATUSES[requirement.status]),
        task: { priority: requirement.priority, dueDate: requirement.dueDate },
        people: task?.people,
        threads,
      };
    }),
  );
  // A task whose requirement is gone counts as the team's own.
  const known = new Set(requirements.map((entry) => `${entry.channel}:${entry.ts}`));
  const own = (await groupTasks(env, group, Object.keys(STATUSES), url))
    .filter(({ task }) => !task.source || !known.has(`${task.source.channel}:${task.source.threadTs}`))
    .map(({ channel, ts, task, link, incident }) => ({
      kind: "task",
      channel,
      ts,
      title: task.title,
      incident,
      link,
      done: task.status === "DONE",
      completedAt: task.completedAt,
      status: statusName(task.status),
      task,
      people: task.people,
      threads: [{ c: channel, t: ts, n: incident ? "Incidents channel thread" : "Dev thread" }],
    }));
  return { requirements, own };
}

// SQLite's CURRENT_TIMESTAMP (UTC, "YYYY-MM-DD HH:MM:SS") as an ISO
// timestamp, as tasks' completion times are.
export function isoTime(timestamp) {
  return new Date(`${timestamp.replace(" ", "T")}Z`).toISOString();
}

// The instant a day (YYYY-MM-DD) starts in TIMEZONE, or with `end` the
// last millisecond before it ends, as an ISO timestamp.
export function dayBoundary(env, day, { end = false } = {}) {
  const [year, month, date] = day.split("-").map(Number);
  const wall = end ? Date.UTC(year, month - 1, date, 23, 59, 59, 999) : Date.UTC(year, month - 1, date);
  // How far the zone's clock is ahead of UTC at `at`; asked twice, in case
  // it changes between the guess and the answer.
  const offset = (at) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: env.TIMEZONE || "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(at)
        .map(({ type, value }) => [type, Number(value)]),
    );
    const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return local - Math.floor(at / 1000) * 1000;
  };
  const guess = wall - offset(wall);
  return new Date(wall - offset(guess)).toISOString();
}

// YYYY-MM-DD, `days` later (earlier, if negative).
function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// A day (YYYY-MM-DD) as DD/MM/YYYY.
export function showDay(day) {
  const [year, month, date] = day.split("-");
  return `${date}/${month}/${year}`;
}

// The summary's period as days in TIMEZONE: { from, to }, as YYYY-MM-DD.
function period(env, summary) {
  return {
    from: todayIn(env, new Date(summary.since)),
    to: summary.until ? todayIn(env, new Date(summary.until)) : todayIn(env),
  };
}

// "18/10/2026 – 25/10/2026"
function periodLabel(env, summary) {
  const { from, to } = period(env, summary);
  return `${showDay(from)} – ${showDay(to)}`;
}

// A status label without its emoji.
export function label(text) {
  return text.replace(/^:[a-z0-9_+-]+:\s*/, "");
}

// The summary's work, read afresh: { done, active, steps }. `done` is what
// was completed in the summary's period, oldest first; `active` what isn't
// done: requirements most urgent first, then tasks. The steps are the
// period, pages of done work, each active entry, then the review.
async function walk(env, summary, url) {
  const group = channelPairs(env).find((pair) => pair.name === summary.group);
  const { requirements, own } = group ? await entries(env, group, url) : { requirements: [], own: [] };
  const all = [...requirements, ...own];
  const done = all
    .filter((entry) => entry.done && entry.completedAt >= summary.since && (!summary.until || entry.completedAt <= summary.until))
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const active = [
    ...requirements.filter((entry) => !entry.done).sort(byUrgency),
    ...own.filter((entry) => !entry.done).sort(byUrgency),
  ];
  const pages = [];
  for (let start = 0; start < done.length; start += MAX_SHOWN) {
    pages.push({ done: done.slice(start, start + MAX_SHOWN), first: start });
  }
  return { done, active, steps: [{ period: true }, ...pages, ...active.map((entry, n) => ({ entry, n })), { review: true }] };
}

// What has been chosen for each entry: chosen(entry) gives { included,
// health, progress, notes }. Entries not visited yet are included, with the
// health and progress the last posted summary gave them.
async function choices(env, summary) {
  const items = await exportItems(env, summary.id);
  const last = await lastExport(env, summary.group);
  const previous = last && last.id !== summary.id ? await exportItems(env, last.id) : {};
  return (entry) => {
    const key = `${entry.channel}:${entry.ts}`;
    const before = previous[key];
    return items[key] ?? { included: true, health: before?.health ?? "ON_TRACK", progress: before?.progress ?? "", notes: "" };
  };
}

// Saves what the step's checkboxes and fields hold, read from the message's
// state. Each block's id names its entry and field (see fieldId).
async function saveStep(env, id, values = {}) {
  const updates = {};
  const days = {};
  for (const [blockId, elements] of Object.entries(values)) {
    let field;
    try {
      field = JSON.parse(blockId);
    } catch {
      continue;
    }
    const value = Object.values(elements)[0] ?? {};
    if ((field?.f === "from" || field?.f === "to") && value.selected_date) days[field.f] = value.selected_date;
    if (!field?.c || !field?.t) continue;
    const update = (updates[`${field.c}:${field.t}`] ??= { channel: field.c, ts: field.t });
    if (field.f === "include") update.included = (value.selected_options ?? []).length > 0;
    if (field.f === "health" && HEALTH[value.selected_option?.value]) update.health = value.selected_option.value;
    if (field.f === "progress") update.progress = (value.value ?? "").trim();
    if (field.f === "notes") update.notes = (value.value ?? "").trim();
  }
  if (!Object.keys(updates).length && !Object.keys(days).length) return;
  const summary = await getExport(env, id);
  if (!summary || summary.exportedAt) return;
  if (Object.keys(days).length) {
    const { from, to } = { ...period(env, summary), ...days };
    await setExportPeriod(env, id, dayBoundary(env, from), dayBoundary(env, to, { end: true }));
  }
  const chosen = await choices(env, summary);
  for (const { channel, ts, ...fields } of Object.values(updates)) {
    await putExportItem(env, id, channel, ts, { ...chosen({ channel, ts }), ...fields });
  }
}

// A field's block_id: its entry, which field, and the summary, for the
// checkboxes that save as soon as they're ticked.
function fieldId(entry, field, summary) {
  return JSON.stringify({ c: entry.channel, t: entry.ts, f: field, s: summary.id });
}

// An entry as a line, for the walk: its title, linking to its thread, its
// status, priority and due date, and who works on it.
function entryLine(entry) {
  const parts = [
    `• ${title(entry)}`,
    entry.status,
    PRIORITIES[entry.task.priority] && `${PRIORITIES[entry.task.priority]} ${entry.task.priority}`,
    `Due ${entry.task.dueDate || "_none_"}`,
  ];
  const ids = [...new Set(Object.keys(ROLES).flatMap((role) => entry.people?.[role] ?? []))];
  parts.push(ids.length ? mentions(ids) : entry.people ? "_Unassigned_" : "_Not tracked yet_");
  return parts.filter(Boolean).join("  ·  ");
}

function title(entry) {
  return `${entry.incident ? "*Incident:* " : ""}<${entry.link}|${escapeSlack(entry.title)}>`;
}

// The message for step `at.i`, with Back, Next (or Post) and Cancel.
// `notice`, if any, is shown above it.
async function render(env, at, notice) {
  const summary = await getExport(env, at.s);
  if (!summary) return { text: "I can't find that summary any more. Send `/cade export` to start again." };
  if (summary.exportedAt) return { text: "This executive summary has been added to the Google Doc. Send `/cade export` to write the next one." };
  // Links are built from the workspace's address.
  const { url } = await callSlack(env, "auth.test", {});
  const { done, active, steps } = await walk(env, summary, url);
  let i = Math.min(at.i, steps.length - 1);
  const { from, to } = period(env, summary);
  // The period must be right before going on.
  if (from > to && i > 0) {
    i = 0;
    notice = ":warning: *From* must be on or before *To*.";
  }
  const step = steps[i];
  const chosen = await choices(env, summary);

  const blocks = [];
  if (notice) blocks.push({ type: "section", text: mrkdwn(notice) });
  blocks.push({
    type: "section",
    text: mrkdwn(`*Executive summary: ${summary.group}*  ·  Step ${i + 1} of ${steps.length}`),
  });

  if (step.period) {
    const zone = env.TIMEZONE || "UTC";
    const day = (field, labelText, initial) => ({
      type: "input",
      block_id: JSON.stringify({ f: field, s: summary.id }),
      label: plainText(labelText),
      element: { type: "datepicker", action_id: "value", initial_date: initial },
    });
    blocks.push(
      {
        type: "context",
        elements: [mrkdwn(`*Period.* Work completed from the start of *From* to the end of *To* (${zone}) is offered as completed.`)],
      },
      day("from", "From", from),
      day("to", "To", to),
    );
  } else if (step.done) {
    const shown = `${step.first + 1}–${step.first + step.done.length} of ${done.length}`;
    blocks.push({
      type: "context",
      elements: [mrkdwn(`*Completed ${periodLabel(env, summary)}* (${shown}). Untick any not to mention as done.`)],
    });
    const option = { text: plainText("Mention as done"), value: "yes" };
    step.done.forEach((entry, place) => {
      blocks.push({
        type: "section",
        block_id: fieldId(entry, "include", summary),
        text: mrkdwn(entryLine(entry)),
        accessory: {
          type: "checkboxes",
          action_id: DONE_ACTIONS[place],
          options: [option],
          ...(chosen(entry).included && { initial_options: [option] }),
        },
      });
    });
  } else if (step.entry) {
    const { entry } = step;
    const choice = chosen(entry);
    const healthOption = (health) => ({ text: { ...plainText(HEALTH[health]), emoji: true }, value: health });
    const include = { text: plainText("Mention in the summary"), value: "yes" };
    const kind = entry.kind === "requirement" ? "Requirements and incidents" : "The team's own tasks";
    const ofKind = active.filter((other) => other.kind === entry.kind);
    blocks.push(
      { type: "context", elements: [mrkdwn(`*${kind}*  ·  ${ofKind.indexOf(entry) + 1} of ${ofKind.length}`)] },
      {
        type: "section",
        text: mrkdwn(entryLine(entry)),
        accessory: {
          type: "button",
          action_id: PEEK_ACTION,
          text: plainText("Peek at threads"),
          value: JSON.stringify(entry.threads),
        },
      },
      {
        type: "input",
        block_id: fieldId(entry, "health", summary),
        label: plainText("How it's going"),
        element: {
          type: "static_select",
          action_id: "value",
          options: HEALTH_MENU.map(healthOption),
          initial_option: healthOption(HEALTH[choice.health] ? choice.health : "ON_TRACK"),
        },
      },
      {
        type: "input",
        block_id: fieldId(entry, "progress", summary),
        optional: true,
        label: plainText("Progress"),
        element: {
          type: "plain_text_input",
          action_id: "value",
          max_length: 30,
          placeholder: plainText("e.g. 3/5"),
          ...(choice.progress && { initial_value: choice.progress }),
        },
      },
      {
        type: "input",
        block_id: fieldId(entry, "notes", summary),
        optional: true,
        label: plainText("Notes"),
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          max_length: 1000,
          ...(choice.notes && { initial_value: choice.notes }),
        },
      },
      {
        type: "input",
        block_id: fieldId(entry, "include", summary),
        optional: true,
        label: plainText("In the summary"),
        element: {
          type: "checkboxes",
          action_id: "value",
          options: [include],
          ...(choice.included && { initial_options: [include] }),
        },
      },
    );
  } else {
    const group = channelPairs(env).find((pair) => pair.name === summary.group);
    const where = group && docId(group.doc) ? `<${docLink(group)}|${summary.group}'s Google Doc>` : "the group's Google Doc";
    blocks.push({ type: "context", elements: [mrkdwn(`*Review.* This is what I'll add to the top of ${where}'s Summary tab.`)] });
    for (const chunk of chunks(summaryText(env, summary, done, active, chosen), 3000).slice(0, 40)) {
      blocks.push({ type: "section", text: mrkdwn(chunk) });
    }
  }

  const go = (action_id, to, text, style) => ({
    type: "button",
    action_id,
    text: plainText(text.slice(0, 75)),
    value: JSON.stringify({ s: summary.id, i: to }),
    ...(style && { style }),
  });
  const buttons = [];
  if (i > 0) buttons.push(go(BACK_ACTION, i - 1, "◀ Back"));
  const next = steps[i + 1];
  if (next) buttons.push(go(NEXT_ACTION, i + 1, `Next: ${stepName(next)} ▶`, "primary"));
  else buttons.push(go(POST_ACTION, i, "Add to the Google Doc", "primary"));
  buttons.push({ type: "button", action_id: CANCEL_ACTION, text: plainText("Cancel"), value: "cancel" });
  blocks.push({ type: "actions", elements: buttons });
  return { text: `Executive summary: step ${i + 1} of ${steps.length}`, blocks };
}

function stepName(step) {
  if (step.period) return "Period";
  if (step.done) return "Completed";
  if (step.entry) return step.entry.title;
  return "Review";
}

// The summary as the review shows it, in sections: Completed, then the active
// incidents, each saying how it's going, then the rest of the active work
// by how it's going, worst first. Each active line has its status, progress
// and notes. Sections with nothing in them are left out, and headings are
// plain words.
export function summaryText(env, summary, done, active, chosen) {
  const health = (entry) => (HEALTH[chosen(entry).health] ? chosen(entry).health : "ON_TRACK");
  const going = active.filter((entry) => chosen(entry).included);
  const lines = [
    `*${summary.group} executive summary*  ·  ${formatTime(env, new Date()).slice(0, 10)}`,
    `_Period: ${periodLabel(env, summary)}_`,
  ];
  const section = (heading, entries, line) => {
    if (!entries.length) return;
    lines.push("", `*${heading} (${entries.length})*`, ...entries.flatMap(line));
  };
  const activeLine = (entry, label) => {
    const { progress, notes } = chosen(entry);
    const parts = [`<${entry.link}|${escapeSlack(entry.title)}>`, label, entry.status, progress && escapeSlack(progress)];
    return [
      `• ${parts.filter(Boolean).join("  ·  ")}`,
      ...(notes ?? "").split("\n").filter((text) => text.trim()).map((note) => `      _${escapeSlack(note.trim())}_`),
    ];
  };

  section("Completed", done.filter((entry) => chosen(entry).included), (entry) => [`• ${title(entry)}`]);
  section("Incidents", going.filter((entry) => entry.incident), (entry) => activeLine(entry, label(HEALTH[health(entry)])));
  for (const [key, heading] of Object.entries(HEALTH)) {
    const these = going.filter((entry) => !entry.incident && health(entry) === key);
    section(label(heading), these, (entry) => activeLine(entry));
  }
  if (lines.length === 2) lines.push("", "_Nothing completed or active._");
  return lines.join("\n");
}

// `text` in pieces of at most `size` characters, split between lines.
function chunks(text, size) {
  const found = [""];
  for (const piece of text.split("\n")) {
    const last = found.length - 1;
    if (found[last] && found[last].length + piece.length + 1 > size) found.push("");
    found[found.length - 1] += (found[found.length - 1] ? "\n" : "") + piece.slice(0, size);
  }
  return found;
}

function peekView(blocks) {
  return { type: "modal", title: plainText("Thread messages"), close: plainText("Close"), blocks };
}

// Fills the peek modal with each thread's latest replies, newest last.
async function fillPeek(env, viewId, threads) {
  const { url } = await callSlack(env, "auth.test", {});
  const blocks = [];
  for (const { c: channel, t: ts, n: name } of threads) {
    if (blocks.length) blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: mrkdwn(`*${name}*  ·  <${threadLink(url, channel, ts)}|Open>`) });
    let replies = [];
    try {
      const { messages = [] } = await callSlack(env, "conversations.replies", { channel, ts, limit: 200 });
      replies = messages.slice(1).slice(-PEEK_REPLIES);
    } catch (error) {
      console.warn("Could not read a thread to peek at", { channel, ts, error: error.message });
      blocks.push({ type: "context", elements: [mrkdwn("_I couldn't read this thread._")] });
      continue;
    }
    if (!replies.length) blocks.push({ type: "context", elements: [mrkdwn("_No replies yet._")] });
    for (const message of replies) {
      const who = message.user ? `<@${message.user}>` : escapeSlack(message.username ?? "Someone");
      const when = formatTime(env, new Date(Number(message.ts) * 1000));
      let text = message.text ?? "";
      if (text.length > PEEK_LENGTH) text = `${text.slice(0, PEEK_LENGTH)}…`;
      if (message.files?.length) text += `${text ? "\n" : ""}_(attachment)_`;
      blocks.push({ type: "section", text: mrkdwn(`*${who}*  ·  ${when}\n${text || "_(no text)_"}`) });
    }
  }
  await callSlack(env, "views.update", { view_id: viewId, view: peekView(blocks.slice(0, 100)) });
}

// Adds the summary to the group's Google Doc, once, then replaces the walk
// with a note that it was. The section is keyed by the summary, so trying
// again replaces it rather than adding another.
async function post(payload, env, at) {
  await saveStep(env, at.s, payload.state?.values);
  const summary = await getExport(env, at.s);
  if (!summary || summary.exportedAt) {
    await respondLater(payload.response_url, { replace_original: true, ...(await render(env, at)) });
    return;
  }
  const group = channelPairs(env).find((pair) => pair.name === summary.group);
  const problem = group ? docProblem(env, group) : `I don't know the group ${summary.group} any more.`;
  if (problem) {
    await respondLater(payload.response_url, { replace_original: true, ...(await render(env, at, `:warning: ${problem}`)) });
    return;
  }
  const { url } = await callSlack(env, "auth.test", {});
  const { done, active } = await walk(env, summary, url);
  const chosen = await choices(env, summary);
  const blocks = summaryDocBlocks(env, summary, done, active, chosen);
  if (!(await claimExport(env, summary.id, new Date().toISOString()))) {
    await respondLater(payload.response_url, { replace_original: true, ...(await render(env, at)) });
    return;
  }
  const doc = docId(group.doc);
  let address;
  try {
    address = await writeSection(env, doc, `export:${summary.id}`, blocks);
  } catch (error) {
    await releaseExport(env, summary.id);
    console.warn("Could not add the executive summary to the doc", { id: summary.id, error: error.message });
    const notice = ":warning: Sorry, I couldn't add it to the Google Doc just now. Press Add to the Google Doc to try again.";
    await respondLater(payload.response_url, { replace_original: true, ...(await render(env, at, notice)) });
    return;
  }
  await recordExportDoc(env, summary.id, doc, address, blocks.map(docBlockText));
  console.log("Executive summary added to the doc", { id: summary.id, group: summary.group, user: payload.user.id });
  await respondLater(payload.response_url, {
    replace_original: true,
    text: `Added the executive summary for ${periodLabel(env, summary)} to <${address}|${summary.group}'s Google Doc>. After going through it with the client, send \`/cade import\` for what was added to it.`,
  });
}

// The summary as a section of the doc (see writeSection in doc.js): a
// heading with the day it was written, the period, then the same sections
// as summaryText, each line a bullet whose title links to its thread, with
// its notes as bullets under it.
export function summaryDocBlocks(env, summary, done, active, chosen) {
  const health = (entry) => (HEALTH[chosen(entry).health] ? chosen(entry).health : "ON_TRACK");
  const going = active.filter((entry) => chosen(entry).included);
  const blocks = [
    { type: "heading", level: 2, text: `${showDay(todayIn(env))} · ${summary.group} executive summary` },
    { type: "paragraph", italic: true, text: `Period: ${periodLabel(env, summary)}` },
  ];
  const section = (heading, entries, item) => {
    if (!entries.length) return;
    blocks.push({ type: "heading", level: 3, text: `${heading} (${entries.length})` }, ...entries.flatMap(item));
  };
  const named = (entry) => [...(entry.incident ? [{ text: "Incident: " }] : []), { text: entry.title, link: entry.link }];
  const activeItem = (entry, label) => {
    const { progress, notes } = chosen(entry);
    const rest = [label, entry.status, progress].filter(Boolean).join("  ·  ");
    return [
      { type: "item", level: 0, parts: [{ text: entry.title, link: entry.link }, ...(rest ? [{ text: `  ·  ${rest}` }] : [])] },
      ...(notes ?? "")
        .split("\n")
        .map((note) => note.trim())
        .filter(Boolean)
        .map((note) => ({ type: "item", level: 1, parts: [{ text: note }] })),
    ];
  };
  section("Completed", done.filter((entry) => chosen(entry).included), (entry) => [{ type: "item", level: 0, parts: named(entry) }]);
  section("Incidents", going.filter((entry) => entry.incident), (entry) => activeItem(entry, label(HEALTH[health(entry)])));
  for (const [key, heading] of Object.entries(HEALTH)) {
    const these = going.filter((entry) => !entry.incident && health(entry) === key);
    section(label(heading), these, (entry) => activeItem(entry));
  }
  if (blocks.length === 2) blocks.push({ type: "paragraph", text: "Nothing completed or active." });
  return blocks;
}

// A doc block's text, as the doc shows it.
export function docBlockText(block) {
  return block.parts ? block.parts.map((part) => part.text).join("") : block.text;
}
