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
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  CHANNEL_PAIRS: [
    { name: "acme", external: "CEXTERNAL", tasks: "CDEV" },
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
// Google web app are recorded with their JSON body: a Sheet row as the
// "sheet" method, answered by `responses.sheet`, and the Doc's as "doc",
// answered by `responses.doc`.
function mockSlack(t, { stored = [], ...responses } = {}) {
  DB.reset();
  seeded = Promise.all(stored.map(store));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
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
    "Happy to! Which role should I assign them to? Try `@Cade assign dev @person`, `@Cade assign review @person`, `@Cade assign test @person`.",
  );
});

test("@Cade assign without anyone mentioned asks privately, with a button that opens every role's form", async (t) => {
  for (const text of ["<@UBOT> assign", "<@UBOT> assign reviewer"]) {
    const calls = mockSlack(t, { stored: [ownTask({ developers: ["UREX"] })] });
    calls.responses = recordResponses(t);
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"], text);
    const [button] = calls[0].args.blocks[1].elements;
    assert.equal(button.text.text, "Assign people");

    await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        trigger_id: "T1",
        user: { id: "UACTOR" },
        response_url: RESPONSE_URL,
        actions: [{ action_id: button.action_id, value: button.value }],
      }),
    );
    const form = calls.at(-1).args.view;
    assert.equal(form.callback_id, "assign:team");
    assert.deepEqual(form.blocks.map((block) => block.block_id), ["developer", "reviewer", "tester"]);
    assert.deepEqual(form.blocks[0].element.initial_users, ["UREX"]);
    // The private button goes as soon as the form is open.
    assert.deepEqual(calls.responses, [{ response_type: "ephemeral", delete_original: true }]);

    await send(
      "/slack/interactions",
      interaction({
        type: "view_submission",
        user: { id: "UACTOR" },
        view: {
          callback_id: form.callback_id,
          private_metadata: form.private_metadata,
          state: { values: { developer: { value: { selected_users: ["UREX", "UBOB"] } } } },
        },
      }),
    );
    assert.deepEqual((await savedTask()).people.developer, ["UREX", "UBOB"]);
  }
});

test("@Cade assign takes short words for each role", async (t) => {
  for (const [text, role] of [
    ["<@UBOT> assign dev <@UBOB>", "developer"],
    ["<@UBOT> assign devs <@UBOB>", "developer"],
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
    // Reaching Done adds a note that the requirement thread was told, and
    // Client review a button to ask someone to approve it; nothing else is
    // posted here.
    for (const call of calls.filter((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV")) {
      if (call.args.blocks) assert.equal(call.args.blocks[1].elements[0].action_id, "status:ask", input);
      else assert.match(call.args.text, /^I've let/, input);
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
    "That one works with `@Cade assign dev @person` in a task thread in <#CDEV>.",
  );
});

test("@Cade track outside the external and dev channels points to them", async (t) => {
  // From a paired channel only its pair's channels are named.
  for (const [channel, hint] of [
    ["CINC", "<#CEXTERNAL> or <#CDEV>"],
    ["COTHER", "<#CEXTERNAL> or <#CTESTEXT> or <#CDEV> or <#CTESTDEV>"],
  ]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent("<@UBOT> track", { channel }), {}, incidentEnv);
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
    assert.match(lines[1], /`\/cade requirement` · `@Cade requirement` · `\/cade incident` · `@Cade incident` · `\/cade track` · `@Cade track`$/);
    // Saying it comes first in a task thread; the commands follow.
    assert.match(lines[2], /^\*In a task thread:\* Just talk to me: .* Or: `@Cade assign dev @person`/);
    for (const usage of ["assign dev @person", "unassign dev @person", "status", "priority high", "due 31/12/2026", "pr add <link>", "delete"]) {
      assert.ok(lines[2].includes(`\`@Cade ${usage}\``), usage);
    }
    assert.equal(lines[3], "*Your work:* `/cade tasks` · `/cade standup` · `/cade summary` · `/cade brief` · `/cade debrief`");
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

// Each group's own spreadsheet.
const SHEETS = { acme: "1AcmeSheetAcmeSheetAcmeSheet", test: "1TestSheetTestSheetTestSheet" };
const withSheets = (pairs) => pairs.map((pair) => ({ ...pair, sheet: `https://docs.google.com/spreadsheets/d/${SHEETS[pair.name]}/edit` }));
// The sheet's times are in TIMEZONE; these tests expect Sri Lanka time.
const sheetEnv = { ...env, CHANNEL_PAIRS: withSheets(env.CHANNEL_PAIRS), GOOGLE_URL, GOOGLE_SECRET: "google-secret", TIMEZONE: "Asia/Colombo" };
const sendWithSheet = (path, body) => send(path, body, {}, sheetEnv);
const slackUsers = {
  "users.info": (args) => ({
    user: { profile: { display_name: { UCREATOR: "Randil", UALICE: "Alice", UBOB: "Bob" }[args.user] } },
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
  const channels = [{ name: "acme", tasks: "C0000000002", sheet }];
  assert.equal(JSON.parse(readConfig(JSON.stringify({ channels })).CHANNEL_PAIRS)[0].sheet, sheet);
  assert.throws(
    () => readConfig(JSON.stringify({ channels: [{ ...channels[0], sheet: "https://docs.google.com/document/d/1AcmeDocAcmeDocAcmeDocAcmeDoc/edit" }] })),
    /acme's sheet should be a Google Sheet's address/,
  );
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

// A group with only a tasks channel: the team tracks its own work, with no
// client channel to start requirements or incidents in.
const teamOnlyEnv = {
  ...env,
  CHANNEL_PAIRS: [...env.CHANNEL_PAIRS, { name: "team", tasks: "CTEAM" }],
};

test("a group with only a tasks channel tracks tasks, and says requirements need an external channel", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/commands", slash("track", "CTEAM"), {}, teamOnlyEnv);
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  assert.deepEqual(JSON.parse(calls[0].args.view.private_metadata), { channel: "CTEAM" });

  for (const name of ["requirement", "incident"]) {
    calls = mockSlack(t);
    const reply = await (await send("/slack/commands", slash(name, "CTEAM"), {}, teamOnlyEnv)).json();
    assert.equal(calls.length, 0);
    assert.equal(
      reply.text,
      "This group has no `external` channel, so that one isn't available here. Add one to its pair in `CHANNEL_PAIRS` to use it.",
    );
  }
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

test("@Cade requirement and @Cade incident outside a thread point to replying in one", async (t) => {
  for (const kind of ["requirement", "incident"]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(`<@UBOT> ${kind}`, { channel: "CEXTERNAL", ts: "400.1", thread_ts: undefined }), {}, incidentEnv);
    assert.equal(
      calls[0].args.text,
      `To start one from a message, reply \`@Cade ${kind}\` in its thread, or use \`/cade ${kind}\` for something new.`,
    );
  }
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
  // The task is Done in this mock, so moving it on and back to Done is a
  // change the requirement thread hears about.
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));
  await send("/slack/events", threadEvent("<@UBOT> status done"));
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
    // Done is posted in the requirement thread too; Client review once
    // someone is chosen to approve it.
    const posted = calls.some((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL");
    assert.equal(posted, status === "DONE", status);
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

// Saving the card menu's form `callbackId` for the task at CDEV/100.1.
const cardFormSubmission = (callbackId, values) =>
  interaction({
    type: "view_submission",
    user: { id: "UACTOR" },
    view: { callback_id: callbackId, private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1" }), state: { values } },
  });

const threadPosts = (calls) =>
  calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").map((call) => call.args.text);

test("a task's card has a menu, with the everyday choices first", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));
  const card = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.1").args;
  const { accessory } = card.blocks[0];
  assert.equal(accessory.action_id, "task:menu");
  assert.deepEqual(accessory.options.map((option) => option.value), ["assign", "status", "prs", "release", "more"]);
});

test("choosing from a task card's menu opens its form, filled in", async (t) => {
  for (const [choice, callbackId, initial] of [
    ["status", "status:form", (view) => view.blocks[0].element.initial_option.value],
    ["assign", "assign:team", (view) => view.blocks[0].element.initial_users],
    ["prs", "pr:form", (view) => view.blocks[0].element.initial_value],
    ["release", "release", (view) => view.blocks[0].element.initial_options.map((option) => option.value)],
  ]) {
    const record = ownTask({ developers: ["UREX"] });
    record.task.prs = ["https://github.com/acme/web/pull/9"];
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/interactions", cardMenuClick(choice));
    assert.deepEqual(calls.map((call) => call.method), ["views.open"], choice);
    const { view, trigger_id } = calls[0].args;
    assert.equal(trigger_id, "T1");
    assert.equal(view.callback_id, callbackId);
    const expected = {
      status: "TODO",
      assign: ["UREX"],
      prs: "https://github.com/acme/web/pull/9",
      release: ["https://github.com/acme/web/pull/9"],
    };
    assert.deepEqual(initial(view), expected[choice]);
  }
});

test("a task card's Send PRs for approval with nothing to send says so privately", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", cardMenuClick("release"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  assert.match(calls[0].args.text, /aren't any PRs/);
});

// The More panel's buttons for the task at CDEV/100.1, after choosing More.
async function morePanel(t, record) {
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/interactions", cardMenuClick("more"));
  const { view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(view.callback_id, "task:more");
  return view.blocks[1].elements;
}

const panelClick = (button) =>
  interaction({
    type: "block_actions",
    trigger_id: "T2",
    user: { id: "UACTOR" },
    view: { id: "V1" },
    actions: [{ action_id: button.action_id, value: button.value }],
  });

test("a task card's More panel offers the priority and due date only when the team owns them", async (t) => {
  const own = await morePanel(t, ownTask());
  assert.deepEqual(own.map((button) => button.action_id), ["task:more:priority", "task:more:due", "task:more:delete"]);
  const tracked = await morePanel(t, storedTask());
  assert.deepEqual(tracked.map((button) => button.action_id), ["task:more:detach", "task:more:delete"]);
  // Slack asks before Detach and Delete do anything.
  assert.ok(tracked.every((button) => button.confirm));
});

test("the More panel's priority and due date open their forms on top of it, filled in", async (t) => {
  const buttons = await morePanel(t, ownTask());
  for (const [button, callbackId, initial] of [
    [buttons[0], "priority:form", (view) => view.blocks[0].element.initial_option.value],
    [buttons[1], "due:form", (view) => view.blocks[0].element.initial_date],
  ]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/interactions", panelClick(button));
    assert.deepEqual(calls.map((call) => call.method), ["views.push"]);
    assert.equal(calls[0].args.trigger_id, "T2");
    assert.equal(calls[0].args.view.callback_id, callbackId);
    assert.equal(initial(calls[0].args.view), { "priority:form": "High", "due:form": "2026-10-31" }[callbackId]);
  }
});

test("the More panel's Detach detaches the task, tells both threads, and says so on the panel", async (t) => {
  const [detach] = await morePanel(t, storedTask());
  const calls = mockSlack(t, { stored: [requirementRoot({ task: true }), storedTask()] });
  await send("/slack/interactions", panelClick(detach));
  assert.equal((await savedTask()).source, undefined);
  assert.ok(calls.some((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL"));
  assert.match(threadPosts(calls)[0], /^<@UACTOR> detached this task/);
  const panel = calls.filter((call) => call.method === "views.update").at(-1).args;
  assert.equal(panel.view_id, "V1");
  assert.match(blockText(panel.view.blocks[0]), /^Detached \*Fix login\* from its requirement\./);
});

test("the More panel's Delete removes a task the team owns, and says so on the panel", async (t) => {
  const [, , remove] = await morePanel(t, ownTask());
  const calls = mockSlack(t, { stored: [ownTask()], "conversations.replies": { messages: [] } });
  await send("/slack/interactions", panelClick(remove));
  assert.equal(await savedTask(), null);
  assert.ok(calls.some((call) => call.method === "chat.delete" && call.args.ts === "100.1"));
  const panel = calls.filter((call) => call.method === "views.update").at(-1).args;
  assert.match(blockText(panel.view.blocks[0]), /^Done, the task/);
});

test("a task card's menu on a task that's gone says so privately", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/interactions", cardMenuClick("status"));
  assert.deepEqual(calls.map((call) => [call.method, call.args.user]), [["chat.postEphemeral", "UACTOR"]]);
});

test("saving the card's status form records who changed it in the thread, and nothing when unchanged", async (t) => {
  let calls = mockSlack(t, { stored: [ownTask({ testers: ["UTOM"] })] });
  await send("/slack/interactions", cardFormSubmission("status:form", { status: { value: { selected_option: { value: "IN_TESTING" } } } }));
  assert.equal((await savedTask()).status, "IN_TESTING");
  assert.deepEqual(threadPosts(calls), [
    "<@UACTOR> set the status to :test_tube: In testing.\n<@UTOM> could you give this a test when you get a chance? Thanks!",
  ]);

  calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", cardFormSubmission("status:form", { status: { value: { selected_option: { value: "TODO" } } } }));
  assert.deepEqual(calls, []);
});

test("saving the card's priority and due date forms records who changed them in the thread", async (t) => {
  for (const [callbackId, values, field, saved, posted] of [
    ["priority:form", { priority: { value: { selected_option: { value: "Low" } } } }, "priority", "Low", "<@UACTOR> set the priority to :large_green_circle: Low."],
    ["due:form", { due_date: { value: { selected_date: "2027-01-15" } } }, "dueDate", "15/01/2027", "<@UACTOR> set the due date to 15/01/2027."],
    ["due:form", { due_date: { value: { selected_date: null } } }, "dueDate", "", "<@UACTOR> removed the due date."],
  ]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/interactions", cardFormSubmission(callbackId, values));
    assert.equal((await savedTask())[field], saved);
    assert.deepEqual(threadPosts(calls), [posted]);
  }

  const calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", cardFormSubmission("priority:form", { priority: { value: { selected_option: { value: "High" } } } }));
  assert.deepEqual(calls, []);
});

test("the card's priority form on a task its requirement owns changes nothing and says why privately", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/interactions", cardFormSubmission("priority:form", { priority: { value: { selected_option: { value: "Low" } } } }));
  assert.equal((await savedTask()).priority, "High");
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  assert.match(calls[0].args.text, /client owns/);
});

test("saving the card's assign form records who was added and removed in the thread", async (t) => {
  const people = (developer, reviewer, tester) => ({
    developer: { value: { selected_users: developer } },
    reviewer: { value: { selected_users: reviewer } },
    tester: { value: { selected_users: tester } },
  });
  let calls = mockSlack(t, { stored: [ownTask({ testers: ["UTOM"] })] });
  await send("/slack/interactions", cardFormSubmission("assign:team", people(["UREX"], ["UMIA"], [])));
  assert.deepEqual((await savedTask()).people, { developer: ["UREX"], reviewer: ["UMIA"], tester: [] });
  assert.deepEqual(threadPosts(calls), [
    [
      "<@UACTOR> assigned <@UREX> as developer: could you pick this up when you get a chance? Thanks!",
      "<@UACTOR> added a reviewer. I'll ask them to review once a PR is linked.",
      "<@UACTOR> removed <@UTOM> as tester, so there's no need to test this anymore. Thanks!",
    ].join("\n"),
  ]);

  calls = mockSlack(t, { stored: [ownTask({ developers: ["UREX"] })] });
  await send("/slack/interactions", cardFormSubmission("assign:team", people(["UREX"], [], [])));
  assert.deepEqual(calls, []);
});

test("saving the card's Link PRs form links and unlinks them, and asks the reviewers", async (t) => {
  const form = (prs, reviewers) => ({
    prs: { value: { value: prs } },
    reviewer: { value: { selected_users: reviewers } },
  });
  const record = ownTask({ reviewers: ["UMIA"] });
  record.task.prs = ["https://github.com/acme/web/pull/9"];
  let calls = mockSlack(t, { stored: [record] });
  await send(
    "/slack/interactions",
    cardFormSubmission("pr:form", form("https://github.com/acme/web/pull/12\n<https://github.com/acme/api/pull/3|api#3>", ["UMIA"])),
  );
  const saved = await savedTask();
  assert.deepEqual(saved.prs, ["https://github.com/acme/web/pull/12", "https://github.com/acme/api/pull/3"]);
  assert.equal(saved.status, "IN_REVIEW");
  assert.deepEqual(threadPosts(calls), [
    [
      "<@UACTOR> linked <https://github.com/acme/web/pull/12|web/12>, <https://github.com/acme/api/pull/3|api/3> and moved the task to :eyes: In review.",
      "<@UACTOR> unlinked <https://github.com/acme/web/pull/9|web/9>.",
      "<@UMIA>, could you review <https://github.com/acme/web/pull/12|web/12>, <https://github.com/acme/api/pull/3|api/3> when you get a chance? Thanks!",
    ].join("\n"),
  ]);

  // A reviewer chosen with the first PR is asked in the same message.
  calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", cardFormSubmission("pr:form", form("https://github.com/acme/web/pull/12", ["UREX"])));
  assert.deepEqual(threadPosts(calls), [
    [
      "<@UACTOR> linked <https://github.com/acme/web/pull/12|web/12> and moved the task to :eyes: In review.",
      "<@UACTOR> assigned <@UREX> as reviewer: could you review <https://github.com/acme/web/pull/12|web/12> when you get a chance? Thanks!",
    ].join("\n"),
  ]);

  // No reviewer at all: the thread asks who should review.
  calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", cardFormSubmission("pr:form", form("https://github.com/acme/web/pull/12", [])));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.blocks[0].accessory.action_id, "pr:reviewers");

  // Unchanged: nothing.
  calls = mockSlack(t, { stored: [record] });
  await send("/slack/interactions", cardFormSubmission("pr:form", form("https://github.com/acme/web/pull/9", ["UMIA"])));
  assert.deepEqual(calls, []);
});

test("the card's Link PRs form refuses a line that isn't a pull request", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask()] });
  const response = await send(
    "/slack/interactions",
    cardFormSubmission("pr:form", {
      prs: { value: { value: "https://github.com/acme/web/pull/12\nhttps://example.com/nope" } },
      reviewer: { value: { selected_users: [] } },
    }),
  );
  const body = await response.json();
  assert.equal(body.response_action, "errors");
  assert.match(body.errors.prs, /example\.com\/nope/);
  assert.deepEqual(calls, []);
});

// A client clicking Approve or Not approve in the requirement thread.
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

test("Client review on a requirement task asks who approves, then asks them in the requirement thread", async (t) => {
  const calls = await clientReview(t, {
    ...threads(requirementRoot({ task: true }), requirementTask("IN_TESTING")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  }, { approver: "UPM" });

  // The command gets a ✅, and whoever sent it a private button to choose who
  // approves, which goes once they have.
  assert.ok(calls.some((call) => call.method === "reactions.add"));
  const ask = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(ask.user, "UACTOR");
  assert.equal(ask.text, "Who should approve this? Choose them, and I'll ask.");
  assert.deepEqual(calls.responses, [{ response_type: "ephemeral", delete_original: true }]);
  // The form picks whoever started the requirement, to begin with.
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.blocks[0].element.type, "users_select");
  assert.equal(form.blocks[0].element.initial_user, "UCREATOR");
  assert.equal(form.blocks[1].elements[0].text, "They approve it in the requirement thread.");

  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL");
  assert.equal(review.args.thread_ts, "200.1");
  assert.match(review.args.text, /\n<@UPM>, could you take a look and approve it/);
  assert.deepEqual(
    review.args.blocks[1].elements.map((button) => button.action_id),
    ["status:approve", "status:reject"],
  );
  assert.equal(JSON.parse(review.args.blocks[1].elements[0].value).approver, "UPM");
  // The task's thread hears who was asked, and where.
  const note = calls.at(-1);
  assert.equal(note.method, "chat.postMessage");
  assert.equal(note.args.channel, "CDEV");
  assert.equal(note.args.thread_ts, "100.1");
  assert.equal(note.args.text, "<@UACTOR> asked <@UPM> to review it in <https://slack.example/source|the requirement thread>.");
});

test("setting Client review again asks again who approves", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true, status: "CLIENT_REVIEW" }), requirementTask("CLIENT_REVIEW")));
  await send("/slack/events", threadEvent("<@UBOT> status client review"));
  assert.equal(calls.find((call) => call.method === "chat.postEphemeral").args.blocks[1].elements[0].action_id, "status:ask");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL"));
});

test("only the chosen approver can approve or reject", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true, status: "CLIENT_REVIEW" }), requirementTask("CLIENT_REVIEW")));
  const click = JSON.parse(new URLSearchParams(reviewClick("status:approve")).get("payload"));
  click.actions[0].value = JSON.stringify({ ...JSON.parse(click.actions[0].value), approver: "UPM" });
  await send("/slack/interactions", interaction(click));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  assert.equal(calls[0].args.user, "UCLIENT");
  assert.equal(calls[0].args.text, "Only <@UPM> can approve or reject this.");
  assert.equal((await savedTask()).status, "CLIENT_REVIEW");
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

