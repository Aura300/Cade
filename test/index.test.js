import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import worker from "../src/index.js";
import { parseDate } from "../src/commands/details.js";
import { parseMessage } from "../src/commands/parse.js";
import {
  getRequirement,
  getTask,
  insertRelease,
  insertRequirement,
  insertTask,
  markTaskDeleted,
  putRequirement,
  putTask,
} from "../src/db.js";
import { formatDueDate } from "../src/tasks.js";
import { parseTaskFilters, todayIn } from "../src/commands/tasks.js";
import { fakeD1 } from "./d1.js";

const SIGNING_SECRET = "test-signing-secret";
const SHEET_URL = "https://script.google.com/macros/s/test/exec";
// Every environment shares this database; it is emptied for each test, and
// again by mockSlack.
const DB = fakeD1();
beforeEach(() => DB.reset());
const env = {
  DB,
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  CHANNEL_PAIRS: [
    { name: "aura300", external: "CEXTERNAL", tasks: "CDEV" },
    { name: "test", external: "CTESTEXT", tasks: "CTESTDEV" },
  ],
};

async function sign(body, timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": `v0=${hex}`,
  };
}

// Sends a signed request and waits for any background work it started.
async function send(path, body, headers = {}, environment = env) {
  await seeded;
  const pending = [];
  const request = new Request(`https://worker.example.net${path}`, {
    method: "POST",
    headers: { ...(await sign(body)), ...headers },
    body,
  });
  const response = await worker.fetch(request, environment, {
    waitUntil: (promise) => pending.push(promise),
  });
  await Promise.all(pending);
  return response;
}

const interaction = (payload) =>
  new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

// A message's blocks, then those of its attachment: a requirement's message
// has only its title outside the attachment that gives it a priority strip.
const allBlocks = (args) => [...(args.blocks ?? []), ...(args.attachments?.[0]?.blocks ?? [])];

// A section's text, or a context block's first element's.
const blockText = (block) => block.text?.text ?? block.elements?.[0]?.text;

// A task card's small-text footer, a line each: who works on it, then who
// tracked it.
const footerLines = (args) => blockText(allBlocks(args).at(-1)).split("\n");

// The action_ids used more than once in a message's blocks.
function duplicateActionIds(blocks) {
  const ids = blocks.flatMap((block) => [
    ...(block.elements ?? []).map((element) => element.action_id),
    block.accessory?.action_id,
    block.element?.action_id && `${block.block_id}:${block.element.action_id}`,
  ]).filter(Boolean);
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

// Stores a task ({ channel, ts, task }) or requirement ({ channel, ts,
// requirement }) record in the database.
// A task's `releases` are stored too, in order.
async function store(record) {
  if (!record.task) return putRequirement(env, record.channel, record.ts, record.requirement);
  await putTask(env, record.channel, record.ts, record.task);
  for (const release of record.task.releases ?? []) await insertRelease(env, record.channel, record.ts, release);
}
let seeded = Promise.resolve();

// `record`, moved to `channel`.
const inChannel = (channel, record) => ({ ...record, channel });

// The task and the requirement as stored, after a test's commands.
const savedTask = (channel = "CDEV", ts = "100.1") => getTask(env, channel, ts);
const savedRequirement = (channel = "CEXTERNAL", ts = "200.1") => getRequirement(env, channel, ts);

// Replaces fetch with a fake Slack API, with an empty database holding just
// `responses.stored` (task and requirement records). `responses` maps a
// method name to its result; every call is recorded with its decoded arguments. Link preview
// settings are recorded as `previews` rather than with the arguments. Requests to the
// Google Sheet are recorded as the "sheet" method with their JSON body.
function mockSlack(t, { stored = [], ...responses } = {}) {
  DB.reset();
  seeded = Promise.all(stored.map(store));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === SHEET_URL) {
      calls.push({ method: "sheet", args: JSON.parse(init.body) });
      return Response.json(responses.sheet ?? { ok: true });
    }
    const method = new URL(url).pathname.replace("/api/", "");
    const args = Object.fromEntries(init.body);
    for (const name of ["view", "blocks", "attachments"]) {
      if (args[name]) args[name] = JSON.parse(args[name]);
    }
    // Slack rejects a message whose blocks reuse an action_id, with
    // invalid_blocks.
    for (const blocks of [args.blocks, args.view?.blocks]) {
      const reused = duplicateActionIds(blocks ?? []);
      if (reused.length) {
        calls.push({ method, args, headers: init.headers, previews: {} });
        return Response.json({ ok: false, error: "invalid_blocks", reused });
      }
    }
    const previews = { links: args.unfurl_links, media: args.unfurl_media };
    delete args.unfurl_links;
    delete args.unfurl_media;
    calls.push({ method, args, headers: init.headers, previews });
    const result =
      typeof responses[method] === "function"
        ? responses[method](args)
        : responses[method];
    return Response.json({ ok: true, ...result });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

// Submissions come from the Track task button in a requirement thread. A
// requirement's task takes its priority and due date from the requirement,
// here the values given.
const submission = (
  values,
  origin = {
    channel: "CEXTERNAL",
    threadTs: "200.1",
    promptTs: "300.1",
    requirement: true,
    priority: values.priority,
    dueDate: formatDueDate(values.dueDate ?? null),
  },
) => ({
  type: "view_submission",
  user: { id: "UCREATOR" },
  view: {
    callback_id: "track",
    private_metadata: JSON.stringify(origin),
    state: {
      values: {
        title: { value: { value: values.title } },
        due_date: { value: { selected_date: values.dueDate ?? null } },
        priority: {
          value: {
            selected_option: values.priority ? { value: values.priority } : null,
          },
        },
      },
    },
  },
});

// The task at CDEV/100.1 as stored, tracked from the requirement thread at
// CEXTERNAL/200.1. Each role lists its people's user IDs.
const storedTask = ({ developers = [], reviewers = [], testers = [] } = {}) => ({
  channel: "CDEV",
  ts: "100.1",
  task: {
    title: "Fix login",
    priority: "High",
    status: "TODO",
    dueDate: "31/10/2026",
    people: { developer: developers, reviewer: reviewers, tester: testers },
    prs: [],
    createdBy: "UCREATOR",
    completedAt: "",
    source: { channel: "CEXTERNAL", threadTs: "200.1", link: "https://slack.example/source", incident: false },
  },
});

// The team's own task, tracked with /cade track: no requirement thread.
const ownTask = (people) => {
  const record = storedTask(people);
  record.task.source = undefined;
  return record;
};

// Posting to the dev channel creates the task; other posts are replies.
const createdTask = {
  "chat.postMessage": (args) =>
    args.channel === "CDEV" ? { channel: "CDEV", ts: "100.1" } : { ts: "300.1" },
  // The external thread links as /source, the new task as /p100.
  "chat.getPermalink": (args) => ({
    permalink: args.channel.endsWith("DEV")
      ? "https://slack.example/p100"
      : "https://slack.example/source",
  }),
};

const threadEvent = (text, overrides = {}) =>
  JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UBOT" }],
    event: {
      type: "message",
      channel: "CDEV",
      user: "UACTOR",
      text,
      ts: "100.5",
      thread_ts: "100.1",
      ...overrides,
    },
  });

test("rejects requests with an invalid signature", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example.net/slack/events", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": `v0=${"0".repeat(64)}`,
      },
      body: "{}",
    }),
    env,
    { waitUntil() {} },
  );
  assert.equal(response.status, 401);
});

test("rejects signed requests older than five minutes", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
  const timestamp = Math.floor(Date.now() / 1000) - 600;
  const response = await worker.fetch(
    new Request("https://worker.example.net/slack/events", {
      method: "POST",
      headers: await sign(body, timestamp),
      body,
    }),
    env,
    { waitUntil() {} },
  );
  assert.equal(response.status, 401);
});

test("answers the Events API URL verification challenge", async () => {
  const response = await send(
    "/slack/events",
    JSON.stringify({ type: "url_verification", challenge: "abc" }),
  );
  assert.deepEqual(await response.json(), { challenge: "abc" });
});

test("modal submission rejects a blank title", async (t) => {
  const calls = mockSlack(t);
  const response = await send(
    "/slack/interactions",
    interaction(submission({ title: "   ", priority: "High" })),
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(await response.json(), {
    response_action: "errors",
    errors: { title: "Please give the task a title." },
  });
});

test("modal submission posts the task and turns the button into a link to it", async (t) => {
  // The requirement is read first, and again to link it to the task; those
  // reads are left out of the order checked here.
  const all = mockSlack(t, createdTask);
  const response = await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix <login>", dueDate: "2027-05-01", priority: "Urgent" })),
  );

  assert.deepEqual(await response.json(), { response_action: "clear" });
  const calls = all.filter((call) => call.method !== "conversations.replies");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.getPermalink", "chat.postMessage", "chat.getPermalink", "pins.add", "chat.update"],
  );
  assert.deepEqual(calls[0].args, { channel: "CEXTERNAL", message_ts: "200.1" });

  const post = calls[1].args;
  assert.equal(post.channel, "CDEV");
  assert.equal(allBlocks(post)[0].text.text, "*Fix &lt;login&gt;*");
  // Under the title, in small text, as on a requirement's card.
  assert.equal(allBlocks(post)[1].type, "context");
  assert.equal(blockText(allBlocks(post)[1]), ":memo: To do  ·  Urgent  ·  Due 01/05/2027");
  // The priority is the colour of the strip beside everything but the title.
  assert.equal(post.blocks.length, 1);
  assert.equal(post.attachments[0].color, "#E01E5A");
  // No PRs yet; who works on it and who tracked it share the small footer.
  assert.equal(allBlocks(post).length, 3);
  assert.equal(allBlocks(post)[2].type, "context");
  assert.deepEqual(footerLines(post), [
    "_Unassigned_",
    "Tracked by <@UCREATOR> from <https://slack.example/source|the requirement thread>",
  ]);
  // The message is only the task's picture; it lives in the database.
  assert.equal(post.metadata, undefined);

  // The task is stored with its message's link, which the Sheet uses.
  assert.deepEqual(calls[2].args, { channel: "CDEV", message_ts: "100.1" });
  assert.deepEqual(await savedTask(), {
    title: "Fix <login>",
    priority: "Urgent",
    status: "TODO",
    dueDate: "01/05/2027",
    people: { developer: [], reviewer: [], tester: [] },
    prs: [],
    releases: [],
    createdBy: "UCREATOR",
    completedAt: "",
    source: { channel: "CEXTERNAL", threadTs: "200.1", link: "https://slack.example/source", incident: false },
    link: "https://slack.example/p100",
  });

  assert.deepEqual(calls[3].args, { channel: "CDEV", timestamp: "100.1" });
  // The button message becomes the news that it's tracked, with the link, so
  // the thread doesn't grow.
  const text = "<@UCREATOR> tracked this as a task: <https://slack.example/p100|Fix &lt;login&gt;>. The team's on it!";
  assert.deepEqual(calls[4].args, {
    channel: "CEXTERNAL",
    ts: "300.1",
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });
});

test("modal submission without a due date leaves it out", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" })),
  );
  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV");
  assert.equal(blockText(allBlocks(post.args)[1]), ":memo: To do  ·  Low");
});

test("modal submission tells the creator when the task cannot be posted", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: new URL(url).pathname.replace("/api/", ""), args: Object.fromEntries(init.body) });
    return Response.json({ ok: false, error: "channel_not_found" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" })),
  );
  // Looking up the source link fails too, but only the failed post holds
  // the task back.
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.getPermalink",
    "chat.postMessage",
    "chat.postEphemeral",
  ]);
  assert.equal(calls[2].args.user, "UCREATOR");
  assert.equal(calls[2].args.thread_ts, "200.1");
  assert.match(calls[2].args.text, /^Sorry, I couldn't post the task "Fix login" just now\. I'll try again in a few minutes\.$/);
  // The task is stored, waiting to be posted.
  const row = await DB.prepare("SELECT ts, post_attempts, origin FROM tasks").first();
  assert.equal(row.ts, null);
  assert.equal(row.post_attempts, 1);
  assert.deepEqual(JSON.parse(row.origin), { channel: "CEXTERNAL", threadTs: "200.1", promptTs: "300.1" });
});

test("@Cade track only works in a requirement thread", async (t) => {
  for (const overrides of [
    // A thread Cade did not start.
    { ts: "200.5", thread_ts: "200.1" },
    // A top-level message, which has no thread to check.
    { ts: "200.5", thread_ts: undefined },
  ]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ...overrides }));
    const reply = calls.at(-1).args;
    assert.equal(reply.text, "I can only track a requirement from its own thread: send `@Cade track` in the thread of one started with `/cade requirement`. For the team's own work, use `/cade track` in <#CDEV>.");
    assert.ok(!reply.blocks, "no Track task button");
  }
});

test("a tracked requirement cannot be tracked again", async (t) => {
  const calls = mockSlack(t, { stored: [requirementRoot({ task: true })] });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.equal(
    calls[0].args.text,
    "Good news: this requirement is already tracked as <https://slack.example/p100|Fix login>.",
  );
});

test("a requirement tracked while the form was open is not tracked twice", async (t) => {
  const calls = mockSlack(t, {
    ...createdTask,
    stored: [requirementRoot({ task: true })],
  });
  await send(
    "/slack/interactions",
    interaction(titleOnlySubmission("Export reports", requirementOrigin)),
  );
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  assert.equal(calls[0].args.user, "UCREATOR");
  assert.equal(calls[0].args.thread_ts, "200.1");
  assert.match(calls[0].args.text, /^Good news: this requirement is already tracked as/);
});
test("the Track task button opens the modal for that thread", async (t) => {
  const calls = mockSlack(t);
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "trigger-2",
      message: { ts: "300.1" },
      actions: [
        {
          action_id: "track:open",
          value: JSON.stringify({ channel: "CEXTERNAL", threadTs: "200.1" }),
        },
      ],
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls[0].method, "views.open");
  assert.equal(calls[0].args.trigger_id, "trigger-2");
  assert.deepEqual(JSON.parse(calls[0].args.view.private_metadata), {
    channel: "CEXTERNAL",
    threadTs: "200.1",
    promptTs: "300.1",
  });
  const blocks = calls[0].args.view.blocks;
  assert.deepEqual(
    blocks.map((block) => [block.block_id, block.element.type, !!block.optional]),
    [
      ["title", "plain_text_input", false],
      ["due_date", "datepicker", true],
      ["priority", "static_select", false],
    ],
  );
  assert.equal(blocks[0].element.initial_value, undefined);
  assert.equal(blocks[1].element.initial_date, undefined);
  assert.equal(blocks[2].element.initial_option, undefined);
});

test("@Cade assign adds people to a role on the root message", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ developers: ["UALICE"], testers: ["UTESS"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB> <@UALICE|alice>"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "chat.postMessage"],
  );
  const update = calls[0].args;
  assert.equal(update.ts, "100.1");
  assert.equal(
    footerLines(update)[0],
    "Dev <@UALICE>, <@UBOB>  ·  Test <@UTESS>",
  );
  const task = await savedTask();
  assert.deepEqual(task.people, { developer: ["UALICE", "UBOB"], reviewer: [], tester: ["UTESS"] });
  assert.equal(task.dueDate, "31/10/2026");
  assert.deepEqual(calls[1].args, {
    channel: "CDEV",
    thread_ts: "100.1",
    text: "<@UBOB>, <@UALICE> could you pick this up when you get a chance? Thanks!",
  });
});

test("@Cade assign works for each role, in any word order", async (t) => {
  for (const [text, role, reply] of [
    // No PR yet, so the reviewer isn't named, and isn't notified.
    ["<@UBOT> assign reviewer <@UBOB>", "reviewer", "<@UACTOR> added a reviewer. I'll ask them to review once a PR is linked."],
    ["<@UBOT> assign tester <@UBOB>", "tester", "<@UBOB> could you give this a test when you get a chance? Thanks!"],
    ["<@UBOT> assign <@UBOB> as Tester", "tester", "<@UBOB> could you give this a test when you get a chance? Thanks!"],
    ["<@UBOT> assign developers <@UBOB>", "developer", "<@UBOB> could you pick this up when you get a chance? Thanks!"],
  ]) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual((await savedTask()).people[role], ["UBOB"], text);
    assert.equal(calls[1].args.text, reply, text);
  }
});

test("@Cade assign without a role asks for one", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign <@UBOB>"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.equal(
    calls[0].args.text,
    "Happy to! Which role should I assign them to? Try `@Cade assign developer @person`, `@Cade assign reviewer @person`, `@Cade assign tester @person`.",
  );
});

test("@Cade assign without anyone mentioned offers a button per role", async (t) => {
  for (const [text, roles, prompt] of [
    ["<@UBOT> assign", ["developer", "reviewer", "tester"], "Who's working on this task?"],
    ["<@UBOT> assign reviewer", ["reviewer"], "Who should be the reviewer?"],
  ]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    const reply = calls.at(-1).args;
    assert.equal(reply.text, prompt, text);
    assert.deepEqual(
      reply.blocks[1].elements.map((button) => [button.action_id, button.text.text]),
      roles.map((role) => [`assign:choose:${role}`, role[0].toUpperCase() + role.slice(1)]),
      text,
    );
  }
});

test("@Cade unassign with a role removes people from that role only", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ developers: ["UALICE", "UBOB"], reviewers: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign developer <@UALICE>"));
  const { people } = await savedTask();
  assert.deepEqual(people.developer, ["UBOB"]);
  assert.deepEqual(people.reviewer, ["UALICE"]);
  assert.equal(calls[1].args.text, "<@UALICE>, you don't need to work on this anymore. Thanks!");
});

test("@Cade unassign without a role removes people from every role", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ developers: ["UALICE", "UBOB"], reviewers: ["UALICE"], testers: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign <@UALICE>"));
  assert.deepEqual((await savedTask()).people, { developer: ["UBOB"], reviewer: [], tester: [] });
  assert.equal(
    footerLines(calls[0].args)[0],
    "Dev <@UBOB>",
  );
  assert.equal(calls[1].args.text, "<@UALICE>, you don't need to work on this anymore. Thanks!");
});

test("@Cade unassign without anyone mentioned offers the same role buttons as assign", async (t) => {
  for (const [text, roles] of [
    ["<@UBOT> unassign", ["developer", "reviewer", "tester"]],
    ["<@UBOT> unassign tester", ["tester"]],
  ]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(
      calls.at(-1).args.blocks[1].elements.map((button) => button.action_id),
      roles.map((role) => `assign:choose:${role}`),
      text,
    );
  }
});

test("@Cade status updates the task's status", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ developers: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add"],
  );
  const update = calls[0].args;
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.deepEqual((await savedTask()).people.developer, ["UALICE"]);
  assert.match(blockText(allBlocks(update)[1]), /^:arrow_forward: In progress  ·/);
  // A typed status gets a ✅ on the command, not a reply.
  assert.deepEqual(calls[1].args, { channel: "CDEV", timestamp: "100.5", name: "white_check_mark" });
});

test("@Cade status DONE unpins the task and reopening pins it again", async (t) => {
  let calls = mockSlack(t, {
    stored: [storedTask()],
  });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  // Done unpins the task and its requirement, and is posted in the
  // requirement thread without asking.
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.update",
    "pins.remove",
    "pins.remove",
    "chat.postMessage",
    "reactions.add",
    "chat.postMessage",
  ]);
  assert.deepEqual(
    calls.filter((call) => call.method === "pins.remove").map((call) => call.args),
    [
      { channel: "CDEV", timestamp: "100.1" },
      { channel: "CEXTERNAL", timestamp: "200.1" },
    ],
  );

  const done = storedTask();
  done.task.status = "DONE";
  calls = mockSlack(t, { stored: [done] });
  await send("/slack/events", threadEvent("<@UBOT> status IN_TESTING"));
  assert.deepEqual(
    calls.filter((call) => call.method === "pins.add").map((call) => call.args.channel),
    ["CDEV", "CEXTERNAL"],
  );
});

test("a failed pin does not stop the task from being announced", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = new URL(url).pathname.replace("/api/", "");
    calls.push(method);
    if (method === "pins.add") return Response.json({ ok: false, error: "missing_scope" });
    if (method === "chat.getPermalink") return Response.json({ ok: true, permalink: "https://slack.example/p100" });
    return Response.json({ ok: true, channel: "CDEV", ts: "100.1" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" })),
  );
  assert.deepEqual(calls, [
    "chat.getPermalink",
    "chat.postMessage",
    "chat.getPermalink",
    "pins.add",
    "chat.update",
  ]);
});

const withStatus = (status) => {
  const record = storedTask();
  record.task.status = status;
  return record;
};

test("a typed status gets a ✅ and never a question", async (t) => {
  for (const [root, input] of [
    [withStatus("TODO"), "in progress"],
    [withStatus("IN_PROGRESS"), "in review"],
    [withStatus("CLIENT_REVIEW"), "done"],
    [withStatus("DONE"), "client review"],
    [withStatus("DONE"), "done"],
    [withStatus("DONE"), "in progress"],
    [ownTask(), "done"],
  ]) {
    const calls = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadEvent(`<@UBOT> status ${input}`));
    assert.ok(calls.some((call) => call.method === "reactions.add"), input);
    // Reaching Client review or Done adds a note that the requirement thread
    // was told; nothing posted here ever asks anything.
    for (const call of calls.filter((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV")) {
      assert.match(call.args.text, /^I've (let|asked)/, input);
      assert.equal(call.args.blocks, undefined, input);
    }
  }
});

test("@Cade status accepts every status name", async (t) => {
  for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "IN_TESTING", "CLIENT_REVIEW", "DONE"]) {
    const calls = mockSlack(t, {
      stored: [storedTask()],
    });
    await send("/slack/events", threadEvent(`<@UBOT> status ${status.toLowerCase()}`));
    assert.deepEqual((await savedTask()).status, status);
  }
});

test("@Cade status without a status replies with a status menu", async (t) => {
  const task = storedTask();
  task.task.status = "IN_REVIEW";
  const calls = mockSlack(t, { stored: [task] });
  await send("/slack/events", threadEvent("<@UBOT> status"));

  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.equal(calls[0].args.thread_ts, "100.1");
  const menu = allBlocks(calls[0].args)[0].accessory;
  assert.equal(menu.action_id, "status:select");
  assert.deepEqual(
    menu.options.map((option) => [option.value, option.text.text]),
    [
      ["TODO", ":memo: To do"],
      ["IN_PROGRESS", ":arrow_forward: In progress"],
      ["IN_REVIEW", ":eyes: In review"],
      ["IN_TESTING", ":test_tube: In testing"],
      ["CLIENT_REVIEW", ":raising_hand: Client review"],
      ["DONE", ":white_check_mark: Done"],
    ],
  );
  assert.equal(menu.initial_option.value, "IN_REVIEW");
});

test("@Cade status with an unknown status shows the menu", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> status blocked"));
  assert.equal(allBlocks(calls[0].args)[0].text.text, 'I don\'t know "blocked" as a status. Which one did you mean?');
  assert.equal(allBlocks(calls[0].args)[0].accessory.action_id, "status:select");
});

