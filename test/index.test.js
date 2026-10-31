import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import worker from "../src/index.js";
import { parseDate } from "../src/commands/details.js";
import { parseMessage } from "../src/commands/parse.js";
import { getTask, insertRelease, insertTask, markTaskDeleted, putTask } from "../src/db.js";
import { changeTask } from "../src/commands/changes.js";
import { editForm } from "../src/commands/edit.js";
import { changeLog, changeRequests } from "../src/notify.js";
import { formatDueDate } from "../src/tasks.js";
import { parseTaskFilters, todayIn } from "../src/commands/tasks.js";
import { fakeD1 } from "./d1.js";

const SIGNING_SECRET = "test-signing-secret";
// The Google web app, for each group's Sheet and Doc; the acme group's doc
// and its Summary tab.
const GOOGLE_URL = "https://script.google.com/macros/s/test/exec";
const DOC_ID = "1AcmeDocAcmeDocAcmeDocAcmeDoc";
const DOC_TAB = `https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`;
// Every environment shares this database; it is emptied for each test, and
// again by mockSlack.
const DB = fakeD1();
beforeEach(() => DB.reset());
const env = {
  DB,
  // Off unless turned on; most tests are of both.
  ACTIVE_TASKS_PINNING: "on",
  SUMMARY_CANVAS: "on",
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  CHANNEL_PAIRS: [
    { name: "acme", tasks: "CDEV" },
    { name: "test", tasks: "CTESTDEV" },
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

// A message's blocks, then those of its attachment: a task's message has
// only its title outside the attachment that gives it a priority strip.
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

// Stores a task record ({ channel, ts, task }) in the database. Its
// `releases` are stored too, in order.
async function store(record) {
  await putTask(env, record.channel, record.ts, record.task);
  for (const release of record.task.releases ?? []) await insertRelease(env, record.channel, record.ts, release);
}
let seeded = Promise.resolve();

// `record`, moved to `channel`.
const inChannel = (channel, record) => ({ ...record, channel });

// The task as stored, after a test's commands.
const savedTask = (channel = "CDEV", ts = "100.1") => getTask(env, channel, ts);

// Replaces fetch with a fake Slack API, with an empty database holding just
// `responses.stored` (task records). `responses` maps a
// method name to its result; every call is recorded with its decoded arguments. Link preview
// settings are recorded as `previews` rather than with the arguments. Requests to the
// Google web app are recorded with their JSON body: a Sheet row as the
// "sheet" method, answered by `responses.sheet`, and the Doc's as "doc",
// answered by `responses.doc`.
function mockSlack(t, { stored = [], ...responses } = {}) {
  DB.reset();
  seeded = Promise.all(stored.map(store));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    // Answers through a click's or command's response_url, unless a test
    // records them itself (see recordResponses).
    if (url === RESPONSE_URL) {
      calls.push({ method: "respond", args: JSON.parse(init.body) });
      return new Response("ok");
    }
    if (url === GOOGLE_URL) {
      const body = JSON.parse(init.body);
      if (body.action === "sheet.row") {
        calls.push({ method: "sheet", args: body });
        return Response.json(responses.sheet ?? { ok: true });
      }
      calls.push({ method: "doc", args: body });
      const reply = typeof responses.doc === "function" ? responses.doc(body) : responses.doc;
      return Response.json(reply ?? { ok: true, url: DOC_TAB, elements: [] });
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

// The track form, submitted from `origin`: /cade task in the dev channel,
// to begin with.
const submission = (values, origin = { channel: "CDEV" }) => ({
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

// The task at CDEV/100.1 as stored. Each role lists its people's user IDs.
const storedTask = ({ owners = [], reviewers = [], testers = [] } = {}) => ({
  channel: "CDEV",
  ts: "100.1",
  task: {
    title: "Fix login",
    priority: "High",
    status: "TODO",
    dueDate: "31/10/2026",
    people: { owner: owners, reviewer: reviewers, tester: testers },
    prs: [],
    createdBy: "UCREATOR",
    completedAt: "",
  },
});

// The same, for tests that name it as the team's own.
const ownTask = storedTask;

// An incident's task at CDEV/100.1: urgent, due immediately.
const incidentTask = (people) => {
  const record = storedTask(people);
  Object.assign(record.task, { title: "Checkout is down", priority: "Urgent", dueDate: "Immediate", incident: true });
  return record;
};

// Posting a root message in a dev channel creates the task; other posts are
// replies. The new task links as /p100.
const createdTask = {
  "chat.postMessage": (args) =>
    args.channel.endsWith("DEV") && !args.thread_ts ? { channel: args.channel, ts: "100.1" } : { ts: "300.1" },
  "chat.getPermalink": { permalink: "https://slack.example/p100" },
};

// The calls besides those keeping the group's summary canvas, which a new
// task makes (see summary.js).
const withoutSummary = (calls) => calls.filter((call) => !/^(auth\.test|conversations\.canvases\.|canvases\.)/.test(call.method));

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

test("modal submission without a due date leaves it out", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" })),
  );
  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV");
  assert.equal(blockText(allBlocks(post.args)[1]), ":memo: To do");
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
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.postEphemeral"]);
  assert.equal(calls[1].args.user, "UCREATOR");
  assert.equal(calls[1].args.channel, "CDEV");
  assert.match(calls[1].args.text, /^Sorry, I couldn't post the task "Fix login" just now\. I'll try again in a few minutes\.$/);
  // The task is stored, waiting to be posted.
  const row = await DB.prepare("SELECT ts, post_attempts, origin FROM tasks").first();
  assert.equal(row.ts, null);
  assert.equal(row.post_attempts, 1);
  assert.deepEqual(JSON.parse(row.origin), {});
});

test("@Cade assign adds people to a role on the root message", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE"], testers: ["UTESS"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB> <@UALICE|alice>"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add", "chat.postMessage"],
  );
  const update = calls[0].args;
  assert.equal(update.ts, "100.1");
  assert.equal(
    footerLines(update)[0],
    "Owner <@UALICE>, <@UBOB>  ·  Test <@UTESS>",
  );
  const task = await savedTask();
  assert.deepEqual(task.people, { owner: ["UALICE", "UBOB"], reviewer: [], tester: ["UTESS"] });
  assert.equal(task.dueDate, "31/10/2026");
  // The card shows who is on it, so the command gets a ✅ and they're asked.
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(calls[2].args, {
    channel: "CDEV",
    thread_ts: "100.1",
    // @alice was an owner already, so isn't asked again.
    text: "<@UBOB>, could you pick this up when you get a chance? Thanks!",
  });
});

test("@Cade assign works for each role, in any word order", async (t) => {
  for (const [text, role, reply] of [
    // No PR yet, so there's nothing to ask the reviewer.
    ["<@UBOT> assign reviewer <@UBOB>", "reviewer", undefined],
    // Not In testing yet, so nothing to ask the tester either.
    ["<@UBOT> assign tester <@UBOB>", "tester", undefined],
    ["<@UBOT> assign <@UBOB> as Tester", "tester", undefined],
    ["<@UBOT> assign owners <@UBOB>", "owner", "<@UBOB>, could you pick this up when you get a chance? Thanks!"],
  ]) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual((await savedTask()).people[role], ["UBOB"], text);
    assert.equal(calls[1].args.name, "white_check_mark", text);
    assert.equal(calls.find((call) => call.method === "chat.postMessage")?.args.text, reply, text);
  }
});

test("people are asked only when there's something for them to do now", async (t) => {
  const task = (status, prs = [], releases = []) => {
    const root = storedTask();
    Object.assign(root.task, { status, prs, releases });
    return root;
  };
  const ask = (role) =>
    ({
      owner: "<@UBOB>, could you pick this up when you get a chance? Thanks!",
      reviewer: `<@UBOB>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
      tester: "<@UBOB>, could you give this a test when you get a chance? Thanks!",
    })[role];
  for (const [role, root, asked] of [
    ["owner", task("TODO"), true],
    ["owner", task("DONE"), false],
    // Reviewers review the PRs not yet sent for approval.
    ["reviewer", task("IN_REVIEW", [PR]), true],
    ["reviewer", task("IN_REVIEW", [PR, MR], [{ prs: [MR], note: "Search", status: "PENDING_APPROVAL", sentBy: "UACTOR" }]), true],
    ["reviewer", task("IN_REVIEW", [PR], [{ prs: [PR], note: "All", status: "PENDING_APPROVAL", sentBy: "UACTOR" }]), false],
    // Testers test it once it's In testing.
    ["tester", task("IN_REVIEW"), false],
    ["tester", task("IN_TESTING"), true],
  ]) {
    const calls = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadEvent(`<@UBOT> assign ${role} <@UBOB>`));
    const label = `${role} on ${root.task.status} with ${root.task.prs.length} PRs`;
    assert.equal(calls.find((call) => call.method === "chat.postMessage")?.args.text, asked ? ask(role) : undefined, label);

    // Those removed are told only when they would have been asked.
    root.task.people[role] = ["UBOB"];
    const again = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadEvent(`<@UBOT> unassign ${role} <@UBOB>`));
    const note = `<@UBOB>, there's no need to ${{ owner: "work on", reviewer: "review", tester: "test" }[role]} this anymore. Thanks!`;
    assert.equal(again.find((call) => call.method === "chat.postMessage")?.args.text, asked ? note : undefined, label);
  }
});

test("@Cade assign takes short words for each role", async (t) => {
  for (const [text, role] of [
    ["<@UBOT> assign owner <@UBOB>", "owner"],
    ["<@UBOT> assign devs <@UBOB>", "owner"],
    ["<@UBOT> assign review <@UBOB>", "reviewer"],
    ["<@UBOT> assign test <@UBOB>", "tester"],
    ["<@UBOT> assign qa <@UBOB>", "tester"],
  ]) {
    mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual((await savedTask()).people[role], ["UBOB"], text);
  }
});

test("@Cade unassign with a role removes people from that role only", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE", "UBOB"], reviewers: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign owner <@UALICE>"));
  const { people } = await savedTask();
  assert.deepEqual(people.owner, ["UBOB"]);
  assert.deepEqual(people.reviewer, ["UALICE"]);
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.equal(calls[2].args.text, "<@UALICE>, there's no need to work on this anymore. Thanks!");
});

test("@Cade unassign without a role removes people from every role", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE", "UBOB"], reviewers: ["UALICE"], testers: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign <@UALICE>"));
  assert.deepEqual((await savedTask()).people, { owner: ["UBOB"], reviewer: [], tester: [] });
  assert.equal(
    footerLines(calls[0].args)[0],
    "Owner <@UBOB>",
  );
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.equal(calls[2].args.text, "<@UALICE>, there's no need to work on this anymore. Thanks!");
});

test("@Cade status updates the task's status", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add"],
  );
  const update = calls[0].args;
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.deepEqual((await savedTask()).people.owner, ["UALICE"]);
  assert.match(blockText(allBlocks(update)[1]), /^:arrow_forward: In progress  ·/);
  // A typed status gets a ✅ on the command, not a reply.
  assert.deepEqual(calls[1].args, { channel: "CDEV", timestamp: "100.5", name: "white_check_mark" });
});

test("@Cade status DONE unpins the task and reopening pins it again", async (t) => {
  let calls = mockSlack(t, {
    stored: [storedTask()],
  });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "pins.remove", "reactions.add"]);
  assert.deepEqual(calls[1].args, { channel: "CDEV", timestamp: "100.1" });

  const done = storedTask();
  done.task.status = "DONE";
  calls = mockSlack(t, { stored: [done] });
  await send("/slack/events", threadEvent("<@UBOT> status IN_TESTING"));
  assert.deepEqual(
    calls.filter((call) => call.method === "pins.add").map((call) => call.args.channel),
    ["CDEV"],
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
  // Then the group's summary canvas is made (see summary.js).
  assert.deepEqual(calls.slice(0, 3), ["chat.postMessage", "chat.getPermalink", "pins.add"]);
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
    // Nothing is posted in the thread but the ✅.
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"), input);
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

test("@Cade delete and @Cade remove point to /cade remove", async (t) => {
  for (const name of ["delete", "remove"]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(`<@UBOT> ${name}`));
    assert.equal(calls.at(-1).args.text, "That one's a slash command: try `/cade remove <link>`.", name);
    assert.ok(await savedTask(), name);
  }
});
const deleteRequest = JSON.stringify({ kind: "task", channel: "CDEV", ts: "100.1" });

const deleteClick = (actionId, user) =>
  interaction({
    type: "block_actions",
    user: { id: user },
    message: { ts: "100.9" },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: deleteRequest }],
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
  // Whoever confirmed sees the task go: nothing is posted, not even
  // privately.
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("deleting a task posts nothing, and only answers whoever asked", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.delete", "respond"]);
  assert.deepEqual(calls.at(-1).args, { response_type: "ephemeral", replace_original: true, text: "Done, it's gone." });
});

test("@Cade assign in a thread that is not a task says so", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage"],
  );
  assert.equal(calls[0].args.text, "Hmm, I'm not tracking a task in this thread.");
});

test("commands outside the dev channels point to them", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "COTHER" }));
  assert.equal(calls[0].args.text, "That one works with `@Cade assign owner @person` in a task thread in <#CDEV> or <#CTESTDEV>.");

  calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> task", { channel: "COTHER" }));
  assert.equal(calls[0].args.text, "That one works with `@Cade task` in <#CDEV> or <#CTESTDEV>.");

  calls = mockSlack(t);
  const reply = await (await send("/slack/commands", slash("task", "COTHER"))).json();
  assert.equal(calls.length, 0);
  assert.equal(reply.response_type, "ephemeral");
  assert.equal(reply.text, "That one works with `/cade task` in <#CDEV> or <#CTESTDEV>.");
});
test("tasks tracked in the test channel go to the test channel", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "High" }, { channel: "CTESTDEV" })));
  assert.equal(calls[0].args.channel, "CTESTDEV");
  assert.ok(calls.some((call) => call.method === "pins.add" && call.args.channel === "CTESTDEV"));
});

test("thread commands work in the test tasks channel", async (t) => {
  const calls = mockSlack(t, {
    stored: [inChannel("CTESTDEV", storedTask())],
  });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "CTESTDEV" }));
  assert.equal(calls[0].args.channel, "CTESTDEV");
  assert.equal(calls[1].args.channel, "CTESTDEV");
  assert.deepEqual((await savedTask("CTESTDEV")).people.owner, ["UBOB"]);
});

test("a missing CHANNEL_PAIRS setting is reported", async (t) => {
  const calls = mockSlack(t);
  const pending = [];
  const body = threadEvent("<@UBOT> assign owner <@UBOB>");
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
    // The slash commands, the messages sent in a thread, the shortcuts, and
    // the admin commands, each on its own.
    assert.deepEqual(calls[0].args.text.split("\n"), [
      "Here's what I can do:",
      "*Slash commands*, at the top of a channel:",
      "`/cade task` · `/cade incident` · `/cade retry <link>` · `/cade export <link>` · `/cade home` · `/cade tasks` · `/cade standup` · `/cade syncup` · `/cade brief` · `/cade debrief`",
      "*Messages*, sent in a thread:",
      "• In a message's thread: `@Cade task` · `@Cade incident` · `@Cade move [message link]`",
      "• In a task's thread: `@Cade assign owner @person` · `@Cade unassign owner @person` · `@Cade status in review` · `@Cade priority high` · `@Cade due 31/12/2026` · `@Cade pr add <link>` · `@Cade pr remove <link>` · `@Cade release` · `@Cade archive`",
      "*On any message*: ⋯ → More actions → New task, New incident or Move to existing.",
      "*Admin commands*, for tidying up: `/cade remove <link>` · `/cade replace <link> <text>` · `/cade resync <link>` · `/cade resync summary`",
      "Send `@Cade help` or `/cade help` any time to see this again.",
    ]);
  }
});

test("ignores messages that do not start with @Cade, bots, edits and retries", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("looks good, assign it later"));
  await send("/slack/events", threadEvent("cade is great"));
  await send("/slack/events", threadEvent("cade assign <@UBOB>"));
  await send("/slack/events", threadEvent("/cade assign <@UBOB>"));
  await send("/slack/events", threadEvent("hi <@UBOT> assign <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { bot_id: "B1" }));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { subtype: "message_changed" }));
  await send("/slack/events", threadEvent("<@UOTHER> assign <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"), {
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
  assert.equal(parseMessage({ text: "@Cade task" }, "UBOT"), null);
  assert.equal(parseMessage({ text: "<@UOTHER> track" }, "UBOT"), null);
});

// Each group's own spreadsheet.
const SHEETS = { acme: "1AcmeSheetAcmeSheetAcmeSheet", test: "1TestSheetTestSheetTestSheet" };
const withSheets = (pairs) => pairs.map((pair) => ({ ...pair, sheet: `https://docs.google.com/spreadsheets/d/${SHEETS[pair.name]}/edit` }));
// The sheet's times are in TIMEZONE; these tests expect Sri Lanka time.
const sheetEnv = { ...env, CHANNEL_PAIRS: withSheets(env.CHANNEL_PAIRS), GOOGLE_URL, GOOGLE_SECRET: "google-secret", TIMEZONE: "Asia/Colombo" };
const sendWithSheet = (path, body) => send(path, body, {}, sheetEnv);
const slackUsers = {
  "users.info": (args) => ({
    user: { profile: { display_name: { UCREATOR: "Randil", UALICE: "Alice", UBOB: "Bob", UREX: "Rex", UMIA: "Mia", UTESS: "Tess", UTOM: "Tom" }[args.user] } },
  }),
};
const sheetRow = (calls) => {
  const sheet = calls.filter((call) => call.method === "sheet");
  assert.equal(sheet.length, 1);
  assert.equal(sheet[0].args.secret, "google-secret");
  assert.equal(sheet[0].args.project, "acme");
  assert.equal(sheet[0].args.spreadsheetId, SHEETS.acme);
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
    Owner: "Unassigned",
    Reviewer: "Unassigned",
    Tester: "Unassigned",
    "Tracked by": "Randil",
    // Slack timestamp 100.1 is 1970-01-01 00:01:40 UTC, 05:31 in Sri Lanka.
    "Tracked at": "01/01/1970 05:31",
    "Completed at": "",
    "Task link": "https://slack.example/p100",
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
  assert.equal(sheet.spreadsheetId, SHEETS.test);
  assert.equal(sheet.row["Task ID"], "CTESTDEV:100.1");
});

test("a group without its own spreadsheet isn't recorded in a Sheet", async (t) => {
  const calls = mockSlack(t, { ...slackUsers, stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"), {}, { ...sheetEnv, CHANNEL_PAIRS: env.CHANNEL_PAIRS });
  assert.equal(calls.filter((call) => call.method === "sheet").length, 0);
  assert.ok(calls.some((call) => call.method === "chat.update"), "the task itself still changes");
});

test("cade.config.json can link a group's own spreadsheet", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const sheet = "https://docs.google.com/spreadsheets/d/1AcmeSheetAcmeSheetAcmeSheet/edit";
  const projects = [{ name: "acme", channel: "C0000000002", sheet }];
  assert.equal(JSON.parse(readConfig(JSON.stringify({ projects })).PROJECTS)[0].sheet, sheet);
  assert.throws(
    () => readConfig(JSON.stringify({ projects: [{ ...projects[0], sheet: "https://docs.google.com/document/d/1AcmeDocAcmeDocAcmeDocAcmeDoc/edit" }] })),
    /acme's sheet should be a Google Sheet's address/,
  );
});

test("a group without a name is reported", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"), {}, {
    ...env,
    CHANNEL_PAIRS: [{ tasks: "CDEV" }],
  });
  assert.equal(calls[0].args.text, "Sorry, something went wrong with `assign`. Could you try again?");
});

test("assigning people updates the sheet with their names", async (t) => {
  const calls = mockSlack(t, {
    ...slackUsers,
    stored: [storedTask({ owners: ["UALICE"] })],
  });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  const row = sheetRow(calls);
  assert.equal(row.Owner, "Alice, Bob");
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
  mockSlack(t, { ...slackUsers, stored: [done] });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> status done"));
  assert.equal((await savedTask()).completedAt, "2026-10-20T04:30:00.000Z");
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
  assert.equal(calls.at(-1).method, "reactions.add");
});

// Apps Script answers a POST with a redirect to a page holding its reply.
function mockRedirectingSheet(t, replyPage) {
  const calls = mockSlack(t, { ...slackUsers, stored: [storedTask()] });
  const mocked = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (url === GOOGLE_URL) {
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
const slash = (text, channel = "CDEV") =>
  new URLSearchParams({
    command: "/cade",
    text,
    user_id: "UACTOR",
    channel_id: channel,
    trigger_id: "trigger-9",
  }).toString();

test("/cade task opens the task form straight away", async (t) => {
  const calls = mockSlack(t);
  const response = await send("/slack/commands", slash("task", "CDEV"));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  assert.equal(calls[0].args.trigger_id, "trigger-9");
  assert.equal(calls[0].args.view.callback_id, "track");
  assert.deepEqual(JSON.parse(calls[0].args.view.private_metadata), { channel: "CDEV" });
});

test("/cade task in the dev channel posts the task without an announcement", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" }, { channel: "CDEV" })),
  );
  assert.deepEqual(withoutSummary(calls).map((call) => call.method), ["chat.postMessage", "chat.getPermalink", "pins.add"]);
});

test("/cade help and unknown slash commands list the commands privately", async (t) => {
  for (const text of ["", "help", "hello"]) {
    mockSlack(t);
    const reply = await (await send("/slack/commands", slash(text))).json();
    assert.equal(reply.response_type, "ephemeral");
    for (const usage of ["/cade task", "/cade incident", "@Cade task", "@Cade priority high", "@Cade due 31/12/2026"]) {
      assert.ok(reply.text.includes(`\`${usage}\``), usage);
    }
  }
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
    stored: [withStatus("DONE")],
    ...createdTask,
  });
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "High" })),
  );
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));

  const posts = calls.filter((call) => ["chat.postMessage", "chat.update"].includes(call.method));
  assert.ok(posts.length >= 4);
  for (const call of posts) {
    assert.deepEqual(call.previews, { links: "false", media: "false" }, call.method);
  }
  assert.ok(calls.filter((call) => call.method === "pins.add").every((call) => !call.previews.links));
});

test("@Cade priority and due change the task's priority and due date", async (t) => {
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

test("owners were called developers before, and dev and developer still mean owner", async (t) => {
  for (const word of ["owner", "owners", "dev", "developer", "developers"]) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(`<@UBOT> assign ${word} <@UBOB>`));
    assert.deepEqual((await savedTask()).people.owner, ["UBOB"], word);
    assert.equal(calls.find((call) => call.method === "chat.postMessage").args.text, "<@UBOB>, could you pick this up when you get a chance? Thanks!", word);
  }
});

test("commands without what they need say what to send", async (t) => {
  for (const [text, reply] of [
    ["<@UBOT> assign", "Who, and as what? Try `@Cade assign owner @person`, `@Cade assign review @person`, `@Cade assign test @person`."],
    ["<@UBOT> assign <@UBOB>", "Who, and as what? Try `@Cade assign owner @person`, `@Cade assign review @person`, `@Cade assign test @person`."],
    ["<@UBOT> unassign", "Who? Try `@Cade unassign owner @person`, or `@Cade unassign @person` for every role."],
    ["<@UBOT> status", "Which status? Try `@Cade status in review`: to do, in progress, in review, in testing, client review or done."],
    ["<@UBOT> status soon", "I don't know \"soon\" as a status. Try `@Cade status in review`: to do, in progress, in review, in testing, client review or done."],
    ["<@UBOT> priority", "Which priority? Try `@Cade priority high`: urgent, high, medium or low."],
    ["<@UBOT> priority soon", "I don't know \"soon\" as a priority. Try `@Cade priority high`: urgent, high, medium or low."],
    ["<@UBOT> due", "When is it due? Try `@Cade due 31/12/2026`, or `@Cade due none` to clear it."],
    ["<@UBOT> due 31/02/2027", "I couldn't read \"31/02/2027\" as a date. Try `@Cade due 31/12/2026`, or `@Cade due none` to clear it."],
  ]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"], text);
    assert.equal(calls[0].args.text, reply, text);
    assert.equal((await savedTask()).status, "TODO", text);
  }
});

// Choosing `choice` from the ⋯ menu on the card of the task at CDEV/100.1.
const cardMenuClick = (choice) =>
  interaction({
    type: "block_actions",
    trigger_id: "T1",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    message: { ts: "100.1" },
    actions: [{ action_id: "task:menu", selected_option: { value: choice } }],
  });

test("a task's card has a menu: Edit, Release while it has PRs not sent, Refresh, Export thread and Archive", async (t) => {
  const menu = async (record) => {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadEvent("<@UBOT> status in progress"));
    const { accessory } = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.1").args.blocks[0];
    assert.equal(accessory.action_id, "task:menu");
    return accessory.options.map((option) => option.text.text);
  };
  assert.deepEqual(await menu(ownTask()), ["Edit", "Refresh", "Export thread", "Archive"]);
  const withPrs = ownTask();
  withPrs.task.prs = [PR, MR];
  assert.deepEqual(await menu(withPrs), ["Edit", "Release", "Refresh", "Export thread", "Archive"]);
  // Once every PR is sent, there's nothing to release.
  withPrs.task.releases = [{ prs: [PR, MR], note: "All of it", status: "PENDING_APPROVAL", sentBy: "UDEV" }];
  assert.deepEqual(await menu(withPrs), ["Edit", "Refresh", "Export thread", "Archive"]);
});

test("@Cade archive and the card's Archive stop tracking the task, keeping its card and thread", async (t) => {
  for (const archive of [
    () => send("/slack/events", threadEvent("<@UBOT> archive")),
    () => send("/slack/interactions", cardMenuClick("archive")),
  ]) {
    const calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })] });
    await archive();
    // Cade no longer finds it, but nothing is deleted.
    assert.equal(await savedTask(), null);
    assert.ok(!calls.some((call) => call.method === "chat.delete"));
    // The card says who archived it, and has no menu.
    const card = calls.find((call) => call.method === "chat.update").args;
    assert.equal(card.ts, "100.1");
    assert.equal(card.blocks[0].accessory, undefined);
    assert.match(blockText(allBlocks(card)[1]), /^:file_cabinet: Archived by <@UACTOR>  ·  Due 31\/10\/2026$/);
    assert.ok(calls.some((call) => call.method === "pins.remove" && call.args.timestamp === "100.1"));
    // The thread hears who did.
    const post = calls.find((call) => call.method === "chat.postMessage").args;
    assert.deepEqual([post.thread_ts, post.text], ["100.1", "<@UACTOR> archived this task."]);
  }

  // Its thread no longer has a task.
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> archive"));
  assert.match(calls[0].args.text, /not tracking a task in this thread/);
});

test("the summary lists archived tasks in their own section, until they're deleted", async (t) => {
  const ts = "1700000000.000100";
  const calls = mockSlack(t, {
    ...canvasResponses,
    stored: [{ ...ownTask(), ts }, historyTask("100.2", { title: "Still open" })],
    "conversations.replies": { messages: [] },
  });
  await runTasksCommand("resync summary", "CDEV");
  await send("/slack/events", threadEvent("<@UBOT> archive", { thread_ts: ts }));
  const archived = canvasMarkdown(calls.filter((call) => call.method === "canvases.edit").at(-1));
  assert.deepEqual(summaryRows(archived).map((row) => row.match(/\[([^\]]+)\]/)[1]), ["Still open"]);
  assert.match(archived, /\n## Archived\n\nThe last 1 archived, most recently first\.\n\n/);
  assert.match(summaryRows(archived, "Archived")[0], /^\| \[Fix login\]/);

  // Deleted with /cade remove, it leaves the summary altogether.
  const { later } = await runTasksCommand(`remove <${messageLink("CDEV", ts)}>`, "CDEV");
  await answerPrivately(t, later, "delete:confirm");
  const deleted = canvasMarkdown(calls.filter((call) => call.method === "canvases.edit").at(-1));
  assert.match(deleted, /\n## Archived\n\nNo archived tasks\.$/);
});

test("an archived task's Sheet row says Archived", async (t) => {
  const record = storedTask();
  record.task.link = "https://slack.example/p100";
  const calls = mockSlack(t, { ...slackUsers, stored: [record] });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> archive"));
  assert.equal(sheetRow(calls).Status, "Archived");
  assert.equal(sheetRow(calls)["Task link"], "https://slack.example/p100");
});

test("Refresh on a task's card redraws it quietly", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })] });
  await send("/slack/interactions", cardMenuClick("refresh"));
  const card = calls.find((call) => call.method === "chat.update").args;
  assert.equal(card.ts, "100.1");
  assert.equal(footerLines(card)[0], "Owner <@UREX>");
  // Nothing is posted, so no one is notified.
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral", "views.open"].includes(call.method)));
});

// The acme project with a Google Doc, for a task's notes page.
const notesEnv = {
  ...env,
  GOOGLE_URL,
  GOOGLE_SECRET: "google-secret",
  CHANNEL_PAIRS: env.CHANNEL_PAIRS.map((project) => (project.name === "acme" ? { ...project, doc: `https://docs.google.com/document/d/${DOC_ID}/edit` } : project)),
};
const NOTES_URL = `https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.notes1`;

test("Refresh makes the task's empty notes page once, and links it on the card", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })], doc: { ok: true, url: NOTES_URL, tabId: "t.notes1" } });
  await send("/slack/interactions", cardMenuClick("refresh"), {}, notesEnv);
  const [made] = calls.filter((call) => call.method === "doc");
  assert.deepEqual(made.args, { secret: "google-secret", action: "doc.task", docId: DOC_ID, parent: "Notes", title: "Fix login" });
  // The card links to it, right under the title, above the status.
  const card = calls.find((call) => call.method === "chat.update").args;
  assert.equal(blockText(allBlocks(card)[1]), `Extra notes <${NOTES_URL}|here>`);
  assert.match(blockText(allBlocks(card)[2]), /^:memo: To do/);
  assert.equal(footerLines(card)[0], "Owner <@UREX>");

  // With a page, Refresh leaves the Doc alone, and the link stays.
  calls.length = 0;
  await send("/slack/interactions", cardMenuClick("refresh"), {}, notesEnv);
  assert.ok(!calls.some((call) => call.method === "doc"));
  assert.equal(blockText(allBlocks(calls.find((call) => call.method === "chat.update").args)[1]), `Extra notes <${NOTES_URL}|here>`);
});

test("a new task in a project with a Doc gets its notes page, linked on its card", async (t) => {
  const calls = mockSlack(t, { ...createdTask, doc: { ok: true, url: NOTES_URL, tabId: "t.notes1" } });
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "Low" })), {}, notesEnv);
  const [made] = calls.filter((call) => call.method === "doc");
  assert.deepEqual(made.args, { secret: "google-secret", action: "doc.task", docId: DOC_ID, parent: "Notes", title: "Fix login" });
  const update = calls.find((call) => call.method === "chat.update");
  assert.equal(update.args.ts, "100.1");
  assert.equal(blockText(allBlocks(update.args)[1]), `Extra notes <${NOTES_URL}|here>`);
  const { loadTask } = await import("../src/tasks.js");
  assert.deepEqual((await loadTask(notesEnv, "CDEV", "100.1")).notes, { url: NOTES_URL, tab: "t.notes1" });
});

