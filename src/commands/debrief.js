import { projects } from "../channels.js";
import { decideSuggestion, getExport, getSuggestion, insertSuggestion, lastExport, pendingSuggestions, suggestions } from "../db.js";
import { readSection } from "../doc.js";
import { callSlack, escapeSlack, linkedThread, mrkdwn, plainText, respondLater } from "../slack.js";
import { docProblem, pickGroup, showDay } from "./brief.js";
import { trackView } from "./track.js";
import { threadLink, todayIn } from "./tasks.js";

const APPLY_ACTION = "import:apply";
const DISCARD_ACTION = "import:discard";
const STOP_ACTION = "import:stop";
const POINT_VIEW = "import:point";

// `/cade debrief` follows up a call with the client, after going through the
// group's last executive summary in its Google Doc (see brief.js) with them.
// It reads the summary's section back and compares it with what Cade wrote,
// for what was added during the call:
//   - a bullet of its own, with no link: a new task, with the lines under it
//     as its details;
//   - lines under one of the summary's tasks: points for its thread.
// It suggests them one at a time, shown only to whoever sent it, each to
// Apply or Discard:
//   - Apply on a point opens a text box with it, to edit, then posts it in
//     the thread its line links to;
//   - Apply on a new task opens the task form, named from it, with an
//     Initial message, its details, posted in the new task's thread in the
//     dev channel once it's tracked.
// Each is found once: sending `/cade debrief` again goes on with those not
// decided yet, and adds any added to the doc since.
export default {
  name: "debrief",
  description: "After a client call, go through what was added to the last executive summary in the group's Google Doc",
  slashUsage: "/cade debrief",
  section: "work",
  async slash(command, context) {
    const { env } = context;
    const group = pickGroup(env, command.text, command.channel, "/cade debrief");
    if (typeof group === "string") return group;
    const problem = docProblem(env, group);
    if (problem) return problem;
    context.waitUntil(
      sync(env, group).then(
        (body) => respondLater(command.responseUrl, body),
        (error) => {
          console.error("Could not sync the executive summary", { group: group.name, error: error.message });
          return respondLater(command.responseUrl, { text: "Sorry, I couldn't read the Google Doc just now. Could you try again?" });
        },
      ),
    );
  },
  actions: {
    // The form must open within three seconds of the click.
    [APPLY_ACTION]: async (payload, context) => {
      const { env } = context;
      const suggestion = await getSuggestion(env, Number(payload.actions[0].value));
      const summary = suggestion && (await getExport(env, suggestion.exportId));
      const group = summary && projects(env).find((pair) => pair.name === summary.group);
      if (!group || suggestion.status !== "PENDING") {
        context.waitUntil(next(env, payload.response_url, suggestion?.exportId));
        return;
      }
      const sync = { id: suggestion.id, r: payload.response_url };
      const initial = { initial: suggestion.details || suggestion.text };
      const view =
        suggestion.kind === "TASK"
          ? trackView(env, { channel: group.channel, title: suggestion.text, sync }, initial)
          : pointView(suggestion, sync);
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view });
    },
    [DISCARD_ACTION]: async (payload, context) => {
      const { env } = context;
      const id = Number(payload.actions[0].value);
      context.waitUntil(
        (async () => {
          await decideSuggestion(env, id, "DISCARDED", payload.user.id);
          await next(env, payload.response_url, (await getSuggestion(env, id))?.exportId);
        })(),
      );
    },
    [STOP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
  views: { [POINT_VIEW]: submitPoint },
};

// Reads the group's last summary back from its doc, stores what was added,
// and returns the first suggestion to show.
async function sync(env, group) {
  const summary = await lastExport(env, group.name);
  if (!summary) return { text: `${group.name} has no executive summary in its Google Doc yet. Write one with \`/cade brief\`.` };
  const elements = await readSection(env, summary.docId, `export:${summary.id}`);
  if (!elements) {
    return { text: `I couldn't find the executive summary of ${writtenOn(env, summary)} in <${summary.docUrl}|the Google Doc> any more. Was its heading deleted?` };
  }
  const found = await suggestions(env, summary.id);
  for (const suggestion of findAdditions(elements, summary.docLines, found)) {
    await insertSuggestion(env, summary.id, suggestion);
  }
  return render(env, summary);
}

// Replaces the message at `responseUrl` with the next suggestion.
async function next(env, responseUrl, exportId) {
  const summary = exportId && (await getExport(env, exportId));
  await respondLater(responseUrl, {
    replace_original: true,
    ...(summary ? await render(env, summary) : { text: "I can't find that summary any more. Send `/cade debrief` to start again." }),
  });
}

// What was added to the section, as suggestions to store: { kind: "POINT",
// channel, ts, title, text } for lines under a linked line, the lines under
// each line together, or { kind: "TASK", text, details } for a bullet
// of its own with no link. `written` is the text of each line Cade wrote,
// which isn't counted, nor are lines of `found`, the summary's suggestions
// so far, however they were decided.
export function findAdditions(elements, written, found = []) {
  const known = new Set(written.map((text) => text.trim()));
  const pointed = new Set(found.filter((s) => s.kind === "POINT").flatMap((s) => s.text.split("\n").map((line) => `${s.channel}:${s.ts}:${line}`)));
  const named = new Set(found.filter((s) => s.kind === "TASK").map((s) => s.text));
  const additions = [];
  let entry = null;
  let fresh = null;
  for (const element of elements) {
    const text = (element.text ?? "").trim();
    if (element.type === "heading") {
      entry = fresh = null;
      continue;
    }
    if (!text) continue;
    if (element.type === "item" && !element.level) {
      const thread = (element.links ?? []).map(threadOf).find(Boolean);
      entry = fresh = null;
      if (thread) {
        entry = { kind: "POINT", channel: thread.channel, ts: thread.ts, title: text.split("  ·  ")[0], lines: [] };
        additions.push(entry);
      } else if (!known.has(text)) {
        fresh = { kind: "TASK", text, lines: [] };
        if (!named.has(text)) additions.push(fresh);
      }
      continue;
    }
    if (known.has(text)) continue;
    if (fresh) fresh.lines.push(text);
    else if (entry && !pointed.has(`${entry.channel}:${entry.ts}:${text}`)) entry.lines.push(text);
  }
  return additions
    .filter((addition) => addition.kind === "TASK" || addition.lines.length)
    .map(({ lines, ...addition }) =>
      addition.kind === "POINT" ? { ...addition, text: lines.join("\n") } : { ...addition, details: lines.join("\n") },
    );
}