test("picking a status from the menu updates the task and the menu", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UPICKER" },
      channel: { id: "CDEV" },
      message: { ts: "100.7", thread_ts: "100.1" },
      actions: [{ action_id: "status:select", selected_option: { value: "DONE" } }],
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.update",
    "pins.remove",
    "pins.remove",
    "chat.postMessage",
    "chat.update",
  ]);
  assert.equal(calls[0].args.ts, "100.1");
  assert.deepEqual((await savedTask()).status, "DONE");
  assert.equal(calls[3].args.channel, "CEXTERNAL");
  // The menu becomes the confirmation, saying the requirement thread was told.
  const menu = calls[4].args;
  assert.equal(menu.ts, "100.7");
  assert.equal(menu.text, "<@UPICKER> set the status to :white_check_mark: Done.\nI've let <https://slack.example/source|the requirement thread> know it's :white_check_mark: Done.");
  assert.equal(menu.blocks.length, 1, "no buttons");
});

test("@Cade delete and @Cade remove ask for confirmation", async (t) => {
  for (const name of ["delete", "remove"]) {
    const calls = mockSlack(t, {
      stored: [ownTask()],
    });
    await send("/slack/events", threadEvent(`<@UBOT> ${name}`));

    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
    assert.equal(calls[0].args.thread_ts, "100.1");
    const [cancel, button] = allBlocks(calls[0].args)[1].elements;
    // Cancel is first and prominent; Delete is plain.
    assert.equal(cancel.action_id, "delete:cancel");
    assert.equal(cancel.style, "primary");
    assert.equal(button.action_id, "delete:confirm");
    assert.equal(button.style, undefined);
    assert.ok(button.confirm);
    assert.deepEqual(JSON.parse(button.value), {
      kind: "task",
      channel: "CDEV",
      ts: "100.1",
      requestedBy: "UACTOR",
    });
  }
});

// Without a kind, as on buttons posted before requirements could be deleted.
const deleteRequest = JSON.stringify({ channel: "CDEV", ts: "100.1", requestedBy: "UACTOR" });

const deleteClick = (actionId, user) =>
  interaction({
    type: "block_actions",
    user: { id: user },
    message: { ts: "100.9" },
    actions: [{ action_id: actionId, value: deleteRequest }],
  });

test("only the requester can confirm or cancel a deletion", async (t) => {
  for (const actionId of ["delete:confirm", "delete:cancel"]) {
    const calls = mockSlack(t);
    await send("/slack/interactions", deleteClick(actionId, "USOMEONE"));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
    assert.equal(calls[0].args.user, "USOMEONE");
    assert.equal(calls[0].args.thread_ts, "100.1");
    assert.match(calls[0].args.text, /Only <@UACTOR> can confirm/);
  }
});

test("cancelling a deletion removes the prompt", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/interactions", deleteClick("delete:cancel", "UACTOR"));
  assert.deepEqual(calls.map((call) => [call.method, call.args]), [
    ["chat.delete", { channel: "CDEV", ts: "100.9" }],
  ]);
});

test("confirming deletion removes Cade's replies and then the task", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": {
            messages: [
              { ts: "100.1", bot_id: "BCADE" },
              { ts: "100.2", user: "UACTOR" },
              { ts: "100.3", bot_id: "BCADE" },
              { ts: "100.4", bot_id: "BCADE" },
            ],
          },
  });
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      actions: [
        { action_id: "delete:confirm", value: deleteRequest },
      ],
    }),
  );

  assert.equal(response.status, 200);
  const deletes = calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts);
  assert.deepEqual(deletes, ["100.3", "100.4", "100.1"]);
  // The requirement's message shows it's untracked, and whoever confirmed
  // sees the task go: nothing is posted, not even privately.
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("deleting the team's own task posts nothing outside its channel", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.replies",
    "chat.delete",
  ]);
});

test("assigning keeps the task's source thread", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask()],
  });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  assert.deepEqual((await savedTask()).source, {
    channel: "CEXTERNAL",
    threadTs: "200.1",
    link: "https://slack.example/source",
    incident: false,
  });
  assert.match(footerLines(calls[0].args)[1], /from <https:\/\/slack\.example\/source\|the requirement thread>/);
});

test("@Cade delete in a thread that is not a task says so", async (t) => {
  const calls = mockSlack(t, {
    stored: [],
  });
  await send("/slack/events", threadEvent("<@UBOT> delete"));
  assert.equal(calls[0].args.text, "Hmm, I'm not tracking a task in this thread.");
});

test("@Cade assign in a thread that is not a task says so", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage"],
  );
  assert.equal(calls[0].args.text, "Hmm, I'm not tracking a task in this thread.");
});

test("@Cade assign outside the dev channel points to it", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { channel: "CEXTERNAL" }));
  assert.equal(
    calls[0].args.text,
    "That one works with `@Cade assign developer @person` in a task thread in <#CDEV>.",
  );
});

test("@Cade track outside the external channels points to them", async (t) => {
  // From a paired channel only its pair's channel is named.
  for (const [channel, hint] of [
    ["CDEV", "<#CEXTERNAL>"],
    ["CTESTDEV", "<#CTESTEXT>"],
    ["COTHER", "<#CEXTERNAL> or <#CTESTEXT>"],
  ]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent("<@UBOT> track", { channel }));
    assert.equal(calls[0].args.text, `That one works with \`@Cade track\` in ${hint}.`, channel);
  }
});

test("/cade track only works in the dev channels", async (t) => {
  const calls = mockSlack(t);
  const reply = await (await send("/slack/commands", slash("track", "CEXTERNAL"))).json();
  assert.equal(calls.length, 0);
  assert.equal(reply.response_type, "ephemeral");
  assert.equal(reply.text, "That one works with `/cade track` in <#CDEV>.");
});
test("tasks with no external thread never ask to inform it", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.equal(calls.at(-1).args.blocks, undefined);
});

test("tasks tracked from the test channel go to the test tasks channel", async (t) => {
  let calls = mockSlack(t, { stored: [inChannel("CTESTEXT", requirementRoot())] });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CTESTEXT", ts: "200.5", thread_ts: "200.1" }),
  );
  assert.equal(calls.at(-1).args.blocks[0].elements[0].action_id, "track:open");

  calls = mockSlack(t, {
    ...createdTask,
    "chat.postMessage": { channel: "CTESTDEV", ts: "100.1" },
  });
  await send(
    "/slack/interactions",
    interaction(
      submission(
        { title: "Fix login", priority: "High" },
        { channel: "CTESTEXT", threadTs: "200.1", promptTs: "300.1", requirement: true, priority: "High" },
      ),
    ),
  );
  const made = calls;
  assert.deepEqual(made[0].args, { channel: "CTESTEXT", message_ts: "200.1" });
  assert.equal(made[1].args.channel, "CTESTDEV");
  assert.deepEqual(made[3].args, { channel: "CTESTDEV", timestamp: "100.1" });
  assert.equal(made[4].args.channel, "CTESTEXT");
});

test("thread commands work in the test tasks channel", async (t) => {
  const calls = mockSlack(t, {
    stored: [inChannel("CTESTDEV", storedTask())],
  });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { channel: "CTESTDEV" }));
  assert.equal(calls[0].args.channel, "CTESTDEV");
  assert.equal(calls[1].args.channel, "CTESTDEV");
  assert.deepEqual((await savedTask("CTESTDEV")).people.developer, ["UBOB"]);
});

test("a missing CHANNEL_PAIRS setting is reported", async (t) => {
  const calls = mockSlack(t);
  const pending = [];
  const body = threadEvent("<@UBOT> assign developer <@UBOB>");
  await worker.fetch(
    new Request("https://worker.example.net/slack/events", {
      method: "POST",
      headers: await sign(body),
      body,
    }),
    { ...env, CHANNEL_PAIRS: undefined },
    { waitUntil: (promise) => pending.push(promise) },
  );
  await Promise.all(pending);
  assert.equal(calls[0].args.text, "Sorry, something went wrong with `assign`. Could you try again?");
});

test("@Cade help, a bare @Cade and unknown commands reply with usage", async (t) => {
  for (const text of ["<@UBOT> help", "<@UBOT>", "<@UBOT> hello"]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    // A greeting, three lines, one per section, then how to see it again.
    const lines = calls[0].args.text.split("\n");
    assert.deepEqual(
      lines.map((line) => line.split(":*")[0]),
      ["Here's what I can do:", "*Start", "*In a task thread", "*Your work", "Send `@Cade help` or `/cade help` any time to see this again."],
    );
    assert.match(lines[1], /`\/cade requirement` · `\/cade incident` · `\/cade track` · `@Cade track`$/);
    // Saying it comes first in a task thread; the commands follow.
    assert.match(lines[2], /^\*In a task thread:\* Just talk to me: .* Or: `@Cade assign developer @person`/);
    for (const usage of ["assign developer @person", "unassign developer @person", "status", "priority high", "due 31/12/2026", "pr add <link>", "delete"]) {
      assert.ok(lines[2].includes(`\`@Cade ${usage}\``), usage);
    }
    assert.equal(lines[3], "*Your work:* `/cade tasks` · `/cade standup`");
  }
});

test("ignores messages that do not start with @Cade, bots, edits and retries", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("looks good, assign it later"));
  await send("/slack/events", threadEvent("cade is great"));
  await send("/slack/events", threadEvent("cade assign <@UBOB>"));
  await send("/slack/events", threadEvent("/cade assign <@UBOB>"));
  await send("/slack/events", threadEvent("hi <@UBOT> assign <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { bot_id: "B1" }));
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { subtype: "message_changed" }));
  await send("/slack/events", threadEvent("<@UOTHER> assign <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"), {
    "x-slack-retry-num": "1",
  });
  assert.equal(calls.length, 0);
});

test("parseMessage reads the command name and mentioned people", () => {
  const command = parseMessage(
    {
      text: "<@UBOT> Assign <@UBOB> <@UALICE|alice> <@UBOB> <@UBOT>",
      user: "UACTOR",
      channel: "CDEV",
      ts: "100.5",
      thread_ts: "100.1",
    },
    "UBOT",
  );
  assert.deepEqual(command, {
    name: "assign",
    text: "<@UBOB> <@UALICE|alice> <@UBOB> <@UBOT>",
    mentions: ["UBOB", "UALICE"],
    user: "UACTOR",
    channel: "CDEV",
    ts: "100.5",
    threadTs: "100.1",
  });
  assert.equal(parseMessage({ text: "<@UBOT> TRACK" }, "UBOT").name, "track");
  assert.equal(parseMessage({ text: "<@UBOT>" }, "UBOT").name, "");
  assert.equal(parseMessage({ text: "@Cade track" }, "UBOT"), null);
  assert.equal(parseMessage({ text: "<@UOTHER> track" }, "UBOT"), null);
});

// The sheet's times are in TIMEZONE; these tests expect Sri Lanka time.
const sheetEnv = { ...env, SHEET_URL, SHEET_SECRET: "sheet-secret", TIMEZONE: "Asia/Colombo" };
const sendWithSheet = (path, body) => send(path, body, {}, sheetEnv);
const slackUsers = {
  "users.info": (args) => ({
    user: { profile: { display_name: { UCREATOR: "Randil", UALICE: "Alice", UBOB: "Bob" }[args.user] } },
  }),
};
const sheetRow = (calls) => {
  const sheet = calls.filter((call) => call.method === "sheet");
  assert.equal(sheet.length, 1);
  assert.equal(sheet[0].args.secret, "sheet-secret");
  assert.equal(sheet[0].args.project, "aura300");
  return sheet[0].args.row;
};

test("a new task is added to the sheet", async (t) => {
  const calls = mockSlack(t, { ...createdTask, ...slackUsers });
  await sendWithSheet(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", dueDate: "2026-10-31", priority: "High" })),
  );
  assert.deepEqual(sheetRow(calls), {
    "Task ID": "CDEV:100.1",
    Title: "Fix login",
    Status: "To do",
    Priority: "High",
    "Due date": "31/10/2026",
    Developer: "Unassigned",
    Reviewer: "Unassigned",
    Tester: "Unassigned",
    "Tracked by": "Randil",
    // Slack timestamp 100.1 is 1970-01-01 00:01:40 UTC, 05:31 in Sri Lanka.
    "Tracked at": "01/01/1970 05:31",
    "Completed at": "",
    "Task link": "https://slack.example/p100",
    "Request link": "https://slack.example/source",
  });
});

test("tasks in the test channels go to the test tabs", async (t) => {
  const calls = mockSlack(t, {
    ...slackUsers,
    stored: [inChannel("CTESTDEV", storedTask())],
  });
  await sendWithSheet(
    "/slack/events",
    threadEvent("<@UBOT> assign tester <@UBOB>", { channel: "CTESTDEV" }),
  );
  const sheet = calls.find((call) => call.method === "sheet").args;
  assert.equal(sheet.project, "test");
  assert.equal(sheet.row["Task ID"], "CTESTDEV:100.1");
});

test("a channel pair without a name is reported", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"), {}, {
    ...env,
    CHANNEL_PAIRS: [{ external: "CEXTERNAL", tasks: "CDEV" }],
  });
  assert.equal(calls[0].args.text, "Sorry, something went wrong with `assign`. Could you try again?");
});

test("assigning people updates the sheet with their names", async (t) => {
  const calls = mockSlack(t, {
    ...slackUsers,
    stored: [storedTask({ developers: ["UALICE"] })],
  });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  const row = sheetRow(calls);
  assert.equal(row.Developer, "Alice, Bob");
  assert.equal(row.Tester, "Unassigned");
});

test("setting Done records when it was completed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T09:02:00Z") });
  const calls = mockSlack(t, {
    ...slackUsers,
    stored: [withStatus("IN_TESTING")],
  });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> status done"));

  assert.deepEqual((await savedTask()).completedAt, "2026-10-24T09:02:00.000Z");
  const row = sheetRow(calls);
  assert.equal(row.Status, "Done");
  assert.equal(row["Completed at"], "24/10/2026 14:32");
});

test("setting Done again keeps the original completion time", async (t) => {
  const done = withStatus("DONE");
  done.task.completedAt = "2026-10-20T04:30:00.000Z";
  const calls = mockSlack(t, { ...slackUsers, stored: [done] });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> status done"));
  assert.equal(sheetRow(calls)["Completed at"], "20/10/2026 10:00");
});

test("reopening a Done task clears its completion time", async (t) => {
  const done = withStatus("DONE");
  done.task.completedAt = "2026-10-20T04:30:00.000Z";
  const calls = mockSlack(t, { ...slackUsers, stored: [done] });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> status in progress"));
  assert.deepEqual((await savedTask()).completedAt, "");
  const row = sheetRow(calls);
  assert.equal(row.Status, "In progress");
  assert.equal(row["Completed at"], "");
});

test("deleting a task marks it Deleted in the sheet", async (t) => {
  const calls = mockSlack(t, {
    ...slackUsers,
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
    stored: [storedTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"), {}, sheetEnv);
  const row = sheetRow(calls);
  assert.equal(row.Status, "Deleted");
  assert.equal(row["Task link"], "");
  // The row is sent before the task message is deleted.
  const order = calls.map((call) => call.method);
  assert.ok(order.indexOf("sheet") < order.lastIndexOf("chat.delete"));
});

test("a sheet failure does not stop the command", async (t) => {
  const calls = mockSlack(t, {
    ...slackUsers,
    sheet: { ok: false, error: "unauthorized" },
    stored: [storedTask()],
  });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"));
  assert.equal(calls.at(-1).args.text, "<@UBOB> could you give this a test when you get a chance? Thanks!");
});

// Apps Script answers a POST with a redirect to a page holding its reply.
function mockRedirectingSheet(t, replyPage) {
  const calls = mockSlack(t, { ...slackUsers, stored: [storedTask()] });
  const mocked = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (url === SHEET_URL) {
      requests.push(init);
      return new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/echo" } });
    }
    if (url === "https://script.googleusercontent.com/echo") return replyPage();
    return mocked(url, init);
  };
  return { calls, requests };
}

test("a sheet redirect counts as delivered even when the reply page is missing", async (t) => {
  const { requests } = mockRedirectingSheet(t, () => new Response("Not found", { status: 404 }));
  const warn = t.mock.method(console, "warn");
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].redirect, "manual");
  assert.ok(
    !warn.mock.calls.some((call) => call.arguments[0] === "Could not sync task to sheet"),
  );
});

test("a sheet reply that rejects the row is logged", async (t) => {
  mockRedirectingSheet(t, () => Response.json({ ok: false, error: "unauthorized" }));
  const warn = t.mock.method(console, "warn");
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"));
  const logged = warn.mock.calls.find((call) => call.arguments[0] === "Could not sync task to sheet");
  assert.match(logged.arguments[1].error, /unauthorized/);
});

test("without users:read the sheet shows user IDs", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  const originalFetch = globalThis.fetch;
  const mocked = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    url.endsWith("users.info") ? Response.json({ ok: false, error: "missing_scope" }) : mocked(url, init);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"));
  const row = sheetRow(calls);
  assert.equal(row.Tester, "UBOB");
  assert.equal(row["Tracked by"], "UCREATOR");
});

test("formatDueDate shows the picked date as DD/MM/YYYY", () => {
  assert.equal(formatDueDate("2026-10-31"), "31/10/2026");
  assert.equal(formatDueDate("2027-01-05"), "05/01/2027");
  assert.equal(formatDueDate(null), "");
  assert.equal(formatDueDate(undefined), "");
});

// `/cade …` slash commands arrive form-encoded.
const slash = (text, channel = "CEXTERNAL") =>
  new URLSearchParams({
    command: "/cade",
    text,
    user_id: "UACTOR",
    channel_id: channel,
    trigger_id: "trigger-9",
  }).toString();

// A requirement root message in the external channel, at 200.1. With `task`,
// the task at CDEV/100.1 has been tracked from it.
// The requirement at CEXTERNAL/200.1 as stored, tracked as the task at
// CDEV/100.1 when `task` is true.
const requirementRoot = ({ task = false, status = task ? "IN_PROGRESS" : "DISCUSSION" } = {}) => ({
  channel: "CEXTERNAL",
  ts: "200.1",
  requirement: {
    title: "Export reports",
    status,
    priority: "High",
    dueDate: "31/10/2026",
    createdBy: "UCREATOR",
    incident: false,
    task: task
      ? { channel: "CDEV", ts: "100.1", title: "Fix login", link: "https://slack.example/p100", trackedBy: "UCREATOR" }
      : undefined,
  },
});

// A task tracked from the requirement above.
const requirementTask = (status = "TODO") => {
  const root = withStatus(status);
  return root;
};

// The requirement and its task, stored.
const threads = (requirement, task = requirementTask()) => ({ stored: [requirement, task] });

test("/cade track opens the task form straight away", async (t) => {
  const calls = mockSlack(t);
  const response = await send("/slack/commands", slash("track", "CDEV"));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  assert.equal(calls[0].args.trigger_id, "trigger-9");
  assert.equal(calls[0].args.view.callback_id, "track");
  assert.deepEqual(JSON.parse(calls[0].args.view.private_metadata), { channel: "CDEV" });
});

test("/cade track in the dev channel posts the task without an announcement", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" }, { channel: "CDEV" })),
  );
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.postMessage",
    "chat.getPermalink",
    "pins.add",
  ]);
  assert.deepEqual((await savedTask()).source?.channel, undefined);
});

test("/cade requirement opens the requirement form in an external channel only", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/commands", slash("requirement"));
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  assert.equal(calls[0].args.view.callback_id, "requirement");
  assert.deepEqual(JSON.parse(calls[0].args.view.private_metadata), { channel: "CEXTERNAL" });
  assert.deepEqual(
    calls[0].args.view.blocks.map((block) => [block.block_id, !!block.optional]),
    [["title", false], ["due_date", true], ["priority", false]],
  );

  calls = mockSlack(t);
  const response = await send("/slack/commands", slash("requirement", "CDEV"));
  assert.equal(calls.length, 0);
  const reply = await response.json();
  assert.equal(reply.response_type, "ephemeral");
  assert.equal(reply.text, "That one works with `/cade requirement` in <#CEXTERNAL>.");
});

test("/cade help and unknown slash commands list the commands privately", async (t) => {
  for (const text of ["", "help", "hello"]) {
    mockSlack(t);
    const reply = await (await send("/slack/commands", slash(text))).json();
    assert.equal(reply.response_type, "ephemeral");
    for (const usage of ["/cade track", "/cade requirement", "@Cade track", "@Cade priority high", "@Cade due 31/12/2026"]) {
      assert.ok(reply.text.includes(`\`${usage}\``), usage);
    }
  }
});

test("@Cade requirement points to the slash command", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> requirement", { channel: "CEXTERNAL" }));
  assert.equal(calls[0].args.text, "That one's a slash command: try `/cade requirement` in <#CEXTERNAL>.");
});

test("submitting a requirement starts its thread in the external channel", async (t) => {
  const calls = mockSlack(t, { "chat.postMessage": { ts: "200.1" } });
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UCREATOR" },
      view: {
        callback_id: "requirement",
        private_metadata: JSON.stringify({ channel: "CEXTERNAL" }),
        state: submission({ title: " Export <reports> ", dueDate: "2026-11-30", priority: "High" }).view.state,
      },
    }),
  );

  assert.deepEqual(await response.json(), { response_action: "clear" });
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "pins.add"]);
  // Pinned in the external channel until its task is Done.
  assert.deepEqual(calls[1].args, { channel: "CEXTERNAL", timestamp: "200.1" });
  const post = calls[0].args;
  assert.equal(post.channel, "CEXTERNAL");
  assert.equal(post.thread_ts, undefined);
  assert.deepEqual(
    allBlocks(post).map((block) => block.text?.text ?? block.elements[0].text),
    [
      "Requirement  ·  *Export &lt;reports&gt;*",
      ":speech_balloon: In discussion  ·  High  ·  Due 30/11/2026",
      "Started by <@UCREATOR>  ·  not tracked yet. Talk it through here, then send `@Cade track` when it's ready.",
    ],
  );
  const requirement = await savedRequirement();
  assert.equal(requirement.title, "Export <reports>");
  assert.equal(requirement.status, "DISCUSSION");
  assert.equal(requirement.priority, "High");
  assert.equal(requirement.dueDate, "30/11/2026");
});

test("a requirement needs a name", async (t) => {
  const calls = mockSlack(t);
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UCREATOR" },
      view: {
        callback_id: "requirement",
        private_metadata: JSON.stringify({ channel: "CEXTERNAL" }),
        state: submission({ title: "  " }).view.state,
      },
    }),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await response.json(), {
    response_action: "errors",
    errors: { title: "Please give the requirement a name.", priority: "Please pick a priority." },
  });
});