test("a task in a project without a Doc has no notes page, and a Google failure doesn't stop Refresh", async (t) => {
  let calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })] });
  await send("/slack/interactions", cardMenuClick("refresh"), {}, { ...notesEnv, CHANNEL_PAIRS: env.CHANNEL_PAIRS });
  assert.ok(!calls.some((call) => call.method === "doc"));
  assert.ok(!allBlocks(calls.find((call) => call.method === "chat.update").args).some((block) => blockText(block).startsWith("Extra notes")));

  calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })], doc: () => ({ ok: false, error: "Document is missing" }) });
  await send("/slack/interactions", cardMenuClick("refresh"), {}, notesEnv);
  assert.equal(calls.filter((call) => call.method === "doc").length, 1);
  assert.equal(footerLines(calls.find((call) => call.method === "chat.update").args)[0], "Owner <@UREX>");
});

test("Export thread writes the thread, names resolved, to the task's page under Export, and writes the same page over next time", async (t) => {
  const thread = [
    { user: "UREX", ts: "100.1", text: "Fix login" },
    { user: "UBOB", ts: "100.2", text: "On it <@UREX>, see <https://example.com/x|the doc> &amp; <#C1|dev>", files: [{ name: "a.png", permalink: "https://acme.slack.com/files/UBOB/F1/a.png" }] },
  ];
  const users = { UREX: { profile: { display_name: "Rex" } }, UBOB: { real_name: "Bob Lee", profile: {} } };
  const calls = mockSlack(t, {
    stored: [ownTask({ owners: ["UREX"] })],
    "conversations.replies": () => ({ messages: thread }),
    "users.info": ({ user }) => ({ user: users[user] }),
    doc: { ok: true, url: NOTES_URL, tabId: "t.export1" },
  });
  await send("/slack/interactions", cardMenuClick("export"), {}, notesEnv);
  const [made] = calls.filter((call) => call.method === "doc");
  assert.equal(made.args.action, "doc.export");
  assert.equal(made.args.parent, "Export");
  assert.equal(made.args.title, "Fix login (thread)");
  assert.equal(made.args.tabId, undefined);
  assert.match(made.args.text, /^Thread: Fix login\n\nRex · .*\nFix login\n\nBob Lee · .*\nOn it @Rex, see the doc \(https:\/\/example.com\/x\) & #dev\n\(attachment: a.png https:\/\/acme.slack.com\/files\/UBOB\/F1\/a.png\)$/);
  // Each person is looked up once, however many messages they wrote.
  assert.equal(calls.filter((call) => call.method === "users.info").length, 2);
  const told = calls.find((call) => call.method === "chat.postEphemeral");
  assert.equal(told.args.user, "UACTOR");
  assert.ok(told.args.text.includes(NOTES_URL));
  const { loadTask } = await import("../src/tasks.js");
  assert.deepEqual((await loadTask(notesEnv, "CDEV", "100.1")).export, { url: NOTES_URL, tab: "t.export1" });

  calls.length = 0;
  await send("/slack/interactions", cardMenuClick("export"), {}, notesEnv);
  assert.equal(calls.find((call) => call.method === "doc").args.tabId, "t.export1");
});

test("Export thread says so, and writes nothing, in a project without a Doc or when it fails", async (t) => {
  let calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })], "conversations.replies": () => ({ messages: [] }) });
  await send("/slack/interactions", cardMenuClick("export"), {}, { ...notesEnv, CHANNEL_PAIRS: env.CHANNEL_PAIRS });
  assert.ok(!calls.some((call) => call.method === "doc"));
  assert.match(calls.find((call) => call.method === "chat.postEphemeral").args.text, /no Google Doc/);

  calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })], "conversations.replies": () => ({ messages: [] }), doc: () => ({ ok: false, error: "Document is missing" }) });
  await send("/slack/interactions", cardMenuClick("export"), {}, notesEnv);
  assert.match(calls.find((call) => call.method === "chat.postEphemeral").args.text, /couldn't export/);
});

test("/cade export writes a task's thread to the Doc from its link, and says when it can't", async (t) => {
  // A task at a timestamp a Slack link can name.
  const ts = "1700000000.000100";
  const calls = mockSlack(t, {
    stored: [{ ...ownTask({ owners: ["UREX"] }), ts }],
    "conversations.replies": () => ({ messages: [{ user: "UREX", ts, text: "Fix login" }] }),
    "users.info": () => ({ user: { profile: { display_name: "Rex" } } }),
    doc: { ok: true, url: NOTES_URL, tabId: "t.export1" },
  });
  assert.match((await runTasksCommand("export", "CDEV")).now, /Paste the link to the task/);
  const link = (stamp) => `<https://acme.slack.com/archives/CDEV/p${stamp.replace(".", "")}>`;
  const { later } = await runTasksCommand(`export ${link(ts)}`, "CDEV", notesEnv);
  assert.equal(calls.find((call) => call.method === "doc").args.action, "doc.export");
  assert.ok(later.text.includes(NOTES_URL));
  const missing = await runTasksCommand(`export ${link("1700000009.000900")}`, "CDEV", notesEnv);
  assert.match(missing.later.text, /isn't to a task/);
});

test("a task reaching Done exports its thread quietly, and its card then links the export after its notes", async (t) => {
  const record = ownTask({ owners: ["UREX"] });
  record.task.notes = { url: "https://docs.google.com/notes", tab: "t.notes1" };
  const calls = mockSlack(t, {
    stored: [record],
    "conversations.replies": () => ({ messages: [{ user: "UREX", ts: "100.1", text: "Fix login" }] }),
    "users.info": () => ({ user: { profile: { display_name: "Rex" } } }),
    doc: { ok: true, url: NOTES_URL, tabId: "t.export1" },
  });
  await send("/slack/events", threadEvent("<@UBOT> status done"), {}, notesEnv);
  assert.equal(calls.filter((call) => call.method === "doc").length, 1);
  assert.equal(calls.find((call) => call.method === "doc").args.action, "doc.export");
  // Nobody is told.
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
  const card = calls.filter((call) => call.method === "chat.update" && call.args.ts === "100.1").at(-1).args;
  assert.equal(blockText(allBlocks(card)[1]), `Extra notes <https://docs.google.com/notes|here>  ·  Thread export <${NOTES_URL}|here>`);

  // Not done again, so not exported again; and an open task's card has no export link.
  const { loadTask } = await import("../src/tasks.js");
  const stored = await loadTask(notesEnv, "CDEV", "100.1");
  assert.deepEqual(stored.export, { url: NOTES_URL, tab: "t.export1" });
  const { taskMessage } = await import("../src/tasks.js");
  const open = taskMessage({ ...stored, status: "IN_PROGRESS" });
  assert.ok(!JSON.stringify(open).includes("Thread export"));
});

test("a task reaching Done isn't exported with exportOnDone off, in a project without a Doc, or when Google fails", async (t) => {
  const off = { ...notesEnv, CHANNEL_PAIRS: notesEnv.CHANNEL_PAIRS.map((project) => ({ ...project, exportOnDone: false })) };
  for (const [environment, doc] of [[off, undefined], [{ ...notesEnv, CHANNEL_PAIRS: env.CHANNEL_PAIRS }, undefined], [notesEnv, () => ({ ok: false, error: "Document is missing" })]]) {
    const calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })], "conversations.replies": () => ({ messages: [] }), doc });
    await send("/slack/events", threadEvent("<@UBOT> status done"), {}, environment);
    assert.equal(calls.filter((call) => call.method === "doc").length, environment === notesEnv ? 1 : 0);
    // The task is done either way.
    assert.ok(calls.some((call) => call.method === "pins.remove"));
    assert.ok(!JSON.stringify(calls.filter((call) => call.method === "chat.update").at(-1).args).includes("Thread export"));
  }
});

test("choosing from a task card's menu opens its form, and an old card's choices open Edit", async (t) => {
  for (const [choice, callbackId] of [
    ["release", "release"],
    ["assign", "task:edit"],
    ["status", "task:edit"],
    ["more", "task:edit"],
  ]) {
    const record = ownTask({ owners: ["UREX"] });
    record.task.prs = ["https://github.com/acme/web/pull/9"];
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/interactions", cardMenuClick(choice));
    assert.deepEqual(calls.map((call) => call.method), ["views.open"], choice);
    assert.equal(calls[0].args.trigger_id, "T1");
    assert.equal(calls[0].args.view.callback_id, callbackId, choice);
  }
});

test("a task card's Send PRs for approval with nothing to send says so privately", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", cardMenuClick("release"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  assert.match(calls[0].args.text, /aren't any PRs/);
});

test("a task card's menu on a task that's gone says so privately", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/interactions", cardMenuClick("status"));
  assert.deepEqual(calls.map((call) => [call.method, call.args.user]), [["chat.postEphemeral", "UACTOR"]]);
});

// The approver clicking Approve or Not approve in the task's thread.
// Moves the task at `channel`/100.1 to Client review as UACTOR, clicks the
// private Ask for approval button and chooses `approver` in its form.
// Returns every Slack call, and in `calls.responses` what was sent to the
// button's response_url.
async function clientReview(t, responses, { channel = "CDEV", approver = "UCREATOR", environment = env } = {}) {
  const calls = mockSlack(t, responses);
  calls.responses = recordResponses(t);
  await send("/slack/events", threadEvent("<@UBOT> status client review", { channel }), {}, environment);
  const button = calls
    .find((call) => call.method === "chat.postEphemeral" && call.args.blocks?.[1]?.elements?.[0]?.action_id === "status:ask")
    .args.blocks[1].elements[0];
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "T1",
      user: { id: "UACTOR" },
      channel: { id: channel },
      message: { ts: "100.8", thread_ts: "100.1" },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "status:ask", value: button.value }],
    }),
    {},
    environment,
  );
  const form = calls.findLast((call) => call.method === "views.open").args.view;
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: form.callback_id,
        private_metadata: form.private_metadata,
        state: { values: { approver: { value: { selected_user: approver } } } },
      },
    }),
    {},
    environment,
  );
  return calls;
}

const reviewClick = (actionId) =>
  interaction({
    type: "block_actions",
    user: { id: "UCLIENT" },
    channel: { id: "CDEV" },
    message: { ts: "100.9", thread_ts: "100.1" },
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
    stored: [withStatus("CLIENT_REVIEW")],
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  const response = await send("/slack/interactions", reviewClick("status:approve"));
  assert.equal(response.status, 200);

  assert.deepEqual(calls.map((call) => [call.method, call.args.ts ?? call.args.thread_ts ?? call.args.timestamp]), [
    ["chat.update", "100.1"],
    ["pins.remove", "100.1"],
    ["chat.postMessage", "100.1"],
    ["chat.update", "100.9"],
  ]);
  assert.deepEqual((await savedTask()).status, "DONE");
  assert.ok((await savedTask()).completedAt);
  assert.equal(calls[2].args.text, "<@UCLIENT> approved this, so it's now :white_check_mark: Done. Nice work!");
  assert.deepEqual(calls[3].args, {
    channel: "CDEV",
    ts: "100.9",
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
    stored: [withStatus("CLIENT_REVIEW")],
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  await send("/slack/interactions", reviewClick("status:reject"));

  const task = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.1");
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  // The task was not Done, so its pin stays.
  assert.ok(!calls.some((call) => call.method.startsWith("pins.")));
  const note = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(note.thread_ts, "100.1");
  assert.equal(
    note.text,
    "<@UCLIENT> didn't approve this, so it's back to :arrow_forward: In progress. Have a look at the thread for what needs to change.",
  );
  assert.match(calls.at(-1).args.text, /\n<@UCLIENT> didn't approve it, so the team will pick it up again\. Thanks for letting us know!$/);
});

test("Approve and Not approve do nothing once the task has left Client review", async (t) => {
  for (const actionId of ["status:approve", "status:reject"]) {
    const calls = mockSlack(t, { stored: [withStatus("IN_TESTING")] });
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

test("setting the status it already has changes nothing, so asks no one", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  await send("/slack/events", threadEvent("<@UBOT> status client review"));
  assert.deepEqual(calls.map((call) => call.method), ["reactions.add"]);
});

test("only the chosen approver can approve or reject", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  const click = JSON.parse(new URLSearchParams(reviewClick("status:approve")).get("payload"));
  click.actions[0].value = JSON.stringify({ ...JSON.parse(click.actions[0].value), approver: "UPM" });
  await send("/slack/interactions", interaction(click));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  assert.equal(calls[0].args.user, "UCLIENT");
  assert.equal(calls[0].args.text, "Only <@UPM> can approve or reject this.");
  assert.equal((await savedTask()).status, "CLIENT_REVIEW");
});

// A stored task at `ts`, with `fields` changed.
const historyTask = (ts, { owners = [], reviewers = [], testers = [], ...fields }) => {
  const record = storedTask({ owners, reviewers, testers });
  record.ts = ts;
  Object.assign(record.task, fields);
  return record;
};

// An incident's task at `ts`, as historyTask.
const incidentHistoryTask = (ts, fields) => historyTask(ts, { priority: "Urgent", dueDate: "Immediate", incident: true, ...fields });

// What `/cade tasks` says it takes, after saying what was wrong.
const TASKS_USAGE =
  "Try `/cade tasks` for your open tasks, with any of: `owned`, `review` or `testing` for one role; `@person` for theirs; `-all` for everyone's; `-unassigned` for those with no owner; `-status=in-progress` (or `todo`, `in-review`, `in-testing`, `client-review`, `done`, several with commas); `-due=@today`, `-due<@today`, `-due>=31/10/2026` or `-due=none`.";

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
      historyTask("100.1", { title: "Low task", priority: "Low", owners: ["UACTOR"] }),
      historyTask("100.2", { title: "High task", priority: "High", dueDate: "05/11/2026", owners: ["UACTOR", "UBOB"] }),
      historyTask("100.3", { title: "High, sooner", priority: "High", dueDate: "01/11/2026", owners: ["UACTOR"] }),
      historyTask("100.4", { title: "Done task", status: "DONE", owners: ["UACTOR"] }),
      historyTask("100.5", { title: "Not mine", owners: ["UBOB"] }),
      historyTask("100.6", { title: "Review me", reviewers: ["UACTOR"], status: "IN_REVIEW" }),
      incidentHistoryTask("100.8", { title: "Checkout is down", owners: ["UACTOR"] }),
    ],
    // Another group's task is left out.
    CTESTDEV: [historyTask("100.9", { title: "Test task", owners: ["UACTOR"] })],
  }), env);

  // Slack is answered at once; the list follows, only to you.
  assert.equal(now, "");
  assert.equal(later.response_type, "ephemeral");
  // The tasks come from the database: Slack is only asked for the
  // workspace's address, for the links.
  assert.deepEqual(calls.map((call) => call.method), ["auth.test"]);

  assert.equal(later.text, "You have 5 open acme tasks.");
  const [header, developing, reviewing, testing] = later.blocks;
  assert.equal(header.text.text, "Your acme tasks");
  // Each link opens the task's thread.
  const thread = (channel, ts) =>
    `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel}`;
  assert.equal(
    developing.text.text,
    [
      "*Owned (4)*",
      `• *Incident:* <${thread("CDEV", "100.8")}|Checkout is down>  ·  :memo: To do  ·  :red_circle: Urgent  ·  Due Immediate`,
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

test("/cade tasks outside every group shows each group in turn", async (t) => {
  const { later } = await tasksCommand(t, "tasks", "CRANDOM", ({
    CDEV: [historyTask("100.1", { owners: ["UACTOR"] })],
    CTESTDEV: [historyTask("100.2", { testers: ["UACTOR"] }), historyTask("100.3", { testers: ["UACTOR"] })],
  }));
  assert.equal(later.text, "You have 1 open acme task. You have 2 open test tasks.");
  assert.deepEqual(
    later.blocks.map((block) => (block.type === "header" ? block.text.text : block.type)),
    ["Your acme tasks", "section", "section", "section", "divider", "Your test tasks", "section", "section", "section"],
  );
});

test("/cade tasks with a role shows only that role", async (t) => {
  const pins = ({
    CDEV: [
      historyTask("100.1", { title: "Build it", owners: ["UACTOR"] }),
      historyTask("100.2", { title: "Review it", reviewers: ["UACTOR"] }),
      historyTask("100.3", { title: "Both", owners: ["UACTOR"], testers: ["UACTOR"] }),
    ],
  });
  for (const [word, heading, text, lines] of [
    ["development", "Owned", "You have 2 open acme owned tasks.", 2],
    ["dev", "Owned", "You have 2 open acme owned tasks.", 2],
    ["Review", "Reviewing", "You have 1 open acme reviewing task.", 1],
    ["testing", "Testing", "You have 1 open acme testing task.", 1],
    ["test", "Testing", "You have 1 open acme testing task.", 1],
  ]) {
    const { later } = await tasksCommand(t, `tasks ${word}`, "CDEV", pins);
    assert.equal(later.text, text, word);
    assert.equal(later.blocks[0].text.text, `Your acme tasks: ${heading}`, word);
    // Just the one role's section.
    assert.equal(later.blocks.length, 2, word);
    assert.equal(later.blocks[1].text.text.split("\n").length, lines + 1, word);
    assert.match(later.blocks[1].text.text, new RegExp(`^\\*${heading} \\(${lines}\\)\\*`), word);
  }
});

test("/cade tasks with a role and no such tasks says so", async (t) => {
  const { later } = await tasksCommand(t, "tasks review", "CDEV", ({
    CDEV: [historyTask("100.1", { owners: ["UACTOR"] })],
  }));
  assert.equal(later.text, "You have no open acme reviewing tasks.");
  assert.equal(later.blocks[0].text.text, "Your acme tasks: Reviewing");
});

test("/cade tasks with anything else says what it takes", async (t) => {
  // Group names are not taken any more: the channel picks the group.
  for (const word of ["mars", "acme"]) {
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
    CDEV: [historyTask("100.1", { owners: ["UBOB"] })],
  }));
  assert.equal(later.text, "You have no open acme tasks.");
  assert.equal(later.blocks[1].text.text, "You have no open tasks.");
});

test("/cade tasks leaves out deleted tasks", async (t) => {
  const { later } = await tasksCommand(t, "tasks", "CDEV", {
    CDEV: [historyTask("100.1", { owners: ["UACTOR"] }), historyTask("100.2", { owners: ["UACTOR"] })],
  });
  assert.equal(later.text, "You have 2 open acme tasks.");

  await markTaskDeleted(env, "CDEV", "100.1");
  const again = await runTasksCommand("tasks", "CDEV");
  assert.equal(again.later.text, "You have 1 open acme task.");
});

test("@Cade tasks points to /cade tasks", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> tasks"));
  assert.equal(calls[0].args.text, "That one's a slash command: try `/cade tasks`.");
});

const PR = "https://github.com/acme/cade/pull/42";
const MR = "https://gitlab.com/acme/web/web-app/-/merge_requests/118";

test("@Cade pr add links pull requests on one line above who tracked it, and reacts ✅", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}/files> <${MR}|the MR> ${PR}`));

  // No reviewer yet, so the reply after the ✅ asks who should review.
  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "reactions.add", "chat.postMessage"]);
  const blocks = allBlocks(calls[0].args);
  // Stored without the /files tab, and only once.
  assert.deepEqual((await savedTask()).prs, [PR, MR]);
  // Not sent to the client yet, so pending.
  assert.equal(blocks[2].type, "context");
  assert.equal(blockText(blocks[2]), `*Pending:* <${PR}|cade/42>, <${MR}|web-app/118>`);
  assert.match(footerLines(calls[0].args)[1], /^Tracked by/);
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.ok(!calls[2].args.text.includes("linked"));
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
  assert.equal(calls[1].args.name, "white_check_mark");

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
  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "reactions.add"]);
  assert.equal(calls[1].args.name, "white_check_mark");

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
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.equal(
    calls[2].args.text,
    `<@URIA>, <@UREX>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
  );
  assert.equal(calls[2].args.blocks, undefined, "no picker");
});

test("linking a PR with no reviewer asks who should review it", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.equal(calls[1].args.name, "white_check_mark");
  const prompt = calls[2].args;
  assert.equal(prompt.text, `There's no reviewer yet. Who should review <${PR}|cade/42>?`);
  const block = prompt.blocks[0];
  assert.equal(block.accessory.type, "multi_users_select");
  assert.equal(block.accessory.action_id, "pr:reviewers");
  assert.deepEqual(JSON.parse(block.block_id), [PR]);
});

test("choosing reviewers assigns them and asks them to review, in a new reply", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: {
        ts: "100.8",
        thread_ts: "100.1",
        text: `<@UACTOR> linked <${PR}|cade/42>.\nThere's no reviewer yet. Who should review it?`,
      },
      actions: [{ action_id: "pr:reviewers", block_id: JSON.stringify([PR]), selected_users: ["URIA"] }],
    }),
  );
  assert.deepEqual(calls.map((call) => [call.method, call.args.ts]), [
    ["chat.update", "100.1"],
    ["chat.update", "100.8"],
    ["chat.postMessage", undefined],
  ]);
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
  // The picker keeps what came before its question.
  assert.equal(calls[1].args.text, `<@UACTOR> linked <${PR}|cade/42>.`);
  assert.equal(calls[1].args.blocks.length, 1, "the picker is gone");
  // A new reply, since an edited message notifies no one.
  assert.deepEqual(calls[2].args, {
    channel: "CDEV",
    thread_ts: "100.1",
    text: `<@UCLICKER> assigned <@URIA> as reviewer.\n<@URIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
  });
});

test("choosing reviewers on a picker with nothing before its question removes it", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: { ts: "100.8", thread_ts: "100.1", text: "There's no reviewer yet. Who should review it?" },
      actions: [{ action_id: "pr:reviewers", block_id: JSON.stringify([PR]), selected_users: ["URIA"] }],
    }),
  );
  assert.deepEqual(calls.slice(1).map((call) => [call.method, call.args.ts]), [
    ["chat.delete", "100.8"],
    ["chat.postMessage", undefined],
  ]);
});

test("assigning a reviewer once a PR is linked asks them to review it", async (t) => {
  const root = storedTask();
  root.task.prs = [PR, MR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA>"));
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
  assert.equal(
    calls[2].args.text,
    `<@URIA>, could you review <${PR}|cade/42>, <${MR}|web-app/118> when you get a chance? Thanks!`,
  );
});

test("reviewers added before a PR are recorded, and asked nothing yet", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA> <@UREX>"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "reactions.add"]);
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
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

test("pull requests pasted into a task's thread are asked about with the other changes, privately", async (t) => {
  const root = storedTask({ reviewers: ["URIA"] });
  root.task.prs = [MR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadReply(`Fixed in <${PR}> and <${MR}>, see <https://example.com/doc>`));

  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  const question = calls[0].args;
  assert.equal(question.user, "UACTOR");
  assert.equal(question.thread_ts, "100.1");
  assert.equal(question.text, "Should I update the task? From your message:");
  // Only the PR that isn't linked yet is offered.
  assert.match(question.blocks[1].text.text, new RegExp(`PRs:\\* <${PR}\\|cade/42> \\(Add\\)`));
  assert.doesNotMatch(question.blocks[1].text.text, /pull\/7|merge_requests/);
  const [accept, edit, reject] = question.blocks[2].elements;
  assert.deepEqual([accept.text.text, edit.text.text, reject.text.text], ["Accept", "Edit…", "Reject"]);
  assert.deepEqual(JSON.parse(accept.value).changes, { prs: { add: [PR] } });
});

test("a PR pasted with a mention proposes the person as reviewer in the same private question", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply(`<@UREX> <@UBOT> can you look at <${PR}>?`));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  const question = calls[0].args;
  assert.equal(question.text, "Should I update the task? From your message:");
  // Cade isn't someone to add.
  const [accept] = question.blocks[2].elements;
  assert.deepEqual(JSON.parse(accept.value).changes, {
    prs: { add: [PR] },
    people: { reviewer: { add: ["UREX"], remove: [] } },
  });
  assert.match(question.blocks[1].text.text, /<@UREX> \(Add\)/);
  assert.doesNotMatch(question.blocks[1].text.text, /UBOT/);
});

test("a question posted with the old reviewer picker is still answered", async (t) => {
  const linking = mockSlack(t, { stored: [storedTask()] });
  const sent = recordResponses(t);
  const click = JSON.parse(new URLSearchParams(suggestionClick("pr:suggest-link", [PR])).get("payload"));
  click.actions[0].value = JSON.stringify({ channel: "CDEV", ts: "100.1", mentioned: ["UREX"], urls: [PR], reviewers: ["UREX"] });
  click.state = { values: { "pr:suggest-reviewers": { "pr:suggest-reviewers": { selected_users: ["UREX", "UMIA"] } } } };
  await send("/slack/interactions", interaction(click));
  const saved = await savedTask();
  assert.deepEqual(saved.prs, [PR]);
  assert.deepEqual(saved.people.reviewer, ["UREX", "UMIA"]);
  // UREX was mentioned in the message, so only UMIA is asked.
  assert.equal(
    linking.find((call) => call.method === "chat.postMessage").args.text,
    `<@UMIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
  );
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("/cade retry asks again about a message in a task's thread, from its link", async (t) => {
  const ts = "1700000001.000500";
  const reply = { ts, thread_ts: "100.1", user: "UREX", text: `<@UMIA> please look at <${PR}>` };
  const calls = mockSlack(t, {
    stored: [storedTask({ reviewers: ["UMIA"] })],
    "conversations.replies": { messages: [reply] },
    "auth.test": { user_id: "UBOT" },
  });
  const { later } = await runTasksCommand(`retry ${messageLink("CDEV", ts, "?thread_ts=100.1&cid=CDEV")}`, "CDEV");

  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "auth.test", "chat.postEphemeral"]);
  assert.equal(calls[0].args.ts, ts);
  // The question goes to whoever wrote the message, as it would have.
  assert.equal(calls[2].args.user, "UREX");
  assert.equal(calls[2].args.thread_ts, "100.1");
  assert.equal(calls[2].args.text, "Should I update the task? From your message:");
  assert.match(later.text, /<@UREX> will see a private question/);
});

test("/cade retry says when the link is missing, not in a thread, or not found", async (t) => {
  mockSlack(t);
  assert.match((await runTasksCommand("retry", "CDEV")).now, /Paste the link to the message/);

  mockSlack(t, {
    "conversations.replies": { messages: [{ ts: "1700000000.000100", user: "UREX", text: "a task" }] },
    "auth.test": { user_id: "UBOT" },
  });
  assert.match((await runTasksCommand(`retry ${messageLink("CDEV", "1700000000.000100")}`, "CDEV")).later.text, /not in a thread/);

  mockSlack(t, { "conversations.replies": { messages: [] } });
  assert.match((await runTasksCommand(`retry ${messageLink("CDEV", "1700000009.000900")}`, "CDEV")).later.text, /couldn't find that message/);
});

test("a PR in a reply also sent to the channel is suggested like any reply", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["UMIA"] })] });
  await send("/slack/events", threadReply(`<@UMIA> can you review <${PR}>?`, { subtype: "thread_broadcast" }));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
});

test("/cade retry asks again about a message in a task's thread, from its link", async (t) => {
  const ts = "1700000001.000500";
  const reply = { ts, thread_ts: "100.1", user: "UREX", text: `<@UMIA> please look at <${PR}>` };
  const calls = mockSlack(t, {
    stored: [storedTask({ reviewers: ["UMIA"] })],
    "conversations.replies": { messages: [reply] },
    "auth.test": { user_id: "UBOT" },
  });
  const { later } = await runTasksCommand(`retry ${messageLink("CDEV", ts, "?thread_ts=100.1&cid=CDEV")}`, "CDEV");

  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "auth.test", "chat.postEphemeral"]);
  assert.equal(calls[0].args.ts, ts);
  // The question goes to whoever wrote the message, as it would have.
  assert.equal(calls[2].args.user, "UREX");
  assert.equal(calls[2].args.thread_ts, "100.1");
  assert.equal(calls[2].args.text, "Should I update the task? From your message:");
  assert.match(later.text, /<@UREX> will see a private question/);
});

test("/cade retry says when the link is missing, not in a thread, or not found", async (t) => {
  mockSlack(t);
  assert.match((await runTasksCommand("retry", "CDEV")).now, /Paste the link to the message/);

  mockSlack(t, {
    "conversations.replies": { messages: [{ ts: "1700000000.000100", user: "UREX", text: "a task" }] },
    "auth.test": { user_id: "UBOT" },
  });
  assert.match((await runTasksCommand(`retry ${messageLink("CDEV", "1700000000.000100")}`, "CDEV")).later.text, /not in a thread/);

  mockSlack(t, { "conversations.replies": { messages: [] } });
  assert.match((await runTasksCommand(`retry ${messageLink("CDEV", "1700000009.000900")}`, "CDEV")).later.text, /couldn't find that message/);
});

test("a PR in a reply also sent to the channel is suggested like any reply", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["UMIA"] })] });
  await send("/slack/events", threadReply(`<@UMIA> can you review <${PR}>?`, { subtype: "thread_broadcast" }));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
});

test("Edit saves the status chosen over the one a PR suggestion moved the task to", async (t) => {
  const task = storedTask({ reviewers: ["UMIA"] });
  task.task.status = "IN_PROGRESS";
  mockSlack(t, { stored: [task] });
  // The form began on In review, as linking the PR moves the task there; the
  // person put In progress back.
  const saveWith = (status) =>
    send(
      "/slack/interactions",
      interaction({
        type: "view_submission",
        user: { id: "UACTOR" },
        view: {
          callback_id: "task:edit",
          private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", details: false, opened: "IN_PROGRESS", shown: "IN_REVIEW" }),
          state: {
            values: {
              owner: { value: { selected_users: [] } },
              reviewer: { value: { selected_users: ["UMIA"] } },
              tester: { value: { selected_users: [] } },
              status: { value: { selected_option: { value: status } } },
              prs: { value: { value: PR } },
            },
          },
        },
      }),
    );
  await saveWith("IN_PROGRESS");
  const saved = await savedTask();
  assert.deepEqual([saved.status, saved.prs], ["IN_PROGRESS", [PR]]);
});

test("messages without unlinked pull requests are left alone", async (t) => {
  const linked = storedTask();
  linked.task.prs = [PR];
  for (const [text, overrides, root] of [
    ["Looks good, no links here", {}, storedTask()],
    [`Already linked <${PR}>`, {}, linked],
    // Not in a team channel, or not a task's thread. (Messages not in a
    // thread are asked whether to track them instead.)
    [`See <${PR}>`, { channel: "COTHER" }, storedTask()],
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
  // No "linked" line: whoever clicked posted the link. The thread hears only
  // that the reviewer the message didn't mention is asked.
  assert.equal(
    calls[1].args.text,
    `<@URIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
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

test("a pasted PR that mentions people proposes them as reviewers too", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  // URIA is already a reviewer and Cade is not a person to add.
  await send("/slack/events", threadReply(`<@UREX> <@URIA> <@UBOT> can you look at <${PR}>?`));

  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  const [accept] = question.blocks[2].elements;
  assert.deepEqual(JSON.parse(accept.value).changes, {
    prs: { add: [PR] },
    people: { reviewer: { add: ["UREX"], remove: [] } },
  });
});

test("an already linked PR is left alone, even when it mentions new people", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadReply(`<@UREX> <@URIA> please look at <${PR}>`));
  assert.deepEqual(calls, []);
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
    `<@URIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
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

test("linking a PR leaves the status to the suggestions", async (t) => {
  for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "IN_TESTING", "CLIENT_REVIEW", "DONE"]) {
    const calls = mockSlack(t, { stored: [withStatus(status)] });
    await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
    assert.deepEqual((await savedTask()).status, status, status);
    assert.ok(!calls.some((call) => call.args.text?.includes("moved the task")), status);
    // Pins only change with Done, so none here.
    assert.ok(!calls.some((call) => call.method.startsWith("pins.")), status);
  }
});

test("removing a PR leaves the status alone", async (t) => {
  const root = withStatus("IN_REVIEW");
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).status, "IN_REVIEW");
});

const assignValue = (role, people, moveTo = null) => JSON.stringify({ channel: "CDEV", ts: "100.1", role, people, moveTo });

const clickAssign = (actionId, value) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value }],
  });

test("a message with a PR link and a hand-off gets one question with both", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply(`<@UREX> please review <${PR}>`));
  const questions = calls.filter((call) => call.method === "chat.postEphemeral");
  assert.equal(questions.length, 1);
  const [accept] = questions[0].args.blocks[2].elements;
  assert.deepEqual(JSON.parse(accept.value).changes, {
    prs: { add: [PR] },
    people: { reviewer: { add: ["UREX"], remove: [] } },
  });
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

test("@Cade assign tester never changes the status", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_PROGRESS")] });
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UTESS>"));
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.deepEqual((await savedTask()).people.tester, ["UTESS"]);
});

test("a task started before the click is not moved again", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("owner", ["UREX"], "IN_PROGRESS")));
  assert.deepEqual((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("@Cade assign owner never changes the status", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UREX>"));
  assert.deepEqual((await savedTask()).status, "TODO");
});

test("saying you've started asks nothing when there's nothing to change, or it isn't a task thread", async (t) => {
  for (const [text, root, overrides] of [
    // A owner on a task that's under way.
    ["started working on this", (() => {
      const root = withStatus("IN_PROGRESS");
      root.task.people.owner = ["UACTOR"];
      return root;
    })(), {}],
    // Anyone, on a task that's Done.
    ["picking this up", withStatus("DONE"), {}],
    // Not about the task, or not a task thread.
    ["can you comment on it?", storedTask(), {}],
    ["started working on this", null, {}],
    ["started working on this", storedTask(), { channel: "COTHER" }],
  ]) {
    const calls = mockSlack(t, { stored: root ? [root] : [] });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${overrides.channel ?? ""}`);
  }
});