// The acme pair with an incidents channel; the test pair has none.
const incidentEnv = {
  ...env,
  CHANNEL_PAIRS: [
    { name: "acme", external: "CEXTERNAL", tasks: "CDEV", incidents: "CINC" },
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

  // Client review asks whoever is chosen in the incident's thread, as for
  // requirements.
  calls = await clientReview(t, {
    ...threads(incidentRoot(), incidentTask("IN_TESTING")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  }, { channel: "CINC", environment: incidentEnv });
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
    { ...incidentEnv, CHANNEL_PAIRS: withSheets(incidentEnv.CHANNEL_PAIRS), GOOGLE_URL, GOOGLE_SECRET: "secret" },
  );
  const row = calls.find((call) => call.method === "sheet").args;
  assert.equal(row.project, "acme");
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

  assert.equal(later.text, "You have 5 open acme tasks.");
  const [header, developing, reviewing, testing] = later.blocks;
  assert.equal(header.text.text, "Your acme tasks");
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
    assert.equal(later.text, "You have 1 open acme task.", channel);
  }
});

test("/cade tasks outside every group shows each group in turn", async (t) => {
  const { later } = await tasksCommand(t, "tasks", "CRANDOM", ({
    CDEV: [historyTask("100.1", { developers: ["UACTOR"] })],
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
      historyTask("100.1", { title: "Build it", developers: ["UACTOR"] }),
      historyTask("100.2", { title: "Review it", reviewers: ["UACTOR"] }),
      historyTask("100.3", { title: "Both", developers: ["UACTOR"], testers: ["UACTOR"] }),
    ],
  });
  for (const [word, heading, text, lines] of [
    ["development", "Developing", "You have 2 open acme developing tasks.", 2],
    ["dev", "Developing", "You have 2 open acme developing tasks.", 2],
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
    CDEV: [historyTask("100.1", { developers: ["UACTOR"] })],
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
    CDEV: [historyTask("100.1", { developers: ["UBOB"] })],
  }));
  assert.equal(later.text, "You have no open acme tasks.");
  assert.equal(later.blocks[1].text.text, "You have no open tasks.");
});

test("/cade tasks leaves out deleted tasks", async (t) => {
  const { later } = await tasksCommand(t, "tasks", "CDEV", {
    CDEV: [historyTask("100.1", { developers: ["UACTOR"] }), historyTask("100.2", { developers: ["UACTOR"] })],
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
    // Not in a team channel, or not a task's thread. (Messages not in a
    // thread are asked whether to track them instead.)
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
    ["sounds good, thanks", storedTask()],
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

test("handing a To do task to a developer only offers to assign them, leaving it To do", async (t) => {
  // A new developer: just the assignment.
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("<@UREX> please start working on this"));
  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.text, "Looks like you asked <@UREX> to work on this. Should I assign them as developer?");
  assert.equal(question.blocks[1].elements[0].text.text, "Assign as developer");
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", ["UREX"]));

  // Assigned ahead of time: nothing to ask, since the work starts when they say so.
  calls = mockSlack(t, { stored: [storedTask({ developers: ["UREX"] })] });
  await send("/slack/events", threadReply("<@UREX> you can start working on this now"));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
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

test("a developer saying they've started offers to move the task to In progress", async (t) => {
  for (const text of [
    "okay, started working on this",
    "Started on it",
    "on it",
    "I'm on it",
    "I’m on this now",
    "picking this up",
    "I'll take this",
    "looking into it",
  ]) {
    const calls = mockSlack(t, { stored: [storedTask({ developers: ["UACTOR"] })] });
    await send("/slack/events", threadReply(text));
    const question = calls.find((call) => call.method === "chat.postEphemeral")?.args;
    assert.ok(question, text);
    assert.equal(question.user, "UACTOR");
    assert.equal(question.text, "Sounds like you've started on this. Should I move the task to :arrow_forward: In progress?", text);
    assert.equal(question.blocks[1].elements[0].text.text, "Move to In progress");
    assert.equal(question.blocks[1].elements[0].value, assignValue("developer", [], "IN_PROGRESS"));
  }
});

test("someone who isn't a developer saying they've started is offered to be assigned, or to choose developers", async (t) => {
  // To do: assign them and move it, or choose developers and move it.
  let calls = mockSlack(t, { stored: [storedTask({ developers: ["UREX"] })] });
  await send("/slack/events", threadReply("ok, the team has started working on this"));
  let question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(
    question.text,
    "Sounds like the work has started. Should I move the task to :arrow_forward: In progress, with you or others as developer?",
  );
  const [me, choose, skip] = question.blocks[1].elements;
  assert.equal(me.text.text, "Assign me and move to In progress");
  assert.equal(me.value, assignValue("developer", ["UACTOR"], "IN_PROGRESS"));
  assert.equal(choose.text.text, "Choose developers and move to In progress");
  assert.equal(choose.action_id, "assign:choose-start");
  assert.deepEqual(JSON.parse(choose.value), { channel: "CDEV", ts: "100.1" });
  assert.equal(skip.text.text, "Not now");

  // Under way already: just the assignment.
  calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  await send("/slack/events", threadReply("picking this up"));
  question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.text, "Sounds like you're working on this. Should I assign you as developer?");
  assert.equal(question.blocks[1].elements[0].text.text, "Assign me as developer");
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", ["UACTOR"]));
});

test("Choose developers and move opens the developers form, which then moves the task", async (t) => {
  let calls = mockSlack(t, { stored: [storedTask({ developers: ["UREX"] })] });
  const sent = recordResponses(t);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "trigger-4",
      user: { id: "UPICKER" },
      channel: { id: "CDEV" },
      container: { is_ephemeral: true },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "assign:choose-start", value: JSON.stringify({ channel: "CDEV", ts: "100.1" }) }],
    }),
  );
  const open = calls.find((call) => call.method === "views.open").args;
  assert.equal(open.trigger_id, "trigger-4");
  assert.deepEqual(JSON.parse(open.view.private_metadata), { channel: "CDEV", ts: "100.1", role: "developer", moveTo: "IN_PROGRESS" });
  assert.equal(open.view.submit.text, "Save and move");
  assert.equal(open.view.blocks[0].optional, false);
  assert.deepEqual(open.view.blocks[0].element.initial_users, ["UREX"]);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  calls = mockSlack(t, { stored: [storedTask({ developers: ["UREX"] })] });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UPICKER" },
      view: {
        callback_id: "assign:people",
        private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", role: "developer", moveTo: "IN_PROGRESS" }),
        state: { values: { people: { value: { selected_users: ["UREX", "UBOB", "UPICKER"] } } } },
      },
    }),
  );
  assert.deepEqual((await savedTask()).people.developer, ["UREX", "UBOB", "UPICKER"]);
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  // Those added, the picker aside, are told; nothing is asked of them.
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UBOB> you're down as developer on this, and it's :arrow_forward: In progress.\n<@UPICKER> moved the task to :arrow_forward: In progress.",
  );
  // There's no button message in the thread to remove.
  assert.ok(!calls.some((call) => call.method === "chat.delete"));
});

test("saying you've started in a tracked requirement's thread offers to move its task", async (t) => {
  // A developer: just the move.
  const task = requirementTask("TODO");
  task.task.people.developer = ["UACTOR"];
  let calls = mockSlack(t, threads(requirementRoot({ task: true }), task));
  await send("/slack/events", requirementReply("I started working on this"));
  let question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.channel, "CEXTERNAL");
  assert.equal(question.thread_ts, "200.1");
  assert.equal(
    question.text,
    "Sounds like you've started on this. Should I move the task of <https://slack.example/p100|Fix login> to :arrow_forward: In progress?",
  );
  // The button changes the task in the dev channel.
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", [], "IN_PROGRESS"));

  // Anyone else: both offers, for the task in the dev channel.
  calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("TODO")));
  await send("/slack/events", requirementReply("the team started working on this today"));
  question = calls.find((call) => call.method === "chat.postEphemeral").args;
  const [me, choose] = question.blocks[1].elements;
  assert.equal(me.value, assignValue("developer", ["UACTOR"], "IN_PROGRESS"));
  assert.deepEqual(JSON.parse(choose.value), { channel: "CDEV", ts: "100.1" });
});

test("saying you've started in an untracked requirement's thread offers to track it In progress", async (t) => {
  const calls = mockSlack(t, { stored: [requirementRoot()] });
  await send("/slack/events", requirementReply("okay, started working on this"));
  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.thread_ts, "200.1");
  assert.equal(question.text, "Sounds like the work has started. Should I track this as a task, :arrow_forward: In progress?");
  const [me, choose, skip] = question.blocks[1].elements;
  const origin = {
    channel: "CEXTERNAL",
    threadTs: "200.1",
    requirement: true,
    incident: false,
    title: "Export reports",
    priority: "High",
    dueDate: "31/10/2026",
    started: true,
  };
  assert.equal(me.text.text, "Track and assign me");
  assert.equal(me.action_id, "track:assign");
  assert.deepEqual(JSON.parse(me.value), { ...origin, developers: ["UACTOR"] });
  assert.equal(choose.text.text, "Track and choose developers");
  assert.equal(choose.action_id, "track:assign");
  assert.deepEqual(JSON.parse(choose.value), { ...origin, chooseDevelopers: true });
  assert.equal(skip.text.text, "Not now");
});

test("the track form asks for developers when tracking work that has started", async (t) => {
  const calls = mockSlack(t);
  recordResponses(t);
  const origin = { channel: "CEXTERNAL", threadTs: "200.1", requirement: true, title: "Export reports", priority: "High", dueDate: "", started: true, chooseDevelopers: true };
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "trigger-7",
      user: { id: "UACTOR" },
      channel: { id: "CEXTERNAL" },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "track:assign", value: JSON.stringify(origin) }],
    }),
  );
  const view = calls.find((call) => call.method === "views.open").args.view;
  const developers = view.blocks.find((block) => block.block_id === "developers");
  assert.equal(developers.element.type, "multi_users_select");
});

test("a task tracked as started is In progress, and its other developers are told", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [requirementRoot()] });
  const submission = titleOnlySubmission("Export reports", {
    channel: "CEXTERNAL",
    threadTs: "200.1",
    requirement: true,
    priority: "High",
    started: true,
    chooseDevelopers: true,
  });
  submission.view.state.values.developers = { value: { selected_users: ["UCREATOR", "UREX"] } };
  await send("/slack/interactions", interaction(submission));
  assert.deepEqual((await savedTask()).people.developer, ["UCREATOR", "UREX"]);
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  const told = calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").args;
  assert.equal(told.text, "<@UREX> you're down as developer on this, and it's :arrow_forward: In progress.");
});

test("tracking yourself as started tells no one", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [requirementRoot()] });
  await send(
    "/slack/interactions",
    interaction(
      titleOnlySubmission("Export reports", {
        channel: "CEXTERNAL",
        threadTs: "200.1",
        requirement: true,
        priority: "High",
        started: true,
        developers: ["UCREATOR"],
      }),
    ),
  );
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1"));
});