// The thread a link in the doc opens, as { channel, ts }, or null. Cade's
// links (see threadLink) name the thread; others are read as Slack message
// links.
function threadOf(link) {
  const match = /\/archives\/([A-Z0-9]+)\/p\d+\?(?:[^#]*&)?thread_ts=([\d.]+)/.exec(link.replace(/&amp;/g, "&"));
  return match ? { channel: match[1], ts: match[2] } : linkedThread(link);
}

function writtenOn(env, summary) {
  return showDay(todayIn(env, new Date(summary.exportedAt)));
}

// The summary's next suggestion still to decide, with Apply, Discard and
// Stop, or a note that there are none.
async function render(env, summary) {
  const pending = await pendingSuggestions(env, summary.id);
  const doc = `<${summary.docUrl}|the executive summary of ${writtenOn(env, summary)}>`;
  if (!pending.length) return { text: `Nothing more to go through: everything added to ${doc} has been applied or discarded.` };
  const suggestion = pending[0];
  const group = projects(env).find((pair) => pair.name === summary.group);
  const blocks = [{ type: "section", text: mrkdwn(`*${escapeSlack(summary.group)}: added to ${doc}*  ·  ${pending.length} to go`) }];
  if (suggestion.kind === "POINT") {
    const { url } = await callSlack(env, "auth.test", {});
    const thread = threadLink(url, suggestion.channel, suggestion.ts);
    blocks.push(
      { type: "section", text: mrkdwn(`*Added under* <${thread}|${escapeSlack(suggestion.title)}>\n${quote(suggestion.text)}`.slice(0, 3000)) },
      { type: "context", elements: [mrkdwn("Apply lets you edit it, then posts it in that thread.")] },
    );
  } else {
    const details = suggestion.details ? `\n${quote(suggestion.details)}` : "";
    blocks.push(
      { type: "section", text: mrkdwn(`*New task:* ${escapeSlack(suggestion.text)}${details}`.slice(0, 3000)) },
      {
        type: "context",
        elements: [
          mrkdwn(`Apply opens the task form, with ${details ? "the lines under it" : "it"} as the initial message, to track it in <#${group?.channel}>.`),
        ],
      },
    );
  }
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: APPLY_ACTION, text: plainText("Apply…"), value: String(suggestion.id), style: "primary" },
      { type: "button", action_id: DISCARD_ACTION, text: plainText("Discard"), value: String(suggestion.id) },
      { type: "button", action_id: STOP_ACTION, text: plainText("Stop for now"), value: "stop" },
    ],
  });
  return { text: `What was added to ${summary.group}'s executive summary`, blocks };
}

function quote(text) {
  return escapeSlack(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

// The text box for a point, to edit before it's posted in its thread.
// `sync` is { id, r }: the suggestion, and the response_url of the message
// to move on once it's posted.
function pointView(suggestion, sync) {
  return {
    type: "modal",
    callback_id: POINT_VIEW,
    private_metadata: JSON.stringify(sync),
    title: plainText("Post to the thread"),
    submit: plainText("Post"),
    close: plainText("Cancel"),
    blocks: [
      { type: "context", elements: [mrkdwn(`Added under *${escapeSlack(suggestion.title)}* during the client call.`)] },
      {
        type: "input",
        block_id: "message",
        label: plainText("Message"),
        element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000, initial_value: suggestion.text.slice(0, 3000) },
      },
    ],
  };
}

async function submitPoint(payload, context) {
  const { env } = context;
  const text = payload.view.state.values.message?.value?.value?.trim() ?? "";
  if (!text) return { response_action: "errors", errors: { message: "Please write something to post." } };
  const sync = JSON.parse(payload.view.private_metadata);
  context.waitUntil(
    (async () => {
      const suggestion = await getSuggestion(env, sync.id);
      if (!suggestion || suggestion.status !== "PENDING") return next(env, sync.r, suggestion?.exportId);
      await callSlack(env, "chat.postMessage", {
        channel: suggestion.channel,
        thread_ts: suggestion.ts,
        ...fromTheCall(text, payload.user.id),
      });
      await syncApplied(env, sync, payload.user.id);
    })(),
  );
  return { response_action: "clear" };
}

// A message from the client call, posted for `user`.
export function fromTheCall(text, user) {
  return {
    text,
    blocks: [
      { type: "section", text: mrkdwn(escapeSlack(text).slice(0, 3000)) },
      { type: "context", elements: [mrkdwn(`From the client call, shared by <@${user}>`)] },
    ],
  };
}

// Marks the suggestion applied, once what it applies is done, and moves the
// message it came from on to the next one.
export async function syncApplied(env, sync, user) {
  await decideSuggestion(env, sync.id, "APPLIED", user);
  await next(env, sync.r, (await getSuggestion(env, sync.id))?.exportId);
}