test("Link PR on a task already in review with no reviewer just asks who should review", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.text, `There's no reviewer yet. Who should review <${PR}|cade/42>?`);
  assert.equal(allBlocks(post)[0].accessory.action_id, "pr:reviewers");
});

test("other typed statuses get only the ✅", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("TODO")] });
  await send("/slack/events", threadEvent("<@UBOT> status in review"));
  assert.equal(calls.at(-1).method, "reactions.add");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("Client review lists the task's PRs for the client, and keeps them after a decision", async (t) => {
  const task = withStatus("IN_TESTING");
  task.task.prs = [PR, MR];
  const calls = await clientReview(t, {
    stored: [task],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });

  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.text?.startsWith("Good news!")).args;
  const announced = [
    "Good news! <@UACTOR> says this is ready for review.",
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
  const calls = await clientReview(t, {
    stored: [withStatus("IN_TESTING")],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.text?.startsWith("Good news!")).args;
  assert.ok(!review.blocks[0].text.text.includes("*PRs:*"));
});

test("a task whose deletion failed after it was marked deleted can be removed again", async (t) => {
  const ts = "1700000000.000100";
  const calls = mockSlack(t, {
    stored: [{ ...withStatus("TODO"), ts }],
    "conversations.replies": (args) => ({ messages: [{ ts: args.ts, bot_id: "BCADE" }] }),
  });
  await seeded;
  await markTaskDeleted(env, "CDEV", ts);
  const ask = (await runTasksCommand(`remove <${messageLink("CDEV", ts)}>`, "CDEV")).later;
  assert.match(ask.text, /should I delete the task \*Fix login\*\?/);

  await answerPrivately(t, ask, "delete:confirm");
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts),
    [ts],
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

test("the ready to review message doesn't link to the team's task", async (t) => {
  const calls = await clientReview(t, {
    stored: [withStatus("IN_TESTING")],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.text?.startsWith("Good news!")).args;
  assert.equal(
    review.text,
    "Good news! <@UACTOR> says this is ready for review.\n<@UCREATOR>, could you take a look and approve it, or let us know what needs to change?",
  );
  assert.ok(!review.text.includes("slack.example/p100"));
  // No link to look up for it.
  assert.ok(!calls.some((call) => call.method === "chat.getPermalink" && call.args.channel === "CDEV"));
});

test("assigning from the task's own thread still doesn't ask them again", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("owner", ["UREX"])));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("@Cade unassign of someone not assigned changes nothing", async (t) => {
  for (const [text, reply] of [
    ["<@UBOT> unassign <@UREX>", "Looks like they aren't assigned to this task."],
    ["<@UBOT> unassign tester <@UALICE>", "Looks like they aren't assigned to this task as tester."],
    ["<@UBOT> unassign <@UREX> <@UBOB>", "Looks like none of them are assigned to this task."],
  ]) {
    const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"], text);
    assert.equal(calls[0].args.text, reply);
  }
});

test("removed reviewers are told they no longer need to review", async (t) => {
  const root = storedTask({ reviewers: ["URIA"] });
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> unassign reviewer <@URIA>"));
  assert.equal(calls.at(-1).args.text, "<@URIA>, there's no need to review this anymore. Thanks!");
});

test("assign-style words without a mention are left alone", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("this was assigned to the wrong sprint, I assigned it to QA board"));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("CHANNEL_PAIRS can be a JSON string, as the Cloudflare dashboard stores it", async (t) => {
  const calls = mockSlack(t);
  const asJson = { ...env, CHANNEL_PAIRS: JSON.stringify(env.CHANNEL_PAIRS) };
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "COTHER" }), {}, asJson);
  assert.equal(calls[0].args.text, "That one works with `@Cade assign owner @person` in a task thread in <#CDEV> or <#CTESTDEV>.");

  const broken = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"), {}, { ...env, CHANNEL_PAIRS: "[{" });
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
    "canvases:write",
    "channels:history",
    // npm run group creates and joins channels, and adds people by email.
    "channels:join",
    "channels:manage",
    "channels:read",
    "chat:write",
    "commands",
    "groups:history",
    "groups:read",
    "groups:write",
    "pins:write",
    // 🎫 and 🔀 on a message convert or move it.
    "reactions:read",
    "reactions:write",
    "users:read",
    "users:read.email",
  ]);
  assert.deepEqual(template.settings.event_subscriptions.bot_events, [
    // Opening the Home tab draws the person's dashboard.
    "app_home_opened",
    "message.channels",
    "message.groups",
    "reaction_added",
  ]);
  assert.equal(template.features.app_home.home_tab_enabled, true);
});

test("opening the Home tab shows the person's open tasks by what they do on them, most urgent first", async (t) => {
  const task = (ts, title, priority, status, people, dueDate = "") => ({
    channel: "CDEV",
    ts,
    task: { ...storedTask().task, title, priority, status, dueDate, people: { owner: [], reviewer: [], tester: [], ...people } },
  });
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      task("1.1", "Low chore", "Low", "TODO", { owner: ["UME"] }),
      task("2.1", "Urgent fix", "Urgent", "IN_PROGRESS", { owner: ["UME"] }, "01/01/2020"),
      task("3.1", "Review me", "High", "IN_REVIEW", { reviewer: ["UME"] }),
      task("4.1", "Not yet testable", "High", "IN_PROGRESS", { tester: ["UME"] }),
      task("5.1", "Someone else's", "Urgent", "TODO", { owner: ["UOTHER"] }),
      task("6.1", "Finished", "Urgent", "DONE", { owner: ["UME"] }),
    ],
  });
  const body = JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UBOT" }],
    event: { type: "app_home_opened", user: "UME", tab: "home" },
  });
  assert.equal((await send("/slack/events", body)).status, 200);

  const [publish] = calls.filter((call) => call.method === "views.publish");
  assert.equal(publish.args.user_id, "UME");
  const text = publish.args.view.blocks.map((block) => blockText(block) ?? "").join("\n");
  // Each task's title links to its thread.
  assert.match(text, /\*<https:\/\/acme\.slack\.com\/archives\/CDEV\/p21\?thread_ts=2\.1&cid=CDEV\|Urgent fix>\*/);
  assert.deepEqual(duplicateActionIds(publish.args.view.blocks), []);
  assert.ok(text.indexOf("Urgent fix") < text.indexOf("Low chore"));
  assert.match(text, /Overdue/);
  assert.match(text, /\|Urgent fix>\*\n:red_circle: Urgent  ·  :arrow_forward: In progress/);
  assert.match(text, /Review me/);
  assert.match(text, /Coming up[^]*Not yet testable/);
  assert.doesNotMatch(text, /Someone else's|Finished/);
  const headers = publish.args.view.blocks.filter((block) => block.type === "header").map(blockText);
  assert.deepEqual(headers, ["Your tasks", ":hammer_and_wrench: To work on (2)", ":eyes: To review (1)", ":test_tube: To test (0)"]);
});

test("the Home tab links a task's notes page right under its title, when it has one", async (t) => {
  const task = (ts, title, notes) => ({
    channel: "CDEV",
    ts,
    task: { ...storedTask().task, title, notes, people: { owner: ["UME"], reviewer: [], tester: [] } },
  });
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [task("1.1", "With notes", { url: NOTES_URL, tab: "t.notes1" }), task("2.1", "Without notes")],
  });
  const body = JSON.stringify({ type: "event_callback", authorizations: [{ user_id: "UBOT" }], event: { type: "app_home_opened", user: "UME", tab: "home" } });
  await send("/slack/events", body);
  const text = calls.find((call) => call.method === "views.publish").args.view.blocks.map((block) => blockText(block) ?? "").join("\n");
  assert.match(text, new RegExp(`\\|With notes>\\*\\nExtra notes <${NOTES_URL.replace(/[.?]/g, "\\$&")}\\|here>\\n`));
  assert.doesNotMatch(text, /Without notes>\*\nExtra notes/);
});

test("the Home tab's buttons switch between My Tasks, Unassigned and All Tasks, and Refresh stays on the view", async (t) => {
  const task = (ts, title, people) => ({
    channel: "CDEV",
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: [], reviewer: [], tester: [], ...people } },
  });
  const stored = [task("1.1", "Mine", { owner: ["UME"] }), task("2.1", "Nobody's", {}), task("3.1", "Theirs", { owner: ["UOTHER"] })];
  const view = async (action_id, value) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    const body = interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id, value }] });
    assert.equal((await send("/slack/interactions", body)).status, 200);
    const [publish] = calls.filter((call) => call.method === "views.publish");
    assert.deepEqual(duplicateActionIds(publish.args.view.blocks), []);
    const buttons = publish.args.view.blocks.flatMap((block) => block.elements ?? []).filter((element) => element.type === "button");
    return { text: publish.args.view.blocks.map((block) => blockText(block) ?? "").join("\n"), primary: buttons.filter((b) => b.style).map((b) => b.text.text) };
  };
  const unassigned = await view("home:tab:unassigned");
  assert.match(unassigned.text, /Nobody's/);
  assert.doesNotMatch(unassigned.text, /Mine|Theirs/);
  assert.deepEqual(unassigned.primary, ["Unassigned"]);
  const all = await view("home:tab:all");
  assert.match(all.text, /Mine[^]*Nobody's[^]*Theirs|Mine[^]*Theirs[^]*Nobody's/);
  assert.doesNotMatch(all.text, /Assign to me/);
  assert.deepEqual(all.primary, ["All Tasks"]);
  const refreshed = await view("home:refresh", "unassigned");
  assert.deepEqual(refreshed.primary, ["Unassigned"]);
  assert.deepEqual((await view("home:tab:mine")).primary, ["My Tasks"]);
});

test("Assign to me on the Home tab's Unassigned view makes the person the owner, unless someone took it", async (t) => {
  const task = (ts, title, people) => ({
    channel: "CDEV",
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: [], reviewer: [], tester: [], ...people } },
  });
  const stored = [task("1.1", "Mine", { owner: ["UME"] }), task("2.1", "Nobody's", {}), task("3.1", "Taken", { owner: ["UOTHER"] })];
  const claim = async (ts) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    const body = interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: `home:claim:CDEV:${ts}` }] });
    assert.equal((await send("/slack/interactions", body)).status, 200);
    return calls;
  };
  const buttons = (calls) => calls.find((call) => call.method === "views.publish").args.view.blocks.flatMap((block) => block.elements ?? []).filter((e) => e.text?.text === "Assign to me");
  const claimed = await claim("2.1");
  assert.equal(claimed.filter((call) => call.method === "chat.update").length, 1);
  assert.equal(claimed.find((call) => call.method === "views.publish").args.user_id, "UME");
  // It is drawn again without the task, now owned.
  assert.deepEqual(buttons(claimed), []);
  const drawn = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored: [task("2.1", "Nobody's", {}), task("1.1", "Mine", { owner: ["UME"] })] });
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:unassigned" }] }));
  assert.deepEqual(buttons(drawn).map((b) => b.action_id), ["home:claim:CDEV:2.1"]);
  const late = await claim("3.1");
  assert.equal(late.filter((call) => call.method === "chat.update").length, 0);
  assert.equal(late.filter((call) => call.method === "views.publish").length, 1);
});

test("the Home tab's project picker keeps the person's project for next time", async (t) => {
  const task = (channel, ts, title) => ({
    channel,
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: ["UME"], reviewer: [], tester: [] } },
  });
  const stored = [task("CDEV", "1.1", "In acme"), task("CTESTDEV", "2.1", "In test")];
  const publishOf = (calls) => calls.find((call) => call.method === "views.publish").args.view;
  const textOf = (view) => view.blocks.map((block) => blockText(block) ?? "").join("\n");
  const interact = (action) => send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, view: { private_metadata: "mine" }, actions: [action] }));

  let calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await interact({ action_id: "home:project", selected_option: { value: "test" } });
  let view = publishOf(calls);
  assert.match(textOf(view), /In test/);
  assert.doesNotMatch(textOf(view), /In acme/);
  const picker = view.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === "home:project");
  assert.equal(picker.initial_option.value, "test");

  // Remembered when the tab is opened later, without the stored tasks being reset.
  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await DB.prepare("INSERT INTO user_preferences (user_id, home_project) VALUES (?, ?)").bind("UME", "test").run();
  await send("/slack/events", JSON.stringify({ type: "event_callback", authorizations: [{ user_id: "UBOT" }], event: { type: "app_home_opened", user: "UME", tab: "home" } }));
  assert.doesNotMatch(textOf(publishOf(calls)), /In acme/);

  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await interact({ action_id: "home:project", selected_option: { value: "all" } });
  view = publishOf(calls);
  assert.match(textOf(view), /In acme[^]*In test|In test[^]*In acme/);
  // The tab is remembered too: it opens on Unassigned after that was last used.
  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await interact({ action_id: "home:tab:unassigned" });
  await send("/slack/events", JSON.stringify({ type: "event_callback", authorizations: [{ user_id: "UBOT" }], event: { type: "app_home_opened", user: "UME", tab: "home" } }));
  assert.match(textOf(calls.filter((call) => call.method === "views.publish").at(-1).args.view), /Unassigned tasks/);
  assert.equal(await DB.prepare("SELECT home_project FROM user_preferences WHERE user_id = ?").bind("UME").first().then((row) => row.home_project), null);
});

test("npm run config checks the activeTasksPinning, summaryCanvas and newMessageTaskDetection switches", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  const set = JSON.parse(readConfig(JSON.stringify({ projects: [{ ...projects[0], activeTasksPinning: false, summaryCanvas: true, newMessageTaskDetection: false }] })).PROJECTS)[0];
  assert.deepEqual([set.activeTasksPinning, set.summaryCanvas, set.newMessageTaskDetection], [false, true, false]);
  assert.throws(() => readConfig(JSON.stringify({ projects: [{ ...projects[0], summaryCanvas: "no" }] })), /acme's summaryCanvas is true or false/);
  assert.throws(() => readConfig(JSON.stringify({ projects, activeTasksPinning: true })), /"activeTasksPinning" at the top; set it on each project/);
  assert.throws(() => readConfig(JSON.stringify({ projects: [{ ...projects[0], activeTasksPinning: 1 }] })), /acme's activeTasksPinning is true or false/);
});

test("pinning and the summary canvas can be turned off, for every group or one", async (t) => {
  const { setPinned, refreshSummary } = await import("../src/tasks.js");
  const pairs = [{ name: "acme", tasks: "CDEV", activeTasksPinning: true }, { name: "test", tasks: "CTESTDEV", summaryCanvas: false }];
  for (const [environment, channel, pins, canvases] of [
    [{ ...env }, "CDEV", 1, true],
    [{ ...env, ACTIVE_TASKS_PINNING: "off", SUMMARY_CANVAS: "off" }, "CDEV", 0, false],
    [{ ...env, ACTIVE_TASKS_PINNING: undefined, SUMMARY_CANVAS: undefined }, "CDEV", 0, false],
    [{ ...env, CHANNEL_PAIRS: pairs, ACTIVE_TASKS_PINNING: "off" }, "CDEV", 1, true],
    [{ ...env, CHANNEL_PAIRS: pairs }, "CTESTDEV", 1, false],
  ]) {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
    await setPinned(environment, channel, "1.1", true);
    await refreshSummary(environment, channel, { create: true });
    assert.equal(calls.filter((call) => call.method === "pins.add").length, pins, JSON.stringify([channel, environment.ACTIVE_TASKS_PINNING]));
    assert.equal(calls.some((call) => /canvas/.test(call.method)), canvases, JSON.stringify([channel, environment.SUMMARY_CANVAS]));
  }
});

test("the Home tab's All Tasks view links the Google Sheet for closed tasks", async (t) => {
  const press = async (environment, action_id) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored: [] });
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id }] }), {}, environment);
    return calls.find((call) => call.method === "views.publish").args.view.blocks.map((block) => blockText(block) ?? "").join("\n");
  };
  const linked = await press(sheetEnv, "home:tab:all");
  assert.match(linked, /Closed and older tasks are in the .*docs\.google\.com\/spreadsheets\/d\/[\w-]+\/edit\|acme>.*\|test>/);
  assert.doesNotMatch(await press(sheetEnv, "home:tab:unassigned"), /spreadsheets/);
  assert.doesNotMatch(await press(env, "home:tab:all"), /spreadsheets/);
});

test("slack:create checks its settings before calling Slack", async () => {
  const { checkSettings } = await import("../scripts/slack-app.mjs");
  assert.deepEqual(checkSettings({ workerUrl: "https://cade.acme.workers.dev", name: "Cade", command: "/cade" }), []);
  assert.equal(checkSettings({ workerUrl: "http://cade", name: "Cade", command: "/cade" }).length, 1);
  assert.equal(checkSettings({ workerUrl: "https://cade.dev", name: "x".repeat(36), command: "/cade" }).length, 1);
  assert.equal(checkSettings({ workerUrl: "https://cade.dev", name: "Cade", command: "cade" }).length, 1);
});

test("npm run config checks the suggestions setting", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  const suggestions = (value) => JSON.parse(readConfig(JSON.stringify({ projects: [{ ...projects[0], taskStatusChangeDetection: value }] })).PROJECTS)[0].taskStatusChangeDetection;
  assert.equal(suggestions(false), false);
  assert.equal(suggestions(true), true);
  assert.throws(() => suggestions(["pr-links"]), /acme's taskStatusChangeDetection is true or false/);
  assert.equal(JSON.parse(readConfig(JSON.stringify({ projects: [{ ...projects[0], suggestions: false }] })).PROJECTS)[0].taskStatusChangeDetection, false, "the old name");
  assert.throws(() => suggestions("off"), /acme's taskStatusChangeDetection is true or false/);
});

test("suggestions can be turned off, all or some, and a kind turned off doesn't hand the message to the next", async (t) => {
  const record = () => {
    const task = ownTask({ owners: ["UDEV1"] });
    task.task.status = "IN_PROGRESS";
    return task;
  };
  for (const [suggestions, text, offered] of [
    [undefined, "<@UREX> please review this", true],
    ["false", "<@UREX> please review this", false],
    ['["hand-offs"]', "<@UREX> please review this", true],
    ['["pr-links"]', "<@UREX> please review this", false],
    // A report is "started": off, it doesn't fall through to the reviewer hand-off.
    ['["hand-offs"]', "<@UREX> started working on the review comments", false],
  ]) {
    const environment = suggestions === undefined ? env : { ...env, TASK_STATUS_CHANGE_DETECTION: suggestions };
    const calls = mockSlack(t, { stored: [record()] });
    await send("/slack/events", threadEvent(text, { user: "UDEV1" }), {}, environment);
    assert.equal(calls.some((call) => call.method === "chat.postEphemeral"), offered, `${suggestions}: ${text}`);
  }
});

test("npm run config turns cade.config.json into the Worker's secrets", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.deepEqual(readConfig(JSON.stringify({ timezone: "Asia/Colombo", projects })), {
    PROJECTS: JSON.stringify(projects),
    TIMEZONE: "Asia/Colombo",
  });
  // The timezone is optional.
  assert.deepEqual(readConfig(JSON.stringify({ projects })), { PROJECTS: JSON.stringify(projects) });
});

test("npm run config stops on a mistake, before uploading anything", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const good = [{ name: "acme", channel: "C0000000002" }];
  for (const [config, problem] of [
    ["{", /not valid JSON/],
    [{ timezone: "UTC" }, /must list \{ name, channel \}/],
    [{ projects: [{ channel: "C0000000002" }] }, /must list \{ name, channel \}/],
    [{ projects: [{ name: "acme" }] }, /must list \{ name, channel \}/],
    [{ projects: [{ name: "acme", channel: "#acme-dev" }] }, /doesn't look like a Slack channel ID/],
    [{ projects: [{ name: "acme", channel: "C0000000001" }, { name: "beta", channel: "C0000000001" }] }, /used twice/],
    [{ projects: good, timezone: "Sri Lanka" }, /isn't a time zone/],
    // A token here would be a mistake: they belong in Cloudflare only.
    [{ projects: good, SLACK_BOT_TOKEN: "xoxb-1" }, /has "SLACK_BOT_TOKEN"; it takes projects and timezone/],
  ]) {
    assert.throws(() => readConfig(typeof config === "string" ? config : JSON.stringify(config)), problem);
  }
});

test("npm run dev passes its settings to Wrangler as a quoted .env file", async () => {
  const { envFile } = await import("../scripts/dev.mjs");
  const pairs = JSON.stringify([{ name: "acme", channel: "C0000000002" }]);
  assert.equal(
    envFile({ PROJECTS: pairs, TIMEZONE: "UTC", SLACK_BOT_TOKEN: "xoxb-1", GOOGLE_URL: undefined }),
    `PROJECTS='${pairs}'\nTIMEZONE='UTC'\nSLACK_BOT_TOKEN='xoxb-1'`,
  );
  assert.throws(() => envFile({ SLACK_SIGNING_SECRET: "it's" }), /can't contain a quote/);
});

test("npm run dev asks for the Google web app's secret only with its URL", async () => {
  const { SECRETS } = await import("../scripts/dev.mjs");
  const googleSecret = SECRETS.find(({ name }) => name === "GOOGLE_SECRET");
  assert.equal(googleSecret.when({}), false);
  assert.equal(googleSecret.when({ GOOGLE_URL: "https://script.google.com/x" }), true);
  assert.deepEqual(SECRETS.filter((secret) => !secret.optional && !secret.when).map(({ name }) => name), [
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
  ]);
});

test("cade.config.json can hold the Google web app's address and each group's doc", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const doc = "https://docs.google.com/document/d/1AcmeDocAcmeDocAcmeDocAcmeDoc/edit";
  const projects = [{ name: "acme", channel: "C0000000002", doc }];
  const googleUrl = "https://script.google.com/macros/s/AKfy-abc/exec";
  const secrets = readConfig(JSON.stringify({ projects, googleUrl }));
  assert.equal(secrets.GOOGLE_URL, googleUrl);
  assert.equal(JSON.parse(secrets.PROJECTS)[0].doc, doc);
  assert.throws(() => readConfig(JSON.stringify({ projects: [{ ...projects[0], doc: "acme doc" }] })), /acme's doc should be a Google Doc's address/);
  assert.throws(() => readConfig(JSON.stringify({ projects, googleUrl: doc })), /googleUrl should be the web app URL/);
  // The old settings, and the secret, stay out of the file.
  assert.throws(() => readConfig(JSON.stringify({ projects, sheetUrl: googleUrl })), /has "sheetUrl"/);
  assert.throws(() => readConfig(JSON.stringify({ projects, googleSecret: "s" })), /has "googleSecret"/);
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

test("handlers' intents are registered in order: work, then new threads", async () => {
  const { intents } = await import("../src/commands/registry.js");
  assert.deepEqual(
    [...intents].sort((a, b) => a.order - b.order).map((each) => each.name),
    ["work", "new-thread"],
  );
});

test("@Cade status takes short names for each status", async () => {
  const { parseStatus } = await import("../src/commands/status.js");
  for (const [input, status] of [
    ["to do", "TODO"], ["todo", "TODO"],
    ["in progress", "IN_PROGRESS"], ["progress", "IN_PROGRESS"], ["wip", "IN_PROGRESS"],
    ["in review", "IN_REVIEW"], ["review", "IN_REVIEW"],
    ["in testing", "IN_TESTING"], ["testing", "IN_TESTING"], ["QA", "IN_TESTING"],
    ["client review", "CLIENT_REVIEW"], ["client", "CLIENT_REVIEW"], ["uat", "CLIENT_REVIEW"],
    ["done", "DONE"], ["Finished", "DONE"], ["CLIENT_REVIEW", "CLIENT_REVIEW"],
    ["soon", undefined],
  ]) {
    assert.equal(parseStatus(input), status, input);
  }
});

test("messages about work already in hand suggest nothing", async (t) => {
  // UDEV1 and UDEV2 develop it, UMIA reviews and UTOM tests, and it's In
  // progress: none of these needs a question.
  const task = () => {
    const record = ownTask({ owners: ["UDEV1", "UDEV2"], reviewers: ["UMIA"], testers: ["UTOM"] });
    record.task.status = "IN_PROGRESS";
    return record;
  };
  for (const [user, text] of [
    ["UDEV1", "<@UDEV2> started working on some subtask"],
    ["UDEV1", "<@UDEV2> started working on the review comments"],
    ["UDEV1", "<@UDEV2> started working on the test cases"],
    ["UDEV1", "<@UDEV2> is working on the login part"],
    ["UDEV1", "<@UDEV2> started on the subtask"],
    ["UDEV1", "<@UMIA> started working on the review"],
    ["UDEV1", "<@UTOM> is working on the test plan"],
    ["UMIA", "started working on the review"],
    ["UTOM", "started working on the test cases"],
    ["UDEV2", "finished the login subtask"],
    ["UDEV2", "first part is done"],
    ["UDEV2", "fixed one of the bugs"],
  ]) {
    const calls = mockSlack(t, { stored: [task()] });
    await send("/slack/events", threadEvent(text, { user }));
    assert.deepEqual(calls.map((call) => call.method), [], `${user}: ${text}`);
  }
});

test("npm run google:create makes Secret.gs, finds the deployment and sets googleUrl", async () => {
  const { deploymentIdIn, secretFile, webAppUrl, withGoogleUrl } = await import("../scripts/google-app.mjs");
  const secret = "a".repeat(64);
  assert.match(secretFile(secret), new RegExp(`^// .*GOOGLE_SECRET.*\\nconst SECRET = "${secret}";\\n$`));
  assert.throws(() => secretFile("short"), /long and hex/);

  // clasp prints the HEAD deployment too; the new one is wanted.
  const output = "Deployed AKfycbHEAD000000000000000000000 @HEAD\nDeployed AKfycbNEW1111111111111111111111-x @1\n";
  assert.equal(deploymentIdIn(output), "AKfycbNEW1111111111111111111111-x");
  assert.equal(deploymentIdIn("nothing here"), undefined);
  assert.equal(webAppUrl("AKfycbNEW1"), "https://script.google.com/macros/s/AKfycbNEW1/exec");

  // Other settings in cade.config.json are kept.
  const config = JSON.parse(withGoogleUrl('{"timezone":"UTC","channels":[]}', "https://script.google.com/macros/s/X/exec"));
  assert.deepEqual(config, { timezone: "UTC", channels: [], googleUrl: "https://script.google.com/macros/s/X/exec" });

  // npm run group takes a doc or spreadsheet you have by its address or ID.
  const { fileIdIn } = await import("../scripts/group.mjs");
  const id = "1AcmeDocAcmeDocAcmeDocAcmeDoc";
  assert.equal(fileIdIn(`https://docs.google.com/document/d/${id}/edit?tab=t.0`, "doc"), id);
  assert.equal(fileIdIn(id, "doc"), id);
  assert.equal(fileIdIn(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`, "sheet"), id);
  assert.throws(() => fileIdIn(`https://docs.google.com/spreadsheets/d/${id}/edit`, "doc"), /--doc should be new, none, or the Google Doc's address/);
});

test("the Google web app checks SECRET from Secret.gs, and each action has its function", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (file) => readFile(new URL(`../google/${file}`, import.meta.url), "utf8");
  const code = await read("Code.gs");
  assert.match(code, /body\.secret !== SECRET/);
  assert.match(code, /function authorize\(\)/);
  const all = [code, await read("Sheet.gs"), await read("Doc.gs")].join("\n");
  assert.ok(!all.includes("getScriptProperties"), "no script properties left to set by hand");
  // Each action calls a function one of the files defines.
  const actions = /const ACTIONS = \{([\s\S]*?)\n\};/.exec(code)[1];
  assert.deepEqual([...actions.matchAll(/"([a-z]+\.[a-z]+)"/g)].map(([, name]) => name), ["sheet.row", "sheet.create", "doc.write", "doc.task", "doc.export", "doc.read", "doc.create"]);
  for (const [, name] of actions.matchAll(/(?:\(|: )([a-zA-Z]+)\(body/g)) {
    assert.match(all, new RegExp(`function ${name}\\(`), name);
  }
  const ignore = await read(".claspignore");
  assert.deepEqual(ignore.split("\n").filter((line) => line.startsWith("!")), ["!Code.gs", "!Sheet.gs", "!Doc.gs", "!Secret.gs", "!appsscript.json"]);
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
  const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UTESS>"));

  // Slack is only written to: nothing is read back from it.
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.update",
    "reactions.add",
    "chat.postMessage",
    "chat.update",
    "reactions.add",
  ]);
  assert.deepEqual((await savedTask()).people, { owner: ["UALICE", "UBOB"], reviewer: [], tester: ["UTESS"] });
  assert.equal(
    footerLines(calls[3].args)[0],
    "Owner <@UALICE>, <@UBOB>  ·  Test <@UTESS>",
  );
});

test("a thread with no stored task isn't one", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  // The task is in CDEV; the same ts in another channel is a different message.
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "CTESTDEV" }));
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
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.match(calls[0].args.text, /not tracking a task in this thread/);
});