test("saying you've started asks nothing when there's nothing to change, or it isn't a task thread", async (t) => {
  for (const [text, root, overrides] of [
    // A developer on a task that's under way.
    ["started working on this", (() => {
      const root = withStatus("IN_PROGRESS");
      root.task.people.developer = ["UACTOR"];
      return root;
    })(), {}],
    // Anyone, on a task that's Done.
    ["picking this up", withStatus("DONE"), {}],
    // Not about the task, or not a task thread.
    ["can you comment on it?", storedTask(), {}],
    ["started working on this", null, {}],
    ["started working on this", storedTask(), { channel: "CEXTERNAL" }],
  ]) {
    const calls = mockSlack(t, { stored: root ? [root] : [] });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${overrides.channel ?? ""}`);
  }
});

test("Assign me and move to In progress assigns them and moves the task", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("developer", ["UACTOR"], "IN_PROGRESS")));
  assert.deepEqual((await savedTask()).people.developer, ["UACTOR"]);
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UACTOR> moved the task to :arrow_forward: In progress.",
  );
});

test("an incident's developer saying they've started is offered In progress in the incidents channel", async (t) => {
  const record = incidentTask("TODO");
  record.task.people.developer = ["UACTOR"];
  const calls = mockSlack(t, threads(incidentRoot(), record));
  await send("/slack/events", threadReply("on it", { channel: "CINC" }), {}, incidentEnv);
  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.blocks[1].elements[0].text.text, "Move to In progress");
  assert.equal(JSON.parse(question.blocks[1].elements[0].value).channel, "CINC");
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

test("a task tracked with Track and assign starts with its developers, To do", async (t) => {
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
  assert.deepEqual((await savedTask()).status, "TODO");
  // The requirement shows In progress, as for any tracked task, and links to the task.
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
    "Looks like you asked <@UREX> to work on this. Should I assign them as developer of <https://slack.example/p100|Fix login>?",
  );
  // The button changes the task in the dev channel, and says it came from
  // the requirement thread.
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", ["UREX"], null, true));
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
  const calls = await clientReview(t, {
    ...threads(requirementRoot({ task: true }), task),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });

  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
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
    ...threads(requirementRoot({ task: true }), requirementTask("IN_TESTING")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
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
  const calls = await clientReview(t, {
    ...threads(requirementRoot({ task: true }), requirementTask("IN_TESTING")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
  assert.equal(
    review.text,
    "Good news! <@UACTOR> says this is ready for review.\n<@UCREATOR>, could you take a look and approve it, or let us know what needs to change?",
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
  assert.equal(calls[0].args.text, "That one works with `@Cade assign dev @person` in a task thread in <#CDEV>.");

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
    "reactions:write",
    "users:read",
    "users:read.email",
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
  // So is the external channel, for a team that only tracks its own tasks.
  const teamOnly = [{ name: "team", tasks: "C0000000003" }];
  assert.deepEqual(readConfig(JSON.stringify({ channels: teamOnly })), { CHANNEL_PAIRS: JSON.stringify(teamOnly) });
});

test("npm run config stops on a mistake, before uploading anything", async () => {
  const { readConfig } = await import("../scripts/config.mjs");
  const good = [{ name: "acme", external: "C0000000001", tasks: "C0000000002" }];
  for (const [config, problem] of [
    ["{", /not valid JSON/],
    [{ timezone: "UTC" }, /must list \{ name, tasks \}/],
    [{ channels: [{ external: "C0000000001", tasks: "C0000000002" }] }, /must list \{ name, tasks \}/],
    [{ channels: [{ name: "acme", external: "C0000000001" }] }, /must list \{ name, tasks \}/],
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
  assert.equal(JSON.parse(secrets.CHANNEL_PAIRS).length, 3);
});

test("npm run dev passes its settings to Wrangler as a quoted .env file", async () => {
  const { envFile } = await import("../scripts/dev.mjs");
  const pairs = JSON.stringify([{ name: "acme", external: "C0000000001", tasks: "C0000000002" }]);
  assert.equal(
    envFile({ CHANNEL_PAIRS: pairs, TIMEZONE: "UTC", SLACK_BOT_TOKEN: "xoxb-1", GOOGLE_URL: undefined }),
    `CHANNEL_PAIRS='${pairs}'\nTIMEZONE='UTC'\nSLACK_BOT_TOKEN='xoxb-1'`,
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
  const channels = [{ name: "acme", external: "C0000000001", tasks: "C0000000002", doc }];
  const googleUrl = "https://script.google.com/macros/s/AKfy-abc/exec";
  const secrets = readConfig(JSON.stringify({ channels, googleUrl }));
  assert.equal(secrets.GOOGLE_URL, googleUrl);
  assert.equal(JSON.parse(secrets.CHANNEL_PAIRS)[0].doc, doc);
  assert.throws(() => readConfig(JSON.stringify({ channels: [{ ...channels[0], doc: "acme doc" }] })), /acme's doc should be a Google Doc's address/);
  assert.throws(() => readConfig(JSON.stringify({ channels, googleUrl: doc })), /googleUrl should be the web app URL/);
  // The old settings, and the secret, stay out of the file.
  assert.throws(() => readConfig(JSON.stringify({ channels, sheetUrl: googleUrl })), /has "sheetUrl"/);
  assert.throws(() => readConfig(JSON.stringify({ channels, googleSecret: "s" })), /has "googleSecret"/);
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

test("handlers' intents are registered in order: PR links, reports, hand-offs, started, progress, then new threads", async () => {
  const { intents } = await import("../src/commands/registry.js");
  assert.deepEqual(
    [...intents].sort((a, b) => a.order - b.order).map((each) => each.name),
    ["pr-link", "started:reported", "hand-off:reviewer", "hand-off:tester", "hand-off:developer", "started", "progress", "new-thread"],
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
    const record = ownTask({ developers: ["UDEV1", "UDEV2"], reviewers: ["UMIA"], testers: ["UTOM"] });
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

test("a report that someone new started still offers to assign them", async (t) => {
  const record = ownTask({ developers: ["UDEV1"] });
  record.task.status = "IN_PROGRESS";
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/events", threadEvent("<@UREX> started working on the review comments", { user: "UDEV1" }));
  assert.equal(calls[0].method, "chat.postEphemeral");
  assert.equal(calls[0].args.text, "Sounds like <@UREX> started on this. Should I assign them as developer?");
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
  assert.deepEqual([...actions.matchAll(/"([a-z]+\.[a-z]+)"/g)].map(([, name]) => name), ["sheet.row", "sheet.create", "doc.write", "doc.read", "doc.create"]);
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
  assert.equal(later.text, "<@UBOB> has 2 open acme tasks.");
  assert.equal(later.blocks[0].text.text, "Bob's acme tasks");
  assert.match(later.blocks[1].text.text, /^\*Developing \(1\)\*\n• <[^|]+\|Bob's>/);
  assert.match(later.blocks[2].text.text, /^\*Reviewing \(1\)\*\n• <[^|]+\|Both>/);

  // Naming yourself is the same as naming no one.
  const mine = await tasksCommand(t, "tasks <@UACTOR>", "CDEV", { CDEV: [historyTask("100.1", { developers: ["UACTOR"] })] });
  assert.equal(mine.later.text, "You have 1 open acme task.");

  const none = await tasksCommand(t, "tasks review <@UBOB>", "CDEV", { CDEV: [historyTask("100.1", { developers: ["UBOB"] })] });
  assert.equal(none.later.text, "<@UBOB> has no open acme reviewing tasks.");
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
      historyTask("100.1", { title: "Started", developers: ["UACTOR"], status: "IN_PROGRESS" }),
      historyTask("100.2", { title: "Waiting", developers: ["UACTOR"] }),
      historyTask("100.3", { title: "Finished", developers: ["UACTOR"], status: "DONE" }),
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
  assert.equal(later.text, "<@UBOB> has 1 acme developing task: In progress  ·  Due before today.");
  assert.equal(later.blocks[0].text.text, "Bob's acme tasks: Developing");
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
  assert.deepEqual((await savedTask("CDEV", "100.2")).people.developer, ["UALICE"]);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.2");
  assert.equal(post.text, "<@UACTOR> assigned this to <@UALICE>.\n<@UALICE> could you pick this up when you get a chance? Thanks!");
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
  assert.equal(sent.at(-1).text, "Every open acme task has a developer. Nice!");
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
    'I don\'t know "everyone" as an option. Send `/cade standup` to go through everyone\'s tasks, or `/cade standup -unassigned` for those with no developer.',
  );
  // It's the team's, so it runs in its channels.
  const outside = await tasksCommand(t, "standup", "CEXTERNAL", {});
  assert.equal(JSON.parse(outside.now).text, "That one works with `/cade standup` in <#CDEV>.");
});

test("/cade tasks -unassigned lists open tasks with no developer", async (t) => {
  const { later } = await tasksCommand(t, "tasks -unassigned", "CDEV", standupTasks());
  assert.equal(later.text, "There is 1 open acme unassigned task.");
  assert.equal(later.blocks[0].text.text, "Unassigned acme tasks");
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

test("sending PRs asks the client in the requirement thread and says so in the task's", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR]),
    "chat.postMessage": { ts: "200.9" },
    "chat.getPermalink": { permalink: "https://slack.example/release" },
  });
  const responses = recordResponses(t);
  await send("/slack/interactions", releaseSubmission([PR]));

  assert.deepEqual(await releasesOf(), [{ ...inReview([PR]), decidedBy: null }]);
  // The private Choose PRs button goes.
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
  // The release in review, named by what it completes, then the PRs not
  // sent, the same on the requirement's card and the task's.
  const shown = `*Pending approval:* Login and sign-up (<${PR}|cade/42>)\n*Pending:* <${MR}|web-app/118>`;
  assert.equal(rootPrs(calls), shown);
  assert.equal(shownPrs(calls, "100.1"), shown);

  const ask = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(ask.channel, "CEXTERNAL");
  assert.equal(ask.thread_ts, "200.1");
  assert.equal(ask.blocks[0].text.text, `<@UDEV> sent these PRs for approval: <${PR}|cade/42>\n*Completes:* Login and sign-up`);
  assert.match(ask.blocks[1].text.text, /^<@UCREATOR>, could you take a look and approve them/);
  assert.deepEqual(ask.blocks[2].elements.map((button) => button.action_id), ["release:approve", "release:reject"]);

  const told = calls.at(-1);
  assert.equal(told.method, "chat.postMessage");
  assert.equal(told.args.channel, "CDEV");
  assert.equal(told.args.thread_ts, "100.1");
  assert.equal(
    told.args.text,
    `<@UDEV> sent <${PR}|cade/42> to <@UCREATOR> for approval in <https://slack.example/release|the requirement thread>. I'll let you know when they reply.\n*Completes:* Login and sign-up`,
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
  const calls = await clientReview(t, {
    ...releaseThreads([PR, MR], [{ ...inReview([PR]), status: "APPROVED" }], "IN_TESTING"),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });

  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
  assert.match(review.blocks[0].text.text, new RegExp(`\\*Remaining PRs:\\* <${MR}\\|web-app/118>\\n`));
  const note = calls.at(-1).args;
  assert.equal(note.thread_ts, "100.1");
  assert.equal(
    note.text,
    `<@UACTOR> asked <@UCREATOR> to review the remaining PRs, <${MR}|web-app/118>, in <https://slack.example/source|the requirement thread>.`,
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
const moveSlack = (root = strayMessage, replies = []) => ({
  "conversations.replies": { messages: root ? [root, ...replies] : [] },
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
    state: { values: { "move:target": { "move:pick": { selected_option: picked ? { value: picked } : null } } } },
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
      ["200.1", "Moved from <@UCLIENT>'s <https://slack.example/400.1?thread_ts=400.1&cid=CEXTERNAL|message>:\n> Also add a CSV export\n> with totals"],
      ["400.1", "<@UCLIENT> moved this message to the requirement thread <https://slack.example/200.9|Export reports>. Please carry on the conversation there."],
    ],
  );
  const reaction = calls.find((call) => call.method === "reactions.add").args;
  assert.deepEqual(reaction, { channel: "CEXTERNAL", timestamp: "400.1", name: "outbox_tray" });
  // The reaction goes once the copy and the note are posted.
  const methods = calls.map((call) => call.method);
  assert.ok(methods.indexOf("reactions.add") > methods.lastIndexOf("chat.postMessage"));
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
    [[otherRequirement("200.1", { status: "DONE" })], strayMessage, "That has been closed or deleted since, so I didn't move anything."],
    [[], strayMessage, "That has been closed or deleted since, so I didn't move anything."],
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
    ["chat.postEphemeral", "Pick where it goes first, then press Move."],
  ]);
  await send("/slack/interactions", moveClick(null, "move:cancel"));
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
  // Choosing from the menu does nothing by itself.
  await send("/slack/interactions", moveClick("200.1", "move:pick"));
  assert.equal(calls.length, 1);
});

// Cade's note under a message it moved already.
const movedNote = {
  ts: "400.3",
  bot_id: "BCADE",
  text: "<@UCLIENT> moved this message to the requirement thread <https://slack.example/200.9|Export reports>. Please carry on the conversation there.",
};

test("a message moved already isn't offered again", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(strayMessage, [movedNote]), stored: [requirementRoot()] });
  await send("/slack/events", moveEvent());
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postEphemeral"]);
  assert.equal(calls[1].args.text, "This message was already moved: <https://slack.example/200.9|see it there>.");
  assert.equal(calls[1].args.blocks, undefined);

  // Nor moved twice from a picker shown before.
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick("200.1"));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(responses, [
    { response_type: "ephemeral", replace_original: true, text: "This message was already moved: <https://slack.example/200.9|see it there>." },
  ]);
});

// `@Cade move <link>`, replied in the stray message's thread, with Slack's
// formatting around the link. The requirement or task linked to is at TARGET.
const TARGET = "1700000000.000100";
const messageLink = (channel, ts, query = "") => `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}${query}`;
const moveLinkEvent = (link) => moveEvent({ text: `<@UBOT> move <${link}>` });

test("@Cade move with a link moves the message there straight away and acknowledges it", async (t) => {
  // The requirement's own message, or a reply in its thread.
  for (const link of [
    messageLink("CEXTERNAL", TARGET),
    messageLink("CEXTERNAL", "1700000300.000200", `?thread_ts=${TARGET}&amp;cid=CEXTERNAL`),
  ]) {
    const calls = mockSlack(t, { ...moveSlack(), stored: [otherRequirement(TARGET)] });
    await send("/slack/events", moveLinkEvent(link));
    const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.thread_ts);
    assert.deepEqual(posts, [TARGET, "400.1"], link);
    assert.deepEqual(
      calls.filter((call) => call.method === "reactions.add").map((call) => [call.args.timestamp, call.args.name]),
      [["400.1", "outbox_tray"], ["400.2", "white_check_mark"]],
    );
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
  }
});

test("@Cade move with a link says why it can't move the message", async (t) => {
  for (const [link, stored, text] of [
    [messageLink("CDEV", TARGET), [otherRequirement(TARGET)], "That link is to another channel. Messages only move within their own channel, so paste a link to a requirement or incident here."],
    [messageLink("CEXTERNAL", TARGET), [], "That link isn't to a requirement or incident here. Use Copy link on its message."],
    [messageLink("CEXTERNAL", TARGET), [otherRequirement(TARGET, { status: "DONE" })], "That requirement is done, so I didn't move anything."],
  ]) {
    const calls = mockSlack(t, { ...moveSlack(), stored });
    await send("/slack/events", moveLinkEvent(link));
    assert.ok(!calls.some((call) => call.method === "reactions.add"), text);
    assert.equal(calls.at(-1).method, "chat.postMessage");
    assert.equal(calls.at(-1).args.text, text);
  }
});

test("@Cade move with a link to a message moved already says where it went", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(strayMessage, [movedNote]), stored: [otherRequirement(TARGET)] });
  await send("/slack/events", moveLinkEvent(messageLink("CEXTERNAL", TARGET)));
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postEphemeral"]);
  assert.equal(calls[1].args.text, "This message was already moved: <https://slack.example/200.9|see it there>.");
});

test("@Cade move with text but no message link offers the picker", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [requirementRoot()] });
  await send("/slack/events", moveEvent({ text: "<@UBOT> move this one <https://github.com/acme/cade/pull/42>" }));
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postEphemeral"]);
  assert.equal(calls[1].args.blocks[1].elements[0].options[0].value, "200.1");
});

test("the copy keeps the message's mentions", async (t) => {
  const calls = mockSlack(t, { ...moveSlack({ ...strayMessage, text: "<@UBOB> can you add totals?" }), stored: [requirementRoot()] });
  recordResponses(t);
  await send("/slack/interactions", moveClick("200.1"));
  assert.match(calls.find((call) => call.method === "chat.postMessage").args.text, /\n> <@UBOB> can you add totals\?$/);
});

// In the dev channel: a message at 100.7, and tasks to move it to.
const devStray = { ts: "100.7", user: "UACTOR", text: "The login bug also hits SSO" };
const devTask = (ts, title, status) => {
  const record = ownTask();
  Object.assign(record, { ts });
  Object.assign(record.task, { title, status });
  return record;
};
const devMoveClick = (picked) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    state: { values: { "move:target": { "move:pick": { selected_option: { value: picked } } } } },
    actions: [{ action_id: "move:confirm", value: JSON.stringify({ channel: "CDEV", ts: "100.7" }) }],
  });

test("@Cade move in the dev channel offers its open tasks, newest first", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack(devStray),
    stored: [devTask("100.1", "Fix login", "IN_PROGRESS"), devTask("100.2", "Old work", "DONE"), devTask("100.3", "Add SSO", "TODO")],
  });
  await send("/slack/events", threadEvent("<@UBOT> move", { ts: "100.8", thread_ts: "100.7" }));
  const picker = calls.at(-1).args;
  assert.equal(picker.user, "UACTOR");
  assert.deepEqual(
    picker.blocks[1].elements[0].options.map((option) => [option.text.text, option.value]),
    [["To do · Add SSO", "100.3"], ["In progress · Fix login", "100.1"]],
  );
});