test("tracking from a requirement thread moves the requirement to In progress", async (t) => {
  const calls = mockSlack(t, {
    ...createdTask,
    stored: [requirementRoot()],
  });
  await send(
    "/slack/interactions",
    interaction(
      submission(
        { title: "Export reports", dueDate: "2026-11-30", priority: "High" },
        { channel: "CEXTERNAL", threadTs: "200.1", promptTs: "300.1", requirement: true },
      ),
    ),
  );

  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV");
  assert.deepEqual((await savedTask()).source.threadTs, "200.1");
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  // The priority is the colour of the strip beside everything but the title.
  assert.equal(update.args.blocks.length, 1);
  assert.equal(update.args.attachments[0].color, "#E8912D");
  const card = allBlocks(update.args);
  assert.equal(
    blockText(card[1]),
    // The requirement's own priority and due date, not the form's.
    ":arrow_forward: In progress  ·  High  ·  Due 31/10/2026",
  );
  // Who started and who tracked it share the small text, and the task is
  // linked the way the task links back to the requirement.
  assert.deepEqual(card[2], {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Started by <@UCREATOR>  ·  tracked by <@UCREATOR> in <https://slack.example/p100|the task thread>",
      },
    ],
  });
  assert.equal(card.length, 3);
  assert.equal(footerLines(post.args)[1], "Tracked by <@UCREATOR> from <https://slack.example/source|the requirement thread>");
  assert.deepEqual((await savedRequirement()).task.ts, "100.1");
  // The button is still replaced by the announcement.
  assert.equal(calls.at(-1).args.ts, "300.1");
});

test("@Cade priority and due in a requirement thread change the requirement until it is tracked", async (t) => {
  for (const [text, field, value, reply] of [
    ["<@UBOT> priority urgent", "priority", "Urgent", "<@UACTOR> set the priority to :red_circle: Urgent."],
    ["<@UBOT> due 15/12/2026", "dueDate", "15/12/2026", "<@UACTOR> set the due date to 15/12/2026."],
    ["<@UBOT> due none", "dueDate", "", "<@UACTOR> removed the due date."],
  ]) {
    const calls = mockSlack(t, { stored: [requirementRoot()] });
    await send(
      "/slack/events",
      threadEvent(text, { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
    );
    assert.deepEqual(calls.map((call) => [call.method, call.args.channel]), [
      ["chat.update", "CEXTERNAL"],
      ["reactions.add", "CEXTERNAL"],
    ], text);
    const update = calls[0].args;
    assert.equal(update.ts, "200.1");
    assert.equal((await savedRequirement())[field], value, text);
    assert.equal((await savedRequirement()).status, "DISCUSSION");
    assert.deepEqual(calls[1].args, { channel: "CEXTERNAL", timestamp: "200.5", name: "white_check_mark" }, reply);
  }
});

test("a requirement's new priority and due date fill in the track form", async (t) => {
  const requirement = requirementRoot();
  Object.assign(requirement.requirement, { priority: "Low", dueDate: "15/12/2026" });
  const calls = mockSlack(t, { stored: [requirement] });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  const origin = JSON.parse(allBlocks(calls[0].args)[0].elements[0].value);
  assert.equal(origin.priority, "Low");
  assert.equal(origin.dueDate, "15/12/2026");
});

test("@Cade priority in an external thread Cade did not start says so", async (t) => {
  const calls = mockSlack(t);
  await send(
    "/slack/events",
    threadEvent("<@UBOT> priority low", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.match(calls[0].args.text, /^Hmm, this thread isn't a requirement\. Start one with `\/cade requirement`/);
});

test("parseDate accepts DD/MM/YYYY and YYYY-MM-DD real dates only", () => {
  assert.equal(parseDate("1/2/2027"), "01/02/2027");
  assert.equal(parseDate("01-02-2027"), "01/02/2027");
  assert.equal(parseDate("2027-02-01"), "01/02/2027");
  assert.equal(parseDate("29/02/2027"), "");
  assert.equal(parseDate("13/13/2027"), "");
  assert.equal(parseDate("tomorrow"), "");
});

test("Cade's messages never preview the messages they link to", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true }), requirementTask("DONE")),
    ...createdTask,
  });
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "High" })),
  );
  // The task is Done in this mock, so moving it to Client review is a change
  // the requirement thread hears about.
  await send("/slack/events", threadEvent("<@UBOT> status client review"));
  await send(
    "/slack/events",
    threadEvent("<@UBOT> priority low", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );

  const posts = calls.filter((call) => ["chat.postMessage", "chat.update"].includes(call.method));
  assert.ok(posts.length >= 6);
  for (const call of posts) {
    assert.deepEqual(call.previews, { links: "false", media: "false" }, call.method);
  }
  assert.ok(calls.filter((call) => call.method === "pins.add").every((call) => !call.previews.links));
});


// The track form's submission when it asks only for the title.
const titleOnlySubmission = (title, origin) => ({
  type: "view_submission",
  user: { id: "UCREATOR" },
  view: {
    callback_id: "track",
    private_metadata: JSON.stringify(origin),
    state: { values: { title: { value: { value: title } } } },
  },
});

const requirementOrigin = {
  channel: "CEXTERNAL",
  threadTs: "200.1",
  promptTs: "300.1",
  requirement: true,
  incident: false,
  title: "Export reports",
  priority: "High",
  dueDate: "31/10/2026",
};

test("@Cade track in a requirement thread asks only for the title", async (t) => {
  let calls = mockSlack(t, { stored: [requirementRoot()] });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  const value = allBlocks(calls[0].args)[0].elements[0].value;
  const { promptTs, ...origin } = requirementOrigin;
  assert.deepEqual(JSON.parse(value), origin);

  calls = mockSlack(t);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "trigger-2",
      message: { ts: "300.1" },
      actions: [{ action_id: "track:open", value }],
    }),
  );
  const blocks = calls[0].args.view.blocks;
  assert.deepEqual(blocks.map((block) => block.block_id ?? block.type), ["title", "context"]);
  assert.equal(blocks[0].element.initial_value, "Export reports");
  assert.match(
    blocks[1].elements[0].text,
    /^\*Priority:\* :large_orange_circle: High  ·  \*Due:\* 31\/10\/2026\nThese come from the requirement/,
  );
});

test("a task tracked from a requirement takes the requirement's current priority and due date", async (t) => {
  const requirement = requirementRoot();
  Object.assign(requirement.requirement, { priority: "Low", dueDate: "15/12/2026" });
  const calls = mockSlack(t, {
    ...createdTask,
    stored: [requirement],
  });
  const response = await send(
    "/slack/interactions",
    interaction(titleOnlySubmission("Export reports", requirementOrigin)),
  );
  assert.deepEqual(await response.json(), { response_action: "clear" });

  assert.deepEqual((await savedTask()).priority, "Low");
  assert.deepEqual((await savedTask()).dueDate, "15/12/2026");
  assert.deepEqual((await savedRequirement()).status, "IN_PROGRESS");
  assert.deepEqual((await savedRequirement()).priority, "Low");
});

test("a requirement always shows its task's current status, as the client sees it", async (t) => {
  for (const [status, shown] of [
    ["IN_REVIEW", "IN_PROGRESS"],
    ["TODO", "IN_PROGRESS"],
    ["CLIENT_REVIEW", "CLIENT_REVIEW"],
    ["DONE", "DONE"],
  ]) {
    const calls = mockSlack(t, threads(requirementRoot({ task: true })));
    await send("/slack/events", threadEvent(`<@UBOT> status ${status}`));
    assert.deepEqual((await savedRequirement()).status, shown, status);
    // Client review and Done are posted in the requirement thread too.
    const posted = calls.some((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL");
    assert.equal(posted, ["CLIENT_REVIEW", "DONE"].includes(status), status);
  }
});

test("@Cade priority and due in a tracked requirement's thread change the task and tell the team", async (t) => {
  for (const [text, field, value, reply] of [
    ["<@UBOT> priority urgent", "priority", "Urgent", "<@UACTOR> set the priority to :red_circle: Urgent."],
    ["<@UBOT> due 15/12/2026", "dueDate", "15/12/2026", "<@UACTOR> set the due date to 15/12/2026."],
    ["<@UBOT> due none", "dueDate", "", "<@UACTOR> removed the due date."],
  ]) {
    const calls = mockSlack(t, {
      ...threads(requirementRoot({ task: true })),
      "chat.getPermalink": { permalink: "https://slack.example/requirement" },
    });
    await send(
      "/slack/events",
      threadEvent(text, { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
    );

    assert.deepEqual(calls.map((call) => [call.method, call.args.channel]), [
      ["chat.update", "CEXTERNAL"],
      ["chat.update", "CDEV"],
      ["chat.getPermalink", "CEXTERNAL"],
      ["chat.postMessage", "CDEV"],
      ["reactions.add", "CEXTERNAL"],
    ], text);
    assert.equal((await savedRequirement())[field], value, text);
    assert.equal((await savedTask())[field], value, text);
    assert.equal(calls[3].args.thread_ts, "100.1");
    assert.equal(
      calls[3].args.text,
      `${reply.replace(/\.$/, "")} in <https://slack.example/requirement|the requirement thread>.`,
    );
    // The team is told in the task's thread; the client just gets a ✅.
    assert.equal(calls[4].args.name, "white_check_mark");
  }
});

test("a task tracked from a requirement cannot change its priority or due date in the dev thread", async (t) => {
  for (const text of ["<@UBOT> priority low", "<@UBOT> due 15/12/2026", "<@UBOT> due"]) {
    const calls = mockSlack(t, { stored: [requirementTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"], text);
    assert.equal(
      calls[0].args.text,
      "The client owns this task's priority and due date, so they're changed in <https://slack.example/source|the requirement thread>.",
    );
  }
});

test("tasks with no requirement change their priority and due date in the dev thread", async (t) => {
  for (const [text, field, value, reply] of [
    ["<@UBOT> priority low", "priority", "Low", "<@UACTOR> set the priority to :large_green_circle: Low."],
    ["<@UBOT> due 5/1/2027", "dueDate", "05/01/2027", "<@UACTOR> set the due date to 05/01/2027."],
    ["<@UBOT> due 2027-02-28", "dueDate", "28/02/2027", "<@UACTOR> set the due date to 28/02/2027."],
  ]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), [
      "chat.update",
      "reactions.add",
    ], text);
    assert.equal((await savedTask())[field], value, text);
    assert.deepEqual(calls[1].args, { channel: "CDEV", timestamp: "100.5", name: "white_check_mark" }, reply);
  }
});

test("@Cade priority and due without a valid value show a picker", async (t) => {
  for (const [text, type, initial] of [
    ["<@UBOT> priority", "static_select", "High"],
    ["<@UBOT> priority soon", "static_select", "High"],
    ["<@UBOT> due", "datepicker", "2026-10-31"],
    ["<@UBOT> due 31/02/2027", "datepicker", "2026-10-31"],
  ]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text));
    const { accessory } = calls.at(-1).args.blocks[0];
    assert.equal(accessory.type, type, text);
    assert.equal(accessory.initial_option?.value ?? accessory.initial_date, initial, text);
  }
});

test("picking from the menu or date picker changes what the picker's thread is about", async (t) => {
  for (const [channel, thread, root, action, field, value] of [
    ["CDEV", "100.1", ownTask(), { action_id: "priority:select", selected_option: { value: "Medium" } }, "priority", "Medium"],
    ["CEXTERNAL", "200.1", requirementRoot(), { action_id: "due:select", selected_date: "2027-03-15" }, "dueDate", "15/03/2027"],
  ]) {
    const calls = mockSlack(t, { stored: [root] });
    await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: "UCLICKER" },
        channel: { id: channel },
        message: { ts: "900.1", thread_ts: thread },
        actions: [action],
      }),
    );
    assert.deepEqual(calls.map((call) => [call.method, call.args.ts]), [
      ["chat.update", thread],
      ["chat.update", "900.1"],
    ]);
    const saved = channel === "CDEV" ? await savedTask() : await savedRequirement();
    assert.equal(saved[field], value);
  }
});

// A client clicking Approve or Not approve in the requirement thread.
const reviewClick = (actionId) =>
  interaction({
    type: "block_actions",
    user: { id: "UCLIENT" },
    channel: { id: "CEXTERNAL" },
    message: { ts: "200.9", thread_ts: "200.1" },
    actions: [
      {
        action_id: actionId,
        value: JSON.stringify({
          channel: "CDEV",
          ts: "100.1",
          text: "<@UACTOR> says this is ready for you to review.",
        }),
      },
    ],
  });

test("Approve moves the task to Done and tells the task's thread", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true, status: "CLIENT_REVIEW" }), requirementTask("CLIENT_REVIEW")),
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  const response = await send("/slack/interactions", reviewClick("status:approve"));
  assert.equal(response.status, 200);

  assert.deepEqual(calls.map((call) => [call.method, call.args.ts ?? call.args.thread_ts ?? call.args.timestamp]), [
    ["chat.update", "100.1"],
    ["chat.update", "200.1"],
    ["pins.remove", "100.1"],
    ["pins.remove", "200.1"],
    ["chat.getPermalink", undefined],
    ["chat.postMessage", "100.1"],
    ["chat.update", "200.9"],
  ]);
  assert.deepEqual((await savedTask()).status, "DONE");
  assert.ok((await savedTask()).completedAt);
  assert.deepEqual((await savedTask()).status, "DONE");
  assert.deepEqual(calls[4].args, { channel: "CEXTERNAL", message_ts: "200.9" });
  assert.equal(calls[5].args.channel, "CDEV");
  assert.equal(
    calls[5].args.text,
    "<@UCLIENT> approved this in <https://slack.example/review|the requirement thread>, so it's now :white_check_mark: Done. Nice work!",
  );
  assert.deepEqual(calls[6].args, {
    channel: "CEXTERNAL",
    ts: "200.9",
    text: "<@UACTOR> says this is ready for you to review.\n<@UCLIENT> approved it. Thanks!",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "<@UACTOR> says this is ready for you to review.\n<@UCLIENT> approved it. Thanks!",
        },
      },
    ],
  });
});

test("Not approve moves the task back to In progress and tells the task's thread", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true, status: "CLIENT_REVIEW" }), requirementTask("CLIENT_REVIEW")),
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  await send("/slack/interactions", reviewClick("status:reject"));

  const task = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.1");
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  const requirement = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.deepEqual((await savedRequirement()).status, "IN_PROGRESS");
  // The task was not Done, so its pin stays.
  assert.ok(!calls.some((call) => call.method.startsWith("pins.")));
  const note = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(note.thread_ts, "100.1");
  assert.equal(
    note.text,
    "<@UCLIENT> didn't approve this in <https://slack.example/review|the requirement thread>, so it's back to :arrow_forward: In progress. Have a look at the thread for what needs to change.",
  );
  assert.match(calls.at(-1).args.text, /\n<@UCLIENT> didn't approve it, so the team will pick it up again\. Thanks for letting us know!$/);
});

test("Approve and Not approve do nothing once the task has left Client review", async (t) => {
  for (const actionId of ["status:approve", "status:reject"]) {
    const calls = mockSlack(t, { stored: [requirementTask("IN_TESTING")] });
    await send("/slack/interactions", reviewClick(actionId));
    assert.deepEqual(calls.map((call) => call.method), ["chat.update"], actionId);
    assert.match(calls[0].args.text, /\nI didn't change anything: the task has since moved to :test_tube: In testing\.$/);
  }
});

test("Approve on a deleted task says so", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/interactions", reviewClick("status:approve"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.update"]);
  assert.match(calls[0].args.text, /\nHmm, this task doesn't exist anymore\.$/);
});

test("Client review on a requirement task asks the client straight away", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true }), requirementTask("IN_TESTING")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send("/slack/events", threadEvent("<@UBOT> status client review"));

  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL");
  assert.equal(review.args.thread_ts, "200.1");
  assert.deepEqual(
    review.args.blocks[1].elements.map((button) => button.action_id),
    ["status:approve", "status:reject"],
  );
  // The command gets a ✅, and a note that the client was asked.
  assert.ok(calls.some((call) => call.method === "reactions.add"));
  const note = calls.at(-1).args;
  assert.equal(note.channel, "CDEV");
  assert.equal(note.thread_ts, "100.1");
  assert.equal(note.text, "I've asked the client to review it in <https://slack.example/source|the requirement thread>.");
});

const requirementDelete = JSON.stringify({
  kind: "requirement",
  channel: "CEXTERNAL",
  ts: "200.1",
  requestedBy: "UCLIENT",
});

test("@Cade remove in a requirement thread asks for confirmation", async (t) => {
  const calls = mockSlack(t, { stored: [requirementRoot()] });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> remove", { channel: "CEXTERNAL", user: "UCLIENT", ts: "200.5", thread_ts: "200.1" }),
  );

  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  const prompt = calls[0].args;
  assert.equal(prompt.thread_ts, "200.1");
  assert.equal(
    prompt.text,
    "<@UCLIENT>, should I delete the requirement *Export reports*? There's no undo.",
  );
  const [cancel, confirm] = prompt.blocks[1].elements;
  assert.equal(confirm.text.text, "Delete requirement");
  assert.equal(confirm.confirm.title.text, "Delete requirement?");
  assert.equal(confirm.confirm.deny.text, "Keep requirement");
  assert.deepEqual(JSON.parse(confirm.value), JSON.parse(requirementDelete));
  assert.equal(cancel.action_id, "delete:cancel");
});

test("removing a tracked requirement asks to delete its task too", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true })));
  await send(
    "/slack/events",
    threadEvent("<@UBOT> remove", { channel: "CEXTERNAL", user: "UCLIENT", ts: "200.5", thread_ts: "200.1" }),
  );
  const prompt = calls.at(-1).args;
  assert.equal(
    prompt.text,
    "<@UCLIENT>, should I delete the requirement *Export reports* and its task <https://slack.example/p100|Fix login> in <#CDEV>? There's no undo.",
  );
  const [, confirm] = prompt.blocks[1].elements;
  assert.equal(
    confirm.confirm.text.text,
    'I\'ll delete "Export reports", its task "Fix login", and my replies in both threads.',
  );
});

test("@Cade remove in an external thread Cade did not start says so", async (t) => {
  const calls = mockSlack(t);
  await send(
    "/slack/events",
    threadEvent("<@UBOT> remove", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  assert.match(calls.at(-1).args.text, /^Hmm, this thread isn't a requirement\./);
});

test("confirming a requirement's deletion removes Cade's replies and then the requirement", async (t) => {
  const calls = mockSlack(t, {
    stored: [requirementRoot()],
    "conversations.replies": {
            messages: [
              { ts: "200.1", bot_id: "BCADE" },
              { ts: "200.2", user: "UCLIENT" },
              { ts: "200.3", bot_id: "BCADE" },
            ],
          },
  });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLIENT" },
      actions: [{ action_id: "delete:confirm", value: requirementDelete }],
    }),
  );

  const deletes = calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts);
  assert.deepEqual(deletes, ["200.3", "200.1"]);
  // Requirements are not in the sheet, there is no other thread to tell, and
  // whoever confirmed sees it go.
  assert.ok(!calls.some((call) => ["sheet", "chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

// The aura300 pair with an incidents channel; the test pair has none.
const incidentEnv = {
  ...env,
  CHANNEL_PAIRS: [
    { name: "aura300", external: "CEXTERNAL", tasks: "CDEV", incidents: "CINC" },
    { name: "test", external: "CTESTEXT", tasks: "CTESTDEV" },
  ],
};

// An incident's message in the external channel, at 200.1, tracked as the task
// at CINC/100.1 unless `task` is false.
const incidentRoot = ({ task = true } = {}) => {
  const record = requirementRoot({ task });
  Object.assign(record.requirement, {
    title: "Checkout is down",
    priority: "Urgent",
    dueDate: "Immediate",
    incident: true,
  });
  if (task) record.requirement.task.channel = "CINC";
  return record;
};

// The incident's task, at CINC/100.1.
const incidentTask = (status = "TODO") => {
  const record = requirementTask(status);
  record.channel = "CINC";
  Object.assign(record.task, { title: "Checkout is down", priority: "Urgent", dueDate: "Immediate" });
  record.task.source.incident = true;
  return record;
};

test("/cade incident opens a form that asks only what the incident is", async (t) => {
  const calls = mockSlack(t);
  const response = await send("/slack/commands", slash("incident"), {}, incidentEnv);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  const { view } = calls[0].args;
  assert.equal(view.callback_id, "incident");
  assert.deepEqual(JSON.parse(view.private_metadata), { channel: "CEXTERNAL" });
  assert.deepEqual(view.blocks.map((block) => block.block_id ?? block.type), ["title", "context"]);
  assert.equal(view.blocks[0].label.text, "What's the incident?");
});

test("/cade incident needs an incidents channel and works only in external channels", async (t) => {
  for (const [channel, text] of [
    ["CTESTEXT", /^I can't take incidents in this channel yet/],
    ["CDEV", /^That one works with `\/cade incident` in <#CEXTERNAL>\.$/],
  ]) {
    const calls = mockSlack(t);
    const reply = await (await send("/slack/commands", slash("incident", channel), {}, incidentEnv)).json();
    assert.equal(calls.length, 0, channel);
    assert.equal(reply.response_type, "ephemeral");
    assert.match(reply.text, text, channel);
  }
});

test("reporting an incident posts it and tracks it straight away in the incidents channel", async (t) => {
  const calls = mockSlack(t, {
    "chat.postMessage": (args) =>
      args.channel === "CINC" ? { channel: "CINC", ts: "100.1" } : { ts: "200.1" },
    "chat.getPermalink": (args) => ({
      permalink: args.channel === "CINC" ? "https://slack.example/p100" : "https://slack.example/source",
    }),
  });
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UCLIENT" },
      view: {
        callback_id: "incident",
        private_metadata: JSON.stringify({ channel: "CEXTERNAL" }),
        state: { values: { title: { value: { value: "Checkout is down" } } } },
      },
    }),
    {},
    incidentEnv,
  );
  assert.deepEqual(await response.json(), { response_action: "clear" });

  // The incident message, in the external channel, as a new thread.
  const root = calls[0].args;
  assert.equal(calls[0].method, "chat.postMessage");
  assert.equal(root.channel, "CEXTERNAL");
  assert.equal(root.thread_ts, undefined);
  // Labelled, so it can be told apart from requirements in the same channel.
  assert.equal(root.text, "Incident: Checkout is down");
  assert.equal(allBlocks(root)[0].text.text, "Incident  ·  *Checkout is down*");
  assert.match(allBlocks(root)[2].elements[0].text, /^Reported by <@UCLIENT>  ·  /);
  assert.equal(root.attachments[0].color, "#E01E5A");
  assert.deepEqual((await savedRequirement()).incident, true);
  assert.deepEqual((await savedRequirement()).priority, "Urgent");
  assert.deepEqual((await savedRequirement()).dueDate, "Immediate");

  // The task, in the incidents channel, pinned, linking back to the incident.
  const task = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CINC");
  assert.equal(blockText(allBlocks(task.args)[1]), ":memo: To do  ·  Urgent  ·  Due Immediate");
  const stored = await savedTask("CINC");
  assert.equal(stored.source.threadTs, "200.1");
  assert.equal(stored.source.incident, true);
  assert.equal(footerLines(task.args)[1], "Tracked by <@UCLIENT> from <https://slack.example/source|the incident thread>");
  assert.ok(calls.some((call) => call.method === "pins.add" && call.args.channel === "CINC"));
  assert.ok(!calls.some((call) => call.args.channel === "CDEV"), "nothing goes to the dev channel");

  // The incident message then links to the task and shows In progress.
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.equal(blockText(allBlocks(update.args)[1]), ":arrow_forward: In progress  ·  Urgent  ·  Due Immediate");
  assert.deepEqual((await savedRequirement()).task.channel, "CINC");
});

test("an incident needs a description", async (t) => {
  const calls = mockSlack(t);
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UCLIENT" },
      view: {
        callback_id: "incident",
        private_metadata: JSON.stringify({ channel: "CEXTERNAL" }),
        state: { values: { title: { value: { value: " " } } } },
      },
    }),
    {},
    incidentEnv,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await response.json(), {
    response_action: "errors",
    errors: { title: "Please tell us what's going on." },
  });
});