test("the sheet uses the task's stored link instead of looking it up", async (t) => {
  const record = storedTask();
  record.task.link = "https://slack.example/stored";
  const calls = mockSlack(t, { ...slackUsers, stored: [record] });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.ok(!calls.some((call) => call.method === "chat.getPermalink"));
  assert.equal(sheetRow(calls)["Task link"], "https://slack.example/stored");
});

// Tasks are stored before they are posted; those Slack refused are posted
// again by the cron.

// Runs the cron, as Cloudflare does, and waits for its work.
async function runCron(environment = env) {
  await seeded;
  const pending = [];
  await worker.scheduled({ cron: "*/5 * * * *" }, environment, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
}

// Makes every stored row look `minutes` old, as if posting failed back then.
const age = (minutes = 2) =>
  DB.prepare("UPDATE tasks SET created_at = datetime('now', ?)").bind(`-${minutes} minutes`).run();

// A task tracked with /cade task that Slack refused `attempts` times.
async function waitingTask(attempts = 1) {
  const { task } = storedTask();
  const id = await insertTask(env, "CDEV", task, {});
  await DB.prepare("UPDATE tasks SET post_attempts = ? WHERE id = ?").bind(attempts, id).run();
  return id;
}

test("the cron posts a task Slack refused, and finishes tracking it", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [] });
  await waitingTask();
  await age();
  await runCron();

  assert.deepEqual(withoutSummary(calls).map((call) => call.method), ["chat.postMessage", "chat.getPermalink", "pins.add"]);
  assert.equal(calls[0].args.channel, "CDEV");
  const task = await savedTask();
  assert.equal(task.title, "Fix login");
  assert.equal(task.link, "https://slack.example/p100");
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
  // Given up: not tried again.
  calls.length = 0;
  await runCron();
  assert.equal(calls.length, 0);
  assert.ok(await DB.prepare("SELECT 1 FROM tasks WHERE deleted_at IS NOT NULL").first());
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
      historyTask("100.1", { title: "Bob's", owners: ["UBOB"] }),
      historyTask("100.2", { title: "Mine", owners: ["UACTOR"] }),
      historyTask("100.3", { title: "Both", reviewers: ["UBOB", "UACTOR"] }),
    ],
  });
  assert.deepEqual(calls.map((call) => call.method).sort(), ["auth.test", "users.info"]);
  assert.equal(later.text, "<@UBOB> has 2 open acme tasks.");
  assert.equal(later.blocks[0].text.text, "Bob's acme tasks");
  assert.match(later.blocks[1].text.text, /^\*Owned \(1\)\*\n• <[^|]+\|Bob's>/);
  assert.match(later.blocks[2].text.text, /^\*Reviewing \(1\)\*\n• <[^|]+\|Both>/);

  // Naming yourself is the same as naming no one.
  const mine = await tasksCommand(t, "tasks <@UACTOR>", "CDEV", { CDEV: [historyTask("100.1", { owners: ["UACTOR"] })] });
  assert.equal(mine.later.text, "You have 1 open acme task.");

  const none = await tasksCommand(t, "tasks review <@UBOB>", "CDEV", { CDEV: [historyTask("100.1", { owners: ["UBOB"] })] });
  assert.equal(none.later.text, "<@UBOB> has no open acme reviewing tasks.");
  assert.equal(none.later.blocks[1].text.text, "<@UBOB> has no open tasks.");
});

test("/cade tasks -all shows everyone's tasks by status, with who works on them", async (t) => {
  const { later } = await tasksCommand(t, "tasks -all", "CDEV", {
    CDEV: [
      historyTask("100.1", { title: "Unassigned" }),
      historyTask("100.2", { title: "Shared", owners: ["UALICE"], testers: ["UBOB", "UALICE"], status: "IN_TESTING" }),
      historyTask("100.3", { title: "Finished", owners: ["UALICE"], status: "DONE" }),
    ],
  });
  assert.equal(later.text, "There are 2 open acme tasks.");
  // Links left out, as other tests check them.
  assert.deepEqual(
    later.blocks.map((block) => block.text.text.replace(/<https:[^|]+\|/g, "<")),
    [
      "All acme tasks",
      "*To do (1)*\n• <Unassigned>  ·  :memo: To do  ·  :large_orange_circle: High  ·  Due 31/10/2026  ·  _Unassigned_",
      "*In testing (1)*\n• <Shared>  ·  :test_tube: In testing  ·  :large_orange_circle: High  ·  Due 31/10/2026  ·  <@UALICE>, <@UBOB>",
    ],
  );
});

test("/cade tasks -status shows only those statuses, Done included when named", async (t) => {
  const stored = {
    CDEV: [
      historyTask("100.1", { title: "Started", owners: ["UACTOR"], status: "IN_PROGRESS" }),
      historyTask("100.2", { title: "Waiting", owners: ["UACTOR"] }),
      historyTask("100.3", { title: "Finished", owners: ["UACTOR"], status: "DONE" }),
    ],
  };
  const progress = await tasksCommand(t, "tasks -status=in-progress", "CDEV", stored);
  assert.equal(progress.later.text, "You have 1 acme task: In progress.");
  // The filter is shown under the header.
  assert.equal(progress.later.blocks[1].elements[0].text, "In progress");
  assert.match(progress.later.blocks[2].text.text, /\|Started>/);

  const several = await tasksCommand(t, "tasks -status=done,to-do", "CDEV", stored);
  assert.equal(several.later.text, "You have 2 acme tasks: Done, To do.");

  const none = await tasksCommand(t, "tasks -status=client-review", "CDEV", stored);
  assert.equal(none.later.text, "You have no acme tasks: Client review.");
  assert.equal(none.later.blocks[2].text.text, "You have no matching tasks.");
});

test("/cade tasks -due compares due dates with today, tomorrow or a date", async (t) => {
  const stored = {
    CDEV: [
      historyTask("100.1", { title: "Late", owners: ["UACTOR"], dueDate: dueIn(-1) }),
      historyTask("100.2", { title: "Today", owners: ["UACTOR"], dueDate: dueIn(0) }),
      historyTask("100.3", { title: "Tomorrow", owners: ["UACTOR"], dueDate: dueIn(1) }),
      historyTask("100.4", { title: "Someday", owners: ["UACTOR"], dueDate: "" }),
      // Immediate counts as today.
      historyTask("100.5", { title: "Down", owners: ["UACTOR"], dueDate: "Immediate" }),
    ],
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
    const { later } = await tasksCommand(t, `tasks ${filter}`, "CDEV", stored, env);
    assert.deepEqual(titles(later), expected, filter);
    assert.equal(later.blocks[1].elements[0].text, label, filter);
  }
});

test("/cade tasks options combine, in any order", async (t) => {
  const { later } = await tasksCommand(t, "tasks -due&lt;@today <@UBOB> dev -status=in-progress", "CDEV", {
    CDEV: [
      historyTask("100.1", { title: "Match", owners: ["UBOB"], status: "IN_PROGRESS", dueDate: dueIn(-2) }),
      historyTask("100.2", { title: "Not late", owners: ["UBOB"], status: "IN_PROGRESS", dueDate: dueIn(2) }),
      historyTask("100.3", { title: "Reviewing", reviewers: ["UBOB"], status: "IN_PROGRESS", dueDate: dueIn(-2) }),
      historyTask("100.4", { title: "To do", owners: ["UBOB"], dueDate: dueIn(-2) }),
    ],
  });
  assert.equal(later.text, "<@UBOB> has 1 acme owned task: In progress  ·  Due before today.");
  assert.equal(later.blocks[0].text.text, "Bob's acme tasks: Owned");
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

// /cade standup: the group's open tasks, one owner at a time, privately.

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
    historyTask("100.1", { title: "Bob's low", priority: "Low", owners: ["UBOB"] }),
    historyTask("100.2", { title: "Bob's urgent", priority: "Urgent", owners: ["UBOB"], status: "IN_PROGRESS" }),
    historyTask("100.3", { title: "Alice's", owners: ["UALICE"] }),
    historyTask("100.4", { title: "Mine", owners: ["UACTOR"], status: "IN_REVIEW" }),
    historyTask("100.5", { title: "Nobody's", testers: ["UALICE"] }),
    historyTask("100.6", { title: "Done already", owners: ["UALICE"], status: "DONE" }),
  ],
});

test("/cade standup starts with whoever runs it, then everyone by name, then tasks with no owner", async (t) => {
  const { now, later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  assert.equal(now, "");
  assert.equal(later.response_type, "ephemeral");
  assert.equal(later.blocks[0].text.text, "*Standup: <@UACTOR>*  ·  1 of 4");
  assert.equal(later.blocks[1].elements[0].text, "1 open task  ·  acme");
  const [mine] = later.blocks.filter((block) => block.accessory);
  assert.match(mine.text.text, /\|Mine>  ·  :eyes: In review/);
  assert.equal(mine.accessory.type, "static_select");
  assert.equal(mine.accessory.initial_option.value, "IN_REVIEW");
  assert.deepEqual(buttonsOf(later), [["Next: Alice ▶", "standup:next"], ["End", "standup:end"]]);

  const alice = await clickButton(t, later, "Next: Alice ▶");
  assert.equal(alice.replace_original, true);
  assert.equal(alice.blocks[0].text.text, "*Standup: <@UALICE>*  ·  2 of 4");
  // Done tasks are left out.
  assert.equal(alice.blocks[1].elements[0].text, "1 open task  ·  acme");
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

  const nobody = await clickButton(t, bob, "Next: No owner ▶");
  assert.equal(nobody.blocks[0].text.text, "*Standup: no owner yet*  ·  4 of 4");
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

test("/cade standup -unassigned goes through tasks with no owner, one at a time, to assign them", async (t) => {
  const { calls, later } = await tasksCommand(t, "standup -unassigned", "CDEV", {
    CDEV: [
      historyTask("100.1", { title: "Low", priority: "Low" }),
      historyTask("100.2", { title: "Urgent", priority: "Urgent" }),
      historyTask("100.3", { title: "Taken", owners: ["UBOB"] }),
    ],
  });
  assert.equal(later.blocks[0].text.text, "*Unassigned acme tasks*  ·  1 of 2");
  const first = later.blocks.find((block) => block.accessory);
  assert.match(first.text.text, /\|Urgent>/);
  assert.deepEqual(buttonsOf(later), [["Skip ▶", "standup:next"], ["End", "standup:end"]]);

  calls.length = 0;
  const sent = recordResponses(t);
  await send(
    "/slack/interactions",
    standupClick({ action_id: first.accessory.action_id, block_id: first.block_id, selected_user: "UALICE" }),
  );
  assert.deepEqual((await savedTask("CDEV", "100.2")).people.owner, ["UALICE"]);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.2");
  assert.equal(
    post.text,
    "<@UACTOR> assigned <@UALICE> as owner.\n<@UALICE>, could you pick this up when you get a chance? Thanks!",
  );
  // Assigned, it leaves the walk: the next one takes its place.
  const next = sent.at(-1);
  assert.equal(next.blocks[0].text.text, "*Unassigned acme tasks*  ·  1 of 1");
  assert.match(next.blocks.find((block) => block.accessory).text.text, /\|Low>/);
  assert.deepEqual(buttonsOf(next), [["Finish", "standup:end"]]);

  const last = next.blocks.find((block) => block.accessory);
  await send(
    "/slack/interactions",
    standupClick({ action_id: last.accessory.action_id, block_id: last.block_id, selected_user: "UBOB" }),
  );
  assert.equal(sent.at(-1).text, "Every open acme task has an owner. Nice!");
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
  assert.equal(empty.later.text, "No one has open acme tasks right now.");

  const wrong = await tasksCommand(t, "standup everyone", "CDEV", {});
  assert.equal(
    JSON.parse(wrong.now).text,
    'I don\'t know "everyone" as an option. Send `/cade standup` to go through everyone\'s tasks, or `/cade standup -unassigned` for those with no owner.',
  );
  // It's the team's, so it runs in its channels.
  const outside = await tasksCommand(t, "standup", "COTHER", {});
  assert.equal(JSON.parse(outside.now).text, "That one works with `/cade standup` in <#CDEV> or <#CTESTDEV>.");
});

test("/cade tasks -unassigned lists open tasks with no owner", async (t) => {
  const { later } = await tasksCommand(t, "tasks -unassigned", "CDEV", standupTasks());
  assert.equal(later.text, "There is 1 open acme unassigned task.");
  assert.equal(later.blocks[0].text.text, "Unassigned acme tasks");
  assert.match(later.blocks[1].text.text, /^\*To do \(1\)\*\n• <[^|]+\|Nobody's>.*<@UALICE>$/);
  assert.equal(parseTaskFilters("-unassigned <@UBOB>").error.split(" Try ")[0], "`-unassigned` shows tasks with no owner, so it can't take a role or a person.");
  assert.equal(parseTaskFilters("-all -unassigned").error.split(" Try ")[0], "Use `-all` or `-unassigned`, not both.");
});

// `@Cade release`: some of a task's PRs sent to the client.

// The task with `prs` linked and `releases` sent already (their ids are 1,
// 2, … in order).
const releaseThreads = (prs, releases = [], status = "IN_PROGRESS") => {
  const task = withStatus(status);
  task.task.prs = prs;
  task.task.releases = releases;
  task.task.people.owner = ["UDEV"];
  return { stored: [task] };
};

const releaseSubmission = (prs, note = "Login and sign-up", approver = "UCREATOR") =>
  interaction({
    type: "view_submission",
    user: { id: "UDEV" },
    view: {
      callback_id: "release",
      private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", responseUrl: RESPONSE_URL }),
      state: {
        values: {
          prs: { value: { selected_options: prs.map((value) => ({ value })) } },
          note: { value: { value: note } },
          approver: { value: { selected_user: approver } },
        },
      },
    },
  });

const releaseClick = (actionId, id = 1) =>
  interaction({
    type: "block_actions",
    user: { id: "UCLIENT" },
    channel: { id: "CDEV" },
    message: {
      ts: "100.9",
      thread_ts: "100.1",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "<@UDEV> sent these PRs for your approval" } }],
    },
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.1", id }) }],
  });

const inReview = (prs) => ({ prs, note: "Login and sign-up", status: "PENDING_APPROVAL", sentBy: "UDEV" });

// What's shown of a task's releases.
const releasesOf = async () =>
  (await savedTask()).releases.map(({ prs, note, status, sentBy, decidedBy }) => ({ prs, note, status, sentBy, decidedBy }));

// The PR sections of the task's card at `ts`, as last rendered.
const shownPrs = (calls, ts = "100.1") => {
  const { args } = calls.findLast((call) => call.method === "chat.update" && call.args.ts === ts);
  return allBlocks(args)
    .map((block) => blockText(block) ?? "")
    .flatMap((text) => text.split("\n"))
    .filter((text) => /^\*(Approved|Pending approval|Pending):\*/.test(text))
    .join("\n");
};
const rootPrs = (calls) => shownPrs(calls);

test("@Cade release needs a task with PRs not sent yet", async (t) => {
  const cases = [
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
  // Only whoever asked sees the button.
  assert.equal(calls.at(-1).method, "chat.postEphemeral");
  assert.equal(calls.at(-1).args.user, "UACTOR");
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
      response_url: RESPONSE_URL,
      actions: [{ action_id: "release:open", value: button.value }],
    }),
  );
  const view = calls.at(-1).args.view;
  assert.equal(view.callback_id, "release");
  assert.deepEqual(JSON.parse(view.private_metadata), { channel: "CDEV", ts: "100.1", responseUrl: RESPONSE_URL });
  assert.deepEqual(view.blocks[0].element.options, [
    { text: { type: "plain_text", text: "web-app/118" }, value: MR },
  ]);
  assert.equal(view.blocks[0].element.type, "checkboxes");
});

test("the release form needs PRs and what they complete", async (t) => {
  mockSlack(t, releaseThreads([PR]));
  const response = await send("/slack/interactions", releaseSubmission([], "", null));
  assert.deepEqual((await response.json()).errors, {
    prs: "Please choose at least one PR.",
    note: "Please say what these PRs complete.",
    approver: "Please choose who approves them.",
  });
});

test("Approve marks the PRs approved and tells the task's thread", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR], [inReview([PR])]),
    "chat.getPermalink": { permalink: "https://slack.example/release" },
  });
  await send("/slack/interactions", releaseClick("release:approve"));

  assert.deepEqual(await releasesOf(), [{ ...inReview([PR]), status: "APPROVED", decidedBy: "UCLIENT" }]);
  assert.equal(rootPrs(calls), `*Approved:* Login and sign-up (<${PR}|cade/42>)\n*Pending:* <${MR}|web-app/118>`);

  const told = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(told.channel, "CDEV");
  assert.equal(told.thread_ts, "100.1");
  assert.equal(
    told.text,
    `<@UDEV>, good news! <@UCLIENT> approved <${PR}|cade/42>.`,
  );
  const decided = calls.at(-1).args;
  assert.equal(decided.ts, "100.9");
  assert.equal(
    decided.text,
    `<@UDEV> sent these PRs for your approval\n<@UCLIENT> approved them. Thanks, <@UDEV>!`,
  );
});

test("Not approve removes the release and tells the task's thread", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR], [inReview([PR])]),
    "chat.getPermalink": { permalink: "https://slack.example/release" },
  });
  await send("/slack/interactions", releaseClick("release:reject"));

  // It is kept as turned down, and no longer shown.
  assert.deepEqual(await releasesOf(), []);
  const rejected = await DB.prepare("SELECT status, decided_by FROM releases").first();
  assert.deepEqual({ ...rejected }, { status: "NOT_APPROVED", decided_by: "UCLIENT" });
  assert.equal(rootPrs(calls), `*Pending:* <${PR}|cade/42>, <${MR}|web-app/118>`);
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

test("a Done task shows every release as approved", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR], [inReview([PR])], "CLIENT_REVIEW"),
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  await send("/slack/interactions", reviewClick("status:approve"));
  // The release in review was approved with the rest.
  assert.equal(
    rootPrs(calls),
    `*Approved:* Login and sign-up (<${PR}|cade/42>)  ·  The rest of the task (<${MR}|web-app/118>)`,
  );
});

test("a Done task after a release lists the rest as its last release", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR], [{ ...inReview([PR]), status: "APPROVED" }], "CLIENT_REVIEW"),
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  await send("/slack/interactions", reviewClick("status:approve"));
  assert.equal(rootPrs(calls), `*Approved:* Login and sign-up (<${PR}|cade/42>)  ·  The rest of the task (<${MR}|web-app/118>)`);
});

// In the dev channel: a message at 100.7, posted on its own, and tasks to
// move it to.
const devStray = { ts: "100.7", user: "UACTOR", text: "The login bug also hits SSO\nfor some people" };
const devTask = (ts, title, status, fields = {}) => {
  const record = storedTask();
  Object.assign(record, { ts });
  Object.assign(record.task, { title, status, ...fields });
  return record;
};

// A Slack API where conversations.replies gives `root` as the thread's root,
// posts get a ts in their thread, and permalinks end with the message's ts.
const moveSlack = (root = devStray, replies = []) => ({
  "conversations.replies": { messages: root ? [root, ...replies] : [] },
  "chat.postMessage": (args) => (args.thread_ts ? { ts: `${args.thread_ts.split(".")[0]}.9` } : { channel: args.channel, ts: "100.1" }),
  "chat.getPermalink": (args) => ({ permalink: `https://slack.example/${args.message_ts}` }),
});

// `@Cade move`, replied in the stray message's thread.
const moveEvent = (overrides = {}) => threadEvent("<@UBOT> move", { ts: "100.8", thread_ts: "100.7", ...overrides });

// Clicks Move on the picker, with `picked` (a task's ts) chosen.
const moveClick = (picked, actionId = "move:confirm") =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    state: { values: { "move:target": { "move:pick": { selected_option: picked ? { value: picked } : null } } } },
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.7" }) }],
  });

// Cade's note under a message it moved already.
const movedNote = {
  ts: "100.71",
  bot_id: "BCADE",
  text: "<@UACTOR> moved this message to the task thread <https://slack.example/100.9|Fix login>. Please carry on the conversation there.",
};

const optionsOf = (element) => element.options.map((option) => [option.text.text, option.value]);

test("@Cade move offers the channel's open tasks, newest first, incidents labelled", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack(),
    stored: [
      devTask("100.1", "Fix login", "IN_PROGRESS"),
      devTask("100.2", "Old work", "DONE"),
      devTask("100.3", "Checkout is down", "TODO", { incident: true }),
    ],
  });
  await send("/slack/events", moveEvent());
  const picker = calls.at(-1).args;
  assert.equal(picker.user, "UACTOR");
  assert.deepEqual(optionsOf(picker.blocks[1].elements[0]), [
    ["To do · Incident · Checkout is down", "100.3"],
    ["In progress · Fix login", "100.1"],
  ]);
});

test("@Cade move says why it can't move a message", async (t) => {
  for (const [event, stored, root, text] of [
    [moveEvent({ ts: "100.7", thread_ts: undefined }), [], devStray, "Reply `@Cade move` in the thread of the message you want to move."],
    [moveEvent({ thread_ts: "100.1" }), [storedTask()], devStray, "This is already a task thread."],
    [moveEvent(), [], { ...devStray, bot_id: "BOTHER" }, "I can only move people's messages."],
    [moveEvent(), [devTask("100.1", "Done", "DONE")], devStray, "There are no open tasks there. Start one with `/cade task`."],
  ]) {
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    await send("/slack/events", event);
    assert.equal(calls.at(-1).args.text, text);
  }

  // A message moved already is pointed to, privately.
  const calls = mockSlack(t, moveSlack(devStray, [movedNote]));
  await send("/slack/events", moveEvent());
  assert.equal(calls.at(-1).method, "chat.postEphemeral");
  assert.equal(calls.at(-1).args.text, "This message was already moved: <https://slack.example/100.9|see it there>.");
});

test("Move copies the message into the task's thread and points the original there", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick("100.1"));
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.channel, call.args.thread_ts, call.args.text]);
  assert.deepEqual(posts, [
    ["CDEV", "100.1", "Moved from <@UACTOR>'s <https://slack.example/100.7?thread_ts=100.7&cid=CDEV|message>:\n> The login bug also hits SSO\n> for some people"],
    ["CDEV", "100.7", "<@UACTOR> moved this message to the task thread <https://slack.example/100.9|Fix login>. Please carry on the conversation there."],
  ]);
  assert.ok(calls.some((call) => call.method === "reactions.add" && call.args.timestamp === "100.7" && call.args.name === "outbox_tray"));
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Move says an incident thread, notes attachments, and unpins a pinned message", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack({ ...devStray, files: [{ id: "F1" }], pinned_to: ["CDEV"] }),
    stored: [devTask("100.1", "Checkout is down", "TODO", { incident: true })],
  });
  recordResponses(t);
  await send("/slack/interactions", moveClick("100.1"));
  const [copy, note] = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.text);
  assert.match(copy, /\n_There's more in the original\._$/);
  assert.match(note, /moved this message to the incident thread/);
  assert.ok(calls.some((call) => call.method === "pins.remove" && call.args.timestamp === "100.7"));
});

test("Move moves nothing if the task was closed or the message deleted since", async (t) => {
  for (const [stored, root, text] of [
    [[devTask("100.1", "Fix login", "DONE")], devStray, "That task has been closed or deleted since, so I didn't move anything."],
    [[devTask("100.1", "Fix login", "TODO")], null, "That message has been deleted since, so there's nothing to move."],
  ]) {
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    const responses = recordResponses(t);
    await send("/slack/interactions", moveClick("100.1"));
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
    assert.equal(responses[0].text, text);
  }
});

test("Move without a pick asks for one, and Cancel removes the picker", async (t) => {
  const calls = mockSlack(t, { stored: [devTask("100.1", "Fix login", "TODO")] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick(null));
  assert.equal(calls[0].args.text, "Pick where it goes first, then press Move.");
  await send("/slack/interactions", moveClick(null, "move:cancel"));
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("a move stands without its reaction, and a thread that's gone can't be moved", async (t) => {
  let calls = mockSlack(t, { ...moveSlack(), "reactions.add": { ok: false, error: "already_reacted" }, stored: [devTask("100.1", "Fix login", "TODO")] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick("100.1"));
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 2);
  assert.deepEqual(responses.at(-1), { response_type: "ephemeral", delete_original: true });

  calls = mockSlack(t, { "conversations.replies": { ok: false, error: "message_not_found" }, stored: [devTask("100.1", "Fix login", "TODO")] });
  await send("/slack/events", moveEvent());
  assert.equal(calls.at(-1).args.text, "I can only move people's messages.");
});

// `@Cade move <link>`, replied in the stray message's thread. The task
// linked to is at TARGET.
const TARGET = "1700000000.000100";
const messageLink = (channel, ts, query = "") => `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}${query}`;

test("@Cade move with a link moves the message there straight away and acknowledges it", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask(TARGET, "Fix login", "IN_PROGRESS")] });
  await send("/slack/events", moveEvent({ text: `<@UBOT> move <${messageLink("CDEV", TARGET, `?thread_ts=${TARGET}&cid=CDEV`)}|link>` }));
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.thread_ts),
    [TARGET, "100.7"],
  );
  assert.deepEqual(calls.at(-1).args, { channel: "CDEV", timestamp: "100.8", name: "white_check_mark" });
});

test("@Cade move with a link says why it can't move the message", async (t) => {
  for (const [stored, text] of [
    [[], "That link isn't to a task. Use Copy link on its message."],
    [[devTask(TARGET, "Fix login", "DONE")], "That task is done, so I didn't move anything."],
  ]) {
    const calls = mockSlack(t, { ...moveSlack(), stored });
    await send("/slack/events", moveEvent({ text: `<@UBOT> move <${messageLink("CDEV", TARGET)}>` }));
    assert.equal(calls.at(-1).args.text, text);
  }
});

// Choosing Cade's message shortcut `callbackId` (⋯ → More actions) on
// `message` in `channel`, a DM to begin with.
const shortcutClick = (callbackId, message = { ts: "500.1", user: "UBOB", text: "Customers can't pay\nsince the deploy" }, channel = "D0BOB") =>
  interaction({
    type: "message_action",
    callback_id: callbackId,
    trigger_id: "T1",
    response_url: RESPONSE_URL,
    team: { domain: "acme" },
    user: { id: "UACTOR" },
    channel: { id: channel },
    message,
  });

const projectOptions = (view) => view.blocks[0].element.options.map((option) => [option.text.text, option.value]);

test("Make new task and Make new incident open their forms, with the project outside a dev channel", async (t) => {
  for (const [callbackId, callback] of [["convert", "track"], ["incident", "incident"]]) {
    let calls = mockSlack(t);
    await send("/slack/interactions", shortcutClick(callbackId));
    let { view } = calls[0].args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].block_id, "project");
    assert.deepEqual(projectOptions(view), [["acme", "CDEV"], ["test", "CTESTDEV"]]);
    assert.equal(view.blocks[1].element.initial_value, "Customers can't pay");
    const origin = JSON.parse(view.private_metadata);
    assert.equal(origin.channel, undefined);
    assert.deepEqual(origin.move, {
      channel: "D0BOB",
      ts: "500.1",
      threadTs: "500.1",
      author: "UBOB",
      text: "Customers can't pay\nsince the deploy",
      files: false,
      pinned: false,
      link: "https://acme.slack.com/archives/D0BOB/p5001?thread_ts=500.1&cid=D0BOB",
    });

    // In a dev channel, the form is for that channel's project.
    calls = mockSlack(t, moveSlack());
    await send("/slack/interactions", shortcutClick(callbackId, devStray, "CDEV"));
    ({ view } = calls.find((call) => call.method === "views.open").args);
    assert.notEqual(view.blocks[0].block_id, "project");
    assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");
  }
});

test("a task made from a message anywhere goes to the chosen project, and the message is copied into it", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), "reactions.add": { ok: false, error: "channel_not_found" } });
  const opened = mockSlack(t);
  await send("/slack/interactions", shortcutClick("convert"));
  const { view } = opened[0].args;
  const all = mockSlack(t, { ...moveSlack(), "chat.postMessage": (args) => (args.channel === "D0BOB" ? { ok: false, error: "channel_not_found" } : moveSlack()["chat.postMessage"](args)) });

  // Without a project, the form says to choose one.
  const values = (project) => ({
    ...(project && { project: { value: { selected_option: { value: project } } } }),
    title: { value: { value: "Payments down" } },
    due_date: { value: { selected_date: null } },
    priority: { value: { selected_option: { value: "High" } } },
  });
  const submit = (project) =>
    send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "track", private_metadata: view.private_metadata, state: { values: values(project) } } }));
  const refused = await (await submit(null)).json();
  assert.deepEqual(refused, { response_action: "errors", errors: { project: "Please choose a project." } });

  await submit("CTESTDEV");
  const posts = all.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.channel, call.args.thread_ts, call.args.text]);
  assert.deepEqual(posts.slice(0, 2), [
    ["CTESTDEV", undefined, "High task: Payments down"],
    ["CTESTDEV", "100.1", "Moved from <@UBOB>'s <https://acme.slack.com/archives/D0BOB/p5001?thread_ts=500.1&cid=D0BOB|message>:\n> Customers can't pay\n> since the deploy"],
  ]);
  // Cade isn't in the DM, so the note under the original is tried and the
  // task stands without it.
  assert.deepEqual(posts[2].slice(0, 2), ["D0BOB", "500.1"]);
  assert.ok((await savedTask("CTESTDEV")).title, "Payments down");
  assert.equal(calls.length, 0);
});

test("Make new incident reports an urgent incident in the dev channel, labelled on its card", async (t) => {
  const calls = mockSlack(t, moveSlack());
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "incident",
        private_metadata: JSON.stringify({ channel: "CDEV", move: { channel: "CDEV", ts: "100.7" } }),
        state: { values: { title: { value: { value: "Checkout is down" } } } },
      },
    }),
  );
  const card = calls.find((call) => call.method === "chat.postMessage" && !call.args.thread_ts).args;
  assert.equal(card.text, "Urgent incident: Checkout is down");
  assert.equal(allBlocks(card)[0].text.text, "[URGENT] [Incident] *Checkout is down*");
  assert.equal(blockText(allBlocks(card)[1]), ":memo: To do  ·  Due Immediate");
  assert.match(footerLines(card)[1], /^Reported by <@UACTOR>$/);
  const task = await savedTask();
  assert.deepEqual([task.incident, task.priority, task.dueDate], [true, "Urgent", "Immediate"]);
  const notes = calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.7");
  assert.match(notes[0].args.text, /moved this message to the incident thread/);
});