test("@Cade move in the dev channel says why it can't", async (t) => {
  for (const [event, stored, text] of [
    [threadEvent("<@UBOT> move"), [ownTask()], "This is already a task thread."],
    [threadEvent("<@UBOT> move", { ts: "100.8", thread_ts: "100.7" }), [devTask("100.1", "Done", "DONE")], "There are no open tasks here. Start one with `/cade track`."],
  ]) {
    const calls = mockSlack(t, { ...moveSlack(devStray), stored });
    await send("/slack/events", event);
    assert.equal(calls.at(-1).args.text, text);
  }
});

test("@Cade move with a link in the dev channel moves the message into the task", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(devStray), stored: [devTask(TARGET, "Fix login", "IN_PROGRESS")] });
  await send("/slack/events", threadEvent(`<@UBOT> move <${messageLink("CDEV", TARGET)}>`, { ts: "100.8", thread_ts: "100.7" }));
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.thread_ts),
    [TARGET, "100.7"],
  );
  assert.deepEqual(calls.at(-1).args, { channel: "CDEV", timestamp: "100.8", name: "white_check_mark" });
});

test("Move in the dev channel copies the message into the task thread", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(devStray), stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  recordResponses(t);
  await send("/slack/interactions", devMoveClick("100.1"));
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.channel, call.args.thread_ts, call.args.text]);
  assert.deepEqual(posts, [
    ["CDEV", "100.1", "Moved from <@UACTOR>'s <https://slack.example/100.7?thread_ts=100.7&cid=CDEV|message>:\n> The login bug also hits SSO"],
    ["CDEV", "100.7", "<@UACTOR> moved this message to the task thread <https://slack.example/100.9|Fix login>. Please carry on the conversation there."],
  ]);
  assert.ok(calls.some((call) => call.method === "reactions.add" && call.args.timestamp === "100.7"));
});

test("Move in the dev channel moves nothing if the task was done since", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(devStray), stored: [devTask("100.1", "Fix login", "DONE")] });
  const responses = recordResponses(t);
  await send("/slack/interactions", devMoveClick("100.1"));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.equal(responses[0].text, "That has been closed or deleted since, so I didn't move anything.");
});

// A message posted on its own in the external channel, at 400.1.
const channelMessage = (text = "*Also* add a CSV export\nwith totals", overrides = {}) =>
  threadEvent(text, { channel: "CEXTERNAL", user: "UCLIENT", ts: "400.1", thread_ts: undefined, ...overrides });

// Clicks a button on the question about a message posted on its own.
const promptClick = (actionId) =>
  interaction({
    type: "block_actions",
    user: { id: "UCLIENT" },
    channel: { id: "CEXTERNAL" },
    container: { is_ephemeral: true },
    trigger_id: "trigger-9",
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CEXTERNAL", ts: "400.1", title: "Also add a CSV export" }) }],
  });

test("a message posted on its own in the external channel is asked where it belongs", async (t) => {
  for (const [environment, stored, buttons] of [
    [incidentEnv, [requirementRoot()], ["Start requirement", "Report incident", "Move to existing", "Not now"]],
    [env, [], ["Start requirement", "Not now"]],
  ]) {
    const calls = mockSlack(t, { stored });
    await send("/slack/events", channelMessage(), {}, environment);
    assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
    const question = calls[0].args;
    assert.equal(question.user, "UCLIENT");
    assert.equal(question.thread_ts, undefined);
    assert.equal(question.text, "Is this a new requirement, an incident, or part of one we're already on?");
    assert.deepEqual(question.blocks[1].elements.map((button) => button.text.text), buttons);
    assert.deepEqual(JSON.parse(question.blocks[1].elements[0].value), { channel: "CEXTERNAL", ts: "400.1", title: "Also add a CSV export" });
  }
});

test("only messages posted on their own in the external and dev channels are asked about", async (t) => {
  const calls = mockSlack(t, { stored: [requirementRoot()] });
  await send("/slack/events", channelMessage("thanks!", { ts: "200.5", thread_ts: "200.1" }));
  await send("/slack/events", channelMessage("deploying now", { channel: "CINC" }), {}, incidentEnv);
  await send("/slack/events", channelMessage("done", { bot_id: "BOTHER" }));
  await send("/slack/events", channelMessage("edited", { subtype: "message_changed" }));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("Start requirement and Report incident open their forms, named from the message", async (t) => {
  for (const [actionId, callbackId] of [["move:start-requirement", "requirement"], ["move:report-incident", "incident"]]) {
    const calls = mockSlack(t);
    const responses = recordResponses(t);
    await send("/slack/interactions", promptClick(actionId), {}, incidentEnv);
    const { view } = calls.find((call) => call.method === "views.open").args;
    assert.equal(view.callback_id, callbackId);
    assert.equal(view.blocks[0].element.initial_value, "Also add a CSV export");
    assert.deepEqual(JSON.parse(view.private_metadata), { channel: "CEXTERNAL", moveTs: "400.1", title: "Also add a CSV export" });
    assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
  }
});

test("Move to existing shows the picker, and Not now removes the question", async (t) => {
  mockSlack(t, { stored: [requirementRoot()] });
  const responses = recordResponses(t);
  await send("/slack/interactions", promptClick("move:existing"));
  assert.equal(responses[0].replace_original, true);
  assert.deepEqual(responses[0].blocks[1].elements[0].options.map((option) => option.value), ["200.1"]);
  assert.deepEqual(JSON.parse(responses[0].blocks[2].elements[0].value), { channel: "CEXTERNAL", ts: "400.1" });

  await send("/slack/interactions", promptClick("move:dismiss"));
  assert.deepEqual(responses[1], { response_type: "ephemeral", delete_original: true });
});

test("a requirement started from a message takes the message into its thread", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack(),
    "chat.postMessage": (args) => (args.thread_ts ? { ts: `${args.thread_ts.split(".")[0]}.9` } : { ts: "200.1" }),
  });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UCLIENT" },
      view: {
        callback_id: "requirement",
        private_metadata: JSON.stringify({ channel: "CEXTERNAL", moveTs: "400.1", title: "Also add a CSV export" }),
        state: {
          values: {
            title: { value: { value: "CSV export" } },
            due_date: { value: { selected_date: null } },
            priority: { value: { selected_option: { value: "High" } } },
          },
        },
      },
    }),
  );
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.thread_ts, call.args.text]);
  assert.equal(posts[0][1], "Requirement: CSV export");
  assert.deepEqual(posts.slice(1), [
    ["200.1", "Moved from <@UCLIENT>'s <https://slack.example/400.1?thread_ts=400.1&cid=CEXTERNAL|message>:\n> Also add a CSV export\n> with totals"],
    ["400.1", "<@UCLIENT> moved this message to the requirement thread <https://slack.example/200.9|CSV export>. Please carry on the conversation there."],
  ]);
  assert.ok(calls.some((call) => call.method === "reactions.add" && call.args.timestamp === "400.1"));
});

test("an incident reported from a message takes the message into its thread once tracked", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack(),
    "chat.postMessage": (args) =>
      args.thread_ts ? { ts: `${args.thread_ts.split(".")[0]}.9` } : args.channel === "CINC" ? { channel: "CINC", ts: "100.1" } : { ts: "200.1" },
  });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UCLIENT" },
      view: {
        callback_id: "incident",
        private_metadata: JSON.stringify({ channel: "CEXTERNAL", moveTs: "400.1", title: "Checkout is down" }),
        state: { values: { title: { value: { value: "Checkout is down" } } } },
      },
    }),
    {},
    incidentEnv,
  );
  const methods = calls.map((call) => [call.method, call.args.channel]);
  // The incident's task is posted before the message is moved.
  const task = methods.findIndex(([method, channel]) => method === "chat.postMessage" && channel === "CINC");
  const copy = calls.findIndex((call) => call.method === "chat.postMessage" && call.args.thread_ts === "200.1");
  assert.ok(task >= 0 && copy > task);
  assert.match(calls.at(-1).args.name ?? "", /outbox_tray/);
});

// `@Cade <kind>` replied in the thread of a message posted on its own.
const startEvent = (kind, channel, threadTs) =>
  threadEvent(`<@UBOT> ${kind}`, { channel, user: "UACTOR", ts: `${threadTs.split(".")[0]}.8`, thread_ts: threadTs });

test("@Cade requirement, @Cade incident and @Cade track in a message's thread offer to start one from it", async (t) => {
  for (const [kind, channel, root, question, button, actionId] of [
    ["requirement", "CEXTERNAL", strayMessage, "Shall I start a requirement from this message?", "Start requirement", "move:start-requirement"],
    ["incident", "CEXTERNAL", strayMessage, "Shall I report an incident from this message?", "Report incident", "move:report-incident"],
    ["track", "CDEV", devStray, "Shall I track this message as a task?", "Track task", "move:track-task"],
  ]) {
    const calls = mockSlack(t, moveSlack(root));
    await send("/slack/events", startEvent(kind, channel, root.ts), {}, incidentEnv);
    assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postEphemeral"], kind);
    const offer = calls[1].args;
    assert.equal(offer.user, "UACTOR", kind);
    assert.equal(offer.thread_ts, root.ts, kind);
    assert.equal(offer.text, question, kind);
    const [start, dismiss] = offer.blocks[1].elements;
    assert.deepEqual([start.text.text, start.action_id, dismiss.action_id], [button, actionId, "move:dismiss"], kind);
    assert.deepEqual(JSON.parse(start.value), { channel, ts: root.ts, title: root.text.split("\n")[0] }, kind);
  }
});

test("@Cade requirement, @Cade incident and @Cade track say why they can't start one from a thread", async (t) => {
  for (const [event, stored, root, text] of [
    [startEvent("requirement", "CEXTERNAL", "200.1"), [requirementRoot()], strayMessage, "This is already a requirement thread."],
    [startEvent("incident", "CEXTERNAL", "400.1"), [], { ...strayMessage, bot_id: "BOTHER" }, "I can only move people's messages."],
    [startEvent("track", "CDEV", "100.1"), [ownTask()], devStray, "This is already a task thread."],
  ]) {
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    await send("/slack/events", event, {}, incidentEnv);
    assert.equal(calls.at(-1).method, "chat.postMessage", text);
    assert.equal(calls.at(-1).args.text, text);
  }

  // A message moved already is pointed to, privately.
  const calls = mockSlack(t, moveSlack(devStray, [{ ...movedNote, text: movedNote.text.replace("requirement", "task") }]));
  await send("/slack/events", startEvent("track", "CDEV", "100.7"));
  assert.deepEqual(calls.map((call) => [call.method, call.args.text]), [
    ["conversations.replies", undefined],
    ["chat.postEphemeral", "This message was already moved: <https://slack.example/200.9|see it there>."],
  ]);
});

test("@Cade track at the top of the dev channel points to replying in a thread", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> track", { ts: "100.7", thread_ts: undefined }));
  assert.equal(
    calls[0].args.text,
    "To track a message as a task, reply `@Cade track` in its thread, or use `/cade track` for something new.",
  );
});

test("Track task opens the full task form, named from the message", async (t) => {
  const calls = mockSlack(t);
  const responses = recordResponses(t);
  const click = JSON.parse(new URLSearchParams(promptClick("move:track-task")).get("payload"));
  click.channel.id = "CDEV";
  click.actions[0].value = JSON.stringify({ channel: "CDEV", ts: "100.7", title: "The login bug also hits SSO" });
  await send("/slack/interactions", interaction(click));
  const { view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(view.callback_id, "track");
  assert.deepEqual(view.blocks.map((block) => block.block_id), ["title", "due_date", "priority"]);
  assert.equal(view.blocks[0].element.initial_value, "The login bug also hits SSO");
  assert.deepEqual(JSON.parse(view.private_metadata), { channel: "CDEV", moveTs: "100.7", title: "The login bug also hits SSO" });
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("a task tracked from a message in the dev channel takes the message into its thread", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack(devStray),
    "chat.postMessage": (args) =>
      args.thread_ts ? { ts: `${args.thread_ts.split(".")[0]}.9` } : { channel: "CDEV", ts: "100.1" },
  });
  await send(
    "/slack/interactions",
    interaction(submission({ title: "SSO login", priority: "High" }, { channel: "CDEV", moveTs: "100.7", title: "The login bug also hits SSO" })),
  );
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.thread_ts, call.args.text]);
  assert.equal(posts[0][1], "High task: SSO login");
  assert.deepEqual(posts.slice(1), [
    ["100.1", "Moved from <@UACTOR>'s <https://slack.example/100.7?thread_ts=100.7&cid=CDEV|message>:\n> The login bug also hits SSO"],
    ["100.7", "<@UCREATOR> moved this message to the task thread <https://slack.example/100.9|SSO login>. Please carry on the conversation there."],
  ]);
  assert.ok(calls.some((call) => call.method === "reactions.add" && call.args.timestamp === "100.7"));
});

test("a message posted on its own in the dev channel is asked whether to track it", async (t) => {
  for (const [stored, buttons] of [
    [[devTask("100.1", "Fix login", "IN_PROGRESS")], ["Track as task", "Move to existing", "Not now"]],
    [[devTask("100.1", "Fix login", "DONE")], ["Track as task", "Not now"]],
  ]) {
    const calls = mockSlack(t, { stored });
    await send("/slack/events", threadEvent("The login bug also hits SSO", { ts: "100.7", thread_ts: undefined }));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
    const question = calls[0].args;
    assert.equal(question.text, "Should I track this as a task, or is it part of one we're already on?");
    assert.deepEqual(question.blocks[1].elements.map((button) => button.text.text), buttons);
    assert.equal(question.blocks[1].elements[0].action_id, "move:track-task");
  }
});

test("Move to existing in the dev channel shows its open tasks", async (t) => {
  mockSlack(t, { stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  const responses = recordResponses(t);
  const click = JSON.parse(new URLSearchParams(promptClick("move:existing")).get("payload"));
  click.actions[0].value = JSON.stringify({ channel: "CDEV", ts: "100.7", title: "x" });
  await send("/slack/interactions", interaction(click));
  assert.deepEqual(
    responses[0].blocks[1].elements[0].options.map((option) => [option.text.text, option.value]),
    [["In progress · Fix login", "100.1"]],
  );
});

// A task in `status`, with `people` in its roles.
const taskWith = (status, people = {}) => {
  const record = storedTask(people);
  record.task.status = status;
  return record;
};

// A reply in the requirement thread at CEXTERNAL/200.1, from `user`.
const requirementReplyFrom = (text, user) =>
  threadEvent(text, { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1", user });

// Who's in the team's channels, as conversations.members gives them.
const teamMembers = (byChannel) => ({
  "conversations.members": (args) => ({ members: byChannel[args.channel] ?? [] }),
});

const progressClick = (status, from, user = "UACTOR") =>
  interaction({
    type: "block_actions",
    user: { id: user },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: `status:suggest:${status}`, value: JSON.stringify({ channel: "CDEV", ts: "100.1", status, from }) }],
  });

const ephemeral = (calls) => calls.find((call) => call.method === "chat.postEphemeral")?.args;
const questionButtons = (question) => question.blocks[1].elements;

test("a reviewer approving a task in review is offered In testing", async (t) => {
  for (const text of ["LGTM", "Approved, nice work", "looks good to me", "review done", "ship it"]) {
    const calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { reviewers: ["UACTOR"] })] });
    await send("/slack/events", threadReply(text));
    const question = ephemeral(calls);
    assert.ok(question, text);
    assert.equal(question.user, "UACTOR");
    assert.equal(question.text, "Sounds like this has moved on. Should I move the task to :test_tube: In testing?", text);
    const [move, skip] = questionButtons(question);
    assert.equal(move.text.text, "Move to In testing");
    assert.equal(move.action_id, "status:suggest:IN_TESTING");
    assert.equal(move.style, "primary");
    assert.deepEqual(JSON.parse(move.value), { channel: "CDEV", ts: "100.1", status: "IN_TESTING", from: "IN_REVIEW" });
    assert.equal(skip.action_id, "status:suggest-skip");
  }
});

test("a tester passing a requirement's task is offered Client review or Done", async (t) => {
  for (const text of ["QA passed", "tested on staging", "verified", "works fine", "all good", "no issues found", "test passed", "looks good"]) {
    const calls = mockSlack(t, { stored: [taskWith("IN_TESTING", { testers: ["UACTOR"] })] });
    await send("/slack/events", threadReply(text));
    const question = ephemeral(calls);
    assert.ok(question, text);
    assert.equal(
      question.text,
      "Sounds like this has moved on. Should I move the task to :raising_hand: Client review or :white_check_mark: Done?",
      text,
    );
    assert.deepEqual(questionButtons(question).map((button) => button.text.text), ["Move to Client review", "Move to Done", "Not now"]);
    assert.deepEqual(questionButtons(question).map((button) => button.action_id), [
      "status:suggest:CLIENT_REVIEW",
      "status:suggest:DONE",
      "status:suggest-skip",
    ]);
    assert.equal(questionButtons(question)[1].style, undefined);
  }
});