test("an incident's priority and due date can't be changed in either thread", async (t) => {
  for (const [channel, overrides] of [
    ["CEXTERNAL", { ts: "200.5", thread_ts: "200.1" }],
    ["CINC", {}],
  ]) {
    for (const text of ["<@UBOT> priority low", "<@UBOT> due 15/12/2026"]) {
      const calls = mockSlack(t, threads(incidentRoot(), incidentTask()));
      await send("/slack/events", threadEvent(text, { channel, ...overrides }), {}, incidentEnv);
      assert.ok(!calls.some((call) => call.method === "chat.update"), `${channel}: ${text}`);
      assert.equal(
        calls.at(-1).args.text,
        "Incidents are always :red_circle: Urgent and due Immediate, so I can't change their priority or due date.",
      );
    }
  }
});

test("the incidents channel runs the task commands like the dev channel", async (t) => {
  let calls = mockSlack(t, threads(incidentRoot(), incidentTask("IN_TESTING")));
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { channel: "CINC" }), {}, incidentEnv);
  assert.equal(calls[0].args.channel, "CINC");
  assert.deepEqual((await savedTask("CINC")).people.developer, ["UBOB"]);

  // Client review asks whoever reported the incident, as for requirements.
  calls = mockSlack(t, {
    ...threads(incidentRoot(), incidentTask("IN_TESTING")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send("/slack/events", threadEvent("<@UBOT> status client review", { channel: "CINC" }), {}, incidentEnv);
  assert.deepEqual((await savedRequirement()).status, "CLIENT_REVIEW");
  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL");
  assert.match(review.args.text, /\n<@UCREATOR>, could you take a look and approve it/);
  assert.equal(review.args.blocks[1].elements[0].action_id, "status:approve");
});

test("an incident whose task was deleted is tracked again in the incidents channel", async (t) => {
  let calls = mockSlack(t, { stored: [incidentRoot({ task: false })] });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
    {},
    incidentEnv,
  );
  const origin = JSON.parse(allBlocks(calls[0].args)[0].elements[0].value);
  assert.equal(origin.incident, true);

  calls = mockSlack(t, {
    ...createdTask,
    "chat.postMessage": (args) =>
      args.channel === "CINC" ? { channel: "CINC", ts: "100.1" } : { ts: "300.1" },
    stored: [incidentRoot({ task: false })],
  });
  await send(
    "/slack/interactions",
    interaction(titleOnlySubmission("Checkout is down", { ...origin, promptTs: "300.1" })),
    {},
    incidentEnv,
  );
  const task = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CINC");
  assert.ok(task, "the task goes to the incidents channel");
  assert.deepEqual((await savedTask("CINC")).priority, "Urgent");
  assert.deepEqual((await savedTask("CINC")).dueDate, "Immediate");
});

test("incident tasks are recorded in the pair's sheet tab", async (t) => {
  const calls = mockSlack(t, {
    ...threads(incidentRoot(), incidentTask()),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> status in progress", { channel: "CINC" }),
    {},
    { ...incidentEnv, SHEET_URL, SHEET_SECRET: "secret" },
  );
  const row = calls.find((call) => call.method === "sheet").args;
  assert.equal(row.project, "aura300");
  assert.equal(row.row["Due date"], "Immediate");
});

test("a requirement is unpinned when its task is Done and pinned again when reopened", async (t) => {
  for (const [from, to, method] of [
    ["IN_TESTING", "done", "pins.remove"],
    ["DONE", "in progress", "pins.add"],
  ]) {
    const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask(from)));
    await send("/slack/events", threadEvent(`<@UBOT> status ${to}`));
    const pins = calls.filter((call) => call.method.startsWith("pins."));
    assert.deepEqual(
      pins.map((call) => [call.method, call.args.channel, call.args.timestamp]),
      [
        [method, "CDEV", "100.1"],
        [method, "CEXTERNAL", "200.1"],
      ],
      to,
    );
  }
});

test("other status changes leave the requirement's pin alone", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("TODO")));
  await send("/slack/events", threadEvent("<@UBOT> status in review"));
  assert.ok(!calls.some((call) => call.method.startsWith("pins.")));
});

test("tasks with no requirement pin only themselves", async (t) => {
  const root = storedTask();
  root.task.source = undefined;
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  const pins = calls.filter((call) => call.method.startsWith("pins."));
  assert.deepEqual(pins.map((call) => call.args.channel), ["CDEV"]);
});

// A stored task at `ts`, with `fields` changed.
const historyTask = (ts, { developers = [], reviewers = [], testers = [], ...fields }) => {
  const record = storedTask({ developers, reviewers, testers });
  record.ts = ts;
  Object.assign(record.task, fields);
  return record;
};

// What `/cade tasks` says it takes, after saying what was wrong.
const TASKS_USAGE =
  "Try `/cade tasks` for your open tasks, with any of: `development`, `review` or `testing` for one role; `@person` for theirs; `-all` for everyone's; `-unassigned` for those with no developer; `-status=in-progress` (or `todo`, `in-review`, `in-testing`, `client-review`, `done`, several with commas); `-due=@today`, `-due<@today`, `-due>=31/10/2026` or `-due=none`.";

// A response_url's answer: like the API, it refuses a message whose blocks
// reuse an action_id, with an OK status and { ok: false }.
function respondAsSlack(body) {
  const reused = duplicateActionIds(body.blocks ?? []);
  return reused.length ? Response.json({ ok: false, error: "invalid_blocks" }) : new Response("ok");
}

// Slash command answers sent later go to RESPONSE_URL.
const RESPONSE_URL = "https://hooks.slack.com/commands/T1/1/abc";

// Runs `/cade <text>` from `channel` as UACTOR, with `stored` (each channel's
// task root messages) in the database, and returns its immediate answer, the
// calls made, and the answer sent later through the response_url.
async function tasksCommand(t, text, channel, stored = {}, environment = env) {
  const calls = mockSlack(t, { ...slackUsers, "auth.test": { url: "https://acme.slack.com/" } });
  for (const [where, messages] of Object.entries(stored)) {
    for (const record of messages) await putTask(env, where, record.ts, record.task);
  }
  return { calls, ...(await runTasksCommand(text, channel, environment)) };
}

// Sends `/cade <text>` and returns its immediate answer and the one sent later.
async function runTasksCommand(text, channel, environment = env) {
  const fakeFetch = globalThis.fetch;
  let later;
  globalThis.fetch = async (url, init) => {
    if (url === RESPONSE_URL) {
      later = JSON.parse(init.body);
      return respondAsSlack(later);
    }
    return fakeFetch(url, init);
  };
  const form = new URLSearchParams(slash(text, channel));
  form.set("response_url", RESPONSE_URL);
  const response = await send("/slack/commands", form.toString(), {}, environment);
  globalThis.fetch = fakeFetch;
  return { now: await response.text(), later };
}

test("/cade tasks in a group's channel shows its open tasks by role, only to you", async (t) => {
  const { now, calls, later } = await tasksCommand(t, "tasks", "CDEV", ({
    CDEV: [
      historyTask("100.1", { title: "Low task", priority: "Low", developers: ["UACTOR"] }),
      historyTask("100.2", { title: "High task", priority: "High", dueDate: "05/11/2026", developers: ["UACTOR", "UBOB"] }),
      historyTask("100.3", { title: "High, sooner", priority: "High", dueDate: "01/11/2026", developers: ["UACTOR"] }),
      historyTask("100.4", { title: "Done task", status: "DONE", developers: ["UACTOR"] }),
      historyTask("100.5", { title: "Not mine", developers: ["UBOB"] }),
      historyTask("100.6", { title: "Review me", reviewers: ["UACTOR"], status: "IN_REVIEW" }),
    ],
    CINC: [
      historyTask("100.8", { title: "Checkout is down", priority: "Urgent", dueDate: "Immediate", developers: ["UACTOR"] }),
    ],
    // Another group's task is left out.
    CTESTDEV: [historyTask("100.9", { title: "Test task", developers: ["UACTOR"] })],
  }), incidentEnv);

  // Slack is answered at once; the list follows, only to you.
  assert.equal(now, "");
  assert.equal(later.response_type, "ephemeral");
  // The tasks come from the database: Slack is only asked for the
  // workspace's address, for the links.
  assert.deepEqual(calls.map((call) => call.method), ["auth.test"]);

  assert.equal(later.text, "You have 5 open aura300 tasks.");
  const [header, developing, reviewing, testing] = later.blocks;
  assert.equal(header.text.text, "Your aura300 tasks");
  // Each link opens the task's thread.
  const thread = (channel, ts) =>
    `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel}`;
  assert.equal(
    developing.text.text,
    [
      "*Developing (4)*",
      `• *Incident:* <${thread("CINC", "100.8")}|Checkout is down>  ·  :memo: To do  ·  :red_circle: Urgent  ·  Due Immediate`,
      `• <${thread("CDEV", "100.3")}|High, sooner>  ·  :memo: To do  ·  :large_orange_circle: High  ·  Due 01/11/2026`,
      `• <${thread("CDEV", "100.2")}|High task>  ·  :memo: To do  ·  :large_orange_circle: High  ·  Due 05/11/2026`,
      `• <${thread("CDEV", "100.1")}|Low task>  ·  :memo: To do  ·  :large_green_circle: Low  ·  Due 31/10/2026`,
    ].join("\n"),
  );
  assert.equal(
    reviewing.text.text,
    `*Reviewing (1)*\n• <${thread("CDEV", "100.6")}|Review me>  ·  :eyes: In review  ·  :large_orange_circle: High  ·  Due 31/10/2026`,
  );
  assert.equal(testing.text.text, "*Testing*\n_Nothing assigned._");
});

test("/cade tasks in an external or incidents channel shows that channel's group", async (t) => {
  for (const channel of ["CEXTERNAL", "CINC"]) {
    const { later } = await tasksCommand(t, "tasks", channel, ({
      CDEV: [historyTask("100.1", { developers: ["UACTOR"] })],
      CTESTDEV: [historyTask("100.2", { developers: ["UACTOR"] })],
    }), incidentEnv);
    assert.equal(later.text, "You have 1 open aura300 task.", channel);
  }
});

test("/cade tasks outside every group shows each group in turn", async (t) => {
  const { later } = await tasksCommand(t, "tasks", "CRANDOM", ({
    CDEV: [historyTask("100.1", { developers: ["UACTOR"] })],
    CTESTDEV: [historyTask("100.2", { testers: ["UACTOR"] }), historyTask("100.3", { testers: ["UACTOR"] })],
  }));
  assert.equal(later.text, "You have 1 open aura300 task. You have 2 open test tasks.");
  assert.deepEqual(
    later.blocks.map((block) => (block.type === "header" ? block.text.text : block.type)),
    ["Your aura300 tasks", "section", "section", "section", "divider", "Your test tasks", "section", "section", "section"],
  );
});

test("/cade tasks with a role shows only that role", async (t) => {
  const pins = ({
    CDEV: [
      historyTask("100.1", { title: "Build it", developers: ["UACTOR"] }),
      historyTask("100.2", { title: "Review it", reviewers: ["UACTOR"] }),
      historyTask("100.3", { title: "Both", developers: ["UACTOR"], testers: ["UACTOR"] }),
    ],
  });
  for (const [word, heading, text, lines] of [
    ["development", "Developing", "You have 2 open aura300 developing tasks.", 2],
    ["dev", "Developing", "You have 2 open aura300 developing tasks.", 2],
    ["Review", "Reviewing", "You have 1 open aura300 reviewing task.", 1],
    ["testing", "Testing", "You have 1 open aura300 testing task.", 1],
    ["test", "Testing", "You have 1 open aura300 testing task.", 1],
  ]) {
    const { later } = await tasksCommand(t, `tasks ${word}`, "CDEV", pins);
    assert.equal(later.text, text, word);
    assert.equal(later.blocks[0].text.text, `Your aura300 tasks: ${heading}`, word);
    // Just the one role's section.
    assert.equal(later.blocks.length, 2, word);
    assert.equal(later.blocks[1].text.text.split("\n").length, lines + 1, word);
    assert.match(later.blocks[1].text.text, new RegExp(`^\\*${heading} \\(${lines}\\)\\*`), word);
  }
});

test("/cade tasks with a role and no such tasks says so", async (t) => {
  const { later } = await tasksCommand(t, "tasks review", "CDEV", ({
    CDEV: [historyTask("100.1", { developers: ["UACTOR"] })],
  }));
  assert.equal(later.text, "You have no open aura300 reviewing tasks.");
  assert.equal(later.blocks[0].text.text, "Your aura300 tasks: Reviewing");
});

test("/cade tasks with anything else says what it takes", async (t) => {
  // Group names are not taken any more: the channel picks the group.
  for (const word of ["mars", "aura300"]) {
    const { now, calls, later } = await tasksCommand(t, `tasks ${word}`, "CDEV", {});
    assert.deepEqual(JSON.parse(now), {
      response_type: "ephemeral",
      text: `I don't know "${word}" as a role. ${TASKS_USAGE}`,
    });
    assert.equal(calls.length, 0);
    assert.equal(later, undefined);
  }
});
test("someone with no open tasks in the group is told so", async (t) => {
  const { later } = await tasksCommand(t, "tasks", "CDEV", ({
    CDEV: [historyTask("100.1", { developers: ["UBOB"] })],
  }));
  assert.equal(later.text, "You have no open aura300 tasks.");
  assert.equal(later.blocks[1].text.text, "You have no open tasks.");
});

test("/cade tasks leaves out deleted tasks", async (t) => {
  const { later } = await tasksCommand(t, "tasks", "CDEV", {
    CDEV: [historyTask("100.1", { developers: ["UACTOR"] }), historyTask("100.2", { developers: ["UACTOR"] })],
  });
  assert.equal(later.text, "You have 2 open aura300 tasks.");

  await markTaskDeleted(env, "CDEV", "100.1");
  const again = await runTasksCommand("tasks", "CDEV");
  assert.equal(again.later.text, "You have 1 open aura300 task.");
});

test("@Cade tasks points to /cade tasks", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> tasks"));
  assert.equal(calls[0].args.text, "That one's a slash command: try `/cade tasks`.");
});

const PR = "https://github.com/acme/cade/pull/42";
const MR = "https://gitlab.com/acme/web/web-app/-/merge_requests/118";

test("@Cade pr add links pull requests on one line above who tracked it", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}/files> <${MR}|the MR> ${PR}`));

  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "chat.postMessage"]);
  const blocks = allBlocks(calls[0].args);
  // Stored without the /files tab, and only once.
  assert.deepEqual((await savedTask()).prs, [PR, MR]);
  // Not sent to the client yet, so pending.
  assert.equal(blocks[2].type, "context");
  assert.equal(blockText(blocks[2]), `*Pending:* <${PR}|cade/42>, <${MR}|web-app/118>`);
  assert.match(footerLines(calls[0].args)[1], /^Tracked by/);
  assert.match(calls[1].args.text, new RegExp(`^<@UACTOR> linked <${PR}\\|cade/42>, <${MR}\\|web-app/118> and moved the task to :eyes: In review\\.\\n`));
});

test("tasks without pull requests show no PRs line", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));
  assert.equal(allBlocks(calls[0].args).length, 3);
  assert.match(footerLines(calls[0].args)[1], /^Tracked by/);
});

test("@Cade pr add skips pull requests already linked", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  let calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}> <${MR}>`));
  assert.deepEqual((await savedTask()).prs, [PR, MR]);
  assert.match(calls[1].args.text, new RegExp(`^<@UACTOR> linked <${MR}\\|web-app/118> and moved the task to :eyes: In review\\.\\n`));

  calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.equal(calls[0].args.text, "Those pull requests are already linked to this task, so we're all set.");
});

test("@Cade pr remove unlinks pull requests", async (t) => {
  const root = storedTask();
  root.task.prs = [PR, MR];
  let calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).prs, [MR]);
  assert.equal(blockText(allBlocks(calls[0].args)[2]), `*Pending:* <${MR}|web-app/118>`);
  assert.equal(calls[1].args.text, `<@UACTOR> unlinked <${PR}|cade/42>.`);

  // Removing the last one removes the PRs line.
  root.task.prs = [PR];
  calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).prs, []);
  assert.equal(allBlocks(calls[0].args).length, 3);

  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.equal(calls.at(-1).args.text, "Hmm, those pull requests aren't linked to this task.");
});

test("@Cade pr needs add or remove and a pull request link", async (t) => {
  for (const [text, reply] of [
    [`<@UBOT> pr <${PR}>`, "Try `@Cade pr add <link>` or `@Cade pr remove <link>`."],
    ["<@UBOT> pr", "Try `@Cade pr add <link>` or `@Cade pr remove <link>`."],
    ["<@UBOT> pr add", "Which pull request? Paste its link. Try `@Cade pr add <link>` or `@Cade pr remove <link>`."],
    [
      "<@UBOT> pr add <https://github.com/acme/cade/issues/3>",
      "Hmm, that doesn't look like a pull request link: https://github.com/acme/cade/issues/3",
    ],
  ]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"], text);
    assert.equal(calls[0].args.text, reply, text);
  }
});

test("@Cade pr works in incidents channels but not in external ones", async (t) => {
  let calls = mockSlack(t, threads(incidentRoot(), incidentTask()));
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`, { channel: "CINC" }), {}, incidentEnv);
  assert.equal(calls[0].args.channel, "CINC");
  assert.deepEqual((await savedTask("CINC")).prs, [PR]);

  calls = mockSlack(t);
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`, { channel: "CEXTERNAL" }));
  assert.equal(calls[0].args.text, "That one works with `@Cade pr add <link>` in a task thread in <#CDEV>.");
});

test("pull requests on GitHub, GitLab and Bitbucket are read as reponame/number", async () => {
  const { parsePullRequest } = await import("../src/tasks.js");
  assert.deepEqual(parsePullRequest(`${PR}/files`), { url: PR, repo: "cade", number: "42" });
  assert.equal(parsePullRequest(MR).repo, "web-app");
  assert.deepEqual(parsePullRequest("https://bitbucket.org/acme/api/pull-requests/7"), {
    url: "https://bitbucket.org/acme/api/pull-requests/7",
    repo: "api",
    number: "7",
  });
  assert.equal(parsePullRequest("https://github.com/acme/cade/issues/3"), null);
});

test("linking a PR asks the task's reviewers to review it", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA", "UREX"] })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.equal(
    calls[1].args.text,
    `<@UACTOR> linked <${PR}|cade/42> and moved the task to :eyes: In review.\n<@URIA>, <@UREX>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
  );
  assert.equal(calls[1].args.blocks, undefined, "no picker");
});

test("linking a PR with no reviewer asks who should review it", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  const prompt = calls[1].args;
  assert.equal(
    prompt.text,
    `<@UACTOR> linked <${PR}|cade/42> and moved the task to :eyes: In review.\nThere's no reviewer yet. Who should review it?`,
  );
  const block = prompt.blocks[0];
  assert.equal(block.accessory.type, "multi_users_select");
  assert.equal(block.accessory.action_id, "pr:reviewers");
  assert.deepEqual(JSON.parse(block.block_id), [PR]);
});

test("choosing reviewers assigns them and asks them to review", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: { ts: "100.8", thread_ts: "100.1" },
      actions: [{ action_id: "pr:reviewers", block_id: JSON.stringify([PR]), selected_users: ["URIA"] }],
    }),
  );
  assert.deepEqual(calls.map((call) => [call.method, call.args.ts]), [
    ["chat.update", "100.1"],
    ["chat.update", "100.8"],
  ]);
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
  assert.equal(
    calls[1].args.text,
    // Just the request; whoever chose sees the picker become it.
    `<@URIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
  );
  assert.equal(calls[1].args.blocks.length, 1, "the picker is gone");
});

test("assigning a reviewer once a PR is linked asks them to review it", async (t) => {
  const root = storedTask();
  root.task.prs = [PR, MR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA>"));
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
  assert.equal(
    calls[1].args.text,
    `<@URIA>, could you review <${PR}|cade/42>, <${MR}|web-app/118> when you get a chance? Thanks!`,
  );
});

test("reviewers added before a PR are not named, so not notified", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA> <@UREX>"));
  const reply = calls[1].args.text;
  assert.equal(reply, "<@UACTOR> added 2 reviewers. I'll ask them to review once a PR is linked.");
  assert.ok(!reply.includes("URIA") && !reply.includes("UREX"));
});

// A plain (non-command) reply in the task's thread, as UACTOR.
const threadReply = (text, overrides = {}) => threadEvent(text, overrides);

// Clicks a button on Cade's private "link these PRs?" question.
const suggestionClick = (actionId, urls) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.1", urls }) }],
  });

// Records what is sent to RESPONSE_URL. Install it after mockSlack, so it
// sees those requests first.
function recordResponses(t) {
  const sent = [];
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === RESPONSE_URL) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return respondAsSlack(body);
    }
    return fakeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = fakeFetch;
  });
  return sent;
}

test("pull requests pasted into a task's thread are offered for linking, privately", async (t) => {
  const root = storedTask();
  root.task.prs = [MR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadReply(`Fixed in <${PR}> and <${MR}>, see <https://example.com/doc>`));

  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  const question = calls[0].args;
  assert.equal(question.user, "UACTOR");
  assert.equal(question.thread_ts, "100.1");
  // Only the PR that isn't linked yet is offered.
  assert.equal(question.text, `I see you posted <${PR}|cade/42>. Should I link it to this task?`);
  const [link, skip] = question.blocks[1].elements;
  assert.equal(link.text.text, "Link PR");
  assert.equal(link.action_id, "pr:suggest-link");
  assert.equal(skip.text.text, "Not now");
  assert.deepEqual(JSON.parse(link.value), { channel: "CDEV", ts: "100.1", mentioned: [], urls: [PR], reviewers: [] });
});