test("Move to existing outside a dev channel asks for the project, then lists its open tasks", async (t) => {
  const stored = [devTask("100.1", "Fix login", "IN_PROGRESS"), devTask("100.3", "Checkout is down", "TODO", { incident: true })];
  let calls = mockSlack(t, { stored });
  await send("/slack/interactions", shortcutClick("move"));
  let { view } = calls[0].args;
  assert.equal(view.callback_id, "move:form");
  // Two projects: none is picked, so there are no tasks to choose yet.
  assert.equal(view.blocks[0].dispatch_action, true);
  assert.equal(view.blocks[0].element.action_id, "move:project");
  assert.equal(view.blocks[0].element.initial_option, undefined);
  assert.equal(blockText(view.blocks[1]), "Choose a project to see its open tasks.");

  // Choosing a project lists its open tasks, incidents included.
  calls = mockSlack(t, { stored });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      view: { id: "V1", hash: "H1", private_metadata: view.private_metadata, state: { values: { project: { "move:project": { selected_option: { value: "CDEV" } } } } } },
      actions: [{ action_id: "move:project", selected_option: { value: "CDEV" } }],
    }),
  );
  assert.equal(calls[0].method, "views.update");
  assert.deepEqual([calls[0].args.view_id, calls[0].args.hash], ["V1", "H1"]);
  ({ view } = calls[0].args);
  assert.equal(view.blocks[0].element.initial_option.value, "CDEV");
  assert.deepEqual(optionsOf(view.blocks[1].element), [
    ["To do · Incident · Checkout is down", "100.3"],
    ["In progress · Fix login", "100.1"],
  ]);

  // Moving copies the message from the DM into the task's thread.
  calls = mockSlack(t, { ...moveSlack(), stored });
  const values = { project: { "move:project": { selected_option: { value: "CDEV" } } }, target: { value: { selected_option: { value: "100.1" } } } };
  await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "move:form", private_metadata: view.private_metadata, state: { values } } }));
  const copy = calls.find((call) => call.method === "chat.postMessage").args;
  assert.deepEqual([copy.channel, copy.thread_ts], ["CDEV", "100.1"]);
  assert.match(copy.text, /^Moved from <@UBOB>'s <https:\/\/acme\.slack\.com\/archives\/D0BOB\/p5001\?thread_ts=500\.1&cid=D0BOB\|message>:/);

  // A project with no open tasks can't be moved to.
  const empty = await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "move:form", private_metadata: view.private_metadata, state: { values: { project: values.project } } } }));
  assert.deepEqual(await empty.json(), { response_action: "errors", errors: { project: "Choose a project with open tasks." } });
});

test("with only one group, the shortcuts anywhere skip the project", async (t) => {
  const single = { ...env, PROJECTS: [{ name: "acme", tasks: "CDEV" }] };
  for (const [callbackId, callback] of [["convert", "track"], ["incident", "incident"]]) {
    const calls = mockSlack(t);
    await send("/slack/interactions", shortcutClick(callbackId), {}, single);
    const { view } = calls[0].args;
    assert.equal(view.callback_id, callback);
    assert.ok(!view.blocks.some((block) => block.block_id === "project"), callbackId);
    assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");
  }

  // Move to existing lists the group's open tasks straight away.
  let calls = mockSlack(t, { stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  await send("/slack/interactions", shortcutClick("move"), {}, single);
  const { view } = calls[0].args;
  assert.equal(view.blocks[0].block_id, "target");
  assert.deepEqual(optionsOf(view.blocks[0].element), [["In progress · Fix login", "100.1"]]);
  assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");

  // With nothing open, it says so instead of opening the form.
  calls = mockSlack(t);
  const responses = recordResponses(t);
  await send("/slack/interactions", shortcutClick("move"), {}, single);
  assert.ok(!calls.some((call) => call.method === "views.open"));
  assert.match(responses[0].text, /There are no open tasks there/);
});

test("Move to existing in a dev channel lists that channel's open tasks, without the project", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  await send("/slack/interactions", shortcutClick("move", devStray, "CDEV"));
  const { view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(view.blocks[0].block_id, "target");
  assert.deepEqual(optionsOf(view.blocks[0].element), [["In progress · Fix login", "100.1"]]);
  assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");
});

test("Message shortcuts in a dev channel say privately why they can't, without opening a form", async (t) => {
  for (const [callbackId, message, stored, text] of [
    ["move", { ...devStray, thread_ts: "100.1" }, [], /not replies in a thread/],
    ["convert", { ...devStray, ts: "100.1" }, [storedTask()], /already a task thread/],
    ["incident", devStray, [], /There are no open tasks|people's messages/],
    ["move", devStray, [], /There are no open tasks there/],
  ]) {
    const root = callbackId === "incident" ? { ...devStray, bot_id: "B1" } : devStray;
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    const responses = recordResponses(t);
    await send("/slack/interactions", shortcutClick(callbackId, message, "CDEV"));
    assert.ok(!calls.some((call) => call.method === "views.open"), callbackId);
    assert.match(responses[0].text, text, callbackId);
  }
});

// Someone adding `reaction` to the message at `ts` in `channel`.
const reactionEvent = (reaction, ts = "100.7", channel = "CDEV", user = "UACTOR") =>
  JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UBOT" }],
    event: { type: "reaction_added", user, reaction, item: { type: "message", channel, ts } },
  });

test("🎫 and 🔀 on a message in a dev channel offer privately to track or move it", async (t) => {
  let calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "TODO")] });
  await send("/slack/events", reactionEvent("twisted_rightwards_arrows"));
  assert.deepEqual(optionsOf(calls.at(-1).args.blocks[1].elements[0]), [["To do · Fix login", "100.1"]]);

  calls = mockSlack(t, moveSlack());
  await send("/slack/events", reactionEvent("ticket"));
  const offer = calls.at(-1).args;
  assert.equal(offer.text, "Shall I track this message as a task?");
  assert.equal(offer.blocks[1].elements[0].action_id, "move:track-task");

  // Elsewhere, and other emoji, are left alone.
  calls = mockSlack(t, moveSlack());
  await send("/slack/events", reactionEvent("ticket", "500.1", "CRANDOM"));
  await send("/slack/events", reactionEvent("thumbsup"));
  assert.equal(calls.length, 0);
});

// Clicks a button on the question about a message posted on its own.
const promptClick = (actionId) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    trigger_id: "trigger-9",
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.7", title: "The login bug also hits SSO" }) }],
  });

test("a message posted on its own in a dev channel is asked whether it's a task, an incident or part of one", async (t) => {
  for (const [stored, buttons] of [
    [[devTask("100.1", "Fix login", "IN_PROGRESS")], ["New task", "New incident", "Move to existing", "Not now"]],
    [[devTask("100.1", "Fix login", "DONE")], ["New task", "New incident", "Not now"]],
  ]) {
    const calls = mockSlack(t, { stored });
    await send("/slack/events", threadEvent("The login bug also hits SSO", { ts: "100.7", thread_ts: undefined }));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
    const question = calls[0].args;
    assert.equal(question.text, "Is this a new task, a new incident, or part of an existing one?");
    assert.deepEqual(question.blocks[1].elements.map((button) => button.text.text), buttons);
  }
});

test("with suggestions off, a message posted on its own is still asked about; others aren't", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/events", threadEvent("hi", { ts: "100.7", thread_ts: undefined }), {}, { ...env, TASK_STATUS_CHANGE_DETECTION: "false" });
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);

  calls = mockSlack(t);
  await send("/slack/events", threadEvent("deploying now", { channel: "CRANDOM", ts: "500.1", thread_ts: undefined }));
  await send("/slack/events", threadEvent("done", { ts: "100.7", thread_ts: undefined, bot_id: "BOTHER" }));
  await send("/slack/events", threadEvent("edited", { ts: "100.7", thread_ts: undefined, subtype: "message_changed" }));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("newMessageTaskDetection false stops the question about a message posted on its own, for one project or every one", async (t) => {
  const post = (environment) => send("/slack/events", threadEvent("hi", { ts: "100.7", thread_ts: undefined }), {}, environment);
  const projects = (settings) => ({ ...env, CHANNEL_PAIRS: env.CHANNEL_PAIRS.map((project) => (project.name === "acme" ? { ...project, ...settings } : project)) });
  for (const [environment, asked] of [
    [env, true],
    [projects({ newMessageTaskDetection: false }), false],
    [{ ...env, NEW_MESSAGE_TASK_DETECTION: "off" }, false],
    [{ ...projects({ newMessageTaskDetection: true }), NEW_MESSAGE_TASK_DETECTION: "off" }, true],
  ]) {
    const calls = mockSlack(t);
    await post(environment);
    assert.equal(calls.some((call) => call.method === "chat.postEphemeral"), asked);
  }
  // Messages in other threads and the other project are unaffected.
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("hi", { channel: "CTESTDEV", ts: "100.7", thread_ts: undefined }), {}, projects({ newMessageTaskDetection: false }));
  assert.ok(calls.some((call) => call.method === "chat.postEphemeral"));
});

test("Track as task and Report incident open their forms, named from the message", async (t) => {
  for (const [actionId, callback] of [["move:track-task", "track"], ["move:report-incident", "incident"]]) {
    const calls = mockSlack(t);
    const responses = recordResponses(t);
    await send("/slack/interactions", promptClick(actionId));
    const { view } = calls.find((call) => call.method === "views.open").args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].element.initial_value, "The login bug also hits SSO");
    assert.deepEqual(JSON.parse(view.private_metadata), {
      channel: "CDEV",
      move: { channel: "CDEV", ts: "100.7" },
      title: "The login bug also hits SSO",
    });
    assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
  }
});

test("Move to existing opens the shortcut's form, and Not now removes the question", async (t) => {
  const stored = [devTask("100.1", "Fix login", "IN_PROGRESS")];
  let calls = mockSlack(t, { stored });
  const responses = recordResponses(t);
  await send("/slack/interactions", promptClick("move:existing"));
  const { view, trigger_id } = calls.find((call) => call.method === "views.open").args;
  assert.equal(trigger_id, "trigger-9");
  assert.equal(view.callback_id, "move:form");
  // The channel's project, so no project picker.
  assert.equal(view.blocks[0].block_id, "target");
  assert.deepEqual(optionsOf(view.blocks[0].element), [["In progress · Fix login", "100.1"]]);
  assert.equal(blockText(view.blocks[1]), "The login bug also hits SSO");
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);

  // Moving reads the message from the channel and copies it in.
  calls = mockSlack(t, { ...moveSlack(), stored });
  await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "move:form", private_metadata: view.private_metadata, state: { values: { target: { value: { selected_option: { value: "100.1" } } } } } } }));
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.thread_ts);
  assert.deepEqual(posts, ["100.1", "100.7"]);

  // With everything closed since, the question says so instead.
  calls = mockSlack(t, { stored: [devTask("100.1", "Fix login", "DONE")] });
  const later = recordResponses(t);
  await send("/slack/interactions", promptClick("move:existing"));
  assert.ok(!calls.some((call) => call.method === "views.open"));
  assert.match(later.at(-1).text, /^Everything here has been closed since/);

  await send("/slack/interactions", promptClick("move:dismiss"));
  assert.deepEqual(later.at(-1), { response_type: "ephemeral", delete_original: true });
});

test("a task tracked from a message takes the message into its thread", async (t) => {
  const calls = mockSlack(t, moveSlack());
  await send(
    "/slack/interactions",
    interaction(submission({ title: "SSO login", priority: "High" }, { channel: "CDEV", move: { channel: "CDEV", ts: "100.7" } })),
  );
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.thread_ts, call.args.text]);
  assert.equal(posts[0][1], "High task: SSO login");
  assert.deepEqual(posts.slice(1), [
    ["100.1", "Moved from <@UACTOR>'s <https://slack.example/100.7?thread_ts=100.7&cid=CDEV|message>:\n> The login bug also hits SSO\n> for some people"],
    ["100.7", "<@UCREATOR> moved this message to the task thread <https://slack.example/100.9|SSO login>. Please carry on the conversation there."],
  ]);
});

// `@Cade <kind>` replied in the thread of the stray message.
const startEvent = (kind, threadTs = "100.7") => threadEvent(`<@UBOT> ${kind}`, { ts: "100.8", thread_ts: threadTs });

test("@Cade task and @Cade incident in a message's thread offer to start one from it", async (t) => {
  for (const [kind, question, button, actionId] of [
    ["task", "Shall I track this message as a task?", "New task", "move:track-task"],
    ["incident", "Shall I report an incident from this message?", "New incident", "move:report-incident"],
  ]) {
    const calls = mockSlack(t, moveSlack());
    await send("/slack/events", startEvent(kind));
    assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postEphemeral"], kind);
    const offer = calls[1].args;
    assert.equal(offer.thread_ts, "100.7", kind);
    assert.equal(offer.text, question, kind);
    const [start, dismiss] = offer.blocks[1].elements;
    assert.deepEqual([start.text.text, start.action_id, dismiss.action_id], [button, actionId, "move:dismiss"], kind);
    assert.deepEqual(JSON.parse(start.value), { channel: "CDEV", ts: "100.7", title: "The login bug also hits SSO" }, kind);
  }

  // A task's own thread isn't a message to start one from.
  const calls = mockSlack(t, { ...moveSlack(), stored: [storedTask()] });
  await send("/slack/events", startEvent("incident", "100.1"));
  assert.equal(calls.at(-1).args.text, "This is already a task thread.");
});

test("@Cade task and @Cade incident at the top of the dev channel point to replying in a thread", async (t) => {
  for (const kind of ["task", "incident"]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(`<@UBOT> ${kind}`, { ts: "100.7", thread_ts: undefined }));
    assert.equal(
      calls[0].args.text,
      `To start one from a message, reply \`@Cade ${kind}\` in its thread, or use \`/cade ${kind}\` for something new.`,
    );
  }
});

test("/cade incident opens a form that asks only what the incident is, in a dev channel", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/commands", slash("incident", "CDEV"));
  const { view } = calls[0].args;
  assert.equal(view.callback_id, "incident");
  assert.deepEqual(JSON.parse(view.private_metadata), { channel: "CDEV" });
  assert.deepEqual(view.blocks.map((block) => block.block_id ?? block.type), ["title", "context"]);

  // An incident needs a description.
  const response = await send(
    "/slack/interactions",
    interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "incident", private_metadata: view.private_metadata, state: { values: { title: { value: { value: " " } } } } } }),
  );
  assert.deepEqual(await response.json(), { response_action: "errors", errors: { title: "Please tell us what's going on." } });
});

test("an incident's priority and due date can't be changed, and its Edit form leaves them out", async (t) => {
  for (const text of ["<@UBOT> priority low", "<@UBOT> due 15/12/2026"]) {
    const calls = mockSlack(t, { stored: [incidentTask()] });
    await send("/slack/events", threadEvent(text));
    assert.equal(calls.at(-1).args.text, "Incidents are always :red_circle: Urgent and due Immediate, so I can't change their priority or due date.");
  }
  const calls = mockSlack(t, { stored: [incidentTask()] });
  await send("/slack/interactions", cardMenuClick("edit"));
  const form = calls[0].args.view;
  assert.deepEqual(form.blocks.map((block) => block.block_id ?? block.type), ["owner", "reviewer", "tester", "status", "context", "prs"]);
  assert.match(blockText(form.blocks[4]), /Incidents are always :red_circle: Urgent and due Immediate/);
});

// A task in `status`, with `people` in its roles.
const taskWith = (status, people = {}) => {
  const record = storedTask(people);
  record.task.status = status;
  return record;
};

const ephemeral = (calls) => calls.find((call) => call.method === "chat.postEphemeral")?.args;

// The changes Cade's private suggestion would make, as its Accept button
// carries them (see changes.js).
const suggestedChanges = (question) => JSON.parse(question.blocks.at(-1).elements[0].value).changes;
const add = (...ids) => ({ add: ids, remove: [] });

// Clicks the suggestion `question`'s button `index`: 0 Accept, 1 Edit…, 2 Reject.
const answerSuggestion = (question, index = 0, user = "UACTOR") => {
  const button = question.blocks.at(-1).elements[index];
  return interaction({
    type: "block_actions",
    user: { id: user },
    channel: { id: "CDEV" },
    trigger_id: "T1",
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: button.action_id, value: button.value }],
  });
};

test("asking for a role suggests adding whoever the request names, not someone only cc'd", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("IN_PROGRESS", { reviewers: ["URIA"] })] });
  await send("/slack/events", threadReply("<@UMIA> can you review this? cc <@UREX>"));
  const question = ephemeral(calls);
  assert.equal(question.user, "UACTOR");
  assert.equal(question.thread_ts, "100.1");
  assert.equal(question.text, "Should I update the task? From your message:");
  assert.equal(question.blocks[1].text.text, "*Reviewers:* <@UMIA> (Add)");
  assert.deepEqual(suggestedChanges(question), { people: { reviewer: add("UMIA") } });
  assert.deepEqual(question.blocks.at(-1).elements.map((button) => button.text.text), ["Accept", "Edit…", "Reject"]);
});

test("one message can ask for several roles, each for whoever it names", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("TODO", { owners: ["UREX"] })] });
  await send("/slack/events", threadReply("<@UREX> please pick this up, <@UMIA> can you review it and <@UTOM> test it"));
  // UREX develops it already; developing it as well as testing it means the
  // work hasn't reached testing.
  assert.deepEqual(suggestedChanges(ephemeral(calls)), { people: { reviewer: add("UMIA"), tester: add("UTOM") } });
});

test("asking someone to implement it while the author tests it suggests them as owner, and the author as tester", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("TODO")] });
  await send("/slack/events", threadReply("<@UUDARA> can you implement this feature while i will try about ways to test this"));
  assert.deepEqual(suggestedChanges(ephemeral(calls)), { people: { owner: add("UUDARA"), tester: add("UACTOR") } });
  assert.equal(ephemeral(calls).blocks[1].text.text, "*Owners:* <@UUDARA> (Add)\n*Testers:* <@UACTOR> (Add)");

  // The author testing it, beside a review asked of someone else, doesn't
  // move it to In testing.
  const review = mockSlack(t, { stored: [taskWith("IN_REVIEW")] });
  await send("/slack/events", threadReply("<@UMIA> please review it and I'll test it after"));
  assert.deepEqual(suggestedChanges(ephemeral(review)), { people: { reviewer: add("UMIA"), tester: add("UACTOR") } });
});

test("asking only for testing also suggests In testing", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { testers: ["UTOM"] })] });
  await send("/slack/events", threadReply("<@UTOM> please test it on staging"));
  // UTOM tests it already, so only the status changes.
  assert.deepEqual(suggestedChanges(ephemeral(calls)), { status: "IN_TESTING" });
});

test("the work starting suggests In progress, and adding as an owner someone not on the task", async (t) => {
  for (const [text, people, changes] of [
    ["on it", { owners: ["UACTOR"] }, { status: "IN_PROGRESS" }],
    ["okay, started working on this", {}, { people: { owner: add("UACTOR") }, status: "IN_PROGRESS" }],
    ["<@UREX> has started working on this", {}, { status: "IN_PROGRESS" }],
  ]) {
    const calls = mockSlack(t, { stored: [taskWith("TODO", people)] });
    await send("/slack/events", threadReply(text));
    assert.deepEqual(suggestedChanges(ephemeral(calls)), changes, text);
  }
});

test("progress in words suggests the next status", async (t) => {
  for (const [text, record, user, status] of [
    ["lgtm", taskWith("IN_REVIEW", { reviewers: ["UACTOR"] }), "UACTOR", "IN_TESTING"],
    ["qa passed", taskWith("IN_TESTING", { testers: ["UACTOR"] }), "UACTOR", "DONE"],
    ["merged and deployed", taskWith("IN_PROGRESS", { owners: ["UACTOR"] }), "UACTOR", "DONE"],
  ]) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadReply(text, { user }));
    assert.deepEqual(suggestedChanges(ephemeral(calls)), { status }, text);
  }
});

test("Accept applies the suggestion and tells the thread who changed what", async (t) => {
  let calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { reviewers: ["URIA"], testers: ["UTOM"] })] });
  await send("/slack/events", threadReply("<@UTESS> please test it"));
  const question = ephemeral(calls);

  calls = mockSlack(t, { ...slackUsers, stored: [taskWith("IN_REVIEW", { reviewers: ["URIA"], testers: ["UTOM"] })] });
  const sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  const saved = await savedTask();
  assert.deepEqual(saved.people.tester, ["UTOM", "UTESS"]);
  assert.equal(saved.status, "IN_TESTING");
  const post = calls.filter((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV").at(-1).args;
  assert.equal(post.thread_ts, "100.1");
  assert.equal(
    post.text,
    [
      // Tess was mentioned in the message, so is named and not asked again;
      // moving to In testing asks the other testers.
      "<@UACTOR> assigned <@UTESS> as tester.",
      "<@UACTOR> set the status to :test_tube: In testing.",
      "<@UTOM>, could you give this a test when you get a chance? Thanks!",
    ].join("\n"),
  );
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("someone who assigns or removes themselves is named as themselves, and isn't asked anything", async (t) => {
  // Commands only get a ✅, and whoever else is asked.
  for (const [text, record, reply] of [
    ["<@UBOT> assign owner <@UACTOR>", storedTask(), undefined],
    [
      "<@UBOT> assign owner <@UACTOR> <@UBOB>",
      storedTask(),
      "<@UBOB>, could you pick this up when you get a chance? Thanks!",
    ],
    ["<@UBOT> unassign owner <@UACTOR>", storedTask({ owners: ["UACTOR"] }), undefined],
    ["<@UBOT> unassign <@UACTOR>", storedTask({ owners: ["UACTOR"] }), undefined],
  ]) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadEvent(text));
    assert.equal(calls.find((call) => call.method === "chat.postMessage")?.args.text, reply, text);
  }

  // Accepting "started working on this" makes the writer an owner, and
  // asks no one.
  let calls = mockSlack(t, { stored: [taskWith("TODO")] });
  await send("/slack/events", threadReply("okay, started working on this"));
  const question = ephemeral(calls);
  calls = mockSlack(t, { stored: [taskWith("TODO")] });
  recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  const post = calls.filter((call) => call.method === "chat.postMessage").at(-1).args;
  assert.equal(post.text, "<@UACTOR> assigned themselves as owner.\n<@UACTOR> set the status to :arrow_forward: In progress.");

  // A tester who moves it to In testing isn't asked to test it.
  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { testers: ["UACTOR", "UTOM"] })] });
  await send("/slack/events", threadEvent("<@UBOT> status in testing"));
  assert.equal(calls.find((call) => call.method === "chat.postMessage").args.text, "<@UTOM>, could you give this a test when you get a chance? Thanks!");
});

test("Edit… on a suggestion by phrases opens the task's Edit form, filled in with it", async (t) => {
  let calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { reviewers: ["URIA"] })] });
  await send("/slack/events", threadReply("<@UMIA> can you review this?"));
  const question = ephemeral(calls);
  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { reviewers: ["URIA"] })] });
  await send("/slack/interactions", answerSuggestion(question, 1));
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.callback_id, "task:edit");
  assert.deepEqual(form.blocks[1].element.initial_users, ["URIA", "UMIA"]);
});

test("Accept leaves a suggested status alone once the task has moved, and Reject changes nothing", async (t) => {
  let calls = mockSlack(t, { stored: [taskWith("TODO", { owners: ["UACTOR"] })] });
  await send("/slack/events", threadReply("on it"));
  const question = ephemeral(calls);

  // Someone moved it to In review meanwhile.
  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { owners: ["UACTOR"] })] });
  let sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  assert.equal((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  calls = mockSlack(t, { stored: [taskWith("TODO", { owners: ["UACTOR"] })] });
  sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question, 2));
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("suggestions follow the kinds turned on", async (t) => {
  for (const [kinds, text, record, user, changes] of [
    ['["hand-offs"]', "lgtm", taskWith("IN_REVIEW", { reviewers: ["UACTOR"] }), "UACTOR", null],
    ['["progress"]', "lgtm", taskWith("IN_REVIEW", { reviewers: ["UACTOR"] }), "UACTOR", { status: "IN_TESTING" }],
    ['["progress"]', "<@UMIA> can you review this?", taskWith("IN_PROGRESS"), "UACTOR", null],
    ['["hand-offs"]', "on it", taskWith("TODO", { owners: ["UACTOR"] }), "UACTOR", null],
    // Asked for testing with progress off: the role, and the status with it.
    ['["hand-offs"]', "<@UTOM> please test it", taskWith("IN_PROGRESS"), "UACTOR", { people: { tester: add("UTOM") }, status: "IN_TESTING" }],
  ]) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadReply(text, { user }), {}, { ...env, TASK_STATUS_CHANGE_DETECTION: kinds });
    const question = ephemeral(calls);
    assert.deepEqual(question ? suggestedChanges(question) : null, changes, `${kinds}: ${text}`);
  }
});

test("progress in words asks nothing for questions, doubts, people off the task or a task that's waiting", async (t) => {
  for (const [text, record, overrides] of [
    // Questions and doubts.
    ["is it done?", taskWith("IN_PROGRESS", { owners: ["UACTOR"] }), {}],
    ["not done yet", taskWith("IN_PROGRESS", { owners: ["UACTOR"] }), {}],
    ["almost finished", taskWith("IN_PROGRESS", { owners: ["UACTOR"] }), {}],
    ["I'll merge once it's approved", taskWith("IN_PROGRESS", { owners: ["UACTOR"] }), {}],
    ["isn't merged", taskWith("IN_PROGRESS", { owners: ["UACTOR"] }), {}],
    // Someone who isn't on the task.
    ["done", taskWith("IN_PROGRESS", { owners: ["UREX"] }), {}],
    // A reviewer approving a task that isn't in review.
    ["LGTM", taskWith("IN_PROGRESS", { reviewers: ["UACTOR"] }), {}],
    // A tester passing a task that isn't in testing.
    ["QA passed", taskWith("IN_REVIEW", { testers: ["UACTOR"] }), {}],
    // A owner "approving" in testing isn't the tester.
    ["looks good", taskWith("IN_TESTING", { owners: ["UACTOR"] }), {}],
    // The client decides, or it's done.
    ["done", taskWith("CLIENT_REVIEW", { owners: ["UACTOR"] }), {}],
    ["done", taskWith("DONE", { owners: ["UACTOR"] }), {}],
    // Not a task thread.
    ["done", null, {}],
    ["done", taskWith("IN_PROGRESS", { owners: ["UACTOR"] }), { channel: "COTHER" }],
  ]) {
    const calls = mockSlack(t, { stored: record ? [record] : [] });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${record?.task.status}`);
  }
});

test("progressOptions reads the task, the writer and their words", async () => {
  const { progressOptions } = await import("../src/commands/status.js");
  const task = (status, people = {}) => taskWith(status, people).task;
  const says = (text) => ({ text });
  assert.deepEqual(progressOptions(task("IN_REVIEW", { reviewers: ["U1"] }), "U1", says("lgtm")), ["IN_TESTING"]);
  assert.deepEqual(progressOptions(task("IN_TESTING", { testers: ["U1"] }), "U1", says("lgtm")), ["DONE"]);
  assert.deepEqual(progressOptions(task("IN_PROGRESS", { owners: ["U1"] }), "U1", says("lgtm")), []);
  assert.deepEqual(progressOptions(task("DONE", { owners: ["U1"] }), "U1", says("done")), []);
});

test("a question about starting isn't taken as having started", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("TODO", { owners: ["UACTOR"] })] });
  await send("/slack/events", threadReply("should I start working on this?"));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

// Paths that only run when something goes wrong, or at the edges.

test("the started intent asks nothing outside the paired channels", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadReply("started working on this", { channel: "COTHER" }));
  assert.deepEqual(calls, []);
});

test("the Worker answers only POSTs to its routes, and needs the signing secret", async () => {
  const get = await worker.fetch(new Request("https://worker.example.net/slack/events"), env, { waitUntil() {} });
  assert.equal(get.status, 405);
  const missing = await worker.fetch(new Request("https://worker.example.net/nowhere", { method: "POST" }), env, {});
  assert.equal(missing.status, 404);
  await assert.rejects(
    worker.fetch(new Request("https://worker.example.net/slack/events", { method: "POST", body: "{}" }), { ...env, SLACK_SIGNING_SECRET: "" }, {}),
    /SLACK_SIGNING_SECRET is not configured/,
  );
});

test("events other than messages, and interactions Cade has no handler for, are acknowledged and ignored", async (t) => {
  const calls = mockSlack(t);
  const reaction = JSON.stringify({ type: "event_callback", authorizations: [{ user_id: "UBOT" }], event: { type: "reaction_added" } });
  assert.equal((await send("/slack/events", reaction)).status, 200);
  for (const payload of [
    { type: "view_closed", view: { callback_id: "track" } },
    { type: "block_actions", actions: [{ action_id: "nobody:knows" }] },
    { type: "view_submission", view: { callback_id: "nobody:knows" } },
  ]) {
    assert.equal((await send("/slack/interactions", interaction(payload))).status, 200, payload.type);
  }
  assert.deepEqual(calls, []);
});

test("callSlack and respondLater report Slack's failures", async (t) => {
  const { callSlack, respondLater } = await import("../src/slack.js");
  await assert.rejects(callSlack({}, "chat.postMessage", {}), /SLACK_BOT_TOKEN is not configured/);
  const fetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetch;
  });
  globalThis.fetch = async () => new Response("down", { status: 503 });
  await assert.rejects(callSlack(env, "chat.postMessage", {}), /Slack chat.postMessage returned HTTP 503/);
  await assert.rejects(respondLater(RESPONSE_URL, { text: "hi" }), /response_url returned HTTP 503/);
  globalThis.fetch = async () => Response.json({ ok: false, error: "invalid_blocks" });
  await assert.rejects(respondLater(RESPONSE_URL, { text: "hi" }), /refused the message: invalid_blocks/);
  // A plain "ok" reply is fine.
  globalThis.fetch = async () => new Response("ok", { headers: { "content-type": "text/plain" } });
  await respondLater(RESPONSE_URL, { text: "hi" });
});

test("choosing reviewers whose PR list didn't fit asks about all the task's PRs", async (t) => {
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
      actions: [{ action_id: "pr:reviewers", block_id: "not json", selected_users: ["URIA"] }],
    }),
  );
  assert.equal(
    calls.at(-1).args.text,
    `<@UCLICKER> assigned <@URIA> as reviewer.\n<@URIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
  );
});

test("deleting copes with a thread that's gone and replies it can't delete", async (t) => {
  // The thread is gone, replies and all: the root still goes.
  let calls = mockSlack(t, { stored: [ownTask()], "conversations.replies": { ok: false, error: "thread_not_found" } });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts), ["100.1"]);

  // A reply that can't be deleted is passed over.
  calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }, { ts: "100.3", bot_id: "BOTHER" }] },
    "chat.delete": (args) => (args.ts === "100.3" ? { ok: false, error: "cant_delete_message" } : {}),
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts), ["100.3", "100.1"]);

  // Reading the replies fails for another reason: nothing is deleted.
  calls = mockSlack(t, { stored: [ownTask()], "conversations.replies": { ok: false, error: "ratelimited" } });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.ok(!calls.some((call) => call.method === "chat.delete"));
});