test("anyone on a task saying it's finished is offered Done, and Client review for a requirement's task", async (t) => {
  for (const [record, user, statuses] of [
    [taskWith("IN_PROGRESS", { developers: ["UACTOR"] }), "UACTOR", ["CLIENT_REVIEW", "DONE"]],
    [taskWith("TODO", { reviewers: ["UACTOR"] }), "UACTOR", ["CLIENT_REVIEW", "DONE"]],
    [taskWith("IN_REVIEW", { testers: ["UACTOR"] }), "UACTOR", ["CLIENT_REVIEW", "DONE"]],
    // Whoever tracked it.
    [taskWith("IN_PROGRESS"), "UCREATOR", ["CLIENT_REVIEW", "DONE"]],
    // The team's own task in a group with a client: whoever handles the
    // client may still show it to them.
    [ownTask({ developers: ["UACTOR"] }), "UACTOR", ["CLIENT_REVIEW", "DONE"]],
    // An incident's has no client review.
    [incidentTask("IN_PROGRESS"), "UCREATOR", ["DONE"]],
  ]) {
    for (const text of ["done", "Finished it", "completed", "merged", "deployed to staging", "released", "shipped", "fixed"]) {
      const calls = mockSlack(t, { stored: [record] });
      const channel = record.channel;
      await send("/slack/events", threadReply(text, { channel, user }), {}, incidentEnv);
      const question = ephemeral(calls);
      assert.ok(question, `${text} ${statuses}`);
      assert.deepEqual(questionButtons(question).slice(0, -1).map((button) => JSON.parse(button.value).status), statuses, text);
    }
  }
});

test("progress in words asks nothing for questions, doubts, people off the task or a task that's waiting", async (t) => {
  for (const [text, record, overrides] of [
    // Questions and doubts.
    ["is it done?", taskWith("IN_PROGRESS", { developers: ["UACTOR"] }), {}],
    ["not done yet", taskWith("IN_PROGRESS", { developers: ["UACTOR"] }), {}],
    ["almost finished", taskWith("IN_PROGRESS", { developers: ["UACTOR"] }), {}],
    ["I'll merge once it's approved", taskWith("IN_PROGRESS", { developers: ["UACTOR"] }), {}],
    ["isn't merged", taskWith("IN_PROGRESS", { developers: ["UACTOR"] }), {}],
    // Someone who isn't on the task.
    ["done", taskWith("IN_PROGRESS", { developers: ["UREX"] }), {}],
    // A reviewer approving a task that isn't in review.
    ["LGTM", taskWith("IN_PROGRESS", { reviewers: ["UACTOR"] }), {}],
    // A tester passing a task that isn't in testing.
    ["QA passed", taskWith("IN_REVIEW", { testers: ["UACTOR"] }), {}],
    // A developer "approving" in testing isn't the tester.
    ["looks good", taskWith("IN_TESTING", { developers: ["UACTOR"] }), {}],
    // The client decides, or it's done.
    ["done", taskWith("CLIENT_REVIEW", { developers: ["UACTOR"] }), {}],
    ["done", taskWith("DONE", { developers: ["UACTOR"] }), {}],
    // Not a task thread.
    ["done", null, {}],
    ["done", taskWith("IN_PROGRESS", { developers: ["UACTOR"] }), { channel: "CEXTERNAL" }],
  ]) {
    const calls = mockSlack(t, { stored: record ? [record] : [] });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${record?.task.status}`);
  }
});

test("Move to In testing moves the task and asks its testers", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { reviewers: ["UACTOR"], testers: ["UTESS"] })] });
  const sent = recordResponses(t);
  await send("/slack/interactions", progressClick("IN_TESTING", "IN_REVIEW"));
  assert.equal((await savedTask()).status, "IN_TESTING");
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.1");
  assert.equal(
    post.text,
    "<@UACTOR> set the status to :test_tube: In testing.\n<@UTESS> could you give this a test when you get a chance? Thanks!",
  );
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Move to In testing with no testers yet asks no one", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { reviewers: ["UACTOR"] })] });
  recordResponses(t);
  await send("/slack/interactions", progressClick("IN_TESTING", "IN_REVIEW"));
  assert.equal(calls.find((call) => call.method === "chat.postMessage").args.text, "<@UACTOR> set the status to :test_tube: In testing.");
});

test("Move to Client review asks who approves, as the status menu does", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true }), taskWith("IN_TESTING", { testers: ["UACTOR"] })),
    "chat.getPermalink": () => ({ permalink: "https://slack.example/source" }),
  });
  recordResponses(t);
  await send("/slack/interactions", progressClick("CLIENT_REVIEW", "IN_TESTING"));
  assert.equal((await savedTask()).status, "CLIENT_REVIEW");
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args);
  assert.ok(!posts.some((post) => post.channel === "CEXTERNAL"));
  assert.equal(calls.find((call) => call.method === "chat.postEphemeral").args.blocks[1].elements[0].action_id, "status:ask");
  assert.equal(posts[0].text, "<@UACTOR> set the status to :raising_hand: Client review.");
});

test("Move to Done marks it done", async (t) => {
  mockSlack(t, { stored: [ownTask({ developers: ["UACTOR"] })] });
  recordResponses(t);
  const record = ownTask({ developers: ["UACTOR"] });
  record.task.status = "IN_PROGRESS";
  mockSlack(t, { stored: [record] });
  recordResponses(t);
  await send("/slack/interactions", progressClick("DONE", "IN_PROGRESS"));
  assert.equal((await savedTask()).status, "DONE");
});

test("a progress suggestion does nothing once the task has moved, and Not now just goes", async (t) => {
  let calls = mockSlack(t, { stored: [taskWith("IN_TESTING", { reviewers: ["UACTOR"] })] });
  let sent = recordResponses(t);
  await send("/slack/interactions", progressClick("IN_TESTING", "IN_REVIEW"));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  // The task is gone.
  calls = mockSlack(t);
  sent = recordResponses(t);
  await send("/slack/interactions", progressClick("DONE", "IN_PROGRESS"));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW")] });
  sent = recordResponses(t);
  await send("/slack/interactions", clickAssign("status:suggest-skip", "{}"));
  assert.equal((await savedTask()).status, "IN_REVIEW");
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("progressOptions reads the task, the writer and their words", async () => {
  const { progressOptions } = await import("../src/commands/status.js");
  const task = (status, people = {}) => taskWith(status, people).task;
  const says = (text) => ({ text });
  assert.deepEqual(progressOptions(task("IN_REVIEW", { reviewers: ["U1"] }), "U1", says("lgtm")), ["IN_TESTING"]);
  assert.deepEqual(progressOptions(task("IN_TESTING", { testers: ["U1"] }), "U1", says("lgtm")), ["CLIENT_REVIEW", "DONE"]);
  assert.deepEqual(progressOptions(task("IN_PROGRESS", { developers: ["U1"] }), "U1", says("lgtm")), []);
  assert.deepEqual(progressOptions(task("DONE", { developers: ["U1"] }), "U1", says("done")), []);
});

test("someone reporting that others have started is offered to assign them and move the task", async (t) => {
  const reported = (people, moveTo, fromRequirement = false) =>
    JSON.stringify({ channel: "CDEV", ts: "100.1", role: "developer", people, moveTo, fromRequirement, started: true });
  for (const [text, record, expected, button, value] of [
    [
      "<@UREX> has started working on this",
      taskWith("TODO"),
      "Sounds like <@UREX> started on this. Should I assign them as developer and move the task to :arrow_forward: In progress?",
      "Assign and move to In progress",
      reported(["UREX"], "IN_PROGRESS"),
    ],
    [
      "<@UREX> is on it",
      taskWith("TODO", { developers: ["UREX"] }),
      "Sounds like <@UREX> started on this. Should I move the task to :arrow_forward: In progress?",
      "Move to In progress",
      reported([], "IN_PROGRESS"),
    ],
    [
      "<@UREX> and <@UBOB> are working on this",
      taskWith("IN_REVIEW"),
      "Sounds like <@UREX>, <@UBOB> started on this. Should I assign them all as developer?",
      "Assign as developer",
      reported(["UREX", "UBOB"], null),
    ],
    [
      "<@UREX> picked this up",
      taskWith("TODO"),
      "Sounds like <@UREX> started on this. Should I assign them as developer and move the task to :arrow_forward: In progress?",
      "Assign and move to In progress",
      reported(["UREX"], "IN_PROGRESS"),
    ],
  ]) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadReply(text));
    const question = ephemeral(calls);
    assert.equal(question.text, expected, text);
    assert.equal(questionButtons(question)[0].text.text, button, text);
    assert.equal(questionButtons(question)[0].value, value, text);
  }
});

test("a report that others have started asks nothing when there's nothing to change, or as a question", async (t) => {
  for (const [text, record] of [
    ["<@UREX> is working on this", taskWith("IN_PROGRESS", { developers: ["UREX"] })],
    ["<@UREX> is working on this", taskWith("DONE")],
    ["<@UREX> is working on this", null],
  ]) {
    const calls = mockSlack(t, { stored: record ? [record] : [] });
    await send("/slack/events", threadReply(text));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), text);
  }
  // A question isn't a report; asking someone to start is a hand-off.
  const calls = mockSlack(t, { stored: [taskWith("TODO")] });
  await send("/slack/events", threadReply("<@UREX> have you started working on this?"));
  assert.match(ephemeral(calls).text, /^Looks like you asked <@UREX> to work on this\./);
});

test("a report that others have started, in a requirement thread, is for its task, and they're told there", async (t) => {
  let calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("TODO")));
  await send("/slack/events", requirementReply("<@UREX> started on this today"));
  const question = ephemeral(calls);
  assert.equal(question.channel, "CEXTERNAL");
  assert.equal(
    question.text,
    "Sounds like <@UREX> started on this. Should I assign them as developer of <https://slack.example/p100|Fix login> and move the task to :arrow_forward: In progress?",
  );
  const value = JSON.parse(questionButtons(question)[0].value);
  assert.deepEqual(value, { channel: "CDEV", ts: "100.1", role: "developer", people: ["UREX"], moveTo: "IN_PROGRESS", fromRequirement: true, started: true });

  // Accepting tells them in the task's thread, rather than asking.
  calls = mockSlack(t, { stored: [requirementTask("TODO")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", JSON.stringify(value)));
  assert.deepEqual((await savedTask()).people.developer, ["UREX"]);
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UREX> you're down as developer on this, and it's :arrow_forward: In progress.\n<@UACTOR> moved the task to :arrow_forward: In progress.",
  );

  // Already a developer: the move names the task.
  const record = requirementTask("TODO");
  record.task.people.developer = ["UREX"];
  calls = mockSlack(t, threads(requirementRoot({ task: true }), record));
  await send("/slack/events", requirementReply("<@UREX> is on it"));
  assert.equal(
    ephemeral(calls).text,
    "Sounds like <@UREX> started on this. Should I move the task of <https://slack.example/p100|Fix login> to :arrow_forward: In progress?",
  );
});

test("a report that others have started, before the requirement is tracked, offers to track it with them", async (t) => {
  const calls = mockSlack(t, { stored: [requirementRoot()] });
  await send("/slack/events", requirementReply("<@UREX> <@UBOB> started working on this"));
  const question = ephemeral(calls);
  assert.equal(
    question.text,
    "Sounds like <@UREX>, <@UBOB> started on this. Should I track it as a task, :arrow_forward: In progress, and assign them all as developer?",
  );
  const [track, skip] = questionButtons(question);
  assert.equal(track.text.text, "Track and assign them all");
  assert.equal(track.action_id, "track:assign");
  assert.deepEqual(JSON.parse(track.value), {
    channel: "CEXTERNAL",
    threadTs: "200.1",
    requirement: true,
    incident: false,
    title: "Export reports",
    priority: "High",
    dueDate: "31/10/2026",
    started: true,
    developers: ["UREX", "UBOB"],
  });
  assert.equal(skip.text.text, "Not now");

  // One person.
  const one = mockSlack(t, { stored: [requirementRoot()] });
  await send("/slack/events", requirementReply("<@UREX> started working on this"));
  assert.equal(questionButtons(ephemeral(one))[0].text.text, "Track and assign them");
});

test("someone in a role asking others to take it over is also offered to hand it over", async (t) => {
  let calls = mockSlack(t, { stored: [taskWith("IN_PROGRESS", { developers: ["UACTOR"] })] });
  await send("/slack/events", threadReply("I can't take this, <@UMIA> can you?"));
  let question = ephemeral(calls);
  assert.equal(
    question.text,
    "Looks like you asked <@UMIA> to work on this. Should I assign them as developer? Or hand it over to them, so you're no longer the developer?",
  );
  const [assign, handOver, skip] = questionButtons(question);
  assert.equal(assign.text.text, "Assign as developer");
  assert.equal(handOver.text.text, "Hand it over");
  assert.equal(handOver.action_id, "assign:hand-over");
  assert.deepEqual(JSON.parse(handOver.value), { ...JSON.parse(assignValue("developer", ["UMIA"])), replace: "UACTOR" });
  assert.equal(skip.text.text, "Not now");

  // Handing testing over moves it on, as the hand-off would.
  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { testers: ["UACTOR"] })] });
  await send("/slack/events", threadReply("<@UTOM> can you test this instead?"));
  question = ephemeral(calls);
  assert.equal(questionButtons(question)[1].text.text, "Hand over and move to In testing");

  // More phrases.
  for (const text of ["handing this over to <@UMIA>", "<@UMIA> can you take over"]) {
    calls = mockSlack(t, { stored: [taskWith("IN_PROGRESS", { developers: ["UACTOR"] })] });
    await send("/slack/events", threadReply(text));
    assert.equal(questionButtons(ephemeral(calls))[1].text.text, "Hand it over", text);
  }

  // Someone who isn't in the role, or who mentions themselves too, isn't handing it over.
  for (const [text, record] of [
    ["<@UMIA> please look into this", taskWith("IN_PROGRESS", { developers: ["UREX"] })],
    ["<@UMIA> and <@UACTOR> please look into this", taskWith("IN_PROGRESS", { developers: ["UACTOR"] })],
  ]) {
    calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadReply(text));
    assert.deepEqual(questionButtons(ephemeral(calls)).map((button) => button.text.text), ["Assign as developer", "Not now"], text);
  }
});

test("Hand it over assigns them and takes whoever handed it over off the role", async (t) => {
  let calls = mockSlack(t, { stored: [taskWith("IN_PROGRESS", { developers: ["UACTOR", "UBOB"] })] });
  let sent = recordResponses(t);
  const value = JSON.stringify({ ...JSON.parse(assignValue("developer", ["UMIA"])), replace: "UACTOR" });
  await send("/slack/interactions", clickAssign("assign:hand-over", value));
  assert.deepEqual((await savedTask()).people.developer, ["UBOB", "UMIA"]);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  // Assigned since: only the hand-over is left to do.
  calls = mockSlack(t, { stored: [taskWith("IN_PROGRESS", { developers: ["UACTOR", "UMIA"] })] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:hand-over", value));
  assert.deepEqual((await savedTask()).people.developer, ["UMIA"]);

  // Handing testing over, with the move.
  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { testers: ["UACTOR"] })] });
  recordResponses(t);
  await send(
    "/slack/interactions",
    clickAssign("assign:hand-over", JSON.stringify({ ...JSON.parse(assignValue("tester", ["UTOM"], "IN_TESTING")), replace: "UACTOR" })),
  );
  assert.deepEqual((await savedTask()).people.tester, ["UTOM"]);
  assert.equal((await savedTask()).status, "IN_TESTING");
});

test("in a requirement thread, the team's suggestions only go to the team", async (t) => {
  const members = teamMembers({ CDEV: ["UACTOR"] });
  for (const [text, stored] of [
    ["okay, started working on this", [requirementRoot()]],
    ["started working on this", [requirementRoot({ task: true }), requirementTask("TODO")]],
    ["<@UREX> has started working on this", [requirementRoot({ task: true }), requirementTask("TODO")]],
    ["<@UREX> please start working on this", [requirementRoot()]],
    ["<@UREX> please start working on this", [requirementRoot({ task: true }), requirementTask("TODO")]],
    [`Here's the fix: <${PR}>`, [requirementRoot({ task: true }), requirementTask("TODO")]],
  ]) {
    // The client isn't in the dev channel.
    let calls = mockSlack(t, { ...members, stored });
    await send("/slack/events", requirementReplyFrom(text, "UCLIENT"));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `client: ${text}`);
    assert.ok(calls.some((call) => call.method === "conversations.members" && call.args.channel === "CDEV"), text);
    // The team is.
    calls = mockSlack(t, { ...members, stored });
    await send("/slack/events", requirementReplyFrom(text, "UACTOR"));
    assert.ok(ephemeral(calls), `team: ${text}`);
  }
});