test("messages without unlinked pull requests are left alone", async (t) => {
  const linked = storedTask();
  linked.task.prs = [PR];
  for (const [text, overrides, root] of [
    ["Looks good, no links here", {}, storedTask()],
    [`Already linked <${PR}>`, {}, linked],
    // Not in a thread, not in a team channel, or not a task's thread.
    [`See <${PR}>`, { thread_ts: undefined }, storedTask()],
    [`See <${PR}>`, { channel: "CEXTERNAL" }, storedTask()],
    [`See <${PR}>`, {}, null],
    // Cade's own messages and edits.
    [`See <${PR}>`, { bot_id: "BCADE" }, storedTask()],
    [`See <${PR}>`, { subtype: "message_changed" }, storedTask()],
  ]) {
    const calls = mockSlack(t, { stored: root ? [root] : [] });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${JSON.stringify(overrides)}`);
  }
});

test("@Cade pr add is a command, not a suggestion", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("Link PRs links them, posts only what is new and removes the question", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  const sent = recordResponses(t);
  const response = await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.equal(response.status, 200);

  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "chat.postMessage"]);
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.equal(calls[1].args.thread_ts, "100.1");
  // No "linked" line: whoever clicked posted the link. The thread hears the
  // status change, and the reviewer the message didn't mention is asked.
  assert.equal(
    calls[1].args.text,
    `<@UACTOR> moved the task to :eyes: In review.\n<@URIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
  );
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Link PRs on a task with no reviewer asks who should review", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(allBlocks(post)[0].accessory.action_id, "pr:reviewers");
});

test("Link PRs after someone else linked them just removes the question", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  const sent = recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.deepEqual(calls.map((call) => call.method), []);
  assert.equal(sent.length, 1);
});

test("Not now just removes the question", async (t) => {
  const calls = mockSlack(t);
  const sent = recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-skip", [PR]));
  assert.equal(calls.length, 0);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

// `mentioned` is who the pasted message mentioned.
const suggestionValue = (fields) =>
  JSON.stringify({ channel: "CDEV", ts: "100.1", mentioned: [], urls: [], reviewers: [], ...fields });

const clickSuggestion = (value) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: "pr:suggest-link", value }],
  });

test("a pasted PR that mentions people offers them as reviewers too", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  // URIA is already a reviewer and Cade is not a person to add.
  await send("/slack/events", threadReply(`<@UREX> <@URIA> <@UBOT> can you look at <${PR}>?`));

  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(
    question.text,
    `I see you posted <${PR}|cade/42> and mentioned <@UREX>. Should I link it to this task and add <@UREX> as reviewer?`,
  );
  const [both, link, skip] = question.blocks[1].elements;
  // Each button has its own action_id, as Slack requires.
  assert.deepEqual(
    [both, link, skip].map((button) => button.action_id),
    ["pr:suggest-link", "pr:suggest-link-only", "pr:suggest-skip"],
  );
  assert.equal(both.text.text, "Link and add reviewer");
  const mentioned = ["UREX", "URIA", "UBOT"];
  assert.equal(both.value, suggestionValue({ mentioned, urls: [PR], reviewers: ["UREX"] }));
  assert.equal(link.text.text, "Just link");
  assert.equal(link.value, suggestionValue({ mentioned, urls: [PR] }));
  assert.equal(skip.text.text, "Not now");
});

test("an already linked PR with new people offers just the reviewers", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadReply(`<@UREX> <@URIA> please look at <${PR}>`));

  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.text, `Should I add <@UREX>, <@URIA> as reviewers of <${PR}|cade/42>?`);
  const [add, skip] = question.blocks[1].elements;
  assert.equal(add.text.text, "Add reviewers");
  assert.equal(add.value, suggestionValue({ mentioned: ["UREX", "URIA"], reviewers: ["UREX", "URIA"] }));
  assert.equal(skip.text.text, "Not now");
});

test("mentions without a PR link are not offered as reviewers", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("<@UREX> can you help with this?"));
  assert.equal(calls.length, 0);
});

test("Link and add reviewer asks only the reviewers the message did not mention", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  const sent = recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ mentioned: ["UREX"], urls: [PR], reviewers: ["UREX"] })));

  assert.deepEqual((await savedTask()).people.reviewer, ["URIA", "UREX"]);
  assert.deepEqual((await savedTask()).prs, [PR]);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  // UREX was mentioned in the message, so only URIA is asked.
  assert.equal(
    post.text,
    `<@UACTOR> moved the task to :eyes: In review.\n<@URIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
  );
  assert.equal(sent.length, 1);
});

test("Add reviewers on an already linked PR adds them and posts nothing", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  const sent = recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ mentioned: ["UREX"], reviewers: ["UREX"] })));

  assert.deepEqual((await savedTask()).people.reviewer, ["UREX"]);
  // The message already asked UREX; the card shows them as reviewer.
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.equal(sent.length, 1);
});

test("Just link leaves the mentioned people out", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ urls: [PR] })));
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
});

test("linking a PR moves a task that is To do or In progress to In review", async (t) => {
  for (const [from, to, moved] of [
    ["TODO", "IN_REVIEW", true],
    ["IN_PROGRESS", "IN_REVIEW", true],
    ["IN_REVIEW", "IN_REVIEW", false],
    // Further on, the task stays where it is.
    ["IN_TESTING", "IN_TESTING", false],
    ["CLIENT_REVIEW", "CLIENT_REVIEW", false],
    ["DONE", "DONE", false],
  ]) {
    const calls = mockSlack(t, { stored: [withStatus(from)] });
    await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
    assert.deepEqual((await savedTask()).status, to, from);
    const said = calls[1].args.text.includes("moved the task to :eyes: In review");
    assert.equal(said, moved, from);
    // Pins only change with Done, so none here.
    assert.ok(!calls.some((call) => call.method.startsWith("pins.")), from);
  }
});

test("removing a PR leaves the status alone", async (t) => {
  const root = withStatus("IN_REVIEW");
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).status, "IN_REVIEW");
});

const assignValue = (role, people, moveTo = null, fromRequirement = false) =>
  JSON.stringify({ channel: "CDEV", ts: "100.1", role, people, moveTo, fromRequirement });

const clickAssign = (actionId, value) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value }],
  });

test("handing a task over in a message offers to assign them, privately", async (t) => {
  for (const [text, role, label, asked] of [
    ["<@UREX> please start working on this", "developer", "developer", "work on this"],
    ["<@UREX> shall we start working on this?", "developer", "developer", "work on this"],
    ["<@UREX> can you start on this", "developer", "developer", "work on this"],
    ["<@UREX> can you look into this?", "developer", "developer", "work on this"],
    ["<@UREX> Could you pick this up", "developer", "developer", "work on this"],
    ["<@UREX> please review this fix", "reviewer", "reviewer", "review this"],
  ]) {
    // In review already, so only the assignment is offered.
    const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
    await send("/slack/events", threadReply(text));
    const question = calls.find((call) => call.method === "chat.postEphemeral")?.args;
    assert.ok(question, text);
    assert.equal(question.user, "UACTOR");
    assert.equal(question.thread_ts, "100.1");
    assert.equal(question.text, `Looks like you asked <@UREX> to ${asked}. Should I assign them as ${label}?`, text);
    const [assign, skip] = question.blocks[1].elements;
    assert.equal(assign.text.text, `Assign as ${label}`, text);
    assert.equal(assign.value, assignValue(role, ["UREX"]), text);
    assert.equal(skip.text.text, "Not now");
  }
});

test("hand-offs leave alone people already in the role, Cade and plain chat", async (t) => {
  for (const [text, root] of [
    ["<@UREX> please start working on this", (() => {
      const root = withStatus("IN_PROGRESS");
      root.task.people.developer = ["UREX"];
      return root;
    })()],
    ["<@UBOT> please look into this", storedTask()],
    ["<@UREX> thanks, looks great", storedTask()],
    ["please start working on this", storedTask()],
    ["<@UREX> please look into this", null],
  ]) {
    const calls = mockSlack(t, { stored: root ? [root] : [] });
    await send("/slack/events", threadReply(text));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), text);
  }
  // In an external thread that isn't a requirement, nothing is offered.
  const calls = mockSlack(t);
  await send("/slack/events", threadReply("<@UREX> please look into this", { channel: "CEXTERNAL" }));
  assert.deepEqual(calls.map((call) => call.method), []);
});

test("a message with a PR link gets the PR question, not a hand-off one", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply(`<@UREX> please review <${PR}>`));
  const questions = calls.filter((call) => call.method === "chat.postEphemeral");
  assert.equal(questions.length, 1);
  assert.equal(questions[0].args.blocks[1].elements[0].action_id, "pr:suggest-link");
});

test("Assign as developer adds them and posts nothing", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ developers: ["UALICE"] })] });
  const sent = recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("developer", ["UREX", "UBOB"])));

  assert.deepEqual((await savedTask()).people.developer, ["UALICE", "UREX", "UBOB"]);
  // The card shows them; the thread hears nothing more.
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Assign as reviewer posts nothing, PR or not", async (t) => {
  for (const prs of ["", PR]) {
    const root = storedTask();
    root.task.prs = prs ? [prs] : [];
    const calls = mockSlack(t, { stored: [root] });
    recordResponses(t);
    await send("/slack/interactions", clickAssign("assign:suggest", assignValue("reviewer", ["UREX"])));
    assert.deepEqual((await savedTask()).people.reviewer, ["UREX"]);
    // The message that asked them to review was the request.
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"), prs || "no PR");
  }
});

test("Assign after they were assigned anyway, or Not now, just removes the question", async (t) => {
  for (const [actionId, root] of [
    ["assign:suggest", storedTask({ developers: ["UREX"] })],
    ["assign:suggest-skip", storedTask()],
  ]) {
    const calls = mockSlack(t, { stored: [root] });
    const sent = recordResponses(t);
    await send("/slack/interactions", clickAssign(actionId, assignValue("developer", ["UREX"])));
    assert.ok(!calls.some((call) => ["chat.update", "chat.postMessage"].includes(call.method)), actionId);
    assert.equal(sent.length, 1, actionId);
  }
});

test("Just link works like the other link button", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  recordResponses(t);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      container: { is_ephemeral: true },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "pr:suggest-link-only", value: suggestionValue({ urls: [PR] }) }],
    }),
  );
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
});

test("handing a task to testing offers to assign the tester and move it to In testing", async (t) => {
  for (const text of ["<@UTESS> please test it on staging", "<@UTESS> can you QA this"]) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadReply(text));
    const question = calls.find((call) => call.method === "chat.postEphemeral").args;
    assert.equal(
      question.text,
      "Looks like you asked <@UTESS> to test this. Should I assign them as tester and move the task to :test_tube: In testing?",
      text,
    );
    const [assign] = question.blocks[1].elements;
    assert.equal(assign.text.text, "Assign and move to In testing");
    assert.equal(assign.value, assignValue("tester", ["UTESS"], "IN_TESTING"));
  }
});

test("a tester assigned ahead of time is offered just the move to In testing", async (t) => {
  const root = withStatus("IN_REVIEW");
  root.task.people.tester = ["UTESS"];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadReply("<@UTESS> ready for testing"));
  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.text, "Looks like you asked <@UTESS> to test this. Should I move the task to :test_tube: In testing?");
  const [move] = question.blocks[1].elements;
  assert.equal(move.text.text, "Move to In testing");
  assert.equal(move.value, assignValue("tester", [], "IN_TESTING"));
});

test("a testing hand-off once testing has started only offers the assignment", async (t) => {
  for (const status of ["IN_TESTING", "CLIENT_REVIEW", "DONE"]) {
    let calls = mockSlack(t, { stored: [withStatus(status)] });
    await send("/slack/events", threadReply("<@UTESS> please test this"));
    const question = calls.find((call) => call.method === "chat.postEphemeral").args;
    assert.equal(question.text, "Looks like you asked <@UTESS> to test this. Should I assign them as tester?", status);
    assert.equal(question.blocks[1].elements[0].value, assignValue("tester", ["UTESS"]));

    // With the tester already there, there's nothing to ask.
    const root = withStatus(status);
    root.task.people.tester = ["UTESS"];
    calls = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadReply("<@UTESS> please test this"));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), status);
  }
});

test("Assign and move to In testing assigns the tester and moves the task", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("IN_REVIEW")));
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("tester", ["UTESS"], "IN_TESTING")));

  assert.deepEqual((await savedTask()).people.tester, ["UTESS"]);
  assert.deepEqual((await savedTask()).status, "IN_TESTING");
  // The client still sees In progress.
  assert.equal((await savedRequirement()).status, "IN_PROGRESS");
  assert.ok(!calls.some((call) => call.method.startsWith("pins.")));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.text, "<@UACTOR> moved the task to :test_tube: In testing.");
});

test("Move to In testing moves a task whose tester was assigned ahead of time", async (t) => {
  const root = withStatus("IN_PROGRESS");
  root.task.people.tester = ["UTESS"];
  const calls = mockSlack(t, { stored: [root] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("tester", [], "IN_TESTING")));
  const task = calls.find((call) => call.method === "chat.update").args;
  assert.deepEqual((await savedTask()).status, "IN_TESTING");
  assert.deepEqual((await savedTask()).people.tester, ["UTESS"]);
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UACTOR> moved the task to :test_tube: In testing.",
  );
});

test("a task that moved on before the click is not moved back to testing", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("tester", ["UTESS"], "IN_TESTING")));
  assert.deepEqual((await savedTask()).status, "CLIENT_REVIEW");
  assert.deepEqual((await savedTask()).people.tester, ["UTESS"]);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("@Cade assign tester never changes the status", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_PROGRESS")] });
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UTESS>"));
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.deepEqual((await savedTask()).people.tester, ["UTESS"]);
});

test("handing a To do task to a developer offers to move it to In progress", async (t) => {
  // A new developer: assign and move.
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("<@UREX> please start working on this"));
  let question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(
    question.text,
    "Looks like you asked <@UREX> to work on this. Should I assign them as developer and move the task to :arrow_forward: In progress?",
  );
  assert.equal(question.blocks[1].elements[0].text.text, "Assign and move to In progress");
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", ["UREX"], "IN_PROGRESS"));

  // Assigned ahead of time: just the move.
  calls = mockSlack(t, { stored: [storedTask({ developers: ["UREX"] })] });
  await send("/slack/events", threadReply("<@UREX> you can start working on this now"));
  question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.text, "Looks like you asked <@UREX> to work on this. Should I move the task to :arrow_forward: In progress?");
  assert.equal(question.blocks[1].elements[0].text.text, "Move to In progress");
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", [], "IN_PROGRESS"));
});

test("a developer hand-off once work has started only offers the assignment", async (t) => {
  for (const status of ["IN_PROGRESS", "IN_REVIEW", "IN_TESTING", "DONE"]) {
    const calls = mockSlack(t, { stored: [withStatus(status)] });
    await send("/slack/events", threadReply("<@UREX> please look into this"));
    const question = calls.find((call) => call.method === "chat.postEphemeral").args;
    assert.equal(question.text, "Looks like you asked <@UREX> to work on this. Should I assign them as developer?", status);
  }
});

test("Assign and move to In progress assigns the developer and moves the task", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("developer", ["UREX"], "IN_PROGRESS")));
  const task = calls.find((call) => call.method === "chat.update").args;
  assert.deepEqual((await savedTask()).people.developer, ["UREX"]);
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UACTOR> moved the task to :arrow_forward: In progress.",
  );
});

test("a task started before the click is not moved again", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("developer", ["UREX"], "IN_PROGRESS")));
  assert.deepEqual((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("@Cade assign developer never changes the status", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UREX>"));
  assert.deepEqual((await savedTask()).status, "TODO");
});

test("Done is posted in the requirement thread without asking", async (t) => {
  for (const from of ["IN_TESTING", "CLIENT_REVIEW"]) {
    const calls = mockSlack(t, {
      ...threads(requirementRoot({ task: true }), requirementTask(from)),
      "chat.getPermalink": { permalink: "https://slack.example/p100" },
    });
    await send("/slack/events", threadEvent("<@UBOT> status done"));
    const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
    assert.equal(post.thread_ts, "200.1");
    assert.equal(
      post.text,
      // The thread is the requirement, so there's no link to the task.
      "Great news! <@UACTOR> marked this as :white_check_mark: Done.",
      from,
    );
    assert.equal(post.blocks.length, 1, "no buttons");
    // The command gets a ✅, and a note that the requirement thread was told.
    assert.ok(calls.some((call) => call.method === "reactions.add"), from);
    assert.equal(calls.at(-1).args.channel, "CDEV", from);
    assert.equal(calls.at(-1).args.text, "I've let <https://slack.example/source|the requirement thread> know it's :white_check_mark: Done.", from);
  }
});

test("statuses the client doesn't hear about, and repeats, post nothing outside", async (t) => {
  for (const [from, to] of [
    ["TODO", "in progress"],
    ["IN_PROGRESS", "in review"],
    ["DONE", "done"],
  ]) {
    const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask(from)));
    await send("/slack/events", threadEvent(`<@UBOT> status ${to}`));
    assert.ok(
      !calls.some((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL"),
      `${from} → ${to}`,
    );
  }
});

test("approving posts nothing more in the requirement thread", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true, status: "CLIENT_REVIEW" }), requirementTask("CLIENT_REVIEW")),
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  await send("/slack/interactions", reviewClick("status:approve"));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL"));
});


test("Link PR on a task already in review with no reviewer just asks who should review", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.text, `There's no reviewer yet. Who should review <${PR}|cade/42>?`);
  assert.equal(allBlocks(post)[0].accessory.action_id, "pr:reviewers");
});

// A message in the requirement thread at 200.1, as UACTOR.
const requirementReply = (text) => threadEvent(text, { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" });

test("asking a developer to start from an untracked requirement offers to track and assign", async (t) => {
  const calls = mockSlack(t, { stored: [requirementRoot()] });
  await send("/slack/events", requirementReply("<@UREX> can you start working on this?"));

  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.channel, "CEXTERNAL");
  assert.equal(question.thread_ts, "200.1");
  assert.equal(question.user, "UACTOR");
  assert.equal(question.text, "Looks like you asked <@UREX> to work on this. Should I track it as a task and assign them as developer?");
  const [track, skip] = question.blocks[1].elements;
  assert.equal(track.text.text, "Track and assign");
  assert.equal(track.action_id, "track:assign");
  assert.deepEqual(JSON.parse(track.value), {
    channel: "CEXTERNAL",
    threadTs: "200.1",
    requirement: true,
    incident: false,
    title: "Export reports",
    priority: "High",
    dueDate: "31/10/2026",
    developers: ["UREX"],
  });
  assert.equal(skip.text.text, "Not now");
});

test("only developer hand-offs are offered from a requirement thread", async (t) => {
  for (const text of ["<@UREX> please review this", "<@UREX> please test this"]) {
    const calls = mockSlack(t, { stored: [requirementRoot()] });
    await send("/slack/events", requirementReply(text));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), text);
  }
});

test("Track and assign opens the track form and removes the question", async (t) => {
  const calls = mockSlack(t);
  const sent = recordResponses(t);
  const origin = { channel: "CEXTERNAL", threadTs: "200.1", requirement: true, title: "Export reports", priority: "High", dueDate: "", developers: ["UREX"] };
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "trigger-7",
      user: { id: "UACTOR" },
      channel: { id: "CEXTERNAL" },
      container: { is_ephemeral: true },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "track:assign", value: JSON.stringify(origin) }],
    }),
  );
  const open = calls.find((call) => call.method === "views.open").args;
  assert.equal(open.trigger_id, "trigger-7");
  assert.deepEqual(JSON.parse(open.view.private_metadata), origin);
  assert.equal(open.view.blocks[0].element.initial_value, "Export reports");
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("a task tracked with Track and assign starts with its developers, In progress", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [requirementRoot()] });
  await send(
    "/slack/interactions",
    interaction(
      titleOnlySubmission("Export reports", {
        channel: "CEXTERNAL",
        threadTs: "200.1",
        requirement: true,
        priority: "High",
        dueDate: "31/10/2026",
        developers: ["UREX"],
      }),
    ),
  );
  assert.deepEqual((await savedTask()).people.developer, ["UREX"]);
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  // The requirement shows In progress and links to the task.
  assert.deepEqual((await savedRequirement()).status, "IN_PROGRESS");
  assert.deepEqual((await savedRequirement()).task.ts, "100.1");
});

test("asking a developer to start on a tracked requirement offers to assign them to its task", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("TODO")));
  await send("/slack/events", requirementReply("<@UREX> please start working on this"));

  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.thread_ts, "200.1");
  assert.equal(
    question.text,
    "Looks like you asked <@UREX> to work on this. Should I assign them as developer of <https://slack.example/p100|Fix login> and move the task to :arrow_forward: In progress?",
  );
  // The button changes the task in the dev channel, and says it came from
  // the requirement thread.
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", ["UREX"], "IN_PROGRESS", true));
});

test("a task tracked with Track and assign is announced in the requirement thread", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [requirementRoot()] });
  await send(
    "/slack/interactions",
    interaction(
      titleOnlySubmission("Export reports", {
        channel: "CEXTERNAL",
        threadTs: "200.1",
        requirement: true,
        priority: "High",
        developers: ["UREX"],
      }),
    ),
  );
  // There's no button message to turn into the news, so it's posted.
  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
  assert.equal(post.thread_ts, "200.1");
  assert.equal(post.text, "<@UCREATOR> tracked this as a task: <https://slack.example/p100|Export reports>. The team's on it!");
});

test("a reported incident is not announced as tracked", async (t) => {
  const calls = mockSlack(t, {
    "chat.postMessage": (args) => (args.channel === "CINC" ? { channel: "CINC", ts: "100.1" } : { ts: "200.1" }),
    stored: [incidentRoot({ task: false })],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UCLIENT" },
      view: {
        callback_id: "incident",
        private_metadata: JSON.stringify({ channel: "CEXTERNAL" }),
        state: { values: { title: { value: { value: "Checkout is down" } } } },
      },
    }),
    {},
    incidentEnv,
  );
  // Only the incident message itself goes to the external channel.
  const external = calls.filter((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL");
  assert.equal(external.length, 1);
  assert.equal(external[0].args.text, "Incident: Checkout is down");
});

test("choosing from the status menu still turns it into the confirmation", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask()] });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UPICKER" },
      channel: { id: "CDEV" },
      message: { ts: "100.7", thread_ts: "100.1" },
      actions: [{ action_id: "status:select", selected_option: { value: "IN_REVIEW" } }],
    }),
  );
  assert.ok(!calls.some((call) => call.method === "reactions.add"));
  assert.equal(calls.at(-1).args.text, "<@UPICKER> set the status to :eyes: In review.");
});

test("other typed statuses get only the ✅", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("TODO")));
  await send("/slack/events", threadEvent("<@UBOT> status in review"));
  assert.equal(calls.at(-1).method, "reactions.add");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("Client review lists the task's PRs for the client, and keeps them after a decision", async (t) => {
  const task = requirementTask("IN_TESTING");
  task.task.prs = [PR, MR];
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true }), task),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send("/slack/events", threadEvent("<@UBOT> status client review"));

  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
  const announced = [
    "Good news! <@UACTOR> says this is ready for you to review.",
    `*PRs:* <${PR}|cade/42>, <${MR}|web-app/118>`,
  ].join("\n");
  assert.equal(
    review.blocks[0].text.text,
    `${announced}\n<@UCREATOR>, could you take a look and approve it, or let us know what needs to change?`,
  );
  assert.deepEqual(
    review.blocks[1].elements.map((button) => button.action_id),
    ["status:approve", "status:reject"],
  );
  // The buttons carry the PRs, so they stay when the buttons are replaced.
  assert.equal(JSON.parse(review.blocks[1].elements[0].value).text, announced);
});