test("a release that can't be sent says why", async (t) => {
  // The button, once nothing is left to send.
  let calls = mockSlack(t, releaseThreads([PR], [inReview([PR])]));
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "T1",
      user: { id: "UDEV" },
      channel: { id: "CDEV" },
      message: { ts: "100.7", thread_ts: "100.1" },
      actions: [{ action_id: "release:open", value: JSON.stringify({ channel: "CDEV", ts: "100.1" }) }],
    }),
  );
  assert.match(calls.find((call) => call.method === "chat.postEphemeral").args.text, /already with the client/);
  assert.ok(!calls.some((call) => call.method === "views.open"));

  // The form, once someone else sent the ones chosen.
  calls = mockSlack(t, releaseThreads([PR, MR], [inReview([PR])]));
  await send("/slack/interactions", releaseSubmission([PR]));
  assert.equal(calls.find((call) => call.method === "chat.postEphemeral").args.text, "Those PRs are already with the client.");

  // The form, once nothing is left to send.
  calls = mockSlack(t, releaseThreads([PR], [inReview([PR])]));
  await send("/slack/interactions", releaseSubmission([PR]));
  assert.match(calls.find((call) => call.method === "chat.postEphemeral").args.text, /already with the client/);
});

test("a release sent without a button message is still sent", async (t) => {
  const calls = mockSlack(t, releaseThreads([PR, MR]));
  const form = JSON.parse(new URLSearchParams(releaseSubmission([PR])).get("payload"));
  form.view.private_metadata = JSON.stringify({ channel: "CDEV", ts: "100.1" });
  await send("/slack/interactions", interaction(form));
  const told = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(told.thread_ts, "100.1");
  assert.match(told.text, /^<@UDEV> sent these PRs for approval/);
});

test("a release someone decided on at the same moment isn't decided again", async (t) => {
  const calls = mockSlack(t, releaseThreads([PR], [inReview([PR])]));
  // The other click's decision lands between reading the release and deciding it.
  const raced = {
    ...env,
    DB: {
      prepare: (sql) =>
        /^\s*UPDATE releases/i.test(sql) ? { bind: () => ({ first: async () => null }) } : DB.prepare(sql),
    },
  };
  await send("/slack/interactions", releaseClick("release:approve"), {}, raced);
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.9").args;
  assert.match(update.text, /Someone's already decided on these PRs\./);
});

// Clicks the syncup button `actionId` on `message`.
const syncupClick = (message, actionId) => {
  const button = message.blocks.at(-1).elements.find((element) => element.action_id === actionId);
  assert.ok(button, `no ${actionId} button`);
  return interaction({ type: "block_actions", user: { id: "UACTOR" }, response_url: RESPONSE_URL, actions: [{ action_id: actionId, value: button.value }] });
};

test("/cade syncup goes through the open tasks one at a time, most urgent first, each linking to its thread", async (t) => {
  const stored = {
    CDEV: [
      historyTask("100.1", { title: "Low task", priority: "Low", owners: ["UALICE"] }),
      historyTask("100.2", { title: "High task", priority: "High", reviewers: ["UBOB"], prs: [PR] }),
      historyTask("100.3", { title: "Done task", status: "DONE" }),
      incidentHistoryTask("100.8", { title: "Checkout is down" }),
    ],
    // Another group's task is left out.
    CTESTDEV: [historyTask("100.9", { title: "Test task" })],
  };
  const { now, later: first } = await tasksCommand(t, "syncup", "CDEV", stored);
  assert.equal(now, "");
  const title = (message) => blockText(message.blocks[1]);
  const buttons = (message) => message.blocks.at(-1).elements.map((button) => button.text.text);
  const thread = (ts) => `https://acme.slack.com/archives/CDEV/p${ts.replace(".", "")}?thread_ts=${ts}&cid=CDEV`;

  // The incident first; its title opens its thread.
  assert.match(blockText(first.blocks[0]), /^\*Syncup: acme\*  ·  1 of 3$/);
  assert.equal(title(first), `*Incident:* *<${thread("100.8")}|Checkout is down>*`);
  assert.equal(blockText(first.blocks[2]), ":memo: To do  ·  :red_circle: Urgent  ·  Due Immediate\n_Unassigned_");
  assert.deepEqual(buttons(first), ["Next ▶", "Last ⏭", "End"]);

  const sent = recordResponses(t);
  await send("/slack/interactions", syncupClick(first, "syncup:next"));
  const second = sent.at(-1);
  assert.equal(second.replace_original, true);
  assert.equal(title(second), `*<${thread("100.2")}|High task>*`);
  assert.equal(blockText(second.blocks[2]), `:memo: To do  ·  :large_orange_circle: High  ·  Due 31/10/2026\nReviewers <@UBOB>\n*Pending:* <${PR}|cade/42>`);
  assert.deepEqual(buttons(second), ["⏮ First", "◀ Previous", "Next ▶", "Last ⏭", "End"]);

  await send("/slack/interactions", syncupClick(second, "syncup:last"));
  const last = sent.at(-1);
  assert.match(blockText(last.blocks[0]), /3 of 3$/);
  assert.equal(title(last), `*<${thread("100.1")}|Low task>*`);
  assert.deepEqual(buttons(last), ["⏮ First", "◀ Previous", "End"]);

  await send("/slack/interactions", syncupClick(last, "syncup:first"));
  assert.match(blockText(sent.at(-1).blocks[0]), /1 of 3$/);

  await send("/slack/interactions", syncupClick(last, "syncup:previous"));
  assert.equal(title(sent.at(-1)), `*<${thread("100.2")}|High task>*`);

  await send("/slack/interactions", syncupClick(last, "syncup:end"));
  assert.deepEqual(sent.at(-1), { response_type: "ephemeral", delete_original: true });
});

test("/cade syncup stays within the tasks still open, and says when there are none", async (t) => {
  const { later } = await tasksCommand(t, "syncup", "CDEV", {});
  assert.equal(later.text, "There are no open acme tasks right now.");

  // The last task was closed since: Next shows the one now last.
  const { later: first } = await tasksCommand(t, "syncup", "CDEV", {
    CDEV: [historyTask("100.1", { title: "One" }), historyTask("100.2", { title: "Two" })],
  });
  await DB.prepare("UPDATE tasks SET status = 'DONE' WHERE ts = '100.2'").run();
  const sent = recordResponses(t);
  await send("/slack/interactions", syncupClick(first, "syncup:last"));
  assert.match(blockText(sent.at(-1).blocks[0]), /1 of 1$/);
  assert.match(blockText(sent.at(-1).blocks[1]), /\|One>\*$/);

  // Only in a dev channel.
  const { now } = await tasksCommand(t, "syncup", "COTHER", {});
  assert.match(JSON.parse(now).text, /That one works with `\/cade syncup` in <#CDEV> or <#CTESTDEV>/);
});

test("a standup step with more tasks than fit says how many more", async (t) => {
  const many = Array.from({ length: 23 }, (_, i) => historyTask(`100.${i + 10}`, { title: `Task ${i}`, owners: ["UALICE"] }));
  const { later } = await tasksCommand(t, "standup", "CDEV", { CDEV: many });
  assert.equal(later.blocks.at(-2).elements[0].text, "_…and 3 more, after these._");
});

test("/cade tasks -all with nothing to show says so", async (t) => {
  const { later } = await tasksCommand(t, "tasks -all", "CDEV", {});
  assert.equal(later.text, "There are no open acme tasks.");
  assert.equal(later.blocks.at(-1).text.text, "There are no open tasks.");
});

// A canvas's markdown, from conversations.canvases.create or canvases.edit.
const canvasMarkdown = (call) =>
  call.method === "canvases.edit"
    ? JSON.parse(call.args.changes)[0].document_content.markdown
    : JSON.parse(call.args.document_content).markdown;

// The table rows of a summary's Open or Closed section, without their
// header and divider.
// The rows of a summary's `section`: Open, Closed or Archived.
const summaryRows = (markdown, section = "Open") =>
  markdown
    .split("\n## ")
    .find((part) => part.startsWith(`${section}\n`))
    .split("\n")
    .filter((line) => line.startsWith("| ") && !/^\| (Title|---) /.test(line))
    .map(unbroken);

// Short cells, such as priorities, are kept on one line with non-breaking
// spaces; shown here as `~`.
const unbroken = (row) => row.replace(/\u00a0/g, "~");

const canvasResponses = {
  "auth.test": { url: "https://acme.slack.com/" },
  "conversations.canvases.create": { canvas_id: "F0CANVAS" },
};

test("/cade resync summary puts the group's open tasks in the dev channel's canvas, most urgent first", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (const [channel, record] of [
    ["CDEV", historyTask("100.1", { title: "Low task", priority: "Low", owners: ["UALICE"] })],
    ["CDEV", historyTask("100.2", { title: "High | [later]", priority: "High", dueDate: "05/11/2026", reviewers: ["UBOB"] })],
    ["CDEV", historyTask("100.3", { title: "High, sooner", priority: "High", dueDate: "01/11/2026", status: "IN_PROGRESS" })],
    ["CDEV", historyTask("100.4", { title: "Done task", status: "DONE", completedAt: "2026-10-10T09:00:00.000Z" })],
    ["CDEV", historyTask("100.5", { title: "Done later", status: "DONE", completedAt: "2026-10-20T09:00:00.000Z", owners: ["UBOB"] })],
    ["CDEV", incidentHistoryTask("100.8", { title: "Checkout is down", testers: ["UALICE", "UBOB"] })],
  ]) await putTask(env, channel, record.ts, record.task);
  const { now, later } = await runTasksCommand("resync summary", "CDEV", env);

  assert.equal(now, "");
  assert.equal(later.text, "Added the summary to this channel's canvas. I'll keep it up to date. Only I can edit it.");
  // Read-only for the channel: Cade rewrites it on every change anyway.
  const lock = calls.find((call) => call.method === "canvases.access.set").args;
  assert.deepEqual(lock, { canvas_id: "F0CANVAS", access_level: "read", channel_ids: '["CDEV"]' });
  const create = calls.find((call) => call.method === "conversations.canvases.create");
  assert.equal(create.args.channel_id, "CDEV");
  assert.equal(create.args.title, "acme tasks");
  const markdown = canvasMarkdown(create);
  assert.match(markdown, /^_Updated \d\d\/\d\d\/\d{4} \d\d:\d\d\. Cade keeps this up to date\._\n\n## Open\n\n4 open, most urgent first\.\n\n/);
  assert.match(markdown, /\n\n---\n\n## Closed\n\nThe last 2 done, most recently first\.\n\n/);
  // Without a Google Sheet, there's nothing to link to.
  assert.ok(!markdown.includes("Google Sheet"));
  assert.ok(markdown.includes("| Title | Status | Priority | Due date | Owner | Reviewer | Tester |"));
  const thread = (channel, ts) =>
    `(https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel})`;
  assert.deepEqual(summaryRows(markdown), [
    `| **Incident:** [Checkout is down]${thread("CDEV", "100.8")} | :memo:~To~do | :red_circle:~Urgent | Immediate | — | — | ![](@UALICE), ![](@UBOB) |`,
    `| [High, sooner]${thread("CDEV", "100.3")} | :arrow_forward:~In~progress | :large_orange_circle:~High | 01/11/2026 | — | — | — |`,
    `| [High \\| \\[later\\]]${thread("CDEV", "100.2")} | :memo:~To~do | :large_orange_circle:~High | 05/11/2026 | — | ![](@UBOB) | — |`,
    `| [Low task]${thread("CDEV", "100.1")} | :memo:~To~do | :large_green_circle:~Low | 31/10/2026 | ![](@UALICE) | — | — |`,
  ]);
  // Done tasks follow, most recently done first.
  assert.deepEqual(summaryRows(markdown, "Closed"), [
    `| [Done later]${thread("CDEV", "100.5")} | :white_check_mark:~Done | :large_orange_circle:~High | 31/10/2026 | ![](@UBOB) | — | — |`,
    `| [Done task]${thread("CDEV", "100.4")} | :white_check_mark:~Done | :large_orange_circle:~High | 31/10/2026 | — | — | — |`,
  ]);

  // Sent again, the same canvas is rewritten, with its title.
  calls.length = 0;
  const again = await runTasksCommand("resync summary", "CDEV", env);
  assert.equal(again.later.text, "Resynced the summary in this channel's canvas. Only I can edit it.");
  const edits = calls.filter((call) => call.method === "canvases.edit");
  assert.deepEqual(edits.map((call) => call.args.canvas_id), ["F0CANVAS", "F0CANVAS"]);
  assert.deepEqual(edits.map((call) => JSON.parse(call.args.changes)[0].operation), ["replace", "rename"]);
  assert.equal(JSON.parse(edits[1].args.changes)[0].title_content.markdown, "acme tasks");
  assert.ok(!calls.some((call) => call.method === "conversations.canvases.create"));
});

test("the summary uses the canvas the channel already has", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "conversations.info": { channel: { id: "CDEV", properties: { canvas: { file_id: "F0THEIRS" } } } },
  });
  const fakeFetch = globalThis.fetch;
  // Slack won't let Cade change who can edit a canvas someone else made;
  // the summary goes in it all the same.
  globalThis.fetch = async (url, init) =>
    url.endsWith("/conversations.canvases.create")
      ? (await fakeFetch(url, init), Response.json({ ok: false, error: "channel_canvas_already_exists" }))
      : url.endsWith("/canvases.access.set")
        ? (await fakeFetch(url, init), Response.json({ ok: false, error: "no_permission" }))
        : fakeFetch(url, init);

  const { later } = await runTasksCommand("resync summary", "CDEV");
  assert.equal(later.text, "Added the summary to this channel's canvas. I'll keep it up to date.");
  const [edit, rename] = calls.filter((call) => call.method === "canvases.edit");
  assert.equal(edit.args.canvas_id, "F0THEIRS");
  assert.match(canvasMarkdown(edit), /No open tasks\.[\s\S]*No closed tasks yet\./);
  // It takes the summary's title.
  assert.equal(rename.args.canvas_id, "F0THEIRS");
  assert.equal(JSON.parse(rename.args.changes)[0].title_content.markdown, "acme tasks");

  // Saved, so it is used from now on.
  calls.length = 0;
  await runTasksCommand("resync summary", "CDEV");
  assert.equal(calls.find((call) => call.method === "canvases.edit").args.canvas_id, "F0THEIRS");
  assert.ok(!calls.some((call) => call.method === "conversations.canvases.create"));
});

test("/cade resync summary only works in a group's dev channel", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  const { now } = await runTasksCommand("resync summary", "CRANDOM");
  assert.equal(JSON.parse(now).text, "Send `/cade resync summary` in a group's dev channel, for its summary.");
  assert.ok(!calls.some((call) => /canvas/.test(call.method)));
});

test("a task change rewrites the summaries of its group that have one", async (t) => {
  const calls = mockSlack(t, { ...canvasResponses, stored: [storedTask()] });
  await runTasksCommand("resync summary", "CDEV");
  calls.length = 0;

  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  const edit = calls.find((call) => call.method === "canvases.edit");
  assert.equal(edit.args.canvas_id, "F0CANVAS");
  assert.match(summaryRows(canvasMarkdown(edit))[0], /^\| \[Fix login\]\(https:[^)]+\) \| :memo:~To~do \| :large_orange_circle:~High \| 31\/10\/2026 \| !\[\]\(@UBOB\) \|/);
});

test("a new task makes its group's summary canvas; other changes only rewrite one there is", async (t) => {
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.ok(!calls.some((call) => /canvas|auth\.test/.test(call.method)));

  calls = mockSlack(t, { ...createdTask, ...canvasResponses });
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "High" })));
  const create = calls.find((call) => call.method === "conversations.canvases.create").args;
  assert.equal(create.channel_id, "CDEV");
  assert.match(canvasMarkdown({ args: create }), /\[Fix login\]/);
  assert.deepEqual(calls.find((call) => call.method === "canvases.access.set").args, { canvas_id: "F0CANVAS", access_level: "read", channel_ids: '["CDEV"]' });
});

test("a long summary continues in another table, as a canvas table holds 300 cells", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (let i = 0; i < 45; i++) {
    const record = historyTask(`100.${String(i).padStart(2, "0")}`, { title: `Task ${i}` });
    await putTask(env, "CDEV", record.ts, record.task);
  }
  await runTasksCommand("resync summary", "CDEV");
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  const tables = markdown.split("\n\n").filter((part) => part.startsWith("| Title"));
  assert.deepEqual(tables.map((part) => part.split("\n").length - 2), [41, 4]);
});

test("a summary's Closed section keeps the last 50 done", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (let i = 0; i < 55; i++) {
    const record = historyTask(`100.${String(i).padStart(2, "0")}`, {
      title: `Done ${i}`,
      status: "DONE",
      completedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    });
    await putTask(env, "CDEV", record.ts, record.task);
  }
  await runTasksCommand("resync summary", "CDEV");
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  const closed = summaryRows(markdown, "Closed");
  assert.equal(closed.length, 50);
  assert.match(closed[0], /^\| \[Done 54\]/);
  assert.match(closed.at(-1), /^\| \[Done 5\]/);
  assert.match(markdown, /The last 50 done, most recently first\./);
});

// The acme pair with a Google Doc, in UTC.
const execEnv = {
  ...env,
  TIMEZONE: "UTC",
  GOOGLE_URL,
  GOOGLE_SECRET: "google-secret",
  PROJECTS: [{ name: "acme", tasks: "CDEV", doc: `https://docs.google.com/document/d/${DOC_ID}/edit` }],
};

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

// Stores a group's work for an executive summary, in CDEV:
//   100.1  "Export reports", done two days ago
//   100.8  the incident "Checkout is down", to do
//   100.3  "Upgrade Node", in review
//   100.5  "Old work", done long ago
async function storeExecWork() {
  for (const record of [
    historyTask("100.1", { title: "Export reports", status: "DONE", completedAt: daysAgo(2), owners: ["UALICE"] }),
    historyTask("100.8", { title: "Checkout is down", priority: "Urgent", dueDate: "Immediate", incident: true, owners: ["UBOB"] }),
    historyTask("100.3", { title: "Upgrade Node", priority: "Medium", status: "IN_REVIEW", owners: ["UALICE"] }),
    historyTask("100.5", { title: "Old work", status: "DONE", completedAt: daysAgo(30) }),
  ]) {
    await putTask(env, "CDEV", record.ts, record.task);
  }
}

// A click on the walk's button `actionId`, with `values` as the message's
// state.
const execClick = (message, actionId, values = {}) => {
  const button = message.blocks.at(-1).elements.find((element) => element.action_id === actionId);
  assert.ok(button, `no ${actionId} button`);
  return interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    response_url: RESPONSE_URL,
    trigger_id: "trigger-9",
    actions: [{ action_id: actionId, value: button.value, block_id: "nav" }],
    state: { values },
  });
};

// A step's block for `field`.
const execField = (message, field) => message.blocks.find((block) => block.block_id?.startsWith("{") && JSON.parse(block.block_id).f === field);

// The state of a step's fields.
const execFields = (message, { health, progress, notes, included = true }) => ({
  [execField(message, "health").block_id]: { value: { type: "static_select", selected_option: { value: health } } },
  [execField(message, "progress").block_id]: { value: { type: "plain_text_input", value: progress } },
  [execField(message, "notes").block_id]: { value: { type: "plain_text_input", value: notes } },
  [execField(message, "include").block_id]: { value: { type: "checkboxes", selected_options: included ? [{ value: "yes" }] : [] } },
});

const messageText = (message) => message.blocks.map(blockText).filter(Boolean).join("\n");

const execLink = (channel, ts) => `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel}`;

test("/cade brief goes through a group's tasks, and adds the summary to its Google Doc", async (t) => {
  const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, "chat.postMessage": { ts: "900.1" } });
  await storeExecWork();
  // Run in a channel outside the group, which has the only group.
  const { now, later: period } = await runTasksCommand("brief", "CLEADS", execEnv);
  assert.equal(now, "");

  // Step 1: the period, the past week to today the first time.
  assert.match(blockText(period.blocks[0]), /^\*Executive summary: acme\*  ·  Step 1 of 5$/);
  const today = todayIn(execEnv);
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  assert.equal(execField(period, "from").element.initial_date, weekAgo);
  assert.equal(execField(period, "to").element.initial_date, today);

  const sent = recordResponses(t);
  await send("/slack/interactions", execClick(period, "export:next"), {}, execEnv);
  const first = sent.at(-1);

  // Step 2: the task completed in the period, ticked to mention; old work is
  // left out.
  assert.match(blockText(first.blocks[0]), /Step 2 of 5$/);
  const done = first.blocks.filter((block) => block.accessory?.type === "checkboxes");
  assert.deepEqual(done.map((block) => block.text.text.match(/\|([^>]+)>/)[1]), ["Export reports"]);
  assert.match(done[0].text.text, /^• <https:\/\/acme\.slack\.com\/archives\/CDEV\/p1001\?thread_ts=100\.1&cid=CDEV\|Export reports>  ·  Done/);
  assert.deepEqual(done[0].accessory.initial_options, done[0].accessory.options);

  // Step 3: the incident, most urgent, with its thread to peek at.
  await send("/slack/interactions", execClick(first, "export:next"), {}, execEnv);
  const incident = sent.at(-1);
  assert.match(messageText(incident), /Open tasks\*  ·  1 of 2[\s\S]*\*Incident:\* <[^|]+\|Checkout is down>  ·  To do  ·  :red_circle: Urgent  ·  Due Immediate  ·  <@UBOB>/);
  const peek = incident.blocks.find((block) => block.accessory?.action_id === "export:peek").accessory;
  assert.deepEqual(JSON.parse(peek.value), [{ c: "CDEV", t: "100.8", n: "Dev thread" }]);
  await send("/slack/interactions", execClick(incident, "export:next", execFields(incident, { health: "BLOCKED", progress: "", notes: "Waiting on the payment provider\nETA Monday" })), {}, execEnv);

  // Step 4: the task in review.
  const dark = sent.at(-1);
  assert.match(messageText(dark), /Open tasks\*  ·  2 of 2[\s\S]*Upgrade Node>  ·  In review  ·  :large_yellow_circle: Medium/);
  await send("/slack/interactions", execClick(dark, "export:next", execFields(dark, { health: "AT_RISK", progress: "3/5", notes: "" })), {}, execEnv);

  // Back keeps what was chosen.
  await send("/slack/interactions", execClick(sent.at(-1), "export:back"), {}, execEnv);
  const darkAgain = sent.at(-1);
  assert.equal(execField(darkAgain, "progress").element.initial_value, "3/5");
  assert.equal(execField(darkAgain, "health").element.initial_option.value, "AT_RISK");
  await send("/slack/interactions", execClick(darkAgain, "export:next", execFields(darkAgain, { health: "AT_RISK", progress: "3/5", notes: "" })), {}, execEnv);

  // Step 5: the summary as it will read, worst first.
  const review = sent.at(-1);
  assert.match(messageText(review), new RegExp(`Step 5 of 5[\\s\\S]*This is what I'll add to the top of <https://docs.google.com/document/d/${DOC_ID}/edit\\|acme's Google Doc>'s Summary tab`));
  const show = (day) => day.split("-").reverse().join("/");
  assert.ok(messageText(review).includes(`_Period: ${show(weekAgo)} – ${show(today)}_`));
  const expected = [
    "*Completed (1)*",
    `• <${execLink("CDEV", "100.1")}|Export reports>`,
    "",
    "*Incidents (1)*",
    `• <${execLink("CDEV", "100.8")}|Checkout is down>  ·  Blocked  ·  To do`,
    "      _Waiting on the payment provider_",
    "      _ETA Monday_",
    "",
    "*At risk (1)*",
    `• <${execLink("CDEV", "100.3")}|Upgrade Node>  ·  In review  ·  3/5`,
  ].join("\n");
  // Sections with nothing in them are left out, and headings have no emoji.
  assert.ok(!/Blocked \(|On track \(|Delayed \(|:no_entry:|:warning:/.test(messageText(review)));
  assert.ok(messageText(review).includes(expected));

  // It goes in the doc, not in Slack: a section of its own, each title
  // linking to its thread, notes as bullets under it.
  calls.length = 0;
  await send("/slack/interactions", execClick(review, "export:post"), {}, execEnv);
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 0);
  const writes = calls.filter((call) => call.method === "doc");
  assert.equal(writes.length, 1);
  const { secret, action, docId, tab, key, blocks } = writes[0].args;
  assert.deepEqual({ secret, action, docId, tab }, { secret: "google-secret", action: "doc.write", docId: DOC_ID, tab: "Summary" });
  assert.match(key, /^export:\d+$/);
  assert.deepEqual(blocks, [
    { type: "heading", level: 2, text: `${show(today)} · acme executive summary` },
    { type: "paragraph", italic: true, text: `Period: ${show(weekAgo)} – ${show(today)}` },
    { type: "heading", level: 3, text: "Completed (1)" },
    { type: "item", level: 0, parts: [{ text: "Export reports", link: execLink("CDEV", "100.1") }] },
    { type: "heading", level: 3, text: "Incidents (1)" },
    { type: "item", level: 0, parts: [{ text: "Checkout is down", link: execLink("CDEV", "100.8") }, { text: "  ·  Blocked  ·  To do" }] },
    { type: "item", level: 1, parts: [{ text: "Waiting on the payment provider" }] },
    { type: "item", level: 1, parts: [{ text: "ETA Monday" }] },
    { type: "heading", level: 3, text: "At risk (1)" },
    { type: "item", level: 0, parts: [{ text: "Upgrade Node", link: execLink("CDEV", "100.3") }, { text: "  ·  In review  ·  3/5" }] },
  ]);
  assert.equal(
    sent.at(-1).text,
    `Added the executive summary for ${show(weekAgo)} – ${show(today)} to acme's Google Doc: <${DOC_TAB}|open it there>. After going through it with the client, send \`/cade debrief\` for what was added to it.`,
  );

  // Adding it again does nothing.
  await send("/slack/interactions", execClick(review, "export:post"), {}, execEnv);
  assert.equal(calls.filter((call) => call.method === "doc").length, 1);
});

test("Peek at threads shows the thread's latest replies in a modal", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "views.open": { view: { id: "V1" } },
    "conversations.replies": {
      messages: [
        { ts: "100.8", user: "UBOT", text: "card" },
        { ts: "1761300000.000100", user: "UCLIENT", text: "Still failing for EU customers" },
        { ts: "1761300060.000100", user: "UBOB", text: "", files: [{ id: "F1" }] },
      ],
    },
  });
  await storeExecWork();
  const { later: first } = await runTasksCommand("brief", "CDEV", execEnv);
  const sent = recordResponses(t);
  await send("/slack/interactions", execClick(first, "export:next"), {}, execEnv);
  await send("/slack/interactions", execClick(sent.at(-1), "export:next"), {}, execEnv);
  const peek = sent.at(-1).blocks.find((block) => block.accessory?.action_id === "export:peek").accessory;
  calls.length = 0;
  await send("/slack/interactions", interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    trigger_id: "trigger-7",
    response_url: RESPONSE_URL,
    actions: [{ action_id: "export:peek", value: peek.value, block_id: "x" }],
  }), {}, execEnv);

  const opened = calls.find((call) => call.method === "views.open");
  assert.equal(opened.args.trigger_id, "trigger-7");
  const update = calls.find((call) => call.method === "views.update");
  assert.equal(update.args.view_id, "V1");
  const { view } = update.args;
  const text = view.blocks.map(blockText).filter(Boolean);
  assert.deepEqual(text, [
    `*Dev thread*  ·  <${execLink("CDEV", "100.8")}|Open>`,
    "*<@UCLIENT>*  ·  24/10/2025 10:00\nStill failing for EU customers",
    "*<@UBOB>*  ·  24/10/2025 10:01\n_(attachment)_",
  ]);
  // Peeking leaves the step as it was.
  assert.equal(sent.length, 2);
});

test("the next /cade brief starts from the last one, with its health and progress", async (t) => {
  mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, "chat.postMessage": { ts: "900.1" } });
  await storeExecWork();
  const { later: first } = await runTasksCommand("brief", "CDEV", execEnv);
  const sent = recordResponses(t);
  for (let i = 0; i < 2; i++) await send("/slack/interactions", execClick(sent.at(-1) ?? first, "export:next"), {}, execEnv);
  const incident = sent.at(-1);
  await send("/slack/interactions", execClick(incident, "export:next", execFields(incident, { health: "DELAYED", progress: "1/2", notes: "Once only" })), {}, execEnv);
  await send("/slack/interactions", execClick(sent.at(-1), "export:next"), {}, execEnv);
  await send("/slack/interactions", execClick(sent.at(-1), "export:post"), {}, execEnv);

  // The last period ended today, so the next starts today too; nothing was
  // completed today, so after the period comes the incident.
  const { later: period } = await runTasksCommand("brief", "CDEV", execEnv);
  assert.equal(execField(period, "from").element.initial_date, todayIn(execEnv));
  await send("/slack/interactions", execClick(period, "export:next"), {}, execEnv);
  const next = sent.at(-1);
  assert.match(messageText(next), /Step 2 of 4[\s\S]*Checkout is down/);
  assert.equal(execField(next, "health").element.initial_option.value, "DELAYED");
  assert.equal(execField(next, "progress").element.initial_value, "1/2");
  // Notes carry over too, to add to or change, and what the last summary
  // said is shown to compare with.
  assert.equal(execField(next, "notes").element.initial_value, "Once only");
  const day = todayIn(execEnv).split("-").reverse().join("/");
  assert.ok(messageText(next).includes(`*In the last summary* (${day}): Delayed  ·  1/2\n_Once only_`));
});

test("/cade brief shows nothing from a last summary that didn't have the item", async (t) => {
  mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
  await storeExecWork();
  const { later: period } = await runTasksCommand("brief", "CDEV", execEnv);
  const sent = recordResponses(t);
  await send("/slack/interactions", execClick(period, "export:next"), {}, execEnv);
  await send("/slack/interactions", execClick(sent.at(-1), "export:next"), {}, execEnv);
  const incident = sent.at(-1);
  assert.ok(!messageText(incident).includes("In the last summary"));
  assert.equal(execField(incident, "notes").element.initial_value, undefined);
});

test("/cade brief says so when the Google Doc can't be written, and can try again", async (t) => {
  let refuse = true;
  mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    doc: () => (refuse ? { ok: false, error: "No item with the given ID could be found." } : { ok: true, url: DOC_TAB }),
  });
  await storeExecWork();
  const { later: first } = await runTasksCommand("brief", "CLEADS", execEnv);
  const sent = recordResponses(t);
  for (let i = 0; i < 4; i++) {
    await send("/slack/interactions", execClick(sent.at(-1) ?? first, "export:next"), {}, execEnv);
  }
  await send("/slack/interactions", execClick(sent.at(-1), "export:post"), {}, execEnv);
  assert.match(blockText(sent.at(-1).blocks[0]), /couldn't add it to the Google Doc just now/);
  refuse = false;
  await send("/slack/interactions", execClick(sent.at(-1), "export:post"), {}, execEnv);
  assert.match(sent.at(-1).text, /^Added the executive summary for /);
});

