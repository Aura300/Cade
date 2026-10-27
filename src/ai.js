import { PRIORITIES, STATUSES } from "./tasks.js";

// Reading what a message in a task's thread asks to change, with a model on
// Workers AI: who should develop, review or test it, and its status,
// priority and due date. Turned on with `ai` in cade.config.json (AI_MODEL),
// with the Workers AI binding `AI` (see wrangler.toml); without them, or if
// the model fails, suggestions read messages by their phrases instead (see
// suggest.js).
//
// The model only proposes: everything it returns is checked against the
// message and the task here (see checkChanges), and nothing changes until
// whoever wrote the message confirms it.

// Small and quick, and keeps to a JSON schema. `ai` in cade.config.json can
// name another text model instead.
export const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";

// A message waits this long for the model before falling back.
const TIMEOUT_MS = 8000;

// The model to read messages with, or null when AI is off.
export function aiModel(env) {
  const setting = env.AI_MODEL;
  if (!env.AI || !setting || setting === "off") return null;
  return setting === "on" ? DEFAULT_MODEL : setting;
}

// What the model fills in. Empty strings and lists mean no change, as small
// models keep to a schema without nulls more reliably.
const PEOPLE = {
  type: "object",
  properties: {
    add: { type: "array", items: { type: "string" } },
    remove: { type: "array", items: { type: "string" } },
  },
  required: ["add", "remove"],
};
const SCHEMA = {
  type: "object",
  properties: {
    developer: PEOPLE,
    reviewer: PEOPLE,
    tester: PEOPLE,
    status: { type: "string", enum: ["", ...Object.keys(STATUSES)] },
    priority: { type: "string", enum: ["", ...Object.keys(PRIORITIES)] },
    dueDate: { type: "string", description: "YYYY-MM-DD, \"clear\" to remove it, or \"\"" },
  },
  required: ["developer", "reviewer", "tester", "status", "priority", "dueDate"],
};

const INSTRUCTIONS = `You read one Slack message posted in the thread of a software task, and say what it asks to change on the task. Reply with JSON only.

People are Slack user IDs such as U0123ABC. In the message, <@U0123ABC> mentions that person. "author" wrote the message.
Roles:
- developer: builds or fixes it ("can you pick this up", "take this", "I'm on it" from the author, "handing this over to").
- reviewer: reviews the code or pull request ("can you review", "PR review").
- tester: tests it or does QA ("can you test", "QA this", "verify").
For each role, "add" lists who should now have it and "remove" who should no longer have it ("@rex is off this", "instead of @bob"). Use only IDs from "mentioned", "author" or the task's people. Don't add someone who already has the role. A mention that only informs ("cc @rex", "thanks @mia") changes nothing.

Statuses: TODO, IN_PROGRESS (work started), IN_REVIEW (code ready for review), IN_TESTING (review approved, ready to test), CLIENT_REVIEW (the client checks it), DONE (finished, merged and tested). Set status only when the message says the work moved on ("started on this", "lgtm" from a reviewer, "QA passed", "done and deployed"), never for a question or a plan ("will start tomorrow", "is it done?").
Priorities: ${Object.keys(PRIORITIES).join(", ")}. Set one only when the message asks for it ("this is urgent", "it's blocking the release", "low priority").
dueDate: when the message sets a deadline ("need this by Friday", "due 30th"), as YYYY-MM-DD, worked out from "today"; "clear" if it says there's no deadline anymore.

Leave anything the message doesn't clearly ask for empty. Most messages change nothing.`;

// Asks the model what `message` changes on `task`, and returns the checked
// changes (see checkChanges), or null if it changes nothing. Throws when the
// model can't be reached or answers with something that isn't JSON, so
// whoever asked can fall back. `today` is { date: "YYYY-MM-DD", weekday }.
export async function readChanges(env, { message, task, today, allowed }) {
  const model = aiModel(env);
  const input = {
    today: `${today.weekday} ${today.date}`,
    author: message.user,
    mentioned: message.mentions,
    task: {
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate || "none",
      people: task.people,
    },
    message: message.text,
  };
  const started = Date.now();
  const result = await withTimeout(
    env.AI.run(model, {
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "task_changes", schema: SCHEMA } },
      max_tokens: 400,
      temperature: 0,
      // The default model reasons first unless told not to, which only slows
      // it down for this.
      ...(model === DEFAULT_MODEL && { chat_template_kwargs: { enable_thinking: false } }),
    }),
  );
  const raw = answerOf(result);
  console.log("AI read a message", { model, ms: Date.now() - started });
  return checkChanges(raw, { task, message, allowed });
}

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer from the model in ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The JSON the model answered with. Models answer in one of two shapes,
// { response } or OpenAI's { choices }, as an object or as text.
function answerOf(result) {
  const answer = result?.choices?.[0]?.message?.content ?? result?.response;
  if (answer && typeof answer === "object") return answer;
  const text = String(answer ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model didn't answer with JSON");
  return JSON.parse(text.slice(start, end + 1));
}

// The changes the model proposed that are real changes, as
//   { people: { [role]: { add, remove } }, status, priority, dueDate }
// with only the fields that change, or null if nothing does:
//   - people added must be mentioned in the message or its author, and not
//     have the role already; people removed must have it;
//   - statuses and priorities must be known ones, and differ from the task's;
//   - a due date must be a real date (YYYY-MM-DD, or "clear"), and differ.
// `allowed` says which kinds may change: { roles, status, details }, and
// `roles` which roles; and `fromMentions`, whether people the message
// mentions may be added (not in a requirement's thread, where the client may
// be among them, and only the author may be).
export function checkChanges(raw, { task, message, allowed }) {
  const changes = {};
  const candidates = new Set([message.user, ...(allowed.fromMentions ? message.mentions : [])]);
  for (const role of allowed.roles ?? []) {
    const current = task.people[role] ?? [];
    const add = unique(raw?.[role]?.add).filter((id) => candidates.has(id) && !current.includes(id));
    const remove = unique(raw?.[role]?.remove).filter((id) => current.includes(id) && !add.includes(id));
    if (add.length || remove.length) (changes.people ??= {})[role] = { add, remove };
  }
  if (allowed.status && STATUSES[raw?.status] && raw.status !== task.status) changes.status = raw.status;
  if (allowed.details && PRIORITIES[raw?.priority] && raw.priority !== task.priority) changes.priority = raw.priority;
  if (allowed.details) {
    const dueDate = raw?.dueDate === "clear" ? "" : isoToDueDate(raw?.dueDate);
    if (dueDate !== null && dueDate !== (task.dueDate ?? "")) changes.dueDate = dueDate;
  }
  return Object.keys(changes).length ? changes : null;
}

function unique(ids) {
  return Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === "string"))] : [];
}

// YYYY-MM-DD as DD/MM/YYYY, or null when it isn't a real date.
function isoToDueDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDate() !== Number(day) || date.getUTCMonth() !== month - 1) return null;
  return `${day}/${month}/${year}`;
}

// Today in TIMEZONE, as { date: "YYYY-MM-DD", weekday: "Monday" }, for dates
// like "Friday" or "tomorrow".
export function today(env, now = new Date()) {
  const timeZone = env.TIMEZONE || "UTC";
  return {
    date: new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now),
    weekday: new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(now),
  };
}