test("the team includes the incidents channel, every page of members, and everyone if Slack won't say", async (t) => {
  const stored = [requirementRoot()];
  // In the incidents channel only.
  let calls = mockSlack(t, { ...teamMembers({ CDEV: [], CINC: ["UACTOR"] }), stored });
  await send("/slack/events", requirementReply("started working on this"), {}, incidentEnv);
  assert.ok(ephemeral(calls));
  assert.deepEqual(calls.filter((call) => call.method === "conversations.members").map((call) => call.args.channel), ["CDEV", "CINC"]);

  // On a later page.
  calls = mockSlack(t, {
    "conversations.members": (args) =>
      args.cursor === "page-2"
        ? { members: ["UACTOR"], response_metadata: { next_cursor: "" } }
        : { members: ["UOTHER"], response_metadata: { next_cursor: "page-2" } },
    stored,
  });
  await send("/slack/events", requirementReply("started working on this"));
  assert.ok(ephemeral(calls));
  assert.deepEqual(calls.filter((call) => call.method === "conversations.members").map((call) => call.args.cursor), [undefined, "page-2"]);

  // Without the scopes to read members, everyone counts, as before.
  calls = mockSlack(t, { "conversations.members": { ok: false, error: "missing_scope" }, stored });
  await send("/slack/events", requirementReply("started working on this"));
  assert.ok(ephemeral(calls));
});

test("a PR pasted in a tracked requirement's thread offers to link it to its task", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("TODO")));
  await send("/slack/events", requirementReply(`<@UREX> here's the fix: <${PR}>`));
  const question = ephemeral(calls);
  assert.equal(question.channel, "CEXTERNAL");
  assert.equal(question.thread_ts, "200.1");
  assert.equal(question.text, `I see you posted <${PR}|cade/42>. Should I link it to this task?`);
  const [link, skip] = questionButtons(question);
  assert.equal(link.text.text, "Link PR");
  // People mentioned in the requirement thread aren't offered as reviewers.
  assert.deepEqual(JSON.parse(link.value), { channel: "CDEV", ts: "100.1", mentioned: [], urls: [PR], reviewers: [] });
  assert.equal(skip.text.text, "Not now");

  // Linking it changes the task, and tells its own thread.
  const linked = mockSlack(t, { stored: [requirementTask("TODO")] });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.equal(linked.find((call) => call.method === "chat.postMessage").args.channel, "CDEV");
});