test("/cade brief needs the group to have a Google Doc", async (t) => {
  mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
  const { now: noApp } = await runTasksCommand("brief", "CDEV");
  assert.match(JSON.parse(noApp).text, /Google web app isn't set up yet: run `npm run google:create`/);
  const noDoc = { ...execEnv, PROJECTS: [{ name: "acme", tasks: "CDEV" }] };
  const { now, later } = await runTasksCommand("brief", "CDEV", noDoc);
  assert.equal(JSON.parse(now).text, "acme has no Google Doc linked. Add the doc's address as `\"doc\"` to its group in cade.config.json, then run `npm run config`.");
  assert.equal(later, undefined);
});

test("/cade brief outside a group asks which, when there are several", async (t) => {
  mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
  const docs = { ...env, GOOGLE_URL, GOOGLE_SECRET: "google-secret", CHANNEL_PAIRS: env.CHANNEL_PAIRS.map((pair) => ({ ...pair, doc: DOC_ID })) };
  const { now } = await runTasksCommand("brief", "CLEADS", docs);
  assert.equal(JSON.parse(now).text, "Which group? Try `/cade brief acme` or `/cade brief test`.");
  const { now: unknown } = await runTasksCommand("brief nope", "CLEADS", docs);
  assert.match(JSON.parse(unknown).text, /I don't know a group called "nope"/);
  const { now: named, later } = await runTasksCommand("brief test", "CLEADS", docs);
  assert.equal(named, "");
  assert.match(blockText(later.blocks[0]), /Executive summary: test/);
});

test("/cade brief offers what was completed in the period picked, from the start of From to the end of To", async (t) => {
  mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
  await storeExecWork();
  const { later: period } = await runTasksCommand("brief", "CDEV", execEnv);
  const sent = recordResponses(t);
  const pick = (from, to) => ({
    [execField(period, "from").block_id]: { value: { type: "datepicker", selected_date: from } },
    [execField(period, "to").block_id]: { value: { type: "datepicker", selected_date: to } },
  });
  const day = (daysBack) => todayIn(execEnv, new Date(Date.now() - daysBack * 86400000));

  // A period that ended before "Export reports" was done offers only the
  // older work.
  await send("/slack/interactions", execClick(period, "export:next", pick(day(40), day(3))), {}, execEnv);
  let text = messageText(sent.at(-1));
  assert.match(text, /Completed .* \(1–1 of 1\)[\s\S]*Old work/);
  assert.ok(!text.includes("Export reports>  ·  Done"));

  // To is counted to the end of its day: "Export reports" is in.
  await send("/slack/interactions", execClick(sent.at(-1), "export:back"), {}, execEnv);
  const again = sent.at(-1);
  assert.equal(execField(again, "from").element.initial_date, day(40));
  await send("/slack/interactions", execClick(again, "export:next", pick(day(2), day(2))), {}, execEnv);
  text = messageText(sent.at(-1));
  assert.match(text, /Completed .* \(1–1 of 1\)[\s\S]*Export reports/);

  // From after To goes no further.
  await send("/slack/interactions", execClick(sent.at(-1), "export:back"), {}, execEnv);
  await send("/slack/interactions", execClick(sent.at(-1), "export:next", pick(day(1), day(5))), {}, execEnv);
  assert.match(messageText(sent.at(-1)), /From\* must be on or before \*To\*[\s\S]*Step 1 of/);
});

test("a period's days start and end in TIMEZONE", async () => {
  const { dayBoundary } = await import("../src/commands/brief.js");
  const colombo = { TIMEZONE: "Asia/Colombo" };
  assert.equal(dayBoundary(colombo, "2026-10-25"), "2026-10-24T18:30:00.000Z");
  assert.equal(dayBoundary(colombo, "2026-10-25", { end: true }), "2026-10-25T18:29:59.999Z");
  assert.equal(dayBoundary({}, "2026-10-25"), "2026-10-25T00:00:00.000Z");
  // Across a change of clocks, in London.
  assert.equal(dayBoundary({ TIMEZONE: "Europe/London" }, "2026-10-25"), "2026-10-24T23:00:00.000Z");
  assert.equal(dayBoundary({ TIMEZONE: "Europe/London" }, "2026-10-25", { end: true }), "2026-10-25T23:59:59.999Z");
});

// Clicks `actionId` on a private question, as posted or sent to a
// response_url, as UACTOR. Returns what was sent to its response_url.
async function answerPrivately(t, question, actionId, environment = env) {
  const responses = recordResponses(t);
  const button = question.blocks[1].elements.find((element) => element.action_id === actionId);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      message: { ts: "100.9" },
      response_url: RESPONSE_URL,
      actions: [{ action_id: actionId, value: button.value }],
    }),
    {},
    environment,
  );
  return responses;
}

// The task at CDEV/100.1 with `prs` linked.
const ownReleaseTask = (prs, releases = []) => {
  const record = ownTask({ owners: ["UDEV"] });
  Object.assign(record.task, { prs, releases });
  return { stored: [record] };
};

test("PRs are sent for approval in the task's own thread", async (t) => {
  let calls = mockSlack(t, ownReleaseTask([PR, MR]));
  await send("/slack/events", threadEvent("<@UBOT> release"));
  const button = calls.at(-1).args.blocks[0].elements[0];
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
  // Nobody is picked to begin with.
  const view = calls.at(-1).args.view;
  assert.equal(view.blocks[2].element.type, "users_select");
  assert.equal(view.blocks[2].element.initial_user, undefined);
  assert.equal(view.blocks[3].elements[0].text, "They approve them in this thread. If they don't, you can send them again.");

  calls = mockSlack(t, ownReleaseTask([PR, MR]));
  await send("/slack/interactions", releaseSubmission([PR], "Login and sign-up", "UPM"));
  assert.deepEqual(await releasesOf(), [{ ...inReview([PR]), decidedBy: null }]);
  // The request is posted in the task's thread.
  const ask = calls.at(-1).args;
  assert.equal(calls.at(-1).method, "chat.postMessage");
  assert.equal(ask.channel, "CDEV");
  assert.equal(ask.thread_ts, "100.1");
  assert.equal(ask.blocks[0].text.text, `<@UDEV> sent these PRs for approval: <${PR}|cade/42>\n*Completes:* Login and sign-up`);
  assert.match(ask.blocks[1].text.text, /^<@UPM>, could you take a look and approve them/);
  assert.equal(JSON.parse(ask.blocks[2].elements[0].value).approver, "UPM");

  // The approver decides there, and the owners hear it.
  for (const [action, status, said] of [
    ["release:approve", "APPROVED", `<@UDEV>, good news! <@UPM> approved <${PR}|cade/42>.`],
    ["release:reject", "NOT_APPROVED", `<@UDEV>, <@UPM> didn't approve <${PR}|cade/42>. Have a look at the thread for what needs to change, then send them again with \`@Cade release\`.`],
  ]) {
    calls = mockSlack(t, ownReleaseTask([PR, MR], [inReview([PR])]));
    const click = JSON.parse(new URLSearchParams(releaseClick(action)).get("payload"));
    Object.assign(click, { user: { id: "UPM" }, channel: { id: "CDEV" } });
    click.message = { ts: "100.7", thread_ts: "100.1", blocks: ask.blocks };
    click.actions[0].value = ask.blocks[2].elements[0].value;
    await send("/slack/interactions", interaction(click));
    const row = await DB.prepare("SELECT status, decided_by FROM releases").first();
    assert.deepEqual({ ...row }, { status, decided_by: "UPM" });
    const told = calls.find((call) => call.method === "chat.postMessage").args;
    assert.equal(told.channel, "CDEV");
    assert.equal(told.text, said);
    assert.ok(!calls.some((call) => call.method === "chat.getPermalink"));
  }
});

test("Client review asks the approver in the task's own thread", async (t) => {
  const record = ownTask({ owners: ["UDEV"] });
  record.task.status = "IN_TESTING";
  record.task.prs = [PR];
  let calls = await clientReview(t, { stored: [record] }, { approver: "UPM" });
  assert.equal((await savedTask()).status, "CLIENT_REVIEW");
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.blocks[0].element.initial_user, undefined);
  assert.equal(form.blocks[1].elements[0].text, "They approve it in this thread.");
  // The request is posted in the task's thread.
  const ask = calls.at(-1).args;
  assert.equal(calls.at(-1).method, "chat.postMessage");
  assert.equal(ask.channel, "CDEV");
  assert.equal(ask.thread_ts, "100.1");
  assert.equal(
    ask.blocks[0].text.text,
    `Good news! <@UACTOR> says this is ready for review.\n*PRs:* <${PR}|cade/42>\n<@UPM>, could you take a look and approve it, or let us know what needs to change?`,
  );
  const [approve] = ask.blocks[1].elements;

  for (const [action, status, said] of [
    ["status:approve", "DONE", "<@UPM> approved this, so it's now :white_check_mark: Done. Nice work!"],
    ["status:reject", "IN_PROGRESS", "<@UPM> didn't approve this, so it's back to :arrow_forward: In progress. Have a look at the thread for what needs to change."],
  ]) {
    calls = mockSlack(t, { stored: [{ ...record, task: { ...record.task, status: "CLIENT_REVIEW" } }] });
    await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: "UPM" },
        channel: { id: "CDEV" },
        message: { ts: "100.8", thread_ts: "100.1" },
        actions: [{ action_id: action, value: approve.value }],
      }),
    );
    assert.equal((await savedTask()).status, status);
    const told = calls.find((call) => call.method === "chat.postMessage").args;
    assert.equal(told.thread_ts, "100.1");
    assert.equal(told.text, said);
    assert.equal(calls.at(-1).args.ts, "100.8");
    assert.ok(!calls.some((call) => call.method === "chat.getPermalink"));
  }
});

test("/cade resync <link> redraws a task's card, with its menu, and tells only whoever sent it", async (t) => {
  // A task at a timestamp a Slack link can name.
  const ts = "1700000000.000100";
  const task = { ...ownTask(), ts };
  task.task.link = "https://slack.example/p100";
  const calls = mockSlack(t, { stored: [task] });
  // A link to a reply in the task's thread stands for the task.
  const link = "https://acme.slack.com/archives/CDEV/p1700000000000500?thread_ts=1700000000.000100&amp;cid=CDEV";
  const { now, later } = await runTasksCommand(`resync <${link}>`, "COTHER");
  assert.equal(now, "");
  assert.equal(later.text, "Resynced the task <https://slack.example/p100|Fix login>.");
  const card = calls.find((call) => call.method === "chat.update" && call.args.ts === ts).args;
  assert.equal(card.blocks[0].accessory.action_id, "task:menu");
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("/cade remove <link> asks privately, then removes what the link points at", async (t) => {
  // A task at a timestamp a Slack link can name.
  const ts = "1700000000.000100";
  const removing = (responses = {}) =>
    mockSlack(t, {
      stored: [{ ...ownTask(), ts }],
      "conversations.replies": { messages: [{ ts: "1700000000.000500", bot_id: "BCADE" }] },
      ...responses,
    });

  // The task's root: its card and Cade's replies, asked privately.
  let calls = removing();
  let { now, later } = await runTasksCommand("remove <https://acme.slack.com/archives/CDEV/p1700000000000100>", "COTHER");
  assert.equal(now, "");
  assert.match(later.text, /^<@UACTOR>, should I delete the task \*Fix login\*\?/);
  const [cancel, button] = later.blocks[1].elements;
  // Cancel is first and prominent; Delete is plain, and asks again.
  assert.deepEqual([cancel.action_id, cancel.style], ["delete:cancel", "primary"]);
  assert.deepEqual([button.action_id, button.style, Boolean(button.confirm)], ["delete:confirm", undefined, true]);
  assert.deepEqual(JSON.parse(button.value), { kind: "task", channel: "CDEV", ts });
  let responses = await answerPrivately(t, later, "delete:confirm");
  assert.equal(await savedTask("CDEV", ts), null);
  assert.deepEqual(responses, [{ response_type: "ephemeral", replace_original: true, text: "Done, it's gone." }]);

  // A reply: just that message.
  calls = removing();
  ({ later } = await runTasksCommand(
    "remove <https://acme.slack.com/archives/CDEV/p1700000000000900?thread_ts=1700000000.000100&cid=CDEV>",
    "COTHER",
  ));
  assert.equal(later.text, "<@UACTOR>, should I remove that message? There's no undo.");
  assert.equal(later.blocks[1].elements[1].text.text, "Delete message");
  responses = await answerPrivately(t, later, "delete:confirm");
  assert.deepEqual(calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts), ["1700000000.000900"]);
  assert.equal(responses[0].text, "Done, that message is gone.");
  assert.ok(await savedTask("CDEV", ts));

  // Someone else's reply stays.
  removing({ "chat.delete": { ok: false, error: "cant_delete_message" } });
  ({ later } = await runTasksCommand(
    "remove <https://acme.slack.com/archives/CDEV/p1700000000000900?thread_ts=1700000000.000100&cid=CDEV>",
    "COTHER",
  ));
  responses = await answerPrivately(t, later, "delete:confirm");
  assert.equal(responses[0].text, "I can only remove my own messages, so that one stays.");

  // Any other message: Cade's replies in its thread, and the message if it's
  // Cade's.
  calls = removing({
    "chat.delete": (args) => (args.ts === "1700000000.000700" ? { ok: false, error: "cant_delete_message" } : {}),
  });
  ({ later } = await runTasksCommand("remove <https://acme.slack.com/archives/CDEV/p1700000000000700>", "COTHER"));
  assert.equal(later.text, "<@UACTOR>, should I remove my messages in that thread? There's no undo.");
  responses = await answerPrivately(t, later, "delete:confirm");
  assert.deepEqual(calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts), ["1700000000.000500", "1700000000.000700"]);
  assert.equal(responses[0].text, "Done, my replies are gone. The message itself isn't mine, so it stays.");

  // Cancel just drops the question.
  removing();
  ({ later } = await runTasksCommand("remove <https://acme.slack.com/archives/CDEV/p1700000000000700>", "COTHER"));
  responses = await answerPrivately(t, later, "delete:cancel");
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("/cade remove needs a link", async (t) => {
  mockSlack(t);
  const { now } = await runTasksCommand("remove", "CDEV");
  assert.match(JSON.parse(now).text, /^Paste the link to what to remove/);
});

test("/cade replace changes what one of Cade's messages says, from anywhere", async (t) => {
  const REPLY = "1700000000.000200";
  const link = `<${messageLink("CDEV", REPLY, "?thread_ts=1700000000.000100&cid=CDEV")}>`;
  for (const [text, said] of [
    [`replace ${link} "The *deposit* goes live on Friday, <@UBOB>"`, "The *deposit* goes live on Friday, <@UBOB>"],
    [`replace ${link} No quotes needed`, "No quotes needed"],
  ]) {
    const calls = mockSlack(t);
    const { now, later } = await runTasksCommand(text, "CRANDOM");
    assert.equal(now, "");
    const update = calls.find((call) => call.method === "chat.update").args;
    assert.deepEqual(update, {
      channel: "CDEV",
      ts: REPLY,
      text: said,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: said } }],
      attachments: [],
    });
    assert.equal(later.text, "Done, the message says that now.");
  }
});

test("/cade replace leaves task cards and other people's messages alone, and needs a link and text", async (t) => {
  // A task's card is drawn from the task.
  let calls = mockSlack(t, { stored: [devTask(TARGET, "Fix login", "TODO")] });
  let { later } = await runTasksCommand(`replace <${messageLink("CDEV", TARGET)}> New title`, "CDEV");
  assert.ok(!calls.some((call) => call.method === "chat.update"));
  assert.match(later.text, /^That's a task's card/);

  // Slack won't let Cade change someone else's message.
  calls = mockSlack(t, { "chat.update": { ok: false, error: "cant_update_message" } });
  ({ later } = await runTasksCommand(`replace <${messageLink("CDEV", TARGET)}> Hello`, "CDEV"));
  assert.equal(later.text, "I can only change my own messages, so that one stays as it is.");

  for (const text of ["replace", `replace <${messageLink("CDEV", TARGET)}>`, `replace <${messageLink("CDEV", TARGET)}> ""`, "replace just words"]) {
    mockSlack(t);
    const { now } = await runTasksCommand(text, "CDEV");
    assert.match(JSON.parse(now).text, /^Paste the link to my message, then what it should say/, text);
  }
});

// A click on a sync suggestion's button `actionId`.
const syncClick = (message, actionId) => {
  const button = message.blocks.at(-1).elements.find((element) => element.action_id === actionId);
  assert.ok(button, `no ${actionId} button`);
  return interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    response_url: RESPONSE_URL,
    trigger_id: "trigger-5",
    actions: [{ action_id: actionId, value: button.value, block_id: "nav" }],
  });
};

// Writes acme's executive summary into its doc, going through the walk as
// it stands, and returns the responses sent since.
async function writeExecSummary(t, environment = execEnv) {
  const { later: first } = await runTasksCommand("brief", "CDEV", environment);
  const sent = recordResponses(t);
  // Through every step to the review, which has no Next.
  let at = first;
  while (at.blocks.at(-1).elements.some((element) => element.action_id === "export:next")) {
    await send("/slack/interactions", execClick(at, "export:next"), {}, environment);
    at = sent.at(-1);
  }
  await send("/slack/interactions", execClick(at, "export:post"), {}, environment);
  assert.match(sent.at(-1).text, /^Added the executive summary/);
  return sent;
}

test("findAdditions finds new bullets and lines added under linked ones", async () => {
  const { findAdditions } = await import("../src/commands/debrief.js");
  const link = (ts) => execLink("CDEV", ts);
  const written = ["Period: 19/10/2026 – 26/10/2026", "Incidents (1)", "Checkout is down  ·  Blocked  ·  To do", "Waiting on the provider", "On track (1)", "Upgrade Node  ·  On track  ·  In review"];
  const elements = [
    { type: "paragraph", level: 0, text: "Period: 19/10/2026 – 26/10/2026", links: [] },
    { type: "heading", level: 3, text: "Incidents (1)", links: [] },
    { type: "item", level: 0, text: "Checkout is down  ·  Blocked  ·  To do", links: [link("100.8")] },
    { type: "item", level: 1, text: "Waiting on the provider", links: [] },
    { type: "item", level: 1, text: "Fixed by Friday", links: [] },
    { type: "paragraph", level: 0, text: "Client retests after", links: [] },
    { type: "heading", level: 3, text: "On track (1)", links: [] },
    { type: "item", level: 0, text: "Upgrade Node  ·  On track  ·  In review", links: [link("100.3")] },
    { type: "item", level: 0, text: "Bulk export", links: [] },
    { type: "item", level: 1, text: "For finance", links: [] },
    { type: "item", level: 0, text: "  ", links: [] },
    { type: "item", level: 0, text: "SSO", links: [] },
  ];
  const point = { kind: "POINT", channel: "CDEV", ts: "100.8", title: "Checkout is down", text: "Fixed by Friday\nClient retests after" };
  assert.deepEqual(findAdditions(elements, written), [
    point,
    { kind: "TASK", text: "Bulk export", details: "For finance" },
    { kind: "TASK", text: "SSO", details: "" },
  ]);
  // What was found before, however decided, isn't found again.
  assert.deepEqual(findAdditions(elements, written, [{ ...point, text: "Fixed by Friday" }, { kind: "TASK", text: "SSO" }]), [
    { ...point, text: "Client retests after" },
    { kind: "TASK", text: "Bulk export", details: "For finance" },
  ]);
});

test("/cade debrief goes through what the call added, posting points in their threads and tracking new tasks", async (t) => {
  const additions = [
    { type: "heading", level: 3, text: "Incidents (1)", links: [] },
    { type: "item", level: 0, text: "Checkout is down  ·  On track  ·  To do", links: [execLink("CDEV", "100.8")] },
    { type: "item", level: 1, text: "Provider says fixed by Friday", links: [] },
    { type: "item", level: 1, text: "Client will retest", links: [] },
    { type: "item", level: 0, text: "Bulk export to CSV", links: [] },
    { type: "item", level: 1, text: "Needed for the finance team", links: [] },
  ];
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: "CDEV", ts: "100.9" }),
    "chat.getPermalink": { permalink: "https://slack.example/p109" },
    doc: (body) => (body.action === "doc.read" ? { ok: true, elements: additions } : { ok: true, url: DOC_TAB }),
  });
  await storeExecWork();
  const sent = await writeExecSummary(t);
  const key = calls.find((call) => call.method === "doc").args.key;

  calls.length = 0;
  const { now, later } = await runTasksCommand("debrief", "CDEV", execEnv);
  assert.equal(now, "");
  assert.deepEqual(calls.find((call) => call.method === "doc").args, { secret: "google-secret", action: "doc.read", docId: DOC_ID, tab: "Summary", key });
  assert.match(messageText(later), /2 to go/);
  assert.ok(messageText(later).includes(`*Added under* <${execLink("CDEV", "100.8")}|Checkout is down>\n> Provider says fixed by Friday\n> Client will retest`));

  // Apply opens a text box with the point, to edit, then posts it in its
  // thread and moves on.
  calls.length = 0;
  await send("/slack/interactions", syncClick(later, "import:apply"), {}, execEnv);
  const box = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(box.callback_id, "import:point");
  assert.equal(box.blocks[1].element.initial_value, "Provider says fixed by Friday\nClient will retest");
  calls.length = 0;
  await send("/slack/interactions", interaction({
    type: "view_submission",
    user: { id: "UACTOR" },
    view: { callback_id: "import:point", private_metadata: box.private_metadata, state: { values: { message: { value: { value: "Fixed by Friday; the client retests after." } } } } },
  }), {}, execEnv);
  const posted = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(posted.channel, "CDEV");
  assert.equal(posted.thread_ts, "100.8");
  assert.equal(posted.text, "Fixed by Friday; the client retests after.");
  assert.equal(posted.blocks[1].elements[0].text, "From the client call, shared by <@UACTOR>");

  // Then the new task: Apply opens the task form, with its lines as the
  // initial message.
  const second = sent.at(-1);
  assert.match(messageText(second), /1 to go[\s\S]*\*New task:\* Bulk export to CSV\n> Needed for the finance team\nApply opens the task form, with the lines under it as the initial message, to track it in <#CDEV>/);
  calls.length = 0;
  await send("/slack/interactions", syncClick(second, "import:apply"), {}, execEnv);
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.callback_id, "track");
  assert.equal(form.blocks.find((block) => block.block_id === "title").element.initial_value, "Bulk export to CSV");
  assert.equal(form.blocks.find((block) => block.block_id === "initial_message").element.initial_value, "Needed for the finance team");
  calls.length = 0;
  const { values } = submission({ title: "Bulk export to CSV", priority: "Medium" }).view.state;
  values.initial_message = { value: { value: "Finance needs it by month end." } };
  await send("/slack/interactions", interaction({
    type: "view_submission",
    user: { id: "UACTOR" },
    view: { callback_id: "track", private_metadata: form.private_metadata, state: { values } },
  }), {}, execEnv);
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args);
  assert.deepEqual([posts[0].channel, posts[0].text], ["CDEV", "Medium task: Bulk export to CSV"]);
  assert.deepEqual([posts[1].channel, posts[1].thread_ts, posts[1].text], ["CDEV", "100.9", "Finance needs it by month end."]);
  assert.match(sent.at(-1).text, /^Nothing more to go through/);

  // Syncing again finds nothing new.
  const { later: again } = await runTasksCommand("debrief", "CDEV", execEnv);
  assert.match(again.text, /^Nothing more to go through/);
});

test("/cade debrief can discard a suggestion, and needs a summary in the doc", async (t) => {
  mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    doc: (body) =>
      body.action === "doc.read"
        ? { ok: true, elements: [{ type: "item", level: 0, text: "SSO", links: [] }] }
        : { ok: true, url: DOC_TAB },
  });
  await storeExecWork();
  const { later: none } = await runTasksCommand("debrief", "CDEV", execEnv);
  assert.equal(none.text, "acme has no executive summary in its Google Doc yet. Write one with `/cade brief`.");

  const sent = await writeExecSummary(t);
  const { later } = await runTasksCommand("debrief", "CDEV", execEnv);
  assert.match(messageText(later), /\*New task:\* SSO/);
  await send("/slack/interactions", syncClick(later, "import:discard"), {}, execEnv);
  assert.match(sent.at(-1).text, /^Nothing more to go through/);
});

test("npm run group adds or changes a group in cade.config.json", async () => {
  const { readArgs, withGroup } = await import("../scripts/group.mjs");
  assert.deepEqual(readArgs(["--name", "acme", "--channel", "C0000000002", "--doc", "new"]), { name: "acme", channel: "C0000000002", doc: "new" });
  assert.throws(() => readArgs(["--channel", "C1"]), /Give the group a --name/);
  assert.throws(() => readArgs(["--name", "acme", "--colour", "red"]), /I don't know "--colour"/);
  assert.throws(() => readArgs(["--name", "acme", "--channel"]), /--channel needs a value/);

  const start = JSON.stringify({ timezone: "UTC", channels: [{ name: "acme", channel: "C0000000002", doc: "https://docs.google.com/document/d/D/edit" }] });
  // A new group goes at the end, its settings in order.
  const added = JSON.parse(withGroup(start, "beta", { sheet: "https://docs.google.com/spreadsheets/d/S/edit", channel: "C0000000003" }));
  assert.equal(added.timezone, "UTC");
  assert.deepEqual(added.projects[1], { name: "beta", channel: "C0000000003", sheet: "https://docs.google.com/spreadsheets/d/S/edit" });
  // A group there already keeps what isn't given; `none` removes a setting.
  const changed = JSON.parse(withGroup(start, "acme", { sheet: "https://docs.google.com/spreadsheets/d/S/edit", doc: "none" }));
  assert.deepEqual(changed.projects, [{ name: "acme", channel: "C0000000002", sheet: "https://docs.google.com/spreadsheets/d/S/edit" }]);
  // An old client or incidents channel goes: a group has only its tasks channel.
  const old = JSON.stringify({ projects: [{ name: "acme", external: "C0000000001", channel: "C0000000002", incidents: "C0000000004" }] });
  assert.deepEqual(JSON.parse(withGroup(old, "acme", {})).projects, [{ name: "acme", channel: "C0000000002" }]);
  assert.throws(() => withGroup(start, "gamma", { doc: "none" }), /gamma needs a --channel/);
});

test("npm run group's guided setup finds channels and people", async () => {
  const { channelName, findChannel, memberIds, validChannelName } = await import("../scripts/group.mjs");
  assert.equal(channelName(" #Acme-Dev "), "acme-dev");
  assert.ok(validChannelName("acme-dev"));
  assert.ok(!validChannelName("acme dev"));
  assert.ok(!validChannelName("-acme"));

  // A fake Slack: two pages of channels, one lookup by ID, one email.
  const pages = [
    { channels: [{ id: "C0000000001", name: "general", is_member: true }], response_metadata: { next_cursor: "next" } },
    { channels: [{ id: "C0000000002", name: "acme-dev", is_member: false }] },
  ];
  const slack = async (method, args) => {
    if (method === "conversations.list") return pages[args.cursor ? 1 : 0];
    if (method === "conversations.info") {
      if (args.channel === "G0000000003") return { channel: { id: "G0000000003", name: "acme-client", is_private: true, is_member: true } };
      throw new Error("Slack conversations.info failed: channel_not_found");
    }
    if (method === "users.lookupByEmail") {
      if (args.email === "ann@acme.test") return { user: { id: "U0000000001" } };
      throw new Error("Slack users.lookupByEmail failed: users_not_found");
    }
    throw new Error(`unexpected ${method}`);
  };
  assert.deepEqual(await findChannel(slack, "#acme-dev"), { id: "C0000000002", name: "acme-dev", isPrivate: false, isMember: false });
  assert.deepEqual(await findChannel(slack, "G0000000003"), { id: "G0000000003", name: "acme-client", isPrivate: true, isMember: true });
  assert.equal(await findChannel(slack, "acme-other"), null);
  assert.equal(await findChannel(slack, "C0000000009"), null);

  assert.deepEqual(await memberIds(slack, "ann@acme.test, U0000000002"), ["U0000000001", "U0000000002"]);
  await assert.rejects(memberIds(slack, "bob@acme.test"), /No one in this Slack workspace has the email bob@acme.test/);
  await assert.rejects(memberIds(slack, "bob"), /isn't an email or a Slack member ID/);
});

test("npm run group asks for each channel, existing by ID or new by name", async () => {
  const { channelPlan } = await import("../scripts/group.mjs");
  const channels = {
    C0000000001: { id: "C0000000001", name: "acme-dev", is_member: false },
    C0000000002: { id: "C0000000002", name: "acme-client", is_member: true },
  };
  let invited = false;
  const slack = async (method, args) => {
    if (method === "conversations.info") {
      // G0000000003 is private: Cade sees it only once invited.
      const found = channels[args.channel] ?? (invited && args.channel === "G0000000003" && { id: "G0000000003", name: "acme-other", is_private: true, is_member: true });
      if (!found) throw new Error("Slack conversations.info failed: channel_not_found");
      return { channel: found };
    }
    if (method === "conversations.list") return { channels: Object.values(channels) };
    throw new Error(`unexpected ${method}`);
  };
  // Answers in order, as typed; each question asked is recorded.
  const answering = (answers, onAsk = () => {}) => {
    const asked = [];
    const ask = async (question, fallback = "") => {
      asked.push(question);
      onAsk(asked.length);
      if (!answers.length) throw new Error(`ran out of answers at: ${question}`);
      return answers.shift() || fallback;
    };
    return { ask, asked };
  };
  const role = { field: "tasks", suffix: "dev", required: true };
  const log = console.log;
  console.log = () => {};
  try {
    // An existing public channel Cade isn't in: joined.
    let { ask } = answering(["e", "C0000000001"]);
    assert.deepEqual(await channelPlan(slack, ask, role, "Acme", [], undefined), { field: "tasks", action: "join", id: "C0000000001", name: "acme-dev", isPrivate: false, isMember: false });
    // A private one, seen once invited.
    ({ ask } = answering(["e", "G0000000003", ""], (n) => n === 3 && (invited = true)));
    assert.equal((await channelPlan(slack, ask, role, "Acme", [], undefined)).action, "use");
    // A new one: a taken name is refused, then the suggested one is made, private.
    const answers = answering(["n", "acme-dev", "n", "", "y"]);
    assert.deepEqual(await channelPlan(slack, answers.ask, role, "Beta", [], undefined), { field: "tasks", action: "create", name: "beta-dev", isPrivate: true });
    assert.ok(answers.asked.some((question) => question.includes("[beta-dev]")));
    // Enter keeps the group's channel; - removes an optional one.
    ({ ask } = answering([""]));
    assert.deepEqual(await channelPlan(slack, ask, role, "Acme", [], "C0000000002"), { field: "tasks", action: "keep", id: "C0000000002" });
    ({ ask } = answering(["-"]));
    assert.deepEqual(await channelPlan(slack, ask, { ...role, required: false }, "Acme", [], "C0000000002"), { field: "tasks", action: "remove" });
  } finally {
    console.log = log;
  }
});

test("the dev channel's summary links the group's Google Sheet", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  await putTask(env, "CDEV", "100.1", historyTask("100.1", { title: "Low task", priority: "Low" }).task);
  const withSheet = { ...env, GOOGLE_URL, GOOGLE_SECRET: "google-secret", PROJECTS: withSheets(env.CHANNEL_PAIRS) };
  await runTasksCommand("resync summary", "CDEV", withSheet);
  const dev = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  assert.match(
    dev,
    new RegExp(`^_Updated [^\\n]*\\. Cade keeps this up to date\\._ \\[All tasks in the Google Sheet\\]\\(https://docs\\.google\\.com/spreadsheets/d/${SHEETS.acme}/edit\\)\\.\\n`),
  );
});

// ---- Suggestions read with AI (see ai.js and ai-suggest.js) ----

// An environment with AI on, whose model answers `answer` (an object, as the
// changes it read) or throws it (an Error). The model's inputs are kept in
// `asked`.
function aiEnv(answer) {
  const asked = [];
  const AI = {
    run: async (model, input) => {
      asked.push({ model, input });
      if (answer instanceof Error) throw answer;
      return { choices: [{ message: { content: JSON.stringify(answer) } }] };
    },
  };
  return { environment: { ...env, AI, AI_MODEL: "on" }, asked };
}

// What the model read, with nothing changed but `fields`.
const aiRead = (fields = {}) => ({
  owner: { add: [], remove: [] },
  reviewer: { add: [], remove: [] },
  tester: { add: [], remove: [] },
  status: "",
  priority: "",
  dueDate: "",
  ...fields,
});

const aiClick = (button, extra = {}) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    trigger_id: "T1",
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: button.action_id, value: button.value }],
    ...extra,
  });