test("Client review on a task with no PRs shows no PRs line", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true }), requirementTask("IN_TESTING")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send("/slack/events", threadEvent("<@UBOT> status client review"));
  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
  assert.ok(!review.blocks[0].text.text.includes("*PRs:*"));
});

test("confirming removes the task first, then the requirement", async (t) => {
  const calls = mockSlack(t, {
    stored: [requirementRoot({ task: true }), requirementTask()],
    "conversations.replies": (args) => ({
      messages: [{ ts: args.ts, bot_id: "BCADE" }, { ts: `${args.ts.split(".")[0]}.3`, bot_id: "BCADE" }],
    }),
  });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLIENT" },
      actions: [{ action_id: "delete:confirm", value: requirementDelete }],
    }),
  );
  const deletes = calls.filter((call) => call.method === "chat.delete").map((call) => [call.args.channel, call.args.ts]);
  assert.deepEqual(deletes, [
    ["CDEV", "100.3"],
    ["CDEV", "100.1"],
    ["CEXTERNAL", "200.3"],
    ["CEXTERNAL", "200.1"],
  ]);
  // The requirement isn't put back to In discussion or pinned again, since
  // it's going too, and nothing is posted anywhere.
  assert.ok(!calls.some((call) => call.method === "chat.update" || call.method === "pins.add"));
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("a task from a requirement or incident can't be removed from its own thread", async (t) => {
  for (const [requirement, root, environment, channel, text] of [
    [requirementRoot({ task: true }), requirementTask(), env, "CDEV", "This task is tracked by <https://slack.example/source|the requirement thread>, so please remove it from there with `@Cade remove`."],
    [incidentRoot(), incidentTask(), incidentEnv, "CINC", "This task is tracked by <https://slack.example/source|the incident thread>, so please remove it from there with `@Cade remove`."],
  ]) {
    const calls = mockSlack(t, {
      stored: [requirement, root],
      "conversations.replies": { messages: [{ ts: "200.1", bot_id: "BCADE" }] },
    });
    await send("/slack/events", threadEvent("<@UBOT> remove", { channel }), {}, environment);
    assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"], channel);
    assert.equal(calls[1].args.text, text);
  }
});

test("confirming a task's deletion does nothing while its requirement is there", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true })),
    "conversations.replies": { messages: [{ ts: "200.1", bot_id: "BCADE" }] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.ok(!calls.some((call) => call.method === "chat.delete"));
  assert.ok(await savedTask());
});

// The ways a task's requirement can be gone: deleted from Cade, or deleted
// by hand in Slack, with no replies or with some.
const orphanings = [
  ["deleted from Cade", [], {}],
  ["deleted in Slack", [requirementRoot({ task: true })], { error: "thread_not_found" }],
  ["deleted in Slack with replies", [requirementRoot({ task: true })], { messages: [{ ts: "200.1", subtype: "tombstone" }] }],
];

// A Slack API for an orphaned task: conversations.replies gives `source` for
// the requirement thread, failing with its `error` if it has one, and Cade's
// replies in the task's own thread.
const mockOrphan = (t, stored, source) => {
  const calls = mockSlack(t, {
    stored,
    "conversations.replies": (args) =>
      args.channel === "CEXTERNAL"
        ? source
        : { messages: [{ ts: args.ts, bot_id: "BCADE" }, { ts: "100.3", bot_id: "BCADE" }] },
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/conversations.replies") && source.error && init.body.get("channel") === "CEXTERNAL") {
      calls.push({ method: "conversations.replies", args: Object.fromEntries(init.body) });
      return Response.json({ ok: false, error: source.error });
    }
    return fetch(url, init);
  };
  return calls;
};

test("a task whose requirement is gone can be removed from its own thread", async (t) => {
  for (const [name, requirement, source] of orphanings) {
    const calls = mockOrphan(t, [...requirement, requirementTask()], source);
    await send("/slack/events", threadEvent("<@UBOT> remove", { user: "UACTOR" }));
    const prompt = calls.at(-1).args;
    assert.equal(
      prompt.text,
      "<@UACTOR>, the requirement this task came from has been deleted, so should I delete the task *Fix login* on its own? There's no undo.",
      name,
    );
    assert.equal(prompt.blocks[1].elements[1].action_id, "delete:confirm", name);
    assert.equal(JSON.parse(prompt.blocks[1].elements[1].value).kind, "task", name);
  }
});

test("confirming an orphaned task's deletion removes it, and the requirement left in the database", async (t) => {
  for (const [name, requirement, source] of orphanings) {
    const calls = mockOrphan(t, [...requirement, requirementTask()], source);
    await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
    const deletes = calls.filter((call) => call.method === "chat.delete").map((call) => [call.args.channel, call.args.ts]);
    assert.deepEqual(deletes, [["CDEV", "100.3"], ["CDEV", "100.1"]], name);
    assert.equal(await savedTask(), null, name);
    assert.equal(await savedRequirement(), null, name);
  }
});

test("a task whose deletion failed after it was marked deleted can be removed again", async (t) => {
  // Left behind when its requirement was deleted, by the old order.
  const calls = mockSlack(t, {
    stored: [requirementTask()],
    "conversations.replies": (args) => ({ messages: [{ ts: args.ts, bot_id: "BCADE" }] }),
  });
  await seeded;
  await markTaskDeleted(env, "CDEV", "100.1");
  await send("/slack/events", threadEvent("<@UBOT> remove"));
  assert.match(calls.at(-1).args.text, /has been deleted, so should I delete the task \*Fix login\* on its own\?/);

  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts),
    ["100.1"],
  );
});

test("a failed task deletion leaves the task to be tried again", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }] },
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    url.endsWith("/chat.delete") ? Response.json({ ok: false, error: "ratelimited" }) : fetch(url, init);
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR")).catch(() => {});
  assert.ok(calls.some((call) => call.method === "conversations.replies"));
  assert.ok(await savedTask());
});

test("removing a requirement whose link to its task was lost still removes the task", async (t) => {
  const task = requirementTask();
  task.task.link = "https://slack.example/p100";
  const calls = mockSlack(t, {
    ...threads(requirementRoot(), task),
    "conversations.replies": (args) => ({ messages: [{ ts: args.ts, bot_id: "BCADE" }] }),
  });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> remove", { channel: "CEXTERNAL", user: "UCLIENT", ts: "200.5", thread_ts: "200.1" }),
  );
  assert.equal(
    calls.at(-1).args.text,
    "<@UCLIENT>, should I delete the requirement *Export reports* and its task <https://slack.example/p100|Fix login> in <#CDEV>? There's no undo.",
  );

  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLIENT" },
      actions: [{ action_id: "delete:confirm", value: requirementDelete }],
    }),
  );
  const deletes = calls.filter((call) => call.method === "chat.delete").map((call) => [call.args.channel, call.args.ts]);
  assert.deepEqual(deletes, [["CDEV", "100.1"], ["CEXTERNAL", "200.1"]]);
  assert.equal(await savedTask(), null);
});

test("removing a requirement drops a task of it still waiting to be posted", async (t) => {
  mockSlack(t, {
    stored: [requirementRoot()],
    "conversations.replies": (args) => ({ messages: [{ ts: args.ts, bot_id: "BCADE" }] }),
  });
  await seeded;
  const waiting = requirementTask().task;
  await insertTask(env, "CDEV", waiting, {});
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLIENT" },
      actions: [{ action_id: "delete:confirm", value: requirementDelete }],
    }),
  );
  const { results } = await DB.prepare("SELECT deleted_at FROM tasks").all();
  assert.ok(results.length === 1 && results[0].deleted_at);
});

test("the ready to review message doesn't link to the team's task", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true }), requirementTask("IN_TESTING")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send("/slack/events", threadEvent("<@UBOT> status client review"));
  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
  assert.equal(
    review.text,
    "Good news! <@UACTOR> says this is ready for you to review.\n<@UCREATOR>, could you take a look and approve it, or let us know what needs to change?",
  );
  assert.ok(!review.text.includes("slack.example/p100"));
  // No link to look up for it.
  assert.ok(!calls.some((call) => call.method === "chat.getPermalink" && call.args.channel === "CDEV"));
});

test("asking someone to look into a tracked incident offers to assign them, in either thread", async (t) => {
  for (const [channel, overrides] of [
    // The incident's thread in the external channel.
    ["CEXTERNAL", { ts: "200.5", thread_ts: "200.1" }],
    // The incident's task thread in the incidents channel.
    ["CINC", {}],
  ]) {
    const calls = mockSlack(t, threads(incidentRoot(), incidentTask("TODO")));
    await send("/slack/events", threadReply("<@UREX> please look into it", { channel, ...overrides }), {}, incidentEnv);
    const question = calls.find((call) => call.method === "chat.postEphemeral")?.args;
    assert.ok(question, channel);
    assert.match(question.text, /^Looks like you asked <@UREX> to work on this\. Should I assign them as developer/, channel);
    // The button assigns them to the task in the incidents channel.
    assert.equal(JSON.parse(question.blocks[1].elements[0].value).channel, "CINC", channel);
  }
});

test("assigning from the requirement thread asks the developer in the task's thread", async (t) => {
  for (const [moveTo, text] of [
    [null, "<@UREX> could you pick this up when you get a chance? Thanks!"],
    ["IN_PROGRESS", "<@UREX> could you pick this up when you get a chance? Thanks!\n<@UACTOR> moved the task to :arrow_forward: In progress."],
  ]) {
    const calls = mockSlack(t, { stored: [requirementTask("TODO")] });
    recordResponses(t);
    await send("/slack/interactions", clickAssign("assign:suggest", assignValue("developer", ["UREX"], moveTo, true)));
    const post = calls.find((call) => call.method === "chat.postMessage").args;
    assert.equal(post.channel, "CDEV");
    assert.equal(post.thread_ts, "100.1");
    assert.equal(post.text, text, moveTo ?? "no move");
  }
});

test("assigning from the task's own thread still doesn't ask them again", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("developer", ["UREX"])));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("Track and assign asks the developers in the new task's thread", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [requirementRoot()] });
  await send(
    "/slack/interactions",
    interaction(
      titleOnlySubmission("Export reports", {
        channel: "CEXTERNAL",
        threadTs: "200.1",
        requirement: true,
        priority: "High",
        developers: ["UREX", "UBOB"],
      }),
    ),
  );
  const ask = calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").args;
  assert.equal(ask.channel, "CDEV");
  assert.equal(ask.text, "<@UREX>, <@UBOB> could you pick this up when you get a chance? Thanks!");
});


// Clicking a role's button under `@Cade assign`, in the task's thread.
const chooseRole = (role) =>
  interaction({
    type: "block_actions",
    trigger_id: "trigger-5",
    user: { id: "UPICKER" },
    channel: { id: "CDEV" },
    message: { ts: "100.8", thread_ts: "100.1" },
    actions: [{ action_id: `assign:choose:${role}`, value: role }],
  });

// Saving the people form.
const savePeopleForm = (role, users) =>
  interaction({
    type: "view_submission",
    user: { id: "UPICKER" },
    view: {
      callback_id: "assign:people",
      private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", role, promptTs: "100.8" }),
      state: { values: { people: { value: { selected_users: users } } } },
    },
  });

test("a role's button opens a form with its people filled in", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ developers: ["UALICE", "UBOB"] })] });
  await send("/slack/interactions", chooseRole("developer"));
  const { trigger_id: trigger, view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(trigger, "trigger-5");
  assert.equal(view.callback_id, "assign:people");
  assert.equal(view.title.text, "Developer");
  assert.equal(view.submit.text, "Save");
  const [field] = view.blocks;
  assert.equal(field.optional, true, "saving with no one clears the role");
  assert.equal(field.label.text, "Developers for Fix login");
  assert.equal(field.element.type, "multi_users_select");
  assert.deepEqual(field.element.initial_users, ["UALICE", "UBOB"]);
});

test("saving the form sets the role, tells those added and removed, and removes the buttons", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ developers: ["UALICE", "UBOB"] })] });
  // UBOB is removed, UREX added.
  const response = await send("/slack/interactions", savePeopleForm("developer", ["UALICE", "UREX"]));
  assert.equal(response.status, 200);
  assert.deepEqual((await savedTask()).people.developer, ["UALICE", "UREX"]);
  const ask = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(ask.thread_ts, "100.1");
  // UREX is asked to start; UBOB, removed, is told they no longer need to.
  assert.equal(ask.text, "<@UREX> could you pick this up when you get a chance? Thanks!\n<@UBOB>, you don't need to work on this anymore. Thanks!");
  assert.deepEqual(calls.at(-1).args, { channel: "CDEV", ts: "100.8" });
  assert.equal(calls.at(-1).method, "chat.delete");
});

test("saving with people only removed tells them", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ testers: ["UTESS"] })] });
  await send("/slack/interactions", savePeopleForm("tester", []));
  assert.deepEqual((await savedTask()).people.tester, []);
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UTESS>, you don't need to test this anymore. Thanks!",
  );
  assert.equal(calls.at(-1).method, "chat.delete");
});

test("reviewers saved are asked to review only once a PR is linked", async (t) => {
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/interactions", savePeopleForm("reviewer", ["URIA"]));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));

  const root = storedTask();
  root.task.prs = [PR];
  calls = mockSlack(t, { stored: [root] });
  await send("/slack/interactions", savePeopleForm("reviewer", ["URIA"]));
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    `<@URIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
  );
});

test("@Cade unassign of someone not assigned changes nothing", async (t) => {
  for (const [text, reply] of [
    ["<@UBOT> unassign <@UREX>", "Looks like they aren't assigned to this task."],
    ["<@UBOT> unassign tester <@UALICE>", "Looks like they aren't assigned to this task as tester."],
    ["<@UBOT> unassign <@UREX> <@UBOB>", "Looks like none of them are assigned to this task."],
  ]) {
    const calls = mockSlack(t, { stored: [storedTask({ developers: ["UALICE"] })] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"], text);
    assert.equal(calls[0].args.text, reply);
  }
});

test("removed reviewers are told they no longer need to review", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  await send("/slack/events", threadEvent("<@UBOT> unassign reviewer <@URIA>"));
  assert.equal(calls.at(-1).args.text, "<@URIA>, you don't need to review this anymore. Thanks!");
});

test("assign-style hand-offs are caught too", async (t) => {
  for (const [text, label] of [
    ["<@UREX> I assigned this to you", "developer"],
    ["Assigning it to <@UREX>", "developer"],
    ["<@UREX> assigned this task to you", "developer"],
    ["<@UREX> can you take care of this?", "developer"],
    ["<@UREX> over to you", "developer"],
    // The role still follows the words used.
    ["<@UREX> assigned this to you for review", "reviewer"],
    ["<@UREX> assigned this to you for testing", "tester"],
  ]) {
    const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
    await send("/slack/events", threadReply(text));
    const question = calls.find((call) => call.method === "chat.postEphemeral")?.args;
    assert.ok(question, text);
    assert.match(question.text, new RegExp(`Should I assign them as ${label}`), text);
  }
});

test("assign-style words without a mention are left alone", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("this was assigned to the wrong sprint, I assigned it to QA board"));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("\"assigned this to you\" in a requirement thread offers to track or assign", async (t) => {
  for (const [root, start] of [
    [requirementRoot(), "Looks like you asked <@URANDIL> to work on this. Should I track it as a task"],
    [requirementRoot({ task: true }), "Looks like you asked <@URANDIL> to work on this. Should I assign them as developer of"],
  ]) {
    const calls = mockSlack(t, threads(root, requirementTask("TODO")));
    await send(
      "/slack/events",
      threadEvent("<@URANDIL|Randil Fernando> assigned this to you", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
    );
    const question = calls.find((call) => call.method === "chat.postEphemeral")?.args;
    assert.ok(question, start);
    assert.ok(question.text.startsWith(start), question.text);
  }
});

test("CHANNEL_PAIRS can be a JSON string, as the Cloudflare dashboard stores it", async (t) => {
  const calls = mockSlack(t);
  const asJson = { ...env, CHANNEL_PAIRS: JSON.stringify(env.CHANNEL_PAIRS) };
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { channel: "CEXTERNAL" }), {}, asJson);
  assert.equal(calls[0].args.text, "That one works with `@Cade assign developer @person` in a task thread in <#CDEV>.");

  const broken = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"), {}, { ...env, CHANNEL_PAIRS: "[{" });
  assert.match(broken[0].args.text, /something went wrong/);
});

test("the Slack app manifest is filled in from the Worker's URL, name and command", async () => {
  const { buildManifest } = await import("../scripts/slack-app.mjs");
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../slack/manifest.json", import.meta.url), "utf8"));
  const settings = { workerUrl: "https://cade.acme.workers.dev/", name: "Acme Cade", command: "/acme" };

  const manifest = buildManifest(template, settings);
  assert.equal(manifest._comment, undefined, "Slack doesn't accept extra keys");
  assert.equal(manifest.display_information.name, "Acme Cade");
  assert.equal(manifest.features.bot_user.display_name, "Acme Cade");
  const [command] = manifest.features.slash_commands;
  assert.equal(command.command, "/acme");
  // The trailing slash is dropped, so the paths are clean.
  assert.equal(command.url, "https://cade.acme.workers.dev/slack/commands");
  assert.equal(manifest.settings.interactivity.request_url, "https://cade.acme.workers.dev/slack/interactions");
  assert.equal(manifest.settings.event_subscriptions.request_url, "https://cade.acme.workers.dev/slack/events");
  assert.ok(!JSON.stringify(manifest).includes("{{"), "every placeholder is filled in");

  // Created first without Event Subscriptions, whose URL Slack checks before
  // the Worker has the signing secret.
  assert.equal(buildManifest(template, { ...settings, events: false }).settings.event_subscriptions, undefined);
  assert.ok(template.settings.event_subscriptions, "the template is left as it was");
});

test("the manifest asks for the scopes Cade uses", async () => {
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../slack/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(template.oauth_config.scopes.bot, [
    "channels:history",
    "chat:write",
    "commands",
    "groups:history",
    "pins:write",
    "reactions:write",
    "users:read",
  ]);
  assert.deepEqual(template.settings.event_subscriptions.bot_events, ["message.channels", "message.groups"]);
});

test("slack:create checks its settings before calling Slack", async () => {
  const { checkSettings } = await import("../scripts/slack-app.mjs");
  assert.deepEqual(checkSettings({ workerUrl: "https://cade.acme.workers.dev", name: "Cade", command: "/cade" }), []);
  assert.equal(checkSettings({ workerUrl: "http://cade", name: "Cade", command: "/cade" }).length, 1);
  assert.equal(checkSettings({ workerUrl: "https://cade.dev", name: "x".repeat(36), command: "/cade" }).length, 1);
  assert.equal(checkSettings({ workerUrl: "https://cade.dev", name: "Cade", command: "cade" }).length, 1);
});

test("npm run config turns cade.config.json into the Worker's secrets", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const channels = [{ name: "acme", external: "C0000000001", tasks: "C0000000002" }];
  assert.deepEqual(readConfig(JSON.stringify({ timezone: "Asia/Colombo", channels })), {
    CHANNEL_PAIRS: JSON.stringify(channels),
    TIMEZONE: "Asia/Colombo",
  });
  // The timezone is optional.
  assert.deepEqual(readConfig(JSON.stringify({ channels })), { CHANNEL_PAIRS: JSON.stringify(channels) });
});

test("npm run config stops on a mistake, before uploading anything", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const good = [{ name: "acme", external: "C0000000001", tasks: "C0000000002" }];
  for (const [config, problem] of [
    ["{", /not valid JSON/],
    [{ timezone: "UTC" }, /must list \{ name, external, tasks \}/],
    [{ channels: [{ external: "C0000000001", tasks: "C0000000002" }] }, /must list \{ name, external, tasks \}/],
    [{ channels: [{ name: "acme", external: "#acme-external", tasks: "C0000000002" }] }, /doesn't look like a Slack channel ID/],
    [{ channels: [{ name: "acme", external: "C0000000001", tasks: "C0000000001" }] }, /used twice/],
    [{ channels: good, timezone: "Sri Lanka" }, /isn't a time zone/],
    // A token here would be a mistake: they belong in Cloudflare only.
    [{ channels: good, SLACK_BOT_TOKEN: "xoxb-1" }, /has "SLACK_BOT_TOKEN"; it takes channels and timezone/],
  ]) {
    assert.throws(() => readConfig(typeof config === "string" ? config : JSON.stringify(config)), problem);
  }
});

test("the example config is valid", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const { readFile } = await import("node:fs/promises");
  const secrets = readConfig(await readFile(new URL("../cade.config.example.json", import.meta.url), "utf8"));
  assert.equal(JSON.parse(secrets.CHANNEL_PAIRS).length, 2);
});

test("npm run dev passes its settings to Wrangler as a quoted .env file", async () => {
  const { envFile } = await import("../scripts/dev.mjs");
  const pairs = JSON.stringify([{ name: "acme", external: "C0000000001", tasks: "C0000000002" }]);
  assert.equal(
    envFile({ CHANNEL_PAIRS: pairs, TIMEZONE: "UTC", SLACK_BOT_TOKEN: "xoxb-1", SHEET_URL: undefined }),
    `CHANNEL_PAIRS='${pairs}'\nTIMEZONE='UTC'\nSLACK_BOT_TOKEN='xoxb-1'`,
  );
  assert.throws(() => envFile({ SLACK_SIGNING_SECRET: "it's" }), /can't contain a quote/);
});

test("npm run dev asks for the Sheet's secret only with its URL", async () => {
  const { SECRETS } = await import("../scripts/dev.mjs");
  const sheetSecret = SECRETS.find(({ name }) => name === "SHEET_SECRET");
  assert.equal(sheetSecret.when({}), false);
  assert.equal(sheetSecret.when({ SHEET_URL: "https://script.google.com/x" }), true);
  assert.deepEqual(SECRETS.filter((secret) => !secret.optional && !secret.when).map(({ name }) => name), [
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
  ]);
});

test("cade.config.json can hold the Google Sheet's address", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const channels = [{ name: "acme", external: "C0000000001", tasks: "C0000000002" }];
  const sheetUrl = "https://script.google.com/macros/s/AKfy-abc/exec";
  assert.equal(readConfig(JSON.stringify({ channels, sheetUrl })).SHEET_URL, sheetUrl);
  assert.throws(
    () => readConfig(JSON.stringify({ channels, sheetUrl: "https://docs.google.com/spreadsheets/d/1/edit" })),
    /web app URL from Apps Script/,
  );
  // The Sheet's secret stays out of the file.
  assert.throws(() => readConfig(JSON.stringify({ channels, sheetSecret: "s" })), /has "sheetSecret"/);
});

test("intent phrases match whole words, or word starts with *", async () => {
  const { intent, plainMessage } = await import("../src/intents.js");
  const message = (text) => plainMessage({ text, user: "U", channel: "C", ts: "1.2", thread_ts: "1.1" }, "UBOT");
  const whole = intent({ name: "whole", order: 1, phrases: ["work on"], handle() {} });
  assert.ok(whole.test(message("can you work on this")));
  assert.ok(!whole.test(message("that would work only later")));
  const start = intent({ name: "start", order: 1, phrases: ["test*"], handle() {} });
  assert.ok(start.test(message("ready for testing")));
  assert.ok(!start.test(message("the latest build")));
  assert.throws(() => intent({ name: "neither", order: 1, handle() {} }), /needs either phrases or match/);
});

test("the first intent by order wins, and needs are checked first", async () => {
  const { findIntent, intent, plainMessage } = await import("../src/intents.js");
  const event = (text, extra = {}) => ({ text, user: "U", channel: "C", ts: "1.2", thread_ts: "1.1", ...extra });
  const late = intent({ name: "late", order: 50, phrases: ["deploy*"], handle() {} });
  const early = intent({ name: "early", order: 5, phrases: ["deploy*"], needs: { mention: true }, handle() {} });
  // Order wins over the order they're listed in…
  assert.equal(findIntent([late, early], plainMessage(event("<@UREX> deploying now"), "UBOT")).name, "early");
  // …but an intent whose needs aren't met is passed over.
  assert.equal(findIntent([late, early], plainMessage(event("deploying now"), "UBOT")).name, "late");
  // Cade mentioning itself isn't someone mentioned.
  assert.equal(findIntent([early], plainMessage(event("<@UBOT> deploying"), "UBOT")), undefined);
  const threaded = intent({ name: "threaded", order: 1, phrases: ["deploy*"], needs: { thread: true }, handle() {} });
  assert.equal(findIntent([threaded], plainMessage(event("deploying", { thread_ts: undefined }), "UBOT")), undefined);
  // Edits and bot posts are never intents.
  assert.equal(plainMessage(event("deploying", { subtype: "message_changed" }), "UBOT"), null);
  assert.equal(plainMessage(event("deploying", { bot_id: "B1" }), "UBOT"), null);
});

test("handlers' intents are registered in order: PR links, then reviewer, tester, developer", async () => {
  const { intents } = await import("../src/commands/registry.js");
  assert.deepEqual(
    [...intents].sort((a, b) => a.order - b.order).map((each) => each.name),
    ["pr-link", "hand-off:reviewer", "hand-off:tester", "hand-off:developer"],
  );
});

test("npm run sheet:create makes Secret.gs, finds the deployment and sets sheetUrl", async () => {
  const { deploymentIdIn, secretFile, webAppUrl, withSheetUrl } = await import("../scripts/sheet-app.mjs");
  const secret = "a".repeat(64);
  assert.match(secretFile(secret), new RegExp(`^// .*\\nconst SECRET = "${secret}";\\n$`));
  assert.throws(() => secretFile("short"), /long and hex/);

  // clasp prints the HEAD deployment too; the new one is wanted.
  const output = "Deployed AKfycbHEAD000000000000000000000 @HEAD\nDeployed AKfycbNEW1111111111111111111111-x @1\n";
  assert.equal(deploymentIdIn(output), "AKfycbNEW1111111111111111111111-x");
  assert.equal(deploymentIdIn("nothing here"), undefined);
  assert.equal(webAppUrl("AKfycbNEW1"), "https://script.google.com/macros/s/AKfycbNEW1/exec");

  // Other settings in cade.config.json are kept.
  const config = JSON.parse(withSheetUrl('{"timezone":"UTC","channels":[]}', "https://script.google.com/macros/s/X/exec"));
  assert.deepEqual(config, { timezone: "UTC", channels: [], sheetUrl: "https://script.google.com/macros/s/X/exec" });
});