test("a PR pasted in a requirement's thread before it's tracked, or outside one, asks nothing", async (t) => {
  for (const [stored, overrides] of [
    [[requirementRoot()], {}],
    [[], {}],
    [[requirementRoot({ task: true })], {}],
  ]) {
    const calls = mockSlack(t, { stored });
    await send("/slack/events", requirementReply(`<${PR}>`, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
  }
  const calls = mockSlack(t);
  await send("/slack/events", threadReply(`<${PR}>`, { channel: "COTHER" }));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("a question about starting isn't taken as having started", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("TODO", { developers: ["UACTOR"] })] });
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

test("a requirement that can't be read is left as it was", async () => {
  const { updateRequirement } = await import("../src/requirements.js");
  const broken = { ...env, DB: { prepare: () => { throw new Error("D1 is down"); } } };
  await updateRequirement(broken, { channel: "CEXTERNAL", threadTs: "200.1" }, () => assert.fail("not called"));
});

test("a task is still tracked when its requirement can't be read again, or its link can't be looked up", async (t) => {
  // The requirement read fails while the form is open: the form's values are used.
  const calls = mockSlack(t, {
    ...createdTask,
    "chat.getPermalink": (args) => (args.channel === "CDEV" ? { ok: false, error: "ratelimited" } : { permalink: "https://slack.example/source" }),
  });
  const readsFail = {
    ...env,
    DB: {
      prepare: (sql) => {
        if (/FROM requirements/i.test(sql) && /^\s*SELECT/i.test(sql)) throw new Error("D1 is down");
        return DB.prepare(sql);
      },
    },
  };
  await send(
    "/slack/interactions",
    interaction(titleOnlySubmission("Export reports", { channel: "CEXTERNAL", threadTs: "200.1", requirement: true, priority: "Low", dueDate: "01/12/2026" })),
    {},
    readsFail,
  );
  const task = await savedTask();
  assert.equal(task.priority, "Low");
  assert.equal(task.dueDate, "01/12/2026");
  // Without a link, it's stored without one.
  assert.equal(task.link ?? "", "");
  assert.ok(calls.some((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV"));
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
  assert.equal(calls[1].args.text, `<@URIA>, could you review <${PR}|cade/42> when you get a chance? Thanks!`);
});

test("a move stands without its reaction, and a thread that's gone can't be moved", async (t) => {
  let calls = mockSlack(t, { ...moveSlack(), "reactions.add": { ok: false, error: "already_reacted" }, stored: [requirementRoot()] });
  recordResponses(t);
  await send("/slack/interactions", moveClick("200.1"));
  assert.ok(calls.some((call) => call.method === "chat.postMessage" && call.args.thread_ts === "200.1"));

  calls = mockSlack(t, { "conversations.replies": { ok: false, error: "message_not_found" }, stored: [requirementRoot()] });
  await send("/slack/events", moveEvent());
  assert.ok(!calls.some((call) => call.method === "chat.postMessage" && call.args.thread_ts === "200.1"));

  // Any other failure is an error, which the reply reports.
  calls = mockSlack(t, { "conversations.replies": { ok: false, error: "ratelimited" }, stored: [requirementRoot()] });
  const response = await send("/slack/events", moveEvent());
  assert.equal(response.status, 200);
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

test("removing a task whose requirement can't be checked doesn't remove it", async (t) => {
  const calls = mockOrphan(t, [requirementRoot({ task: true }), requirementTask()], { error: "ratelimited" });
  await send("/slack/events", threadEvent("<@UBOT> remove", { user: "UACTOR" }));
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

test("a release sent without a button message is posted, and still sent without a link", async (t) => {
  const calls = mockSlack(t, {
    ...releaseThreads([PR, MR]),
    "chat.postMessage": { ts: "200.9" },
    "chat.getPermalink": { ok: false, error: "ratelimited" },
  });
  const form = JSON.parse(new URLSearchParams(releaseSubmission([PR])).get("payload"));
  form.view.private_metadata = JSON.stringify({ channel: "CDEV", ts: "100.1" });
  await send("/slack/interactions", interaction(form));
  const told = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV").args;
  assert.match(told.text, /for approval in the requirement thread\./);
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
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.9").args;
  assert.match(update.text, /Someone's already decided on these PRs\./);
});

test("a standup step with more tasks than fit says how many more", async (t) => {
  const many = Array.from({ length: 23 }, (_, i) => historyTask(`100.${i + 10}`, { title: `Task ${i}`, developers: ["UALICE"] }));
  const { later } = await tasksCommand(t, "standup", "CDEV", { CDEV: many });
  assert.equal(later.blocks.at(-2).elements[0].text, "_…and 3 more, after these._");
});

test("/cade tasks -all with nothing to show says so", async (t) => {
  const { later } = await tasksCommand(t, "tasks -all", "CDEV", {});
  assert.equal(later.text, "There are no open acme tasks.");
  assert.equal(later.blocks.at(-1).text.text, "There are no open tasks.");
});

test("Move unpins a pinned message it moves", async (t) => {
  const calls = mockSlack(t, { ...moveSlack({ ...strayMessage, pinned_to: ["CEXTERNAL"] }), stored: [requirementRoot()] });
  recordResponses(t);
  await send("/slack/interactions", moveClick("200.1"));
  assert.deepEqual(
    calls.filter((call) => call.method === "pins.remove").map((call) => call.args),
    [{ channel: "CEXTERNAL", timestamp: "400.1" }],
  );
});

// A canvas's markdown, from conversations.canvases.create or canvases.edit.
const canvasMarkdown = (call) =>
  call.method === "canvases.edit"
    ? JSON.parse(call.args.changes)[0].document_content.markdown
    : JSON.parse(call.args.document_content).markdown;

// The table rows of a summary's Open or Closed section, without their
// header and divider.
const summaryRows = (markdown, section = "Open") =>
  markdown
    .split("\n## Closed\n")[section === "Open" ? 0 : 1]
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

test("/cade summary in the dev channel puts the group's open tasks in its canvas, most urgent first", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (const [channel, record] of [
    ["CDEV", historyTask("100.1", { title: "Low task", priority: "Low", developers: ["UALICE"] })],
    ["CDEV", historyTask("100.2", { title: "High | [later]", priority: "High", dueDate: "05/11/2026", reviewers: ["UBOB"] })],
    ["CDEV", historyTask("100.3", { title: "High, sooner", priority: "High", dueDate: "01/11/2026", status: "IN_PROGRESS" })],
    ["CDEV", historyTask("100.4", { title: "Done task", status: "DONE", completedAt: "2026-10-10T09:00:00.000Z" })],
    ["CDEV", historyTask("100.5", { title: "Done later", status: "DONE", completedAt: "2026-10-20T09:00:00.000Z", developers: ["UBOB"] })],
    ["CINC", historyTask("100.8", { title: "Checkout is down", priority: "Urgent", dueDate: "Immediate", testers: ["UALICE", "UBOB"] })],
  ]) await putTask(env, channel, record.ts, record.task);
  const { now, later } = await runTasksCommand("summary", "CDEV", incidentEnv);

  assert.equal(now, "");
  assert.equal(later.text, "Added the summary to this channel's canvas. I'll keep it up to date.");
  const create = calls.find((call) => call.method === "conversations.canvases.create");
  assert.equal(create.args.channel_id, "CDEV");
  assert.equal(create.args.title, "acme tasks");
  const markdown = canvasMarkdown(create);
  assert.match(markdown, /^_Updated \d\d\/\d\d\/\d{4} \d\d:\d\d\. Cade keeps this up to date\._\n\n## Open\n\n4 open, most urgent first\.\n\n/);
  assert.match(markdown, /\n\n---\n\n## Closed\n\nThe last 2 done, most recently first\.\n\n/);
  // Without a Google Sheet, there's nothing to link to.
  assert.ok(!markdown.includes("Google Sheet"));
  assert.ok(markdown.includes("| Title | Status | Priority | Due date | Dev | Reviewer | Tester |"));
  const thread = (channel, ts) =>
    `(https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel})`;
  assert.deepEqual(summaryRows(markdown), [
    `| **Incident:** [Checkout is down]${thread("CINC", "100.8")} | :memo:~To~do | :red_circle:~Urgent | Immediate | — | — | ![](@UALICE), ![](@UBOB) |`,
    `| [High, sooner]${thread("CDEV", "100.3")} | :arrow_forward:~In~progress | :large_orange_circle:~High | 01/11/2026 | — | — | — |`,
    `| [High \\| \\[later\\]]${thread("CDEV", "100.2")} | :memo:~To~do | :large_orange_circle:~High | 05/11/2026 | — | ![](@UBOB) | — |`,
    `| [Low task]${thread("CDEV", "100.1")} | :memo:~To~do | :large_green_circle:~Low | 31/10/2026 | ![](@UALICE) | — | — |`,
  ]);
  // Done tasks follow, most recently done first.
  assert.deepEqual(summaryRows(markdown, "Closed"), [
    `| [Done later]${thread("CDEV", "100.5")} | :white_check_mark:~Done | :large_orange_circle:~High | 31/10/2026 | ![](@UBOB) | — | — |`,
    `| [Done task]${thread("CDEV", "100.4")} | :white_check_mark:~Done | :large_orange_circle:~High | 31/10/2026 | — | — | — |`,
  ]);

  // Sent again, the same canvas is rewritten.
  calls.length = 0;
  const again = await runTasksCommand("summary", "CDEV", incidentEnv);
  assert.equal(again.later.text, "Updated the summary in this channel's canvas.");
  const edits = calls.filter((call) => call.method === "canvases.edit");
  assert.deepEqual(edits.map((call) => call.args.canvas_id), ["F0CANVAS", "F0CANVAS"]);
  assert.deepEqual(edits.map((call) => JSON.parse(call.args.changes)[0].operation), ["replace", "rename"]);
  assert.equal(JSON.parse(edits[1].args.changes)[0].title_content.markdown, "acme tasks");
  assert.ok(!calls.some((call) => call.method === "conversations.canvases.create"));
});

test("/cade summary in the external channel lists open requirements and incidents", async (t) => {
  const calls = mockSlack(t, { ...canvasResponses, stored: [requirementRoot({ task: true })] });
  await putRequirement(env, "CEXTERNAL", "200.2", {
    title: "Dark mode",
    status: "DISCUSSION",
    priority: "Low",
    dueDate: "",
    createdBy: "UCLIENT",
  });
  await putRequirement(env, "CEXTERNAL", "200.3", { title: "Old one", status: "DONE", priority: "Urgent", dueDate: "", createdBy: "UCLIENT" });
  await putRequirement(env, "CEXTERNAL", "200.4", {
    title: "Checkout is down",
    status: "IN_PROGRESS",
    priority: "Urgent",
    dueDate: "Immediate",
    createdBy: "UCLIENT",
    incident: true,
  });
  const { later } = await runTasksCommand("summary", "CEXTERNAL");

  assert.equal(later.text, "Added the summary to this channel's canvas. I'll keep it up to date.");
  const create = calls.find((call) => call.method === "conversations.canvases.create");
  assert.equal(create.args.title, "acme requirements");
  const markdown = canvasMarkdown(create);
  assert.match(markdown, /## Open\n\n3 open, most urgent first\./);
  assert.match(markdown, /## Closed\n\nThe last 1 done, most recently first\./);
  assert.ok(markdown.includes("| Title | Priority | Due date | Status | Tracked |"));
  const thread = (ts) => `(https://acme.slack.com/archives/CEXTERNAL/p${ts.replace(".", "")}?thread_ts=${ts}&cid=CEXTERNAL)`;
  assert.deepEqual(summaryRows(markdown), [
    `| **Incident:** [Checkout is down]${thread("200.4")} | :red_circle:~Urgent | Immediate | :arrow_forward:~In~progress | Not yet |`,
    `| [Export reports]${thread("200.1")} | :large_orange_circle:~High | 31/10/2026 | :arrow_forward:~In~progress | :white_check_mark: Yes |`,
    `| [Dark mode]${thread("200.2")} | :large_green_circle:~Low | — | :speech_balloon:~In~discussion | Not yet |`,
  ]);
  assert.deepEqual(summaryRows(markdown, "Closed"), [
    `| [Old one]${thread("200.3")} | :red_circle:~Urgent | — | :white_check_mark:~Done | Not yet |`,
  ]);
});

test("/cade summary uses the canvas the channel already has", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "conversations.info": { channel: { id: "CDEV", properties: { canvas: { file_id: "F0THEIRS" } } } },
  });
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    url.endsWith("/conversations.canvases.create")
      ? (await fakeFetch(url, init), Response.json({ ok: false, error: "channel_canvas_already_exists" }))
      : fakeFetch(url, init);

  const { later } = await runTasksCommand("summary", "CDEV");
  assert.equal(later.text, "Added the summary to this channel's canvas. I'll keep it up to date.");
  const [edit, rename] = calls.filter((call) => call.method === "canvases.edit");
  assert.equal(edit.args.canvas_id, "F0THEIRS");
  assert.match(canvasMarkdown(edit), /No open tasks\.[\s\S]*No closed tasks yet\./);
  // It takes the summary's title.
  assert.equal(rename.args.canvas_id, "F0THEIRS");
  assert.equal(JSON.parse(rename.args.changes)[0].title_content.markdown, "acme tasks");

  // Saved, so it is used from now on.
  calls.length = 0;
  await runTasksCommand("summary", "CDEV");
  assert.equal(calls.find((call) => call.method === "canvases.edit").args.canvas_id, "F0THEIRS");
  assert.ok(!calls.some((call) => call.method === "conversations.canvases.create"));
});

test("/cade summary only works in a group's external and dev channels", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (const channel of ["CRANDOM", "CINC"]) {
    const { now } = await runTasksCommand("summary", channel, incidentEnv);
    assert.match(now, /summary/);
  }
  assert.ok(!calls.some((call) => /canvas/.test(call.method)));
});

test("a task change rewrites the summaries of its group that have one", async (t) => {
  const calls = mockSlack(t, { ...canvasResponses, stored: [storedTask()] });
  await runTasksCommand("summary", "CDEV");
  calls.length = 0;

  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  const edit = calls.find((call) => call.method === "canvases.edit");
  assert.equal(edit.args.canvas_id, "F0CANVAS");
  assert.match(summaryRows(canvasMarkdown(edit))[0], /^\| \[Fix login\]\(https:[^)]+\) \| :memo:~To~do \| :large_orange_circle:~High \| 31\/10\/2026 \| !\[\]\(@UBOB\) \|/);
});

test("a task change touches no canvas until /cade summary has made one", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  assert.ok(!calls.some((call) => /canvas|auth\.test/.test(call.method)));
});

test("a long summary continues in another table, as a canvas table holds 300 cells", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (let i = 0; i < 45; i++) {
    const record = historyTask(`100.${String(i).padStart(2, "0")}`, { title: `Task ${i}` });
    await putTask(env, "CDEV", record.ts, record.task);
  }
  await runTasksCommand("summary", "CDEV");
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
  await runTasksCommand("summary", "CDEV");
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  const closed = summaryRows(markdown, "Closed");
  assert.equal(closed.length, 50);
  assert.match(closed[0], /^\| \[Done 54\]/);
  assert.match(closed.at(-1), /^\| \[Done 5\]/);
  assert.match(markdown, /The last 50 done, most recently first\./);
});

// The acme pair with an incidents channel and a Google Doc, in UTC.
const execEnv = {
  ...env,
  TIMEZONE: "UTC",
  GOOGLE_URL,
  GOOGLE_SECRET: "google-secret",
  CHANNEL_PAIRS: [{ name: "acme", external: "CEXTERNAL", tasks: "CDEV", incidents: "CINC", doc: `https://docs.google.com/document/d/${DOC_ID}/edit` }],
};

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

// Stores a group's work for an executive summary:
//   CEXTERNAL/200.1  requirement "Export reports", its task CDEV/100.1 done
//                    two days ago
//   CEXTERNAL/200.2  requirement "Dark mode", in discussion
//   CEXTERNAL/200.4  incident "Checkout is down", its task CINC/100.8 to do
//   CDEV/100.3       the team's own task "Upgrade Node", in review
//   CDEV/100.5       the team's own task "Old work", done long ago
async function storeExecWork() {
  const requirement = (title, fields) => ({ title, status: "DISCUSSION", priority: "High", dueDate: "31/10/2026", createdBy: "UCLIENT", ...fields });
  const task = (channel, ts, title, fields) => ({ ...historyTask(ts, { title, ...fields }), channel });
  await putRequirement(env, "CEXTERNAL", "200.1", requirement("Export reports", {
    status: "DONE",
    task: { channel: "CDEV", ts: "100.1", title: "Export reports", link: "https://slack.example/p100", trackedBy: "UACTOR" },
  }));
  await putRequirement(env, "CEXTERNAL", "200.2", requirement("Dark mode", { priority: "Low", dueDate: "" }));
  await putRequirement(env, "CEXTERNAL", "200.4", requirement("Checkout is down", {
    status: "IN_PROGRESS",
    priority: "Urgent",
    dueDate: "Immediate",
    incident: true,
    task: { channel: "CINC", ts: "100.8", title: "Checkout is down", link: "https://slack.example/p108", trackedBy: "UACTOR" },
  }));
  for (const record of [
    task("CDEV", "100.1", "Export reports", { status: "DONE", completedAt: daysAgo(2), developers: ["UALICE"] }),
    task("CINC", "100.8", "Checkout is down", { priority: "Urgent", dueDate: "Immediate", developers: ["UBOB"] }),
  ]) {
    record.task.source = { channel: "CEXTERNAL", threadTs: record.ts === "100.1" ? "200.1" : "200.4", incident: record.ts === "100.8" };
    await putTask(env, record.channel, record.ts, record.task);
  }
  for (const record of [
    task("CDEV", "100.3", "Upgrade Node", { priority: "Medium", status: "IN_REVIEW", developers: ["UALICE"] }),
    task("CDEV", "100.5", "Old work", { status: "DONE", completedAt: daysAgo(30) }),
  ]) {
    record.task.source = undefined;
    await putTask(env, record.channel, record.ts, record.task);
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

test("/cade brief goes through a client group's requirements and incidents, and adds the summary to its Google Doc", async (t) => {
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

  // Step 2: the requirement completed in the period, ticked to mention.
  // Its task, tracked from it, isn't listed again; old work is left out.
  assert.match(blockText(first.blocks[0]), /Step 2 of 5$/);
  const done = first.blocks.filter((block) => block.accessory?.type === "checkboxes");
  assert.deepEqual(done.map((block) => block.text.text.match(/\|([^>]+)>/)[1]), ["Export reports"]);
  assert.match(done[0].text.text, /^• <https:\/\/acme\.slack\.com\/archives\/CEXTERNAL\/p2001\?thread_ts=200\.1&cid=CEXTERNAL\|Export reports>  ·  Done/);
  assert.deepEqual(done[0].accessory.initial_options, done[0].accessory.options);

  // Step 3: the incident, most urgent, with its incident and task threads to
  // peek at.
  await send("/slack/interactions", execClick(first, "export:next"), {}, execEnv);
  const incident = sent.at(-1);
  assert.match(messageText(incident), /Requirements and incidents\*  ·  1 of 2[\s\S]*\*Incident:\* <[^|]+\|Checkout is down>  ·  To do  ·  :red_circle: Urgent  ·  Due Immediate  ·  <@UBOB>/);
  const peek = incident.blocks.find((block) => block.accessory?.action_id === "export:peek").accessory;
  assert.deepEqual(JSON.parse(peek.value), [
    { c: "CEXTERNAL", t: "200.4", n: "Incident thread" },
    { c: "CINC", t: "100.8", n: "Incidents channel thread" },
  ]);
  await send("/slack/interactions", execClick(incident, "export:next", execFields(incident, { health: "BLOCKED", progress: "", notes: "Waiting on the payment provider\nETA Monday" })), {}, execEnv);

  // Step 4: the requirement in discussion, not tracked yet. The team's own
  // tasks aren't part of a client group's summary.
  const dark = sent.at(-1);
  assert.match(messageText(dark), /Requirements and incidents\*  ·  2 of 2[\s\S]*Dark mode>  ·  In discussion  ·  :large_green_circle: Low  ·  Due _none_  ·  _Not tracked yet_/);
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
    `• <${execLink("CEXTERNAL", "200.1")}|Export reports>`,
    "",
    "*Incidents (1)*",
    `• <${execLink("CEXTERNAL", "200.4")}|Checkout is down>  ·  Blocked  ·  To do`,
    "      _Waiting on the payment provider_",
    "      _ETA Monday_",
    "",
    "*At risk (1)*",
    `• <${execLink("CEXTERNAL", "200.2")}|Dark mode>  ·  In discussion  ·  3/5`,
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
    { type: "item", level: 0, parts: [{ text: "Export reports", link: execLink("CEXTERNAL", "200.1") }] },
    { type: "heading", level: 3, text: "Incidents (1)" },
    { type: "item", level: 0, parts: [{ text: "Checkout is down", link: execLink("CEXTERNAL", "200.4") }, { text: "  ·  Blocked  ·  To do" }] },
    { type: "item", level: 1, parts: [{ text: "Waiting on the payment provider" }] },
    { type: "item", level: 1, parts: [{ text: "ETA Monday" }] },
    { type: "heading", level: 3, text: "At risk (1)" },
    { type: "item", level: 0, parts: [{ text: "Dark mode", link: execLink("CEXTERNAL", "200.2") }, { text: "  ·  In discussion  ·  3/5" }] },
  ]);
  assert.equal(
    sent.at(-1).text,
    `Added the executive summary for ${show(weekAgo)} – ${show(today)} to acme's Google Doc: <${DOC_TAB}|open it there>. After going through it with the client, send \`/cade debrief\` for what was added to it.`,
  );

  // Adding it again does nothing.
  await send("/slack/interactions", execClick(review, "export:post"), {}, execEnv);
  assert.equal(calls.filter((call) => call.method === "doc").length, 1);
});

test("Peek at threads shows each thread's latest replies in a modal", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "views.open": { view: { id: "V1" } },
    "conversations.replies": (args) => ({
      messages:
        args.channel === "CEXTERNAL"
          ? [
              { ts: "200.4", user: "UBOT", text: "card" },
              { ts: "1761300000.000100", user: "UCLIENT", text: "Still failing for EU customers" },
              { ts: "1761300060.000100", user: "UBOB", text: "", files: [{ id: "F1" }] },
            ]
          : [{ ts: "100.8", user: "UBOT", text: "card" }],
    }),
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
    `*Incident thread*  ·  <${execLink("CEXTERNAL", "200.4")}|Open>`,
    "*<@UCLIENT>*  ·  24/10/2025 10:00\nStill failing for EU customers",
    "*<@UBOB>*  ·  24/10/2025 10:01\n_(attachment)_",
    `*Incidents channel thread*  ·  <${execLink("CINC", "100.8")}|Open>`,
    "_No replies yet._",
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
  const noDoc = { ...execEnv, CHANNEL_PAIRS: [{ name: "acme", external: "CEXTERNAL", tasks: "CDEV" }] };
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

// acme without its client channel: its summaries are of the dev and
// incidents channels' tasks.
const teamEnv = { ...execEnv, CHANNEL_PAIRS: [{ name: "acme", tasks: "CDEV", incidents: "CINC", doc: execEnv.CHANNEL_PAIRS[0].doc }] };

test("/cade brief goes through a team group's tasks", async (t) => {
  mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
  await storeExecWork();
  const { later: period } = await runTasksCommand("brief", "CDEV", teamEnv);
  const sent = recordResponses(t);
  // Step 1 is the period, step 2 the task done in it, then the open tasks,
  // the incident first, with their dev or incidents thread to peek at.
  assert.match(blockText(period.blocks[0]), /Step 1 of 5$/);
  await send("/slack/interactions", execClick(period, "export:next"), {}, teamEnv);
  assert.match(messageText(sent.at(-1)), /Completed[\s\S]*Export reports>  ·  Done/);
  await send("/slack/interactions", execClick(sent.at(-1), "export:next"), {}, teamEnv);
  const incident = sent.at(-1);
  assert.match(messageText(incident), /The team's own tasks\*  ·  1 of 2[\s\S]*\*Incident:\* <[^|]+\|Checkout is down>/);
  await send("/slack/interactions", execClick(incident, "export:next"), {}, teamEnv);
  const own = sent.at(-1);
  assert.match(messageText(own), /The team's own tasks\*  ·  2 of 2[\s\S]*Upgrade Node>  ·  In review/);
  assert.deepEqual(JSON.parse(own.blocks.find((block) => block.accessory?.action_id === "export:peek").accessory.value), [
    { c: "CDEV", t: "100.3", n: "Dev thread" },
  ]);
  // No requirement is part of it.
  assert.ok(!sent.some((message) => messageText(message).includes("Dark mode")));
});

test("/cade brief offers what was completed in the period picked, from the start of From to the end of To", async (t) => {
  mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
  await storeExecWork();
  const { later: period } = await runTasksCommand("brief", "CDEV", teamEnv);
  const sent = recordResponses(t);
  const pick = (from, to) => ({
    [execField(period, "from").block_id]: { value: { type: "datepicker", selected_date: from } },
    [execField(period, "to").block_id]: { value: { type: "datepicker", selected_date: to } },
  });
  const day = (daysBack) => todayIn(execEnv, new Date(Date.now() - daysBack * 86400000));

  // A period that ended before "Export reports" was done offers only the
  // older work.
  await send("/slack/interactions", execClick(period, "export:next", pick(day(40), day(3))), {}, teamEnv);
  let text = messageText(sent.at(-1));
  assert.match(text, /Completed .* \(1–1 of 1\)[\s\S]*Old work/);
  assert.ok(!text.includes("Export reports>  ·  Done"));

  // To is counted to the end of its day: "Export reports" is in.
  await send("/slack/interactions", execClick(sent.at(-1), "export:back"), {}, teamEnv);
  const again = sent.at(-1);
  assert.equal(execField(again, "from").element.initial_date, day(40));
  await send("/slack/interactions", execClick(again, "export:next", pick(day(2), day(2))), {}, teamEnv);
  text = messageText(sent.at(-1));
  assert.match(text, /Completed .* \(1–1 of 1\)[\s\S]*Export reports/);

  // From after To goes no further.
  await send("/slack/interactions", execClick(sent.at(-1), "export:back"), {}, teamEnv);
  await send("/slack/interactions", execClick(sent.at(-1), "export:next", pick(day(1), day(5))), {}, teamEnv);
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
async function answerPrivately(t, question, actionId = "detach:confirm", environment = env) {
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

test("@Cade detach asks privately first, and Cancel leaves the task linked", async (t) => {
  const calls = mockSlack(t, { stored: [requirementRoot({ task: true }), storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> detach"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  const question = calls[0].args;
  assert.equal(question.user, "UACTOR");
  assert.equal(question.thread_ts, "100.1");
  assert.equal(
    question.text,
    "Should I detach *Fix login* from its requirement? The team owns it from then on, and I stop updating the requirement.",
  );
  const [cancel, detach] = question.blocks[1].elements;
  assert.equal(cancel.action_id, "detach:cancel");
  assert.equal(cancel.style, "primary");
  assert.equal(detach.text.text, "Detach");
  assert.equal(detach.confirm.confirm.text, "Detach");
  assert.match(detach.confirm.text.text, /Both threads are told\. There's no undo\.$/);

  const responses = await answerPrivately(t, question, "detach:cancel");
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
  assert.ok((await savedTask()).source);
});

test("@Cade detach in a task thread hands it to the team and closes its requirement", async (t) => {
  const calls = mockSlack(t, { stored: [requirementRoot({ task: true }), storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> detach"));
  const responses = await answerPrivately(t, calls[0].args);
  assert.deepEqual(responses, [{ response_type: "ephemeral", replace_original: true, text: "Detached *Fix login* from its requirement." }]);

  // The task no longer follows the requirement, but still links to it.
  const task = await savedTask();
  assert.equal(task.source, undefined);
  assert.deepEqual(task.trackedFrom, { link: "https://slack.example/source", incident: false });
  const card = calls.find((call) => call.method === "chat.update" && call.args.channel === "CDEV");
  assert.match(footerLines(card.args).at(-1), /from <https:\/\/slack\.example\/source\|the requirement thread>/);

  // The requirement's message says where the work went, and Cade stops
  // tracking it.
  const root = calls.find((call) => call.method === "chat.update" && call.args.channel === "CEXTERNAL");
  assert.match(blockText(root.args.blocks[1]), /^Moved to <https:\/\/slack\.example\/p100\|its task> in <#CDEV> by <@UACTOR>/);
  assert.deepEqual(root.args.attachments, []);
  assert.ok(calls.some((call) => call.method === "pins.remove" && call.args.channel === "CEXTERNAL"));
  assert.equal(await savedRequirement(), null);

  // Both threads hear it.
  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(posts.map((call) => [call.args.channel, call.args.thread_ts]), [["CEXTERNAL", "200.1"], ["CDEV", "100.1"]]);
  assert.match(posts[0].args.text, /detached the task\. The team tracks it in <https:\/\/slack\.example\/p100\|its own thread>/);
  assert.match(posts[1].args.text, /detached this task from <https:\/\/slack\.example\/source\|its requirement thread>\. Its priority and due date are set here now\.$/);

  // Its priority is the team's to change now.
  mockSlack(t, { stored: [{ channel: "CDEV", ts: "100.1", task }] });
  await send("/slack/events", threadEvent("<@UBOT> priority low"));
  assert.equal((await savedTask()).priority, "Low");
});

test("@Cade detach frees an incident's task to change its priority and due date", async (t) => {
  const incidentTask = inChannel("CINC", storedTask());
  incidentTask.task.source.incident = true;
  const calls = mockSlack(t, { stored: [incidentTask] });
  await send("/slack/events", threadEvent("<@UBOT> detach", { channel: "CINC" }), {}, incidentEnv);
  await answerPrivately(t, calls[0].args, "detach:confirm", incidentEnv);
  mockSlack(t, { stored: [{ ...incidentTask, task: await savedTask("CINC") }] });
  await send("/slack/events", threadEvent("<@UBOT> due 5/1/2027", { channel: "CINC" }), {}, incidentEnv);
  assert.equal((await savedTask("CINC")).dueDate, "05/01/2027");
});

test("@Cade detach works only in a linked task's thread", async (t) => {
  let calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/events", threadEvent("<@UBOT> detach"));
  assert.equal(calls.at(-1).method, "chat.postEphemeral");
  assert.equal(calls.at(-1).args.text, "This task isn't linked to a requirement or incident, so there's nothing to detach.");

  // From the client's thread it points to the task's.
  calls = mockSlack(t, { stored: [requirementRoot({ task: true }), storedTask()] });
  await send("/slack/events", requirementReplyFrom("<@UBOT> detach", "UACTOR"));
  assert.equal(calls.at(-1).args.text, "That one works with `@Cade detach` in a task thread in <#CDEV>.");
  assert.ok((await savedTask()).source);
});

test("a team-only group's task saying it's finished is offered Done only", async (t) => {
  const record = inChannel("CTEAM", ownTask({ developers: ["UACTOR"] }));
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/events", threadReply("done", { channel: "CTEAM" }), {}, teamOnlyEnv);
  assert.deepEqual(questionButtons(ephemeral(calls)).slice(0, -1).map((button) => JSON.parse(button.value).status), ["DONE"]);
});

// The team's own task at CDEV/100.1, or one detached from its requirement,
// with `prs` linked: no requirement thread to send them to.
const ownReleaseTask = (prs, releases = []) => {
  const record = ownTask({ developers: ["UDEV"] });
  Object.assign(record.task, { prs, releases });
  return { stored: [record] };
};

test("PRs of a task with no requirement thread are sent for approval in its own thread", async (t) => {
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
  // No requirement, so nobody is picked to begin with.
  const view = calls.at(-1).args.view;
  assert.equal(view.blocks[2].element.type, "users_select");
  assert.equal(view.blocks[2].element.initial_user, undefined);
  assert.equal(view.blocks[3].elements[0].text, "They approve them in this thread. If they don't, you can send them again.");

  calls = mockSlack(t, ownReleaseTask([PR, MR]));
  await send("/slack/interactions", releaseSubmission([PR], "Login and sign-up", "UPM"));
  assert.deepEqual(await releasesOf(), [{ ...inReview([PR]), decidedBy: null }]);
  // The request is posted in the task's thread only.
  assert.ok(!calls.some((call) => call.args.channel === "CEXTERNAL"));
  const ask = calls.at(-1).args;
  assert.equal(calls.at(-1).method, "chat.postMessage");
  assert.equal(ask.channel, "CDEV");
  assert.equal(ask.thread_ts, "100.1");
  assert.equal(ask.blocks[0].text.text, `<@UDEV> sent these PRs for approval: <${PR}|cade/42>\n*Completes:* Login and sign-up`);
  assert.match(ask.blocks[1].text.text, /^<@UPM>, could you take a look and approve them/);
  assert.equal(JSON.parse(ask.blocks[2].elements[0].value).approver, "UPM");

  // The approver decides there, and the developers hear it.
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

test("Client review on a task with no requirement thread asks the approver in its own thread", async (t) => {
  const record = ownTask({ developers: ["UDEV"] });
  record.task.status = "IN_TESTING";
  record.task.prs = [PR];
  let calls = await clientReview(t, { stored: [record] }, { approver: "UPM" });
  assert.equal((await savedTask()).status, "CLIENT_REVIEW");
  assert.ok(!calls.some((call) => call.args.channel === "CEXTERNAL"));
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

test("/cade detach <link> detaches quietly, from anywhere, and tells only whoever sent it", async (t) => {
  // A task and requirement at timestamps a Slack link can name.
  const ts = "1700000000.000100";
  const requirement = requirementRoot({ task: true });
  requirement.requirement.task.ts = ts;
  const task = { ...storedTask(), ts };
  task.task.link = "https://slack.example/p100";
  const calls = mockSlack(t, { stored: [requirement, task] });
  const link = "https://acme.slack.com/archives/CDEV/p1700000000000100";
  const { now, later } = await runTasksCommand(`detach <${link}>`, "COTHER");
  assert.equal(now, "");
  // Asked privately first, saying nothing is posted.
  assert.match(later.text, /^Should I detach <https:\/\/slack\.example\/p100\|Fix login> from its requirement\?/);
  assert.match(later.blocks[1].elements[1].confirm.text.text, /Nothing is posted in either thread\./);
  assert.ok((await savedTask("CDEV", ts)).source);
  const responses = await answerPrivately(t, later);
  assert.equal(responses[0].text, "Detached <https://slack.example/p100|Fix login> from its requirement. I didn't post in either thread.");

  const saved = await savedTask("CDEV", ts);
  assert.equal(saved.source, undefined);
  assert.deepEqual(saved.trackedFrom, { link: "https://slack.example/source", incident: false });
  assert.equal(await savedRequirement(), null);
  // Messages are edited, which notifies no one; nothing is posted.
  assert.ok(calls.some((call) => call.method === "chat.update" && call.args.channel === "CEXTERNAL"));
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("/cade detach needs a link to a linked task's thread", async (t) => {
  mockSlack(t, { stored: [{ ...ownTask(), ts: "1700000000.000100" }] });
  for (const [text, reply] of [
    ["detach", /^Paste the link to the task's thread/],
    ["detach <https://acme.slack.com/archives/CEXTERNAL/p1700000000000100>", /^Paste the link to the task's thread/],
    ["detach <https://acme.slack.com/archives/CDEV/p1700000000000200>", /^That link isn't to a task's thread/],
    ["detach <https://acme.slack.com/archives/CDEV/p1700000000000100>", /^This task isn't linked/],
  ]) {
    const { now, later } = await runTasksCommand(text, "CDEV");
    assert.match(now ? JSON.parse(now).text : later.text, reply, text);
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

test("/cade resync redraws a requirement too, and needs a link to something Cade tracks", async (t) => {
  const ts = "1700000000.000200";
  mockSlack(t, { stored: [{ ...requirementRoot(), ts }] });
  for (const [text, reply] of [
    ["resync", /^Paste the link to the task/],
    ["resync <https://acme.slack.com/archives/CEXTERNAL/p1700000000000200>", /^Resynced the requirement \*/],
    ["resync <https://acme.slack.com/archives/CDEV/p1700000000000900>", /^That link isn't to a task I'm tracking/],
  ]) {
    const { now, later } = await runTasksCommand(text, "CDEV");
    assert.match(now ? JSON.parse(now).text : later.text, reply, text);
  }
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

  // The task's root: deleted as `@Cade delete` would, asked privately.
  let calls = removing();
  let { now, later } = await runTasksCommand("remove <https://acme.slack.com/archives/CDEV/p1700000000000100>", "COTHER");
  assert.equal(now, "");
  assert.match(later.text, /^<@UACTOR>, should I delete the task \*Fix login\*\?/);
  assert.equal(JSON.parse(later.blocks[1].elements[1].value).private, true);
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
  const link = (ts) => execLink("CEXTERNAL", ts);
  const written = ["Period: 19/10/2026 – 26/10/2026", "Incidents (1)", "Checkout is down  ·  Blocked  ·  To do", "Waiting on the provider", "On track (1)", "Dark mode  ·  On track  ·  In discussion"];
  const elements = [
    { type: "paragraph", level: 0, text: "Period: 19/10/2026 – 26/10/2026", links: [] },
    { type: "heading", level: 3, text: "Incidents (1)", links: [] },
    { type: "item", level: 0, text: "Checkout is down  ·  Blocked  ·  To do", links: [link("200.4")] },
    { type: "item", level: 1, text: "Waiting on the provider", links: [] },
    { type: "item", level: 1, text: "Fixed by Friday", links: [] },
    { type: "paragraph", level: 0, text: "Client retests after", links: [] },
    { type: "heading", level: 3, text: "On track (1)", links: [] },
    { type: "item", level: 0, text: "Dark mode  ·  On track  ·  In discussion", links: [link("200.2")] },
    { type: "item", level: 0, text: "Bulk export", links: [] },
    { type: "item", level: 1, text: "For finance", links: [] },
    { type: "item", level: 0, text: "  ", links: [] },
    { type: "item", level: 0, text: "SSO", links: [] },
  ];
  const point = { kind: "POINT", channel: "CEXTERNAL", ts: "200.4", title: "Checkout is down", text: "Fixed by Friday\nClient retests after" };
  assert.deepEqual(findAdditions(elements, written), [
    point,
    { kind: "REQUIREMENT", text: "Bulk export", details: "For finance" },
    { kind: "REQUIREMENT", text: "SSO", details: "" },
  ]);
  // What was found before, however decided, isn't found again.
  assert.deepEqual(findAdditions(elements, written, [{ ...point, text: "Fixed by Friday" }, { kind: "REQUIREMENT", text: "SSO" }]), [
    { ...point, text: "Client retests after" },
    { kind: "REQUIREMENT", text: "Bulk export", details: "For finance" },
  ]);
});

test("/cade debrief goes through what the call added, posting points in their threads and starting new requirements", async (t) => {
  const additions = [
    { type: "heading", level: 3, text: "Incidents (1)", links: [] },
    { type: "item", level: 0, text: "Checkout is down  ·  On track  ·  To do", links: [execLink("CEXTERNAL", "200.4")] },
    { type: "item", level: 1, text: "Provider says fixed by Friday", links: [] },
    { type: "item", level: 1, text: "Client will retest", links: [] },
    { type: "item", level: 0, text: "Bulk export to CSV", links: [] },
    { type: "item", level: 1, text: "Needed for the finance team", links: [] },
  ];
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "chat.postMessage": { ts: "900.1" },
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
  assert.ok(messageText(later).includes(`*Added under* <${execLink("CEXTERNAL", "200.4")}|Checkout is down>\n> Provider says fixed by Friday\n> Client will retest`));

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
  assert.equal(posted.channel, "CEXTERNAL");
  assert.equal(posted.thread_ts, "200.4");
  assert.equal(posted.text, "Fixed by Friday; the client retests after.");
  assert.equal(posted.blocks[1].elements[0].text, "From the client call, shared by <@UACTOR>");

  // Then the new requirement: Apply opens the requirement form, with its
  // lines as the initial message.
  const second = sent.at(-1);
  assert.match(messageText(second), /1 to go[\s\S]*\*New requirement:\* Bulk export to CSV\n> Needed for the finance team/);
  calls.length = 0;
  await send("/slack/interactions", syncClick(second, "import:apply"), {}, execEnv);
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.callback_id, "requirement");
  assert.equal(form.blocks.find((block) => block.block_id === "title").element.initial_value, "Bulk export to CSV");
  assert.equal(form.blocks.find((block) => block.block_id === "initial_message").element.initial_value, "Needed for the finance team");
  calls.length = 0;
  const { values } = submission({ title: "Bulk export to CSV", priority: "Medium" }).view.state;
  values.initial_message = { value: { value: "Finance needs it by month end." } };
  await send("/slack/interactions", interaction({
    type: "view_submission",
    user: { id: "UACTOR" },
    view: { callback_id: "requirement", private_metadata: form.private_metadata, state: { values } },
  }), {}, execEnv);
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args);
  assert.equal(posts[0].channel, "CEXTERNAL");
  assert.equal(posts[0].text, "Requirement: Bulk export to CSV");
  assert.deepEqual([posts[1].channel, posts[1].thread_ts, posts[1].text], ["CEXTERNAL", "900.1", "Finance needs it by month end."]);
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
  assert.match(messageText(later), /\*New requirement:\* SSO/);
  await send("/slack/interactions", syncClick(later, "import:discard"), {}, execEnv);
  assert.match(sent.at(-1).text, /^Nothing more to go through/);
});

test("npm run group adds or changes a group in cade.config.json", async () => {
  const { readArgs, withGroup } = await import("../scripts/group.mjs");
  assert.deepEqual(readArgs(["--name", "acme", "--tasks", "C0000000002", "--doc", "new"]), { name: "acme", tasks: "C0000000002", doc: "new" });
  assert.throws(() => readArgs(["--tasks", "C1"]), /Give the group a --name/);
  assert.throws(() => readArgs(["--name", "acme", "--colour", "red"]), /I don't know "--colour"/);
  assert.throws(() => readArgs(["--name", "acme", "--tasks"]), /--tasks needs a value/);

  const start = JSON.stringify({ timezone: "UTC", channels: [{ name: "acme", external: "C0000000001", tasks: "C0000000002", doc: "https://docs.google.com/document/d/D/edit" }] });
  // A new group goes at the end, its settings in order.
  const added = JSON.parse(withGroup(start, "beta", { sheet: "https://docs.google.com/spreadsheets/d/S/edit", tasks: "C0000000003" }));
  assert.equal(added.timezone, "UTC");
  assert.deepEqual(added.channels[1], { name: "beta", tasks: "C0000000003", sheet: "https://docs.google.com/spreadsheets/d/S/edit" });
  // A group there already keeps what isn't given; `none` removes a setting.
  const changed = JSON.parse(withGroup(start, "acme", { incidents: "C0000000004", doc: "none" }));
  assert.deepEqual(changed.channels, [{ name: "acme", external: "C0000000001", tasks: "C0000000002", incidents: "C0000000004" }]);
  assert.throws(() => withGroup(start, "gamma", { external: "C0000000005" }), /gamma needs a --tasks channel/);
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
  assert.equal(await findChannel(slack, "acme-incidents"), null);
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
      const found = channels[args.channel] ?? (invited && args.channel === "G0000000003" && { id: "G0000000003", name: "acme-incidents", is_private: true, is_member: true });
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
    assert.equal((await channelPlan(slack, ask, { ...role, field: "incidents" }, "Acme", [], undefined)).action, "use");
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

test("the dev channel's summary links the group's Google Sheet, the client channel's doesn't", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  await putTask(env, "CDEV", "100.1", historyTask("100.1", { title: "Low task", priority: "Low" }).task);
  const withSheet = { ...incidentEnv, GOOGLE_URL, GOOGLE_SECRET: "google-secret", CHANNEL_PAIRS: withSheets(incidentEnv.CHANNEL_PAIRS) };
  await runTasksCommand("summary", "CDEV", withSheet);
  const dev = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  assert.match(
    dev,
    new RegExp(`^_Updated [^\\n]*\\. Cade keeps this up to date\\._ \\[All tasks in the Google Sheet\\]\\(https://docs\\.google\\.com/spreadsheets/d/${SHEETS.acme}/edit\\)\\.\\n`),
  );

  calls.length = 0;
  await runTasksCommand("summary", "CEXTERNAL", withSheet);
  const client = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  assert.ok(!client.includes("Google Sheet"));
});

test("/cade debrief tracks a new item as a dev task for a group with no client channel", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "chat.postMessage": (args) => (args.channel === "CDEV" && !args.thread_ts ? { channel: "CDEV", ts: "100.9" } : { ts: "300.1" }),
    "chat.getPermalink": { permalink: "https://slack.example/p109" },
    doc: (body) =>
      body.action === "doc.read"
        ? { ok: true, elements: [{ type: "item", level: 0, text: "Bulk export to CSV", links: [] }, { type: "item", level: 1, text: "For finance", links: [] }] }
        : { ok: true, url: DOC_TAB },
  });
  await storeExecWork();
  const sent = await writeExecSummary(t, teamEnv);
  const { later } = await runTasksCommand("debrief", "CDEV", teamEnv);
  assert.match(messageText(later), /\*New requirement:\* Bulk export to CSV[\s\S]*Apply opens the task form, with the lines under it as the initial message, to track it in <#CDEV>/);

  calls.length = 0;
  await send("/slack/interactions", syncClick(later, "import:apply"), {}, teamEnv);
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.callback_id, "track");
  assert.equal(form.blocks.find((block) => block.block_id === "title").element.initial_value, "Bulk export to CSV");
  assert.equal(form.blocks.find((block) => block.block_id === "initial_message").element.initial_value, "For finance");

  calls.length = 0;
  const { values } = submission({ title: "Bulk export to CSV", priority: "Medium" }).view.state;
  values.initial_message = { value: { value: "Finance needs it by month end." } };
  await send("/slack/interactions", interaction({
    type: "view_submission",
    user: { id: "UACTOR" },
    view: { callback_id: "track", private_metadata: form.private_metadata, state: { values } },
  }), {}, teamEnv);
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args);
  // The task in the dev channel, then the message in its thread; nothing in
  // any client channel.
  assert.equal(posts[0].channel, "CDEV");
  assert.equal(posts[0].thread_ts, undefined);
  assert.deepEqual([posts[1].channel, posts[1].thread_ts, posts[1].text], ["CDEV", "100.9", "Finance needs it by month end."]);
  assert.ok(!posts.some((post) => post.channel === "CEXTERNAL"));
  assert.match(sent.at(-1).text, /^Nothing more to go through/);
});