test("AI's changes are checked against the message and the task", async () => {
  const { checkChanges } = await import("../src/ai.js");
  const task = { status: "IN_PROGRESS", priority: "High", dueDate: "31/10/2026", people: { owner: ["UBOB"], reviewer: [], tester: [] } };
  const message = { user: "UACTOR", mentions: ["UREX", "UMIA"] };
  const allowed = { roles: ["owner", "reviewer", "tester"], status: true, details: true };
  const raw = aiRead({
    // UZED wasn't mentioned, and UBOB is an owner already.
    owner: { add: ["UREX", "UZED", "UBOB"], remove: ["UMIA"] },
    reviewer: { add: ["UMIA", "UMIA"], remove: [] },
    tester: { add: [], remove: ["UTOM"] },
    status: "IN_REVIEW",
    priority: "High",
    dueDate: "2026-02-30",
  });
  assert.deepEqual(checkChanges(raw, { task, message, allowed }), {
    people: { owner: { add: ["UREX"], remove: [] }, reviewer: { add: ["UMIA"], remove: [] } },
    status: "IN_REVIEW",
  });
  assert.deepEqual(checkChanges(aiRead({ priority: "Urgent", dueDate: "2026-11-06" }), { task, message, allowed }), {
    priority: "Urgent",
    dueDate: "06/11/2026",
  });
  assert.deepEqual(checkChanges(aiRead({ dueDate: "clear" }), { task, message, allowed }), { dueDate: "" });
  // What isn't allowed is dropped; with nothing left, nothing changes.
  const narrow = { roles: ["reviewer"], status: false, details: false, author: false };
  assert.equal(checkChanges(aiRead({ owner: { add: ["UREX"], remove: [] }, status: "DONE" }), { task, message, allowed: narrow }), null);
  // The author is added only when allowed.
  assert.deepEqual(
    checkChanges(aiRead({ reviewer: { add: ["UACTOR", "UREX"], remove: [] } }), { task, message, allowed: narrow }),
    { people: { reviewer: { add: ["UREX"], remove: [] } } },
  );
  assert.equal(checkChanges(aiRead({ status: "IN_PROGRESS", priority: "Loud" }), { task, message, allowed }), null);
});

test("with AI on, a message is read for every change and confirmed privately", async (t) => {
  const { environment, asked } = aiEnv(
    aiRead({
      owner: { add: ["UREX"], remove: ["UBOB"] },
      reviewer: { add: ["UMIA"], remove: [] },
      status: "IN_PROGRESS",
      priority: "Urgent",
      dueDate: "2026-10-30",
    }),
  );
  const calls = mockSlack(t, { ...slackUsers, stored: [ownTask({ owners: ["UBOB"] })] });
  calls.responses = recordResponses(t);
  const text = "<@UREX> can you take this over from <@UBOB>? <@UMIA> please review. Need it by Friday, it's blocking the release";
  await send("/slack/events", threadEvent(text), {}, environment);

  assert.equal(asked[0].model, "@cf/zai-org/glm-4.7-flash");
  assert.deepEqual(asked[0].input.chat_template_kwargs, { enable_thinking: false });
  const input = JSON.parse(asked[0].input.messages[1].content);
  assert.deepEqual(input.mentioned, ["UREX", "UBOB", "UMIA"]);
  assert.equal(input.task.status, "TODO");

  const question = ephemeral(calls);
  assert.equal(question.user, "UACTOR");
  assert.equal(question.text, "Should I update the task? From your message:");
  assert.equal(
    question.blocks[1].text.text,
    [
      "*Owners:* <@UREX> (Add) · <@UBOB> (Remove)",
      "*Reviewers:* <@UMIA> (Add)",
      "*Status:* :memo: To do → :arrow_forward: In progress",
      "*Priority:* :large_orange_circle: High → :red_circle: Urgent",
      "*Due:* 31/10/2026 → 30/10/2026",
    ].join("\n"),
  );
  const [confirm, change, skip] = question.blocks[2].elements;
  assert.deepEqual([confirm.text.text, change.text.text, skip.text.text], ["Accept", "Edit…", "Reject"]);

  // Accept applies it all, and the thread hears it as one message. Everyone
  // it names was mentioned in the message, so they're named, not notified
  // again, and asked nothing.
  await send("/slack/interactions", aiClick(confirm), {}, environment);
  const saved = await savedTask();
  assert.deepEqual(saved.people, { owner: ["UREX"], reviewer: ["UMIA"], tester: [] });
  assert.deepEqual([saved.status, saved.priority, saved.dueDate], ["IN_PROGRESS", "Urgent", "30/10/2026"]);
  const posts = calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1");
  assert.equal(posts.length, 1);
  assert.equal(
    posts[0].args.text,
    [
      "<@UACTOR> assigned <@UREX> as owner.",
      "<@UACTOR> removed <@UBOB> as owner.",
      "<@UACTOR> assigned <@UMIA> as reviewer.",
      "<@UACTOR> set the priority to :red_circle: Urgent.",
      "<@UACTOR> set the due date to 30/10/2026.",
      "<@UACTOR> set the status to :arrow_forward: In progress.",
    ].join("\n"),
  );
  assert.deepEqual(calls.responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Edit… opens the task's Edit form filled in with what AI read, and saving it applies the form", async (t) => {
  const { environment } = aiEnv(aiRead({ tester: { add: ["UTESS"], remove: [] }, status: "IN_TESTING" }));
  const calls = mockSlack(t, { ...slackUsers, stored: [ownTask({ testers: ["UTOM"] })] });
  calls.responses = recordResponses(t);
  await send("/slack/events", threadEvent("<@UTESS> can you test this now?"), {}, environment);
  const [, change] = ephemeral(calls).blocks[2].elements;

  await send("/slack/interactions", aiClick(change), {}, environment);
  const form = calls.at(-1).args.view;
  assert.equal(calls.at(-1).method, "views.open");
  assert.equal(form.callback_id, "task:edit");
  assert.deepEqual(form.blocks.map((block) => block.block_id), ["owner", "reviewer", "tester", "status", "priority", "due_date", "prs"]);
  assert.deepEqual(form.blocks[2].element.initial_users, ["UTOM", "UTESS"]);
  assert.equal(form.blocks[3].element.initial_option.value, "IN_TESTING");
  assert.equal(form.blocks[5].element.initial_date, "2026-10-31");

  // Whoever saved it changed their mind about UTOM, and moved the due date.
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: form.callback_id,
        private_metadata: form.private_metadata,
        state: {
          values: {
            owner: { value: { selected_users: [] } },
            reviewer: { value: { selected_users: [] } },
            tester: { value: { selected_users: ["UTESS"] } },
            status: { value: { selected_option: { value: "IN_TESTING" } } },
            priority: { value: { selected_option: { value: "High" } } },
            due_date: { value: { selected_date: "2026-11-02" } },
            prs: { value: { value: "" } },
          },
        },
      },
    }),
    {},
    environment,
  );
  const saved = await savedTask();
  assert.deepEqual(saved.people.tester, ["UTESS"]);
  assert.deepEqual([saved.status, saved.dueDate], ["IN_TESTING", "02/11/2026"]);
  assert.equal(
    calls.filter((call) => call.method === "chat.postMessage").at(-1).args.text,
    [
      // Tess was mentioned in the message; Tom, removed in the form, wasn't.
      "<@UACTOR> assigned <@UTESS> as tester.",
      "<@UACTOR> removed <@UTOM> as tester.",
      "<@UACTOR> set the due date to 02/11/2026.",
      "<@UACTOR> set the status to :test_tube: In testing.",
    ].join("\n"),
  );
  // The private question goes once the form is saved.
  assert.deepEqual(calls.responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("AI isn't asked about the priority and due date of an incident", async (t) => {
  const { environment } = aiEnv(aiRead({ priority: "Low", dueDate: "2026-10-30" }));
  const calls = mockSlack(t, { stored: [incidentTask()] });
  await send("/slack/events", threadEvent("This is urgent, need it by Friday"), {}, environment);
  assert.equal(ephemeral(calls), undefined);
});

test("with AI on, a message that changes nothing gets no question", async (t) => {
  const { environment, asked } = aiEnv(aiRead());
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("cc <@UREX>, thanks for the review earlier"), {}, environment);
  assert.equal(asked.length, 1);
  assert.equal(ephemeral(calls), undefined);
});

test("AI doesn't read messages in a task that's Done", async (t) => {
  const { environment, asked } = aiEnv(aiRead({ reviewer: { add: ["UMIA"], remove: [] } }));
  const calls = mockSlack(t, { stored: [withStatus("DONE")] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, environment);
  assert.equal(asked.length, 0);
  assert.equal(ephemeral(calls), undefined);
});

test("when AI fails, the message is read by its phrases instead", async (t) => {
  const { environment } = aiEnv(new Error("model unavailable"));
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, environment);
  const question = ephemeral(calls);
  assert.equal(question.text, "Should I update the task? From your message:");
  assert.deepEqual(suggestedChanges(question), { people: { reviewer: add("UMIA") } });
});

test("with suggestions off, AI isn't asked and only commands work", async (t) => {
  const { environment, asked } = aiEnv(aiRead({ reviewer: { add: ["UMIA"], remove: [] } }));
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, { ...environment, TASK_STATUS_CHANGE_DETECTION: "false" });
  assert.equal(asked.length, 0);
  assert.equal(ephemeral(calls), undefined);
});

test("ai in cade.config.json turns AI on or off, and aiModel names the model", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const project = (settings) => JSON.parse(readConfig(JSON.stringify({ projects: [{ name: "acme", channel: "C0000000002", ...settings }] })).PROJECTS)[0];
  assert.equal(project({ aiSuggestions: true }).aiSuggestions, true);
  assert.equal(project({ aiSuggestions: false }).aiSuggestions, false);
  assert.deepEqual(project({ aiSuggestions: true, aiModel: "@cf/qwen/qwen3-30b-a3b-fp8" }), { name: "acme", channel: "C0000000002", aiSuggestions: true, aiModel: "@cf/qwen/qwen3-30b-a3b-fp8" });
  // `aiSuggestions` was called `ai`, which used to take a model's name.
  assert.deepEqual(project({ ai: "@cf/qwen/qwen3-30b-a3b-fp8" }), { name: "acme", channel: "C0000000002", aiSuggestions: true, aiModel: "@cf/qwen/qwen3-30b-a3b-fp8" });
  assert.throws(() => project({ aiSuggestions: "gpt" }), /aiModel is a Workers AI/);
  assert.throws(() => project({ aiSuggestions: true, aiModel: "gpt" }), /acme's aiModel is a Workers AI/);
  const { aiModel } = await import("../src/ai.js");
  const env = (settings) => ({ AI: {}, CHANNEL_PAIRS: [{ name: "acme", channel: "CDEV", ...settings }] });
  assert.equal(aiModel(env({ aiSuggestions: true }), "CDEV"), "@cf/zai-org/glm-4.7-flash");
  assert.equal(aiModel(env({ aiSuggestions: true, aiModel: "@cf/x/y" }), "CDEV"), "@cf/x/y");
  assert.equal(aiModel(env({ aiModel: "@cf/x/y" }), "CDEV"), null, "aiModel alone does nothing");
  assert.equal(aiModel({ AI_MODEL: "on" }), null, "no binding");
  assert.equal(aiModel({ AI: {}, AI_MODEL: "off" }), null);
  assert.equal(aiModel({ AI: {}, AI_MODEL: "@cf/x/y" }), "@cf/x/y");
});

test("suggestions and ai can be set per group, over the setting for every group", async (t) => {
  const pairs = (acme) => env.CHANNEL_PAIRS.map((pair) => (pair.name === "acme" ? { ...pair, ...acme } : pair));

  // acme turns the proactive agent off, though it's on for every group.
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, { ...env, CHANNEL_PAIRS: pairs({ taskStatusChangeDetection: false }) });
  assert.equal(ephemeral(calls), undefined);

  // acme turns AI on, though it's off for every group.
  const { environment, asked } = aiEnv(aiRead({ reviewer: { add: ["UMIA"], remove: [] } }));
  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, { ...environment, AI_MODEL: "off", CHANNEL_PAIRS: pairs({ aiSuggestions: true }) });
  assert.equal(asked.length, 1);
  assert.equal(ephemeral(calls).text, "Should I update the task? From your message:");

  // Another group keeps the setting for every group.
  const { aiModel } = await import("../src/ai.js");
  const { suggesting } = await import("../src/intents.js");
  const split = { AI: {}, AI_MODEL: "off", TASK_STATUS_CHANGE_DETECTION: "false", CHANNEL_PAIRS: pairs({ ai: "@cf/x/y", taskStatusChangeDetection: ["hand-offs"] }) };
  assert.equal(aiModel(split, "CDEV"), "@cf/x/y");
  assert.equal(aiModel(split, "CTESTDEV"), null);
  assert.equal(suggesting(split, "hand-offs", "CDEV"), true);
  assert.equal(suggesting(split, "progress", "CDEV"), false);
  assert.equal(suggesting(split, "hand-offs", "CTESTDEV"), false);
});

test("npm run config checks each group's suggestions and ai, and npm run group keeps them", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const projects = [
    { name: "acme", channel: "C0000000002", taskStatusChangeDetection: true, aiSuggestions: true },
    { name: "test", channel: "C0000000003", taskStatusChangeDetection: false },
  ];
  assert.deepEqual(JSON.parse(readConfig(JSON.stringify({ projects })).PROJECTS), [
    projects[0],
    projects[1],
  ]);
  assert.throws(() => readConfig(JSON.stringify({ projects: [{ ...projects[0], aiSuggestions: "gpt" }] })), /acme's aiModel is a Workers AI/);
  assert.throws(() => readConfig(JSON.stringify({ projects: [{ ...projects[1], taskStatusChangeDetection: ["nope"] }] })), /test's taskStatusChangeDetection is true or false/);

  const { withGroup } = await import("../scripts/group.mjs");
  const next = JSON.parse(withGroup(JSON.stringify({ projects }), "test", { sheet: "https://docs.google.com/spreadsheets/d/S/edit" }));
  assert.deepEqual(next.projects[1], { name: "test", channel: "C0000000003", sheet: "https://docs.google.com/spreadsheets/d/S/edit", taskStatusChangeDetection: false });
});

test("the card's Edit opens one form with everything, and saving it applies what changed as one message", async (t) => {
  const record = ownTask({ owners: ["UREX"], reviewers: ["UMIA"] });
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/interactions", cardMenuClick("edit"));
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  const form = calls[0].args.view;
  assert.equal(form.callback_id, "task:edit");
  assert.deepEqual(form.blocks.map((block) => block.block_id), ["owner", "reviewer", "tester", "status", "priority", "due_date", "prs"]);
  assert.deepEqual(form.blocks[0].element.initial_users, ["UREX"]);
  assert.equal(form.blocks[3].element.initial_option.value, "TODO");

  // A PR linked with the status left alone keeps it, and the reviewer is
  // asked; a tester is added too.
  const values = {
    owner: { value: { selected_users: ["UREX"] } },
    reviewer: { value: { selected_users: ["UMIA"] } },
    tester: { value: { selected_users: ["UTESS"] } },
    status: { value: { selected_option: { value: "TODO" } } },
    priority: { value: { selected_option: { value: "High" } } },
    due_date: { value: { selected_date: "2026-10-31" } },
    prs: { value: { value: "https://github.com/acme/web/pull/12" } },
  };
  const submit = (state) =>
    send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values: state } } }));
  await submit(values);
  const saved = await savedTask();
  assert.deepEqual([saved.status, saved.prs, saved.people.tester], ["TODO", ["https://github.com/acme/web/pull/12"], ["UTESS"]]);
  const posts = calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1");
  assert.equal(posts.length, 1);
  assert.match(posts[0].args.text, /^<@UACTOR> linked /);
  assert.match(posts[0].args.text, /<@UACTOR> assigned <@UTESS> as tester\./);
  assert.match(posts[0].args.text, /<@UMIA>, could you review/);

  // A link that isn't a PR is refused in the form.
  const refused = await submit({ ...values, prs: { value: { value: "not a link" } } });
  assert.match(JSON.stringify(await refused.json()), /doesn't look like a pull request link/);
});

test("AI only adds the author to a role when their message speaks of themselves", async (t) => {
  // The model adds the author to whatever the message is about.
  for (const [text, suggested] of [
    ["this is urgent, client needs it by Friday", false],
    ["lgtm, approved", false],
    ["<@UREX> can you build this? I'll do the review", true],
    ["on it", true],
  ]) {
    const { environment } = aiEnv(aiRead({ reviewer: { add: ["UACTOR"], remove: [] } }));
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text), {}, environment);
    assert.equal(Boolean(ephemeral(calls)), suggested, text);
  }
});

test("AI is given the dates of the coming week, for deadlines like Friday", async () => {
  const { comingDays } = await import("../src/ai.js");
  const days = comingDays("2026-10-27");
  assert.equal(days.Friday, "2026-10-30");
  assert.equal(days.Tuesday, "2026-11-03");
  assert.equal(Object.keys(days).length, 7);
});

test("the Edit form of a suggestion shows the task as it will be, with its pull requests and status", () => {
  const { task } = storedTask({ reviewers: ["URIA"] });
  task.status = "IN_PROGRESS";
  task.prs = [MR];
  const field = (view, id) => view.blocks.find((block) => block.block_id === id).element;

  const form = editForm({ channel: "CDEV", ts: "100.1" }, task, {
    changes: { prs: { add: [PR], remove: [MR] }, people: { reviewer: { add: ["UREX"], remove: [] } } },
  });
  // Linking leaves the status alone, as the suggestion has none.
  assert.equal(field(form, "status").initial_option.value, "IN_PROGRESS");
  assert.equal(field(form, "prs").initial_value, PR);
  assert.deepEqual(field(form, "reviewer").initial_users, ["URIA", "UREX"]);

  // As the task stands, without a suggestion.
  const plain = editForm({ channel: "CDEV", ts: "100.1" }, task);
  assert.equal(field(plain, "status").initial_option.value, "IN_PROGRESS");
  assert.equal(field(plain, "prs").initial_value, MR);
});

test("Edit saves a new status and a tester who is the person saving, in one update, and posts the log", async (t) => {
  const task = storedTask({ reviewers: ["UMIA"] });
  task.task.status = "IN_REVIEW";
  const calls = mockSlack(t, { stored: [task] });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "task:edit",
        private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", details: false }),
        state: {
          values: {
            owner: { value: { selected_users: [] } },
            reviewer: { value: { selected_users: ["UMIA"] } },
            tester: { value: { selected_users: ["UACTOR"] } },
            status: { value: { selected_option: { value: "IN_TESTING" } } },
            prs: { value: { value: "" } },
          },
        },
      },
    }),
  );
  const saved = await savedTask();
  assert.deepEqual([saved.status, saved.people.tester], ["IN_TESTING", ["UACTOR"]]);
  // One update of the card, for all of it.
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 1);
  const post = calls.find((call) => call.method === "chat.postMessage");
  assert.equal(post.args.text, "<@UACTOR> assigned themselves as tester.\n<@UACTOR> set the status to :test_tube: In testing.");
});

test("someone removed from several roles at once is told once", async (t) => {
  const root = storedTask({ owners: ["UALICE"], reviewers: ["UALICE"] });
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> unassign <@UALICE>"));
  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(posts.map((call) => call.args.text), ["<@UALICE>, there's no need to work on this or review this anymore. Thanks!"]);
});

test("someone asked in several roles at once is asked once, and people asked alike share a note", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "task:edit",
        private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", details: false }),
        state: {
          values: {
            owner: { value: { selected_users: ["UBOB", "UREX"] } },
            reviewer: { value: { selected_users: ["UBOB"] } },
            tester: { value: { selected_users: [] } },
            status: { value: { selected_option: { value: "TODO" } } },
            prs: { value: { value: PR } },
          },
        },
      },
    }),
  );
  const post = calls.find((call) => call.method === "chat.postMessage").args.text;
  const notes = post.split("\n").filter((line) => line.includes("could you"));
  assert.deepEqual(notes, [
    `<@UBOB>, could you pick this up and review <${PR}|cade/42> when you get a chance? Thanks!`,
    "<@UREX>, could you pick this up when you get a chance? Thanks!",
  ]);
});

// ---- The update engine: what actually changed ----

const where = { channel: "CDEV", ts: "100.1" };

test("changeTask returns only what differs from the stored task", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
  const change = await changeTask(
    env,
    where,
    {
      // @alice is an owner already; @bob is new.
      people: { owner: { add: ["UALICE", "UBOB"] }, tester: { remove: ["UTOM"] } },
      // The priority is as it is; the due date is not.
      priority: "High",
      dueDate: "02/11/2026",
      status: "TODO",
    },
    "UACTOR",
  );
  assert.deepEqual(change.people, [{ role: "owner", added: ["UBOB"], removed: [] }]);
  assert.deepEqual([change.prs, change.priority, change.status], [null, null, null]);
  assert.deepEqual(change.dueDate, { from: "31/10/2026", to: "02/11/2026" });
  // Stored, and the card updated once, for all of it.
  const saved = await savedTask();
  assert.deepEqual([saved.people.owner, saved.dueDate], [["UALICE", "UBOB"], "02/11/2026"]);
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 1);
});

test("changeTask returns what each kind of change was from and to", async (t) => {
  const root = storedTask({ reviewers: ["UMIA"] });
  root.task.prs = [MR];
  mockSlack(t, { stored: [root] });
  const change = await changeTask(
    env,
    where,
    { prs: { add: [PR, MR], remove: [MR, "https://github.com/acme/other/pull/1"] }, priority: "Low", status: "IN_REVIEW" },
    "UACTOR",
  );
  assert.deepEqual(change.prs, { added: [PR], removed: [MR] });
  assert.deepEqual(change.priority, { from: "High", to: "Low" });
  assert.deepEqual(change.status, { from: "TODO", to: "IN_REVIEW" });
  assert.equal(change.task.status, "IN_REVIEW");
});

test("changeTask returns null, and saves nothing, when nothing differs", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
  const change = await changeTask(
    env,
    where,
    { people: { owner: { add: ["UALICE"] } }, priority: "High", dueDate: "31/10/2026", status: "TODO", prs: { remove: [PR] } },
    "UACTOR",
  );
  assert.equal(change, null);
  assert.deepEqual(calls.map((call) => call.method), []);
});

test("changeTask leaves an incident's priority and due date, and a task that is gone", async (t) => {
  mockSlack(t, { stored: [incidentTask({})] });
  assert.equal(await changeTask(env, where, { priority: "Low", dueDate: "01/01/2027" }, "UACTOR"), null);
  assert.equal(await changeTask(env, { channel: "CDEV", ts: "999.9" }, { priority: "Low" }, "UACTOR"), null);
});

test("changeTask leaves the status when the task moved on from where the suggestion saw it", async (t) => {
  const root = storedTask();
  root.task.status = "IN_PROGRESS";
  mockSlack(t, { stored: [root] });
  const change = await changeTask(env, where, { status: "IN_REVIEW", priority: "Low" }, "UACTOR", { from: "TODO" });
  assert.equal(change.status, null);
  assert.equal(change.priority.to, "Low");
  assert.equal((await savedTask()).status, "IN_PROGRESS");
});

// ---- The acknowledgement engine: what is said about a change ----

// A change as changeTask returns it, with `task` as it now is.
const changed = ({ people = [], prs = null, status = null, priority = null, dueDate = null, told = {}, task = {} } = {}) => ({
  user: "UACTOR",
  told,
  people,
  prs,
  status,
  priority,
  dueDate,
  task: {
    status: status?.to ?? "TODO",
    prs: prs?.added ?? [],
    releases: [],
    people: { owner: [], reviewer: [], tester: [] },
    ...task,
  },
});
const team = (owner = [], reviewer = [], tester = []) => ({ owner, reviewer, tester });

test("the change log has a line for each thing that changed, in order", () => {
  const change = changed({
    people: [
      { role: "owner", added: ["UBOB"], removed: [] },
      { role: "tester", added: [], removed: ["UTOM"] },
    ],
    prs: { added: [PR], removed: [MR] },
    priority: { from: "High", to: "Low" },
    dueDate: { from: "31/10/2026", to: "" },
    status: { from: "TODO", to: "IN_PROGRESS" },
  });
  assert.deepEqual(changeLog(change), [
    `<@UACTOR> linked <${PR}|cade/42>.`,
    `<@UACTOR> unlinked <${MR}|web-app/118>.`,
    "<@UACTOR> assigned <@UBOB> as owner.",
    "<@UACTOR> removed <@UTOM> as tester.",
    "<@UACTOR> set the priority to :large_green_circle: Low.",
    "<@UACTOR> removed the due date.",
    "<@UACTOR> set the status to :arrow_forward: In progress.",
  ]);
  assert.deepEqual(changeLog(changed()), []);
});

test("a person is asked once, for everything they are asked to do", () => {
  const notes = changeRequests(
    changed({
      people: [
        { role: "owner", added: ["UBOB", "UREX"], removed: [] },
        { role: "reviewer", added: ["UBOB"], removed: [] },
      ],
      prs: { added: [PR], removed: [] },
      task: { people: team(["UBOB", "UREX"], ["UBOB"]) },
    }),
  );
  assert.deepEqual(notes, [
    `<@UBOB>, could you pick this up and review <${PR}|cade/42> when you get a chance? Thanks!`,
    "<@UREX>, could you pick this up when you get a chance? Thanks!",
  ]);
});

test("people asked alike share a note, and reviewers kept are asked about the new pull requests", () => {
  const notes = changeRequests(
    changed({
      people: [{ role: "owner", added: ["UBOB", "UREX"], removed: [] }],
      prs: { added: [PR], removed: [] },
      task: { people: team(["UBOB", "UREX"], ["UMIA", "UZOE"]) },
    }),
  );
  assert.deepEqual(notes, [
    `<@UMIA>, <@UZOE>, could you review <${PR}|cade/42> when you get a chance? Thanks!`,
    "<@UBOB>, <@UREX>, could you pick this up when you get a chance? Thanks!",
  ]);
});

test("no one is asked who made the change, was told already, or has nothing to do yet", () => {
  const people = (role, ...ids) => [{ role, added: ids, removed: [] }];
  // Made the change, or told by the message the suggestion came from.
  assert.deepEqual(changeRequests(changed({ people: people("owner", "UACTOR"), task: { people: team(["UACTOR"]) } })), []);
  assert.deepEqual(changeRequests(changed({ people: people("owner", "UBOB"), told: { UBOB: null }, task: { people: team(["UBOB"]) } })), []);
  // A reviewer with no pull requests to review, a tester before In testing, an owner once Done.
  assert.deepEqual(changeRequests(changed({ people: people("reviewer", "UMIA"), task: { people: team([], ["UMIA"]) } })), []);
  assert.deepEqual(changeRequests(changed({ people: people("tester", "UTOM"), task: { people: team([], [], ["UTOM"]) } })), []);
  assert.deepEqual(changeRequests(changed({ people: people("owner", "UBOB"), task: { status: "DONE", people: team(["UBOB"]) } })), []);
  // Pull requests all sent for approval are not for reviewers to review.
  const sent = { people: team([], ["UMIA"]), prs: [PR], releases: [{ prs: [PR], status: "PENDING_APPROVAL" }] };
  assert.deepEqual(changeRequests(changed({ people: people("reviewer", "UMIA"), task: sent })), []);
});

test("moving to In testing asks every tester once, those just added too", () => {
  const notes = changeRequests(
    changed({
      people: [{ role: "tester", added: ["UTESS"], removed: [] }],
      status: { from: "IN_REVIEW", to: "IN_TESTING" },
      task: { people: team([], [], ["UTOM", "UTESS", "UACTOR"]) },
    }),
  );
  assert.deepEqual(notes, ["<@UTESS>, <@UTOM>, could you give this a test when you get a chance? Thanks!"]);
});

test("people removed are told only if they had been asked, and once", () => {
  // Removed from two roles they were asked in: one note.
  const both = changed({
    people: [
      { role: "owner", added: [], removed: ["UALICE"] },
      { role: "reviewer", added: [], removed: ["UALICE"] },
    ],
    task: { prs: [PR] },
  });
  assert.deepEqual(changeRequests(both), ["<@UALICE>, there's no need to work on this or review this anymore. Thanks!"]);

  // A tester removed as it moves to In testing was never asked to test it.
  const testing = changed({
    people: [{ role: "tester", added: [], removed: ["UTOM"] }],
    status: { from: "IN_REVIEW", to: "IN_TESTING" },
  });
  assert.deepEqual(changeRequests(testing), []);

  // Nor a reviewer removed as the only pull request goes, or when it is Done.
  const noPrs = changed({ people: [{ role: "reviewer", added: [], removed: ["UMIA"] }] });
  assert.deepEqual(changeRequests(noPrs), []);
  const done = changed({ people: [{ role: "owner", added: [], removed: ["UBOB"] }], task: { status: "DONE" } });
  assert.deepEqual(changeRequests(done), []);
});

test("changes that are not about people ask no one", () => {
  assert.deepEqual(changeRequests(changed({ priority: { from: "High", to: "Low" }, dueDate: { from: "", to: "01/01/2027" } })), []);
  assert.deepEqual(changeRequests(changed({ status: { from: "TODO", to: "IN_PROGRESS" } })), []);
});

test("the Home tab's Refresh button draws it again", async (t) => {
  const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored: [storedTask({ owners: ["UME"] })] });
  const body = interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:refresh" }] });
  assert.equal((await send("/slack/interactions", body)).status, 200);
  const [publish] = calls.filter((call) => call.method === "views.publish");
  assert.equal(publish.args.user_id, "UME");
  assert.match(publish.args.view.blocks.map((block) => blockText(block) ?? "").join("\n"), /Fix login/);
});