test("Code.gs checks requests against SECRET from Secret.gs, not a script property", async () => {
  const { readFile } = await import("node:fs/promises");
  const code = await readFile(new URL("../google-sheet/Code.gs", import.meta.url), "utf8");
  assert.match(code, /body\.secret !== SECRET/);
  assert.ok(!code.includes("getScriptProperties"), "no script properties left to set by hand");
  assert.match(code, /function authorize\(\)/);
  const ignore = await readFile(new URL("../google-sheet/.claspignore", import.meta.url), "utf8");
  assert.deepEqual(ignore.split("\n").filter((line) => line.startsWith("!")), ["!Code.gs", "!Secret.gs", "!appsscript.json"]);
});

test("the Slack app's description fits Slack's 140 characters", async () => {
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../slack/manifest.json", import.meta.url), "utf8"));
  assert.ok(template.display_information.description.length <= 140);
});

test("the setup prompt keeps tokens away from the agent", async () => {
  const { readFile } = await import("node:fs/promises");
  const prompt = await readFile(new URL("../scripts/setup-prompt.md", import.meta.url), "utf8");
  assert.match(prompt, /^Set up Cade for me by following GETTING_STARTED\.md/);
  assert.match(prompt, /Never ask me for a token or secret/);
  assert.match(prompt, /separate terminal window/);
  const guide = await readFile(new URL("../GETTING_STARTED.md", import.meta.url), "utf8");
  assert.match(guide, /npm run setup/);
});

test("npm run slack:create asks for both tokens hidden", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../scripts/slack-app.mjs", import.meta.url), "utf8");
  assert.match(script, /askHidden\("Bot token/);
  assert.doesNotMatch(script, /createInterface/);
});

// D1 is the source of truth; root messages and the Sheet are rendered from it.

test("each change is stored, and the root message is rendered from the stored task", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ developers: ["UALICE"] })] });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UTESS>"));

  // Slack is only written to: nothing is read back from it.
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.update",
    "chat.postMessage",
    "chat.update",
    "chat.postMessage",
  ]);
  assert.deepEqual((await savedTask()).people, { developer: ["UALICE", "UBOB"], reviewer: [], tester: ["UTESS"] });
  assert.equal(
    footerLines(calls[2].args)[0],
    "Dev <@UALICE>, <@UBOB>  ·  Test <@UTESS>",
  );
});

test("a thread with no stored task or requirement is neither", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  // The task is in CDEV; the same ts in another channel is a different message.
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { channel: "CTESTDEV" }));
  assert.match(calls.at(-1).args.text, /not tracking a task in this thread/);
});

test("a deleted task is kept in the database and no longer loads", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.equal(await savedTask(), null);
  assert.ok(await DB.prepare("SELECT 1 FROM tasks WHERE deleted_at IS NOT NULL").first());

  calls.length = 0;
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.match(calls[0].args.text, /not tracking a task in this thread/);
});

test("the sheet uses the task's stored link instead of looking it up", async (t) => {
  const record = storedTask();
  record.task.link = "https://slack.example/stored";
  const calls = mockSlack(t, { ...slackUsers, stored: [record] });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  assert.ok(!calls.some((call) => call.method === "chat.getPermalink"));
  assert.equal(sheetRow(calls)["Task link"], "https://slack.example/stored");
});

test("tasks with and without a requirement thread can be told apart", async (t) => {
  mockSlack(t, { stored: [storedTask(), historyTask("100.2", { source: undefined })] });
  await seeded;
  const { results } = await DB.prepare(
    "SELECT ts, source_channel FROM tasks ORDER BY ts",
  ).all();
  assert.deepEqual(results.map((row) => ({ ...row })), [
    { ts: "100.1", source_channel: "CEXTERNAL" },
    { ts: "100.2", source_channel: null },
  ]);
});

test("a new requirement is stored", async (t) => {
  mockSlack(t, { "chat.postMessage": { ts: "200.1" } });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UCREATOR" },
      view: {
        callback_id: "requirement",
        private_metadata: JSON.stringify({ channel: "CEXTERNAL" }),
        state: submission({ title: "Export reports", dueDate: "2026-11-30", priority: "High" }).view.state,
      },
    }),
  );
  assert.deepEqual(await getRequirement(env, "CEXTERNAL", "200.1"), {
    title: "Export reports",
    status: "DISCUSSION",
    priority: "High",
    dueDate: "30/11/2026",
    createdBy: "UCREATOR",
    incident: false,
    task: undefined,
  });
});

// Tasks and requirements are stored before they are posted; those Slack
// refused are posted again by the cron.

// Runs the cron, as Cloudflare does, and waits for its work.
async function runCron(environment = env) {
  await seeded;
  const pending = [];
  await worker.scheduled({ cron: "*/5 * * * *" }, environment, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
}

// Makes every stored row look `minutes` old, as if posting failed back then.
const age = (minutes = 2) =>
  Promise.all(
    ["tasks", "requirements"].map((table) =>
      DB.prepare(`UPDATE ${table} SET created_at = datetime('now', ?)`).bind(`-${minutes} minutes`).run(),
    ),
  );

// A task tracked from the requirement at CEXTERNAL/200.1 with the Track task
// button at 300.1, that Slack refused once.
async function waitingTask(attempts = 1) {
  const { task } = storedTask();
  const id = await insertTask(env, "CDEV", task, { channel: "CEXTERNAL", threadTs: "200.1", promptTs: "300.1" });
  await DB.prepare("UPDATE tasks SET post_attempts = ? WHERE id = ?").bind(attempts, id).run();
  return id;
}

test("the cron posts a task Slack refused, and finishes tracking it", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [requirementRoot()] });
  await waitingTask();
  await age();
  await runCron();

  assert.deepEqual(calls.map((call) => call.method), [
    "chat.postMessage",
    "chat.getPermalink",
    "pins.add",
    "chat.update",
    "chat.update",
  ]);
  assert.equal(calls[0].args.channel, "CDEV");
  const task = await savedTask();
  assert.equal(task.title, "Fix login");
  assert.equal(task.link, "https://slack.example/p100");
  // The requirement shows it's tracked, and the button becomes the news.
  assert.equal((await savedRequirement()).task.ts, "100.1");
  assert.equal(calls[4].args.ts, "300.1");
  assert.match(calls[4].args.text, /tracked this as a task/);
  // Posted once: nothing is left to retry.
  calls.length = 0;
  await runCron();
  assert.equal(calls.length, 0);
});

test("the cron leaves alone posts that may still be under way", async (t) => {
  const calls = mockSlack(t, createdTask);
  await waitingTask();
  await runCron();
  assert.equal(calls.length, 0);
});

test("the cron tells nobody while it keeps trying, and gives up after the last attempt", async (t) => {
  const calls = mockSlack(t, { "chat.postMessage": { ok: false, error: "channel_not_found" } });
  await waitingTask(1);
  await age();
  await runCron();
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);

  calls.length = 0;
  await DB.prepare("UPDATE tasks SET post_attempts = 4").run();
  await runCron();
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.postEphemeral"]);
  assert.equal(calls[1].args.user, "UCREATOR");
  assert.equal(calls[1].args.text, 'Sorry, I couldn\'t create the task "Fix login", even after a few tries.');
  // Given up: not tried again, and the requirement can be tracked afresh.
  calls.length = 0;
  await runCron();
  assert.equal(calls.length, 0);
  assert.ok(await DB.prepare("SELECT 1 FROM tasks WHERE deleted_at IS NOT NULL").first());
});

test("tracking a requirement whose task is waiting to be posted says so", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [requirementRoot()] });
  await waitingTask();
  await send("/slack/interactions", interaction(titleOnlySubmission("Export reports", requirementOrigin)));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  assert.match(calls[0].args.text, /^This requirement is already tracked\. Its task will show up/);
});

test("a requirement Slack refused is stored and posted by the cron", async (t) => {
  let calls = mockSlack(t, { "chat.postMessage": { ok: false, error: "rate_limited" } });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UCREATOR" },
      view: {
        callback_id: "requirement",
        private_metadata: JSON.stringify({ channel: "CEXTERNAL" }),
        state: submission({ title: "Export reports", priority: "High" }).view.state,
      },
    }),
  );
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.postEphemeral"]);
  assert.equal(
    calls[1].args.text,
    'Sorry, I couldn\'t post the requirement "Export reports" just now. I\'ll try again in a few minutes.',
  );

  calls = mockSlack(t, { "chat.postMessage": { ts: "200.1" } });
  await insertRequirement(env, "CEXTERNAL", {
    title: "Export reports",
    status: "DISCUSSION",
    priority: "High",
    dueDate: "",
    createdBy: "UCREATOR",
  });
  await age();
  await runCron();
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "pins.add"]);
  assert.equal((await savedRequirement()).title, "Export reports");
});

test("an incident Slack refused is tracked as a task once the cron posts it", async (t) => {
  const calls = mockSlack(t, {
    ...createdTask,
    "chat.postMessage": (args) =>
      args.channel === "CINC" ? { channel: "CINC", ts: "100.1" } : { ts: "200.1" },
  });
  await insertRequirement(env, "CEXTERNAL", {
    title: "Checkout is down",
    status: "DISCUSSION",
    priority: "Urgent",
    dueDate: "Immediate",
    incident: true,
    createdBy: "UCLIENT",
  });
  await age();
  await runCron(incidentEnv);

  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.channel);
  assert.deepEqual(posts, ["CEXTERNAL", "CINC"]);
  const task = await savedTask("CINC");
  assert.equal(task.source.threadTs, "200.1");
  assert.equal(task.source.incident, true);
  assert.equal((await savedRequirement()).task.channel, "CINC");
});

// /cade tasks options: a person, everyone, status and due date filters.

// A date `days` from today (UTC, as the test env has no TIMEZONE), as
// DD/MM/YYYY.
const dueIn = (days) => {
  const date = new Date(Date.parse(`${todayIn(env)}T00:00:00Z`) + days * 86400000);
  return date.toISOString().slice(0, 10).split("-").reverse().join("/");
};

test("/cade tasks @person shows their tasks, headed with their name", async (t) => {
  const { calls, later } = await tasksCommand(t, "tasks <@UBOB|bob>", "CDEV", {
    CDEV: [
      historyTask("100.1", { title: "Bob's", developers: ["UBOB"] }),
      historyTask("100.2", { title: "Mine", developers: ["UACTOR"] }),
      historyTask("100.3", { title: "Both", reviewers: ["UBOB", "UACTOR"] }),
    ],
  });
  assert.deepEqual(calls.map((call) => call.method).sort(), ["auth.test", "users.info"]);
  assert.equal(later.text, "<@UBOB> has 2 open aura300 tasks.");
  assert.equal(later.blocks[0].text.text, "Bob's aura300 tasks");
  assert.match(later.blocks[1].text.text, /^\*Developing \(1\)\*\n• <[^|]+\|Bob's>/);
  assert.match(later.blocks[2].text.text, /^\*Reviewing \(1\)\*\n• <[^|]+\|Both>/);

  // Naming yourself is the same as naming no one.
  const mine = await tasksCommand(t, "tasks <@UACTOR>", "CDEV", { CDEV: [historyTask("100.1", { developers: ["UACTOR"] })] });
  assert.equal(mine.later.text, "You have 1 open aura300 task.");

  const none = await tasksCommand(t, "tasks review <@UBOB>", "CDEV", { CDEV: [historyTask("100.1", { developers: ["UBOB"] })] });
  assert.equal(none.later.text, "<@UBOB> has no open aura300 reviewing tasks.");
  assert.equal(none.later.blocks[1].text.text, "<@UBOB> has no open tasks.");
});

test("/cade tasks -all shows everyone's tasks by status, with who works on them", async (t) => {
  const { later } = await tasksCommand(t, "tasks -all", "CDEV", {
    CDEV: [
      historyTask("100.1", { title: "Unassigned" }),
      historyTask("100.2", { title: "Shared", developers: ["UALICE"], testers: ["UBOB", "UALICE"], status: "IN_TESTING" }),
      historyTask("100.3", { title: "Finished", developers: ["UALICE"], status: "DONE" }),
    ],
  });
  assert.equal(later.text, "There are 2 open aura300 tasks.");
  // Links left out, as other tests check them.
  assert.deepEqual(
    later.blocks.map((block) => block.text.text.replace(/<https:[^|]+\|/g, "<")),
    [
      "All aura300 tasks",
      "*To do (1)*\n• <Unassigned>  ·  :memo: To do  ·  :large_orange_circle: High  ·  Due 31/10/2026  ·  _Unassigned_",
      "*In testing (1)*\n• <Shared>  ·  :test_tube: In testing  ·  :large_orange_circle: High  ·  Due 31/10/2026  ·  <@UALICE>, <@UBOB>",
    ],
  );
});

test("/cade tasks -status shows only those statuses, Done included when named", async (t) => {
  const stored = {
    CDEV: [
      historyTask("100.1", { title: "Started", developers: ["UACTOR"], status: "IN_PROGRESS" }),
      historyTask("100.2", { title: "Waiting", developers: ["UACTOR"] }),
      historyTask("100.3", { title: "Finished", developers: ["UACTOR"], status: "DONE" }),
    ],
  };
  const progress = await tasksCommand(t, "tasks -status=in-progress", "CDEV", stored);
  assert.equal(progress.later.text, "You have 1 aura300 task: In progress.");
  // The filter is shown under the header.
  assert.equal(progress.later.blocks[1].elements[0].text, "In progress");
  assert.match(progress.later.blocks[2].text.text, /\|Started>/);

  const several = await tasksCommand(t, "tasks -status=done,to-do", "CDEV", stored);
  assert.equal(several.later.text, "You have 2 aura300 tasks: Done, To do.");

  const none = await tasksCommand(t, "tasks -status=client-review", "CDEV", stored);
  assert.equal(none.later.text, "You have no aura300 tasks: Client review.");
  assert.equal(none.later.blocks[2].text.text, "You have no matching tasks.");
});

test("/cade tasks -due compares due dates with today, tomorrow or a date", async (t) => {
  const stored = {
    CDEV: [
      historyTask("100.1", { title: "Late", developers: ["UACTOR"], dueDate: dueIn(-1) }),
      historyTask("100.2", { title: "Today", developers: ["UACTOR"], dueDate: dueIn(0) }),
      historyTask("100.3", { title: "Tomorrow", developers: ["UACTOR"], dueDate: dueIn(1) }),
      historyTask("100.4", { title: "Someday", developers: ["UACTOR"], dueDate: "" }),
    ],
    // Immediate counts as today.
    CINC: [historyTask("100.5", { title: "Down", developers: ["UACTOR"], dueDate: "Immediate" })],
  };
  const titles = (later) =>
    later.blocks.filter((block) => block.type === "section").flatMap((block) =>
      [...block.text.text.matchAll(/\|([^>]+)>/g)].map(([, title]) => title),
    ).sort();
  for (const [filter, expected, label] of [
    ["-due<@today", ["Late"], "Due before today"],
    ["-due=@today", ["Down", "Today"], "Due today"],
    ["-due<=@today", ["Down", "Late", "Today"], "Due by today"],
    ["-due=@tomorrow", ["Tomorrow"], "Due tomorrow"],
    ["-due>@today", ["Tomorrow"], "Due after today"],
    [`-due>=${dueIn(1)}`, ["Tomorrow"], `Due from ${dueIn(1)}`],
    [`-due=${dueIn(-1).split("/").reverse().join("-")}`, ["Late"], `Due ${dueIn(-1)}`],
    ["-due=none", ["Someday"], "No due date"],
  ]) {
    const { later } = await tasksCommand(t, `tasks ${filter}`, "CDEV", stored, incidentEnv);
    assert.deepEqual(titles(later), expected, filter);
    assert.equal(later.blocks[1].elements[0].text, label, filter);
  }
});

test("/cade tasks options combine, in any order", async (t) => {
  const { later } = await tasksCommand(t, "tasks -due&lt;@today <@UBOB> dev -status=in-progress", "CDEV", {
    CDEV: [
      historyTask("100.1", { title: "Match", developers: ["UBOB"], status: "IN_PROGRESS", dueDate: dueIn(-2) }),
      historyTask("100.2", { title: "Not late", developers: ["UBOB"], status: "IN_PROGRESS", dueDate: dueIn(2) }),
      historyTask("100.3", { title: "Reviewing", reviewers: ["UBOB"], status: "IN_PROGRESS", dueDate: dueIn(-2) }),
      historyTask("100.4", { title: "To do", developers: ["UBOB"], dueDate: dueIn(-2) }),
    ],
  });
  assert.equal(later.text, "<@UBOB> has 1 aura300 developing task: In progress  ·  Due before today.");
  assert.equal(later.blocks[0].text.text, "Bob's aura300 tasks: Developing");
  assert.match(later.blocks[2].text.text, /\|Match>/);
});

test("/cade tasks says what's wrong with options it can't use", () => {
  for (const [text, start] of [
    ["-status=blocked", 'I don\'t know "-status=blocked" as a status filter.'],
    ["-status", 'I don\'t know "-status" as a status filter.'],
    ["-due=soon", 'I don\'t know "-due=soon" as a due date filter.'],
    ["-due=31/02/2027", 'I don\'t know "-due=31/02/2027" as a due date filter.'],
    ["-due<none", 'I don\'t know "-due&lt;none" as a due date filter.'],
    ["-mine", 'I don\'t know "-mine" as an option.'],
    ["-all dev", "`-all` shows everyone's tasks, so it can't take a role or a person."],
    ["-all <@UBOB>", "`-all` shows everyone's tasks, so it can't take a role or a person."],
    ["<@UBOB> <@UALICE>", "I can only look up one person at a time."],
    ["dev review", "I can only show one role at a time."],
  ]) {
    assert.equal(parseTaskFilters(text).error, `${start} ${TASKS_USAGE}`, text);
  }
  // A dash Slack made of a typed --, and upper case, are fine.
  assert.equal(parseTaskFilters("—ALL").all, true);
  assert.deepEqual(parseTaskFilters("--status=In-Progress").statuses, ["IN_PROGRESS"]);
});

test("today is in the configured time zone", () => {
  const lateEvening = new Date("2026-10-24T20:00:00Z");
  assert.equal(todayIn({}, lateEvening), "2026-10-24");
  assert.equal(todayIn({ TIMEZONE: "Asia/Colombo" }, lateEvening), "2026-10-25");
});

// /cade standup: the group's open tasks, one developer at a time, privately.

// A click on a standup message's button or menu, `action` as Slack sends it.
const standupClick = (action) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    response_url: RESPONSE_URL,
    container: { is_ephemeral: true },
    actions: [action],
  });

// The step's buttons, as [label, action_id].
const buttonsOf = (message) =>
  message.blocks.at(-1).elements.map((button) => [button.text.text, button.action_id]);

// Clicks the button labelled `label` in `message`, and returns the step shown
// in its place.
async function clickButton(t, message, label) {
  const button = message.blocks.at(-1).elements.find((element) => element.text.text === label);
  const sent = recordResponses(t);
  await send("/slack/interactions", standupClick({ action_id: button.action_id, value: button.value }));
  return sent.at(-1);
}

const standupTasks = () => ({
  CDEV: [
    historyTask("100.1", { title: "Bob's low", priority: "Low", developers: ["UBOB"] }),
    historyTask("100.2", { title: "Bob's urgent", priority: "Urgent", developers: ["UBOB"], status: "IN_PROGRESS" }),
    historyTask("100.3", { title: "Alice's", developers: ["UALICE"] }),
    historyTask("100.4", { title: "Mine", developers: ["UACTOR"], status: "IN_REVIEW" }),
    historyTask("100.5", { title: "Nobody's", testers: ["UALICE"] }),
    historyTask("100.6", { title: "Done already", developers: ["UALICE"], status: "DONE" }),
  ],
});

test("/cade standup starts with whoever runs it, then everyone by name, then tasks with no developer", async (t) => {
  const { now, later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  assert.equal(now, "");
  assert.equal(later.response_type, "ephemeral");
  assert.equal(later.blocks[0].text.text, "*Standup: <@UACTOR>*  ·  1 of 4");
  assert.equal(later.blocks[1].elements[0].text, "1 open task  ·  aura300");
  const [mine] = later.blocks.filter((block) => block.accessory);
  assert.match(mine.text.text, /\|Mine>  ·  :eyes: In review/);
  assert.equal(mine.accessory.type, "static_select");
  assert.equal(mine.accessory.initial_option.value, "IN_REVIEW");
  assert.deepEqual(buttonsOf(later), [["Next: Alice ▶", "standup:next"], ["End", "standup:end"]]);

  const alice = await clickButton(t, later, "Next: Alice ▶");
  assert.equal(alice.replace_original, true);
  assert.equal(alice.blocks[0].text.text, "*Standup: <@UALICE>*  ·  2 of 4");
  // Done tasks are left out.
  assert.equal(alice.blocks[1].elements[0].text, "1 open task  ·  aura300");
  assert.deepEqual(buttonsOf(alice), [["◀ Back", "standup:back"], ["Next: Bob ▶", "standup:next"], ["End", "standup:end"]]);

  const bob = await clickButton(t, alice, "Next: Bob ▶");
  // Most urgent first.
  const titles = bob.blocks.filter((block) => block.accessory).map((block) => block.text.text.match(/\|([^>]+)>/)[1]);
  assert.deepEqual(titles, ["Bob's urgent", "Bob's low"]);
  // Each menu has its own action_id, as Slack requires.
  assert.deepEqual(
    bob.blocks.filter((block) => block.accessory).map((block) => block.accessory.action_id),
    ["standup:status:0", "standup:status:1"],
  );

  const nobody = await clickButton(t, bob, "Next: No developer ▶");
  assert.equal(nobody.blocks[0].text.text, "*Standup: no developer yet*  ·  4 of 4");
  const [unassigned] = nobody.blocks.filter((block) => block.accessory);
  assert.match(unassigned.text.text, /\|Nobody's>/);
  assert.equal(unassigned.accessory.type, "users_select");
  assert.deepEqual(buttonsOf(nobody), [["◀ Back", "standup:back"], ["Finish", "standup:end"]]);

  const back = await clickButton(t, nobody, "◀ Back");
  assert.equal(back.blocks[0].text.text, "*Standup: <@UBOB>*  ·  3 of 4");
});

test("a standup's status menu sets the status and tells the task's thread", async (t) => {
  const { calls, later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  const [mine] = later.blocks.filter((block) => block.accessory);
  calls.length = 0;
  const sent = recordResponses(t);
  await send(
    "/slack/interactions",
    standupClick({ action_id: mine.accessory.action_id, block_id: mine.block_id, selected_option: { value: "IN_TESTING" } }),
  );
  assert.equal((await savedTask("CDEV", "100.4")).status, "IN_TESTING");
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.4");
  assert.equal(post.text, "<@UACTOR> set the status to :test_tube: In testing.");
  // The same step again, showing the change.
  assert.equal(sent.at(-1).replace_original, true);
  assert.equal(sent.at(-1).blocks[0].text.text, "*Standup: <@UACTOR>*  ·  1 of 4");
  assert.equal(sent.at(-1).blocks.find((block) => block.accessory).accessory.initial_option.value, "IN_TESTING");
});

test("/cade standup -unassigned goes through tasks with no developer, one at a time, to assign them", async (t) => {
  const { calls, later } = await tasksCommand(t, "standup -unassigned", "CDEV", {
    CDEV: [
      historyTask("100.1", { title: "Low", priority: "Low" }),
      historyTask("100.2", { title: "Urgent", priority: "Urgent" }),
      historyTask("100.3", { title: "Taken", developers: ["UBOB"] }),
    ],
  });
  assert.equal(later.blocks[0].text.text, "*Unassigned aura300 tasks*  ·  1 of 2");
  const first = later.blocks.find((block) => block.accessory);
  assert.match(first.text.text, /\|Urgent>/);
  assert.deepEqual(buttonsOf(later), [["Skip ▶", "standup:next"], ["End", "standup:end"]]);

  calls.length = 0;
  const sent = recordResponses(t);
  await send(
    "/slack/interactions",
    standupClick({ action_id: first.accessory.action_id, block_id: first.block_id, selected_user: "UALICE" }),
  );
  assert.deepEqual((await savedTask("CDEV", "100.2")).people.developer, ["UALICE"]);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.2");
  assert.equal(post.text, "<@UACTOR> assigned this to <@UALICE>.\n<@UALICE> could you pick this up when you get a chance? Thanks!");
  // Assigned, it leaves the walk: the next one takes its place.
  const next = sent.at(-1);
  assert.equal(next.blocks[0].text.text, "*Unassigned aura300 tasks*  ·  1 of 1");
  assert.match(next.blocks.find((block) => block.accessory).text.text, /\|Low>/);
  assert.deepEqual(buttonsOf(next), [["Finish", "standup:end"]]);

  const last = next.blocks.find((block) => block.accessory);
  await send(
    "/slack/interactions",
    standupClick({ action_id: last.accessory.action_id, block_id: last.block_id, selected_user: "UBOB" }),
  );
  assert.equal(sent.at(-1).text, "Every open aura300 task has a developer. Nice!");
});

test("End and Finish remove the standup", async (t) => {
  const { later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  const sent = recordResponses(t);
  await send("/slack/interactions", standupClick({ action_id: "standup:end", value: "end" }));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
  assert.ok(later);
});

test("/cade standup says so when there's nothing to go through, and takes only -unassigned", async (t) => {
  const empty = await tasksCommand(t, "standup", "CDEV", {});
  assert.equal(empty.later.text, "No one has open aura300 tasks right now.");

  const wrong = await tasksCommand(t, "standup everyone", "CDEV", {});
  assert.equal(
    JSON.parse(wrong.now).text,
    'I don\'t know "everyone" as an option. Send `/cade standup` to go through everyone\'s tasks, or `/cade standup -unassigned` for those with no developer.',
  );
  // It's the team's, so it runs in its channels.
  const outside = await tasksCommand(t, "standup", "CEXTERNAL", {});
  assert.equal(JSON.parse(outside.now).text, "That one works with `/cade standup` in <#CDEV>.");
});

test("/cade tasks -unassigned lists open tasks with no developer", async (t) => {
  const { later } = await tasksCommand(t, "tasks -unassigned", "CDEV", standupTasks());
  assert.equal(later.text, "There is 1 open aura300 unassigned task.");
  assert.equal(later.blocks[0].text.text, "Unassigned aura300 tasks");
  assert.match(later.blocks[1].text.text, /^\*To do \(1\)\*\n• <[^|]+\|Nobody's>.*<@UALICE>$/);
  assert.equal(parseTaskFilters("-unassigned <@UBOB>").error.split(" Try ")[0], "`-unassigned` shows tasks with no developer, so it can't take a role or a person.");
  assert.equal(parseTaskFilters("-all -unassigned").error.split(" Try ")[0], "Use `-all` or `-unassigned`, not both.");
});

// `@Cade release`: some of a requirement task's PRs sent to the client.

// The requirement and its task with `prs` linked and `releases` sent already
// (their ids are 1, 2, … in order).
const releaseThreads = (prs, releases = [], status = "IN_PROGRESS") => {
  const requirement = requirementRoot({ task: true });
  const task = requirementTask(status);
  task.task.prs = prs;
  task.task.releases = releases;
  task.task.people.developer = ["UDEV"];
  return { stored: [requirement, task] };
};

const releaseSubmission = (prs, note = "Login and sign-up") =>
  interaction({
    type: "view_submission",
    user: { id: "UDEV" },
    view: {
      callback_id: "release",
      private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", promptTs: "100.7" }),
      state: {
        values: {
          prs: { value: { selected_options: prs.map((value) => ({ value })) } },
          note: { value: { value: note } },
        },
      },
    },
  });

const releaseClick = (actionId, id = 1) =>
  interaction({
    type: "block_actions",
    user: { id: "UCLIENT" },
    channel: { id: "CEXTERNAL" },
    message: {
      ts: "200.9",
      thread_ts: "200.1",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "<@UDEV> sent these PRs for your approval" } }],
    },
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.1", id }) }],
  });

const inReview = (prs) => ({ prs, note: "Login and sign-up", status: "PENDING_APPROVAL", sentBy: "UDEV" });

// What's shown of a task's releases.
const releasesOf = async () =>
  (await savedTask()).releases.map(({ prs, note, status, sentBy, decidedBy }) => ({ prs, note, status, sentBy, decidedBy }));

// The PR sections of the root message at `ts`, as last rendered: the
// requirement's released and pending PRs, or the task's PRs.
const shownPrs = (calls, ts = "200.1") => {
  const { args } = calls.findLast((call) => call.method === "chat.update" && call.args.ts === ts);
  return allBlocks(args)
    .map((block) => blockText(block) ?? "")
    .flatMap((text) => text.split("\n"))
    .filter((text) => /^\*(Approved|Pending approval|Pending):\*/.test(text))
    .join("\n");
};
const rootPrs = (calls) => shownPrs(calls);

test("@Cade release needs a requirement task with PRs not sent yet", async (t) => {
  const cases = [
    [{ stored: [ownTask()] }, /doesn't have a client thread/],
    [releaseThreads([]), /There aren't any PRs to send yet/],
    [releaseThreads([PR], [inReview([PR])]), /already with the client/],
  ];
  for (const [responses, reply] of cases) {
    const calls = mockSlack(t, responses);
    await send("/slack/events", threadEvent("<@UBOT> release"));
    assert.match(calls.at(-1).args.text, reply);
  }
});

test("@Cade release offers a button that opens the form with the unsent PRs", async (t) => {
  const calls = mockSlack(t, releaseThreads([PR, MR], [inReview([PR])]));
  await send("/slack/events", threadEvent("<@UBOT> deliver"));
  const button = calls.at(-1).args.blocks[0].elements[0];
  assert.equal(button.action_id, "release:open");

  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "T1",
      user: { id: "UDEV" },
      channel: { id: "CDEV" },
      message: { ts: "100.7", thread_ts: "100.1" },
      actions: [{ action_id: "release:open", value: button.value }],
    }),
  );
  const view = calls.at(-1).args.view;
  assert.equal(view.callback_id, "release");
  assert.deepEqual(JSON.parse(view.private_metadata), { channel: "CDEV", ts: "100.1", promptTs: "100.7" });
  assert.deepEqual(view.blocks[0].element.options, [
    { text: { type: "plain_text", text: "web-app/118" }, value: MR },
  ]);
  assert.equal(view.blocks[0].element.type, "checkboxes");
});

test("the release form needs PRs and what they complete", async (t) => {
  mockSlack(t, releaseThreads([PR]));
  const response = await send("/slack/interactions", releaseSubmission([], ""));
  assert.deepEqual((await response.json()).errors, {
    prs: "Please choose at least one PR.",
    note: "Please say what these PRs complete.",
  });
});

test("sending PRs asks the client in the requirement thread and says so in the task's", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR]),
    "chat.postMessage": { ts: "200.9" },
    "chat.getPermalink": { permalink: "https://slack.example/release" },
  });
  await send("/slack/interactions", releaseSubmission([PR]));

  assert.deepEqual(await releasesOf(), [{ ...inReview([PR]), decidedBy: null }]);
  // The release in review, named by what it completes, then the PRs not
  // sent, the same on the requirement's card and the task's.
  const shown = `*Pending approval:* Login and sign-up (<${PR}|cade/42>)\n*Pending:* <${MR}|web-app/118>`;
  assert.equal(rootPrs(calls), shown);
  assert.equal(shownPrs(calls, "100.1"), shown);

  const ask = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(ask.channel, "CEXTERNAL");
  assert.equal(ask.thread_ts, "200.1");
  assert.equal(ask.blocks[0].text.text, `<@UDEV> sent these PRs for your approval: <${PR}|cade/42>\n*Completes:* Login and sign-up`);
  assert.match(ask.blocks[1].text.text, /^<@UCREATOR>, could you take a look and approve them/);
  assert.deepEqual(ask.blocks[2].elements.map((button) => button.action_id), ["release:approve", "release:reject"]);

  const told = calls.at(-1);
  assert.equal(told.method, "chat.update");
  assert.equal(told.args.ts, "100.7");
  assert.equal(
    told.args.text,
    `<@UDEV> sent <${PR}|cade/42> to the client for approval in <https://slack.example/release|the requirement thread>. I'll let you know when they reply.\n*Completes:* Login and sign-up`,
  );
});

test("Approve marks the PRs approved and tells both threads", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR], [inReview([PR])]),
    "chat.getPermalink": { permalink: "https://slack.example/release" },
  });
  await send("/slack/interactions", releaseClick("release:approve"));

  assert.deepEqual(await releasesOf(), [{ ...inReview([PR]), status: "APPROVED", decidedBy: "UCLIENT" }]);
  const shown = `*Approved:* Login and sign-up (<${PR}|cade/42>)\n*Pending:* <${MR}|web-app/118>`;
  assert.equal(rootPrs(calls), shown);
  assert.equal(shownPrs(calls, "100.1"), shown);

  const told = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(told.channel, "CDEV");
  assert.equal(told.thread_ts, "100.1");
  assert.equal(
    told.text,
    `<@UDEV>, good news! <@UCLIENT> approved <${PR}|cade/42> in <https://slack.example/release|the requirement thread>.`,
  );
  const decided = calls.at(-1).args;
  assert.equal(decided.ts, "200.9");
  assert.equal(
    decided.text,
    `<@UDEV> sent these PRs for your approval\n<@UCLIENT> approved them. Thanks, <@UDEV>!`,
  );
});

test("Not approve removes the release and tells both threads", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR], [inReview([PR])]),
    "chat.getPermalink": { permalink: "https://slack.example/release" },
  });
  await send("/slack/interactions", releaseClick("release:reject"));

  // It is kept as turned down, and no longer shown.
  assert.deepEqual(await releasesOf(), []);
  const rejected = await DB.prepare("SELECT status, decided_by FROM releases").first();
  assert.deepEqual({ ...rejected }, { status: "NOT_APPROVED", decided_by: "UCLIENT" });
  const shown = `*Pending:* <${PR}|cade/42>, <${MR}|web-app/118>`;
  assert.equal(rootPrs(calls), shown);
  assert.equal(shownPrs(calls, "100.1"), shown);
  const told = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(told.channel, "CDEV");
  assert.match(told.text, /^<@UDEV>, <@UCLIENT> didn't approve .*send them again with `@Cade release`\.$/);
  assert.match(calls.at(-1).args.text, /\n<@UCLIENT> didn't approve them\. <@UDEV>, have a look at this thread/);
});

test("a release decided already, or gone, is not applied again", async (t) => {
  const released = { ...inReview([PR]), status: "APPROVED" };
  const rejected = { ...inReview([PR]), status: "NOT_APPROVED" };
  for (const [releases, outcome] of [[[released], /already approved/], [[rejected], /aren't waiting for approval anymore/], [[], /aren't waiting for approval anymore/]]) {
    const calls = mockSlack(t, releaseThreads([PR], releases));
    await send("/slack/interactions", releaseClick("release:reject"));
    assert.deepEqual(calls.map((call) => call.method), ["chat.update"]);
    assert.match(calls[0].args.text, outcome);
  }
});

test("Client review after a release sends the remaining PRs, and both threads say so", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR], [{ ...inReview([PR]), status: "APPROVED" }], "IN_TESTING"),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send("/slack/events", threadEvent("<@UBOT> status client review"));

  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
  assert.match(review.blocks[0].text.text, new RegExp(`\\*Remaining PRs:\\* <${MR}\\|web-app/118>\\n`));
  const note = calls.at(-1).args;
  assert.equal(note.thread_ts, "100.1");
  assert.equal(
    note.text,
    `I've asked the client to review the remaining PRs, <${MR}|web-app/118>, in <https://slack.example/source|the requirement thread>.`,
  );
});

test("a Done requirement shows every release as approved", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR], [inReview([PR])], "CLIENT_REVIEW"),
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  await send("/slack/interactions", reviewClick("status:approve"));
  // The release in review was approved with the rest.
  assert.equal(
    rootPrs(calls),
    `*Approved:* Login and sign-up (<${PR}|cade/42>)  ·  The rest of the requirement (<${MR}|web-app/118>)`,
  );
});

test("a Done requirement after a release lists the rest as its last release", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR], [{ ...inReview([PR]), status: "APPROVED" }], "CLIENT_REVIEW"),
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  await send("/slack/interactions", reviewClick("status:approve"));
  const shown = `*Approved:* Login and sign-up (<${PR}|cade/42>)  ·  The rest of the requirement (<${MR}|web-app/118>)`;
  assert.equal(rootPrs(calls), shown);
  assert.equal(shownPrs(calls, "100.1"), shown);
});

// A message about a requirement posted on its own in the external channel,
// at 400.1, and `@Cade move` replied in its thread.
const strayMessage = { ts: "400.1", user: "UCLIENT", text: "Also add a CSV export\nwith totals" };
const moveEvent = (overrides = {}) =>
  threadEvent("<@UBOT> move", { channel: "CEXTERNAL", user: "UCLIENT", ts: "400.2", thread_ts: "400.1", ...overrides });

// A Slack API where conversations.replies gives `root` as the thread's root,
// posts get a ts in their thread, and permalinks end with the message's ts.
const moveSlack = (root = strayMessage) => ({
  "conversations.replies": { messages: root ? [root] : [] },
  "chat.postMessage": (args) => ({ ts: `${args.thread_ts.split(".")[0]}.9` }),
  "chat.getPermalink": (args) => ({ permalink: `https://slack.example/${args.message_ts}` }),
});

// A requirement in the external channel at `ts`.
const otherRequirement = (ts, fields) => {
  const record = requirementRoot();
  record.ts = ts;
  Object.assign(record.requirement, fields);
  return record;
};

// Clicks Move on the picker, with `picked` (a requirement's ts) chosen.
const moveClick = (picked, actionId = "move:confirm") =>
  interaction({
    type: "block_actions",
    user: { id: "UCLIENT" },
    channel: { id: "CEXTERNAL" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    state: { values: { "move:requirement": { "move:pick": { selected_option: picked ? { value: picked } : null } } } },
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CEXTERNAL", ts: "400.1" }) }],
  });

test("@Cade move privately offers the channel's open requirements and incidents", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack(),
    stored: [
      requirementRoot(),
      otherRequirement("200.7", { title: "Old report", status: "DONE" }),
      otherRequirement("200.8", { title: "Checkout is down", incident: true }),
    ],
  });
  await send("/slack/events", moveEvent());
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postEphemeral"]);
  const picker = calls[1].args;
  assert.equal(picker.user, "UCLIENT");
  assert.equal(picker.thread_ts, "400.1");
  const options = picker.blocks[1].elements[0].options;
  assert.deepEqual(
    options.map((option) => [option.text.text, option.value]).sort(),
    [["Incident · Checkout is down", "200.8"], ["Requirement · Export reports", "200.1"]],
  );
  assert.deepEqual(picker.blocks[2].elements.map((button) => button.action_id), ["move:confirm", "move:cancel"]);
});

test("@Cade move says why it can't move a message", async (t) => {
  for (const [event, stored, root, text] of [
    [moveEvent({ ts: "400.1", thread_ts: undefined }), [requirementRoot()], strayMessage, "Reply `@Cade move` in the thread of the message you want to move."],
    [moveEvent({ thread_ts: "200.1" }), [requirementRoot()], strayMessage, "This is already a requirement thread."],
    [moveEvent(), [requirementRoot()], { ts: "400.1", bot_id: "BOTHER", text: "Deploy done" }, "I can only move people's messages."],
    [moveEvent(), [otherRequirement("200.1", { status: "DONE" })], strayMessage, "There are no open requirements here. Start one with `/cade requirement`."],
  ]) {
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    await send("/slack/events", event);
    const reply = calls.at(-1);
    assert.equal(reply.method, "chat.postMessage", text);
    assert.equal(reply.args.text, text);
  }
});

test("Move copies the message into the requirement thread and points the original there", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [requirementRoot()] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick("200.1"));

  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args);
  assert.deepEqual(
    posts.map((post) => [post.thread_ts, post.text]),
    [
      ["200.1", "Moved from <@UCLIENT>'s <https://slack.example/400.1|message>:\n> Also add a CSV export\n> with totals"],
      ["400.1", "<@UCLIENT> moved this message to the requirement thread <https://slack.example/200.9|Export reports>. Please carry on the conversation there."],
    ],
  );
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Move says an incident thread, and that a message's attachments stay behind", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack({ ...strayMessage, files: [{ id: "F1" }] }),
    stored: [otherRequirement("200.8", { title: "Checkout is down", incident: true })],
  });
  recordResponses(t);
  await send("/slack/interactions", moveClick("200.8"));
  const [copy, note] = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.text);
  assert.match(copy, /\n_It has attachments: see the original\._$/);
  assert.match(note, /moved this message to the incident thread <https:\/\/slack\.example\/200\.9\|Checkout is down>\./);
});

test("Move moves nothing if the requirement was closed or the message deleted since", async (t) => {
  for (const [stored, root, text] of [
    [[otherRequirement("200.1", { status: "DONE" })], strayMessage, "That requirement has been closed or deleted since, so I didn't move anything."],
    [[], strayMessage, "That requirement has been closed or deleted since, so I didn't move anything."],
    [[requirementRoot()], null, "That message has been deleted since, so there's nothing to move."],
  ]) {
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    const responses = recordResponses(t);
    await send("/slack/interactions", moveClick("200.1"));
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"), text);
    assert.deepEqual(responses, [{ response_type: "ephemeral", replace_original: true, text }]);
  }
});

test("Move without a pick asks for one, and Cancel removes the picker", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [requirementRoot()] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick(null));
  assert.deepEqual(calls.map((call) => [call.method, call.args.text]), [
    ["chat.postEphemeral", "Pick a requirement first, then press Move."],
  ]);
  await send("/slack/interactions", moveClick(null, "move:cancel"));
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
  // Choosing from the menu does nothing by itself.
  await send("/slack/interactions", moveClick("200.1", "move:pick"));
  assert.equal(calls.length, 1);
});
