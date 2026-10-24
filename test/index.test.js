import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { parseDate } from "../src/commands/details.js";
import { parseMessage } from "../src/commands/parse.js";
import { formatDueDate } from "../src/tasks.js";

const SIGNING_SECRET = "test-signing-secret";
const SHEET_URL = "https://script.google.com/macros/s/test/exec";
const env = {
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

// Replaces fetch with a fake Slack API. `responses` maps a method name to its
// result; every call is recorded with its decoded arguments. Requests to the
// Google Sheet are recorded as the "sheet" method with their JSON body.
function mockSlack(t, responses = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === SHEET_URL) {
      calls.push({ method: "sheet", args: JSON.parse(init.body) });
      return Response.json(responses.sheet ?? { ok: true });
    }
    const method = new URL(url).pathname.replace("/api/", "");
    const args = Object.fromEntries(init.body);
    for (const name of ["view", "blocks", "metadata"]) {
      if (args[name]) args[name] = JSON.parse(args[name]);
    }
    calls.push({ method, args, headers: init.headers });
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

// Submissions come from the Track task button in an external thread.
const submission = (values, origin = { channel: "CEXTERNAL", threadTs: "200.1", promptTs: "300.1" }) => ({
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

// `people` holds comma-separated user IDs per role, as stored in metadata.
const rootMessage = ({ developers = "", reviewers = "", testers = "" } = {}) => ({
  ts: "100.1",
  metadata: {
    event_type: "luma_task",
    event_payload: {
      title: "Fix login",
      priority: "High",
      status: "TODO",
      due_date: "31/10/2026",
      developers,
      reviewers,
      testers,
      created_by: "UCREATOR",
      source_channel: "CEXTERNAL",
      source_thread_ts: "200.1",
      source_link: "https://slack.example/source",
    },
  },
});

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
    errors: { title: "Enter a task title." },
  });
});

test("modal submission posts the task and replaces the button with the announcement", async (t) => {
  const calls = mockSlack(t, createdTask);
  const response = await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix <login>", dueDate: "2027-05-01", priority: "Urgent" })),
  );

  assert.deepEqual(await response.json(), { response_action: "clear" });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.getPermalink", "chat.postMessage", "pins.add", "chat.getPermalink", "chat.update"],
  );
  assert.deepEqual(calls[0].args, { channel: "CEXTERNAL", message_ts: "200.1" });

  const post = calls[1].args;
  assert.equal(post.channel, "CDEV");
  assert.equal(post.blocks[0].text.text, "*Fix &lt;login&gt;*");
  assert.equal(
    post.blocks[1].text.text,
    "*Status:* :white_circle: To do  ·  *Priority:* :red_circle: Urgent  ·  *Due:* 01/05/2027",
  );
  assert.equal(
    post.blocks[2].text.text,
    "*Developer:* _Unassigned_  ·  *Reviewer:* _Unassigned_  ·  *Tester:* _Unassigned_",
  );
  assert.equal(post.blocks[3].type, "context");
  assert.match(
    post.blocks[3].elements[0].text,
    /^Tracked by <@UCREATOR> from <https:\/\/slack\.example\/source\|the request thread>$/,
  );
  assert.deepEqual(post.metadata, {
    event_type: "luma_task",
    event_payload: {
      title: "Fix <login>",
      priority: "Urgent",
      status: "TODO",
      due_date: "01/05/2027",
      developers: "",
      reviewers: "",
      testers: "",
      created_by: "UCREATOR",
      completed_at: "",
      source_channel: "CEXTERNAL",
      source_thread_ts: "200.1",
      source_link: "https://slack.example/source",
      source_requirement: "",
    },
  });

  assert.deepEqual(calls[2].args, { channel: "CDEV", timestamp: "100.1" });
  const text = "<@UCREATOR> tracked a task: <https://slack.example/p100|Fix &lt;login&gt;>";
  assert.deepEqual(calls[4].args, {
    channel: "CEXTERNAL",
    ts: "300.1",
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });
});

test("modal submission without a due date shows None", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" })),
  );
  assert.match(calls[1].args.blocks[1].text.text, /\*Due:\* _None_$/);
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
  // The source link fails too, but only the failed post stops the task.
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.getPermalink",
    "chat.postMessage",
    "chat.postEphemeral",
  ]);
  assert.equal(calls[2].args.user, "UCREATOR");
  assert.equal(calls[2].args.thread_ts, "200.1");
  assert.match(calls[2].args.text, /could not be created/);
});

test("@LUMA track in an external thread replies with a button", async (t) => {
  const calls = mockSlack(t);
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );

  // The thread's root is checked for a requirement first.
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"]);
  assert.equal(calls[1].args.channel, "CEXTERNAL");
  assert.equal(calls[1].args.thread_ts, "200.1");
  const button = calls[1].args.blocks[0].elements[0];
  assert.equal(button.action_id, "track:open");
  assert.deepEqual(JSON.parse(button.value), { channel: "CEXTERNAL", threadTs: "200.1" });
});

test("@LUMA track as a top-level message starts a thread on it", async (t) => {
  const calls = mockSlack(t);
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: undefined }),
  );
  assert.equal(calls[0].args.thread_ts, "200.5");
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
});

test("@LUMA assign adds people to a role on the root message", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": {
      messages: [rootMessage({ developers: "UALICE", testers: "UTESS" })],
    },
  });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB> <@UALICE|alice>"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["conversations.replies", "chat.update", "chat.postMessage"],
  );
  assert.equal(calls[0].args.include_all_metadata, "true");
  const update = calls[1].args;
  assert.equal(update.ts, "100.1");
  assert.equal(
    update.blocks[2].text.text,
    "*Developer:* <@UALICE>, <@UBOB>  ·  *Reviewer:* _Unassigned_  ·  *Tester:* <@UTESS>",
  );
  const payload = update.metadata.event_payload;
  assert.equal(payload.developers, "UALICE,UBOB");
  assert.equal(payload.reviewers, "");
  assert.equal(payload.testers, "UTESS");
  assert.equal(payload.due_date, "31/10/2026");
  assert.deepEqual(calls[2].args, {
    channel: "CDEV",
    thread_ts: "100.1",
    text: "<@UBOB>, <@UALICE> please start working on this.",
  });
});

test("@LUMA assign works for each role, in any word order", async (t) => {
  for (const [text, key, reply] of [
    ["<@UBOT> assign reviewer <@UBOB>", "reviewers", "<@UBOB> please review this."],
    ["<@UBOT> assign tester <@UBOB>", "testers", "<@UBOB> please test this."],
    ["<@UBOT> assign <@UBOB> as Tester", "testers", "<@UBOB> please test this."],
    ["<@UBOT> assign developers <@UBOB>", "developers", "<@UBOB> please start working on this."],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
    await send("/slack/events", threadEvent(text));
    assert.equal(calls[1].args.metadata.event_payload[key], "UBOB", text);
    assert.equal(calls[2].args.text, reply, text);
  }
});

test("@LUMA assign without a role asks for one", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign <@UBOB>"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.equal(
    calls[0].args.text,
    "Say which role to assign: `@LUMA assign developer @person`, `@LUMA assign reviewer @person`, `@LUMA assign tester @person`.",
  );
});

test("@LUMA assign without mentions replies with usage", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.equal(
    calls[0].args.text,
    "Mention who to assign, for example `@LUMA assign reviewer @person`.",
  );
});

test("@LUMA unassign with a role removes people from that role only", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": {
      messages: [rootMessage({ developers: "UALICE,UBOB", reviewers: "UALICE" })],
    },
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign developer <@UALICE>"));
  const payload = calls[1].args.metadata.event_payload;
  assert.equal(payload.developers, "UBOB");
  assert.equal(payload.reviewers, "UALICE");
  assert.equal(calls[2].args.text, "<@UACTOR> unassigned <@UALICE> as developer.");
});

test("@LUMA unassign without a role removes people from every role", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": {
      messages: [rootMessage({ developers: "UALICE,UBOB", reviewers: "UALICE", testers: "UALICE" })],
    },
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign <@UALICE>"));
  const payload = calls[1].args.metadata.event_payload;
  assert.deepEqual([payload.developers, payload.reviewers, payload.testers], ["UBOB", "", ""]);
  assert.equal(
    calls[1].args.blocks[2].text.text,
    "*Developer:* <@UBOB>  ·  *Reviewer:* _Unassigned_  ·  *Tester:* _Unassigned_",
  );
  assert.equal(calls[2].args.text, "<@UACTOR> unassigned <@UALICE>.");
});

test("@LUMA unassign without mentions replies with usage", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> unassign developer"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.match(calls[0].args.text, /@LUMA unassign developer @person/);
});

test("tasks tracked before roles keep their assignees as developers", async (t) => {
  const legacy = rootMessage();
  delete legacy.metadata.event_payload.developers;
  delete legacy.metadata.event_payload.reviewers;
  delete legacy.metadata.event_payload.testers;
  legacy.metadata.event_payload.assignees = "UALICE";
  const calls = mockSlack(t, { "conversations.replies": { messages: [legacy] } });
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"));
  const payload = calls[1].args.metadata.event_payload;
  assert.deepEqual([payload.developers, payload.reviewers, payload.testers], ["UALICE", "", "UBOB"]);
  assert.equal(payload.assignees, undefined);
});

test("@LUMA status updates the task's status", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": { messages: [rootMessage({ developers: "UALICE" })] },
  });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["conversations.replies", "chat.update", "chat.postMessage"],
  );
  const update = calls[1].args;
  assert.equal(update.metadata.event_payload.status, "IN_PROGRESS");
  assert.equal(update.metadata.event_payload.developers, "UALICE");
  assert.match(update.blocks[1].text.text, /^\*Status:\* :large_blue_circle: In progress  ·/);
  assert.equal(calls[2].args.text, "<@UACTOR> set the status to :large_blue_circle: In progress.");
});

test("@LUMA status DONE unpins the task and reopening pins it again", async (t) => {
  let calls = mockSlack(t, {
    "conversations.replies": { messages: [rootMessage()] },
  });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.replies",
    "chat.update",
    "pins.remove",
    "chat.postMessage",
  ]);
  assert.deepEqual(calls[2].args, { channel: "CDEV", timestamp: "100.1" });

  const done = rootMessage();
  done.metadata.event_payload.status = "DONE";
  calls = mockSlack(t, { "conversations.replies": { messages: [done] } });
  await send("/slack/events", threadEvent("<@UBOT> status IN_TESTING"));
  assert.equal(calls[2].method, "pins.add");
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
    "pins.add",
    "chat.getPermalink",
    "chat.update",
  ]);
});

const withStatus = (status) => {
  const root = rootMessage();
  root.metadata.event_payload.status = status;
  return root;
};

test("moving from an open status to Client review or Done asks about the external thread", async (t) => {
  for (const [from, input, status] of [
    ["TODO", "client review", "CLIENT_REVIEW"],
    ["IN_TESTING", "done", "DONE"],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [withStatus(from)] } });
    await send("/slack/events", threadEvent(`<@UBOT> status ${input}`));

    assert.ok(!calls.some((call) => call.args.channel === "CEXTERNAL"), "nothing is sent yet");
    const reply = calls.at(-1).args;
    assert.equal(reply.thread_ts, "100.1");
    assert.match(reply.blocks[0].text.text, /\nShould Luma tell the external thread\?$/);
    const [informButton, skipButton] = reply.blocks[1].elements;
    assert.equal(informButton.action_id, "status:inform");
    assert.equal(informButton.text.text, "Inform external thread");
    assert.equal(skipButton.action_id, "status:skip");
    assert.equal(skipButton.text.text, "I'll tell them");
    assert.deepEqual(JSON.parse(informButton.value), {
      channel: "CDEV",
      ts: "100.1",
      status,
      user: "UACTOR",
    });
  }
});

test("other status changes do not ask about the external thread", async (t) => {
  const legacy = rootMessage();
  delete legacy.metadata.event_payload.source_channel;
  for (const [root, input] of [
    [withStatus("TODO"), "in progress"],
    [withStatus("IN_PROGRESS"), "in review"],
    [withStatus("CLIENT_REVIEW"), "done"],
    [withStatus("DONE"), "client review"],
    [withStatus("DONE"), "done"],
    [withStatus("DONE"), "in progress"],
    [legacy, "done"],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
    await send("/slack/events", threadEvent(`<@UBOT> status ${input}`));
    const reply = calls.at(-1).args;
    assert.equal(reply.blocks, undefined, `${input} should not ask`);
    assert.match(reply.text, /^<@UACTOR> set the status to /);
  }
});

const statusButton = (actionId, status = "DONE") =>
  interaction({
    type: "block_actions",
    user: { id: "UCLICKER" },
    channel: { id: "CDEV" },
    message: { ts: "100.8", thread_ts: "100.1" },
    actions: [
      {
        action_id: actionId,
        value: JSON.stringify({ channel: "CDEV", ts: "100.1", status, user: "UACTOR" }),
      },
    ],
  });

test("Inform external thread posts the status there", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": { messages: [withStatus("DONE")] },
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  const response = await send("/slack/interactions", statusButton("status:inform"));
  assert.equal(response.status, 200);

  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.replies",
    "chat.getPermalink",
    "chat.postMessage",
    "chat.update",
  ]);
  const text = "<@UACTOR> marked a task as :white_check_mark: Done: <https://slack.example/p100|Fix login>";
  assert.deepEqual(calls[2].args, {
    channel: "CEXTERNAL",
    thread_ts: "200.1",
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });
  assert.equal(calls[3].args.ts, "100.8");
  assert.equal(
    calls[3].args.text,
    "<@UACTOR> set the status to :white_check_mark: Done.\n<@UCLICKER> informed the external thread.",
  );
  assert.equal(calls[3].args.blocks.length, 1);
});

test("I'll tell them removes the buttons without posting", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/interactions", statusButton("status:skip", "CLIENT_REVIEW"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.update"]);
  assert.equal(
    calls[0].args.text,
    "<@UACTOR> set the status to :large_yellow_circle: Client review.\n<@UCLICKER> will tell the external thread.",
  );
});

test("Inform external thread is not sent if the status changed since", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": { messages: [withStatus("IN_PROGRESS")] },
  });
  await send("/slack/interactions", statusButton("status:inform"));
  assert.ok(!calls.some((call) => call.args.channel === "CEXTERNAL"));
  assert.match(calls.at(-1).args.text, /Not sent: the status is now :large_blue_circle: In progress\.$/);
});

test("@LUMA status accepts every status name", async (t) => {
  for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "IN_TESTING", "CLIENT_REVIEW", "DONE"]) {
    const calls = mockSlack(t, {
      "conversations.replies": { messages: [rootMessage()] },
    });
    await send("/slack/events", threadEvent(`<@UBOT> status ${status.toLowerCase()}`));
    assert.equal(calls[1].args.metadata.event_payload.status, status);
  }
});

test("@LUMA status without a status replies with a status menu", async (t) => {
  const task = rootMessage();
  task.metadata.event_payload.status = "IN_REVIEW";
  const calls = mockSlack(t, { "conversations.replies": { messages: [task] } });
  await send("/slack/events", threadEvent("<@UBOT> status"));

  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"]);
  assert.equal(calls[1].args.thread_ts, "100.1");
  const menu = calls[1].args.blocks[0].accessory;
  assert.equal(menu.action_id, "status:select");
  assert.deepEqual(
    menu.options.map((option) => [option.value, option.text.text]),
    [
      ["TODO", ":white_circle: To do"],
      ["IN_PROGRESS", ":large_blue_circle: In progress"],
      ["IN_REVIEW", ":large_purple_circle: In review"],
      ["IN_TESTING", ":large_orange_circle: In testing"],
      ["CLIENT_REVIEW", ":large_yellow_circle: Client review"],
      ["DONE", ":white_check_mark: Done"],
    ],
  );
  assert.equal(menu.initial_option.value, "IN_REVIEW");
});

test("@LUMA status with an unknown status shows the menu", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadEvent("<@UBOT> status blocked"));
  assert.equal(calls[1].args.blocks[0].text.text, '"blocked" is not a status. Pick one:');
  assert.equal(calls[1].args.blocks[0].accessory.action_id, "status:select");
});

test("picking a status from the menu updates the task and the menu", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
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
    "conversations.replies",
    "chat.update",
    "pins.remove",
    "chat.update",
  ]);
  assert.equal(calls[1].args.ts, "100.1");
  assert.equal(calls[1].args.metadata.event_payload.status, "DONE");
  // The menu becomes the confirmation, asking about the external thread.
  const menu = calls[3].args;
  assert.equal(menu.ts, "100.7");
  assert.equal(menu.text, "<@UPICKER> set the status to :white_check_mark: Done.");
  assert.deepEqual(
    menu.blocks[1].elements.map((button) => button.action_id),
    ["status:inform", "status:skip"],
  );
});

test("@LUMA delete and @LUMA remove ask for confirmation", async (t) => {
  for (const name of ["delete", "remove"]) {
    const calls = mockSlack(t, {
      "conversations.replies": { messages: [rootMessage()] },
    });
    await send("/slack/events", threadEvent(`<@UBOT> ${name}`));

    assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"]);
    assert.equal(calls[1].args.thread_ts, "100.1");
    const button = calls[1].args.blocks[1].elements[0];
    assert.equal(button.action_id, "delete:confirm");
    assert.equal(button.style, "danger");
    assert.ok(button.confirm);
    assert.deepEqual(JSON.parse(button.value), {
      channel: "CDEV",
      ts: "100.1",
      requestedBy: "UACTOR",
    });
    assert.equal(calls[1].args.blocks[1].elements[1].action_id, "delete:cancel");
  }
});

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

test("confirming deletion removes Luma's replies and then the task", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": (args) =>
      args.limit === "1"
        ? { messages: [rootMessage()] }
        : {
            messages: [
              { ts: "100.1", bot_id: "BLUMA" },
              { ts: "100.2", user: "UACTOR" },
              { ts: "100.3", bot_id: "BLUMA" },
              { ts: "100.4", bot_id: "BLUMA" },
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
  const untracked = "<@UACTOR> untracked a task: Fix login";
  assert.deepEqual(calls.at(-2).args, {
    channel: "CEXTERNAL",
    thread_ts: "200.1",
    text: untracked,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: untracked } }],
  });
  assert.deepEqual(calls.at(-1), {
    method: "chat.postEphemeral",
    args: { channel: "CDEV", user: "UACTOR", text: 'Deleted the task "Fix login".' },
    headers: calls.at(-1).headers,
  });
});

test("deleting a task tracked before source threads were stored skips the announcement", async (t) => {
  const legacy = rootMessage();
  delete legacy.metadata.event_payload.source_channel;
  delete legacy.metadata.event_payload.source_thread_ts;
  const calls = mockSlack(t, {
    "conversations.replies": (args) =>
      args.limit === "1" ? { messages: [legacy] } : { messages: [{ ts: "100.1", bot_id: "BLUMA" }] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.replies",
    "conversations.replies",
    "chat.delete",
    "chat.postEphemeral",
  ]);
});

test("assigning keeps the task's source thread", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": { messages: [rootMessage()] },
  });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  const payload = calls[1].args.metadata.event_payload;
  assert.equal(payload.source_channel, "CEXTERNAL");
  assert.equal(payload.source_thread_ts, "200.1");
  assert.equal(payload.source_link, "https://slack.example/source");
  assert.match(
    calls[1].args.blocks[3].elements[0].text,
    /from <https:\/\/slack\.example\/source\|the request thread>/,
  );
});

test("@LUMA delete in a thread that is not a task says so", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": { messages: [{ ts: "100.1" }] },
  });
  await send("/slack/events", threadEvent("<@UBOT> delete"));
  assert.equal(calls[1].args.text, "This thread is not a tracked task.");
});

test("@LUMA assign in a thread that is not a task says so", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": { messages: [{ ts: "100.1" }] },
  });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["conversations.replies", "chat.postMessage"],
  );
  assert.equal(calls[1].args.text, "This thread is not a tracked task.");
});

test("@LUMA assign outside the dev channel points to it", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { channel: "CEXTERNAL" }));
  assert.equal(
    calls[0].args.text,
    "Use `@LUMA assign developer @person` in a task thread in <#CDEV> or <#CTESTDEV>.",
  );
});

test("@LUMA track outside the configured channels points to them", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> track", { channel: "COTHER" }));
  assert.equal(
    calls[0].args.text,
    "Use `@LUMA track` in <#CEXTERNAL> or <#CTESTEXT> or <#CDEV> or <#CTESTDEV>.",
  );
});

test("@LUMA track in the dev channel creates a task with no external thread", async (t) => {
  let calls = mockSlack(t);
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CDEV", ts: "400.1", thread_ts: undefined }),
  );
  assert.equal(calls[0].args.channel, "CDEV");
  assert.equal(calls[0].args.thread_ts, "400.1");
  assert.deepEqual(JSON.parse(calls[0].args.blocks[0].elements[0].value), {
    channel: "CDEV",
    threadTs: "400.1",
  });

  calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(
      submission(
        { title: "Refactor auth", priority: "Medium" },
        { channel: "CDEV", threadTs: "400.1", promptTs: "400.2" },
      ),
    ),
  );
  // No link to an external thread is looked up.
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage", "pins.add", "chat.getPermalink", "chat.update"],
  );
  const post = calls[0].args;
  assert.equal(post.channel, "CDEV");
  assert.equal(post.blocks[3].elements[0].text, "Tracked by <@UCREATOR>");
  assert.equal(post.metadata.event_payload.source_channel, "");
  assert.deepEqual(calls[3].args.ts, "400.2");
  assert.equal(
    calls[3].args.text,
    "<@UCREATOR> tracked a task: <https://slack.example/p100|Refactor auth>",
  );
});

test("tasks with no external thread never ask to inform it", async (t) => {
  const own = rootMessage();
  own.metadata.event_payload.source_channel = "";
  own.metadata.event_payload.source_thread_ts = "";
  own.metadata.event_payload.source_link = "";
  const calls = mockSlack(t, { "conversations.replies": { messages: [own] } });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.equal(calls.at(-1).args.blocks, undefined);
});

test("tasks tracked from the test channel go to the test tasks channel", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> track", { channel: "CTESTEXT" }));
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
        { channel: "CTESTEXT", threadTs: "200.1", promptTs: "300.1" },
      ),
    ),
  );
  assert.deepEqual(calls[0].args, { channel: "CTESTEXT", message_ts: "200.1" });
  assert.equal(calls[1].args.channel, "CTESTDEV");
  assert.deepEqual(calls[2].args, { channel: "CTESTDEV", timestamp: "100.1" });
  assert.equal(calls[4].args.channel, "CTESTEXT");
});

test("thread commands work in the test tasks channel", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": { messages: [rootMessage()] },
  });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { channel: "CTESTDEV" }));
  assert.equal(calls[0].args.channel, "CTESTDEV");
  assert.equal(calls[1].args.channel, "CTESTDEV");
  assert.equal(calls[1].args.metadata.event_payload.developers, "UBOB");
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
  assert.equal(calls[0].args.text, "Sorry, `assign` failed. Please try again.");
});

test("@LUMA help, a bare @LUMA and unknown commands reply with usage", async (t) => {
  for (const text of ["<@UBOT> help", "<@UBOT>", "<@UBOT> hello"]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    assert.match(calls[0].args.text, /^Available commands:/);
    for (const usage of ["track", "assign developer @person", "unassign developer @person", "status", "delete", "help"]) {
      assert.ok(calls[0].args.text.includes(`\`@LUMA ${usage}\``), usage);
    }
  }
});

test("ignores messages that do not start with @LUMA, bots, edits and retries", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("looks good, assign it later"));
  await send("/slack/events", threadEvent("luma is great"));
  await send("/slack/events", threadEvent("luma assign <@UBOB>"));
  await send("/slack/events", threadEvent("/luma assign <@UBOB>"));
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
  assert.equal(parseMessage({ text: "@LUMA track" }, "UBOT"), null);
  assert.equal(parseMessage({ text: "<@UOTHER> track" }, "UBOT"), null);
});

const sheetEnv = { ...env, SHEET_URL, SHEET_SECRET: "sheet-secret" };
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
    "conversations.replies": { messages: [rootMessage()] },
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
  assert.equal(calls[0].args.text, "Sorry, `assign` failed. Please try again.");
});

test("assigning people updates the sheet with their names", async (t) => {
  const calls = mockSlack(t, {
    ...slackUsers,
    "conversations.replies": { messages: [rootMessage({ developers: "UALICE" })] },
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
    "conversations.replies": { messages: [withStatus("IN_TESTING")] },
  });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> status done"));

  const update = calls.find((call) => call.method === "chat.update").args;
  assert.equal(update.metadata.event_payload.completed_at, "2026-10-24T09:02:00.000Z");
  const row = sheetRow(calls);
  assert.equal(row.Status, "Done");
  assert.equal(row["Completed at"], "24/10/2026 14:32");
});

test("setting Done again keeps the original completion time", async (t) => {
  const done = withStatus("DONE");
  done.metadata.event_payload.completed_at = "2026-10-20T04:30:00.000Z";
  const calls = mockSlack(t, { ...slackUsers, "conversations.replies": { messages: [done] } });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> status done"));
  assert.equal(sheetRow(calls)["Completed at"], "20/10/2026 10:00");
});

test("reopening a Done task clears its completion time", async (t) => {
  const done = withStatus("DONE");
  done.metadata.event_payload.completed_at = "2026-10-20T04:30:00.000Z";
  const calls = mockSlack(t, { ...slackUsers, "conversations.replies": { messages: [done] } });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> status in progress"));
  const update = calls.find((call) => call.method === "chat.update").args;
  assert.equal(update.metadata.event_payload.completed_at, "");
  const row = sheetRow(calls);
  assert.equal(row.Status, "In progress");
  assert.equal(row["Completed at"], "");
});

test("deleting a task marks it Deleted in the sheet", async (t) => {
  const calls = mockSlack(t, {
    ...slackUsers,
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
    "conversations.replies": (args) =>
      args.limit === "1" ? { messages: [rootMessage()] } : { messages: [{ ts: "100.1", bot_id: "BLUMA" }] },
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
    "conversations.replies": { messages: [rootMessage()] },
  });
  await sendWithSheet("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"));
  assert.equal(calls.at(-1).args.text, "<@UBOB> please test this.");
});

// Apps Script answers a POST with a redirect to a page holding its reply.
function mockRedirectingSheet(t, replyPage) {
  const calls = mockSlack(t, { ...slackUsers, "conversations.replies": { messages: [rootMessage()] } });
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
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
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

// `/luma …` slash commands arrive form-encoded.
const slash = (text, channel = "CEXTERNAL") =>
  new URLSearchParams({
    command: "/luma",
    text,
    user_id: "UACTOR",
    channel_id: channel,
    trigger_id: "trigger-9",
  }).toString();

// A requirement root message in the external channel, at 200.1. With `task`,
// the task at CDEV/100.1 has been tracked from it.
const requirementRoot = ({ task = false, status = task ? "IN_PROGRESS" : "DISCUSSION" } = {}) => ({
  ts: "200.1",
  metadata: {
    event_type: "luma_requirement",
    event_payload: {
      title: "Export reports",
      status,
      priority: task ? "High" : "",
      due_date: task ? "31/10/2026" : "",
      created_by: "UCREATOR",
      task_channel: task ? "CDEV" : "",
      task_ts: task ? "100.1" : "",
      task_title: task ? "Fix login" : "",
      task_link: task ? "https://slack.example/p100" : "",
      tracked_by: task ? "UCREATOR" : "",
    },
  },
});

// A task tracked from the requirement above.
const requirementTask = (status = "TODO") => {
  const root = withStatus(status);
  root.metadata.event_payload.source_requirement = "true";
  return root;
};

// conversations.replies returns the requirement for 200.1 and the task for 100.1.
const threads = (requirement, task = requirementTask()) => ({
  "conversations.replies": (args) => ({
    messages: [args.ts === "200.1" ? requirement : task],
  }),
});

test("/luma track opens the task form straight away", async (t) => {
  const calls = mockSlack(t);
  const response = await send("/slack/commands", slash("track", "CDEV"));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  assert.equal(calls[0].args.trigger_id, "trigger-9");
  assert.equal(calls[0].args.view.callback_id, "track");
  assert.deepEqual(JSON.parse(calls[0].args.view.private_metadata), { channel: "CDEV" });
});

test("/luma track in the dev channel posts the task without an announcement", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" }, { channel: "CDEV" })),
  );
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.postMessage",
    "pins.add",
    "chat.getPermalink",
  ]);
  assert.equal(calls[0].args.metadata.event_payload.source_channel, "");
});

test("/luma track in an external channel posts a message to be the external thread", async (t) => {
  const calls = mockSlack(t, {
    ...createdTask,
    "chat.postMessage": (args) =>
      args.channel === "CDEV" ? { channel: "CDEV", ts: "100.1" } : { ts: "400.1" },
  });
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" }, { channel: "CEXTERNAL" })),
  );

  assert.deepEqual(calls.map((call) => call.method), [
    "chat.postMessage",
    "chat.getPermalink",
    "chat.postMessage",
    "pins.add",
    "chat.getPermalink",
    "chat.update",
  ]);
  assert.equal(calls[0].args.channel, "CEXTERNAL");
  assert.equal(calls[0].args.thread_ts, undefined);
  assert.equal(calls[0].args.text, "<@UCREATOR> is tracking a task: Fix login");
  assert.equal(calls[2].args.metadata.event_payload.source_thread_ts, "400.1");
  assert.equal(calls[5].args.ts, "400.1");
  assert.equal(calls[5].args.text, "<@UCREATOR> tracked a task: <https://slack.example/p100|Fix login>");
});

test("/luma requirement opens the requirement form in an external channel only", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/commands", slash("requirement"));
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  assert.equal(calls[0].args.view.callback_id, "requirement");
  assert.deepEqual(JSON.parse(calls[0].args.view.private_metadata), { channel: "CEXTERNAL" });
  assert.deepEqual(calls[0].args.view.blocks.map((block) => block.block_id), ["title"]);

  calls = mockSlack(t);
  const response = await send("/slack/commands", slash("requirement", "CDEV"));
  assert.equal(calls.length, 0);
  const reply = await response.json();
  assert.equal(reply.response_type, "ephemeral");
  assert.match(reply.text, /^Use `\/luma requirement` in <#CEXTERNAL> or <#CTESTEXT>\.$/);
});

test("/luma help and unknown slash commands list the commands privately", async (t) => {
  for (const text of ["", "help", "hello"]) {
    mockSlack(t);
    const reply = await (await send("/slack/commands", slash(text))).json();
    assert.equal(reply.response_type, "ephemeral");
    for (const usage of ["/luma track", "/luma requirement", "@LUMA track", "@LUMA priority high", "@LUMA due 31/12/2026"]) {
      assert.ok(reply.text.includes(`\`${usage}\``), usage);
    }
  }
});

test("@LUMA requirement points to the slash command", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> requirement", { channel: "CEXTERNAL" }));
  assert.equal(calls[0].args.text, "Use `/luma requirement` in <#CEXTERNAL> or <#CTESTEXT>.");
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
        state: { values: { title: { value: { value: " Export <reports> " } } } },
      },
    }),
  );

  assert.deepEqual(await response.json(), { response_action: "clear" });
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  const post = calls[0].args;
  assert.equal(post.channel, "CEXTERNAL");
  assert.equal(post.thread_ts, undefined);
  assert.deepEqual(
    post.blocks.map((block) => block.text?.text ?? block.elements[0].text),
    [
      "*:memo: Export &lt;reports&gt;*",
      "*Status:* :speech_balloon: In discussion  ·  *Priority:* _None_  ·  *Due:* _None_",
      "*Tracked task:* _None yet. Discuss it in this thread, then send `@LUMA track` here._",
      "Started by <@UCREATOR>",
    ],
  );
  assert.equal(post.metadata.event_type, "luma_requirement");
  assert.equal(post.metadata.event_payload.title, "Export <reports>");
  assert.equal(post.metadata.event_payload.status, "DISCUSSION");
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
        state: { values: { title: { value: { value: "  " } } } },
      },
    }),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await response.json(), {
    response_action: "errors",
    errors: { title: "Enter a requirement name." },
  });
});

test("@LUMA track in a requirement thread fills in the requirement's title", async (t) => {
  let calls = mockSlack(t, { "conversations.replies": { messages: [requirementRoot()] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  const value = calls[1].args.blocks[0].elements[0].value;
  assert.deepEqual(JSON.parse(value), {
    channel: "CEXTERNAL",
    threadTs: "200.1",
    requirement: true,
    title: "Export reports",
  });

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
  assert.equal(calls[0].args.view.blocks[0].element.initial_value, "Export reports");
});

test("@LUMA track in other threads leaves the title empty", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [{ ts: "200.1" }] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  assert.deepEqual(JSON.parse(calls[1].args.blocks[0].elements[0].value), {
    channel: "CEXTERNAL",
    threadTs: "200.1",
  });
});

test("tracking from a requirement thread moves the requirement to In progress", async (t) => {
  const calls = mockSlack(t, {
    ...createdTask,
    "conversations.replies": { messages: [requirementRoot()] },
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

  assert.equal(calls[1].args.metadata.event_payload.source_requirement, "true");
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.deepEqual(
    update.args.blocks.slice(1, 3).map((block) => block.text.text),
    [
      "*Status:* :large_blue_circle: In progress  ·  *Priority:* :large_orange_circle: High  ·  *Due:* 30/11/2026",
      "*Tracked task:* <https://slack.example/p100|Export reports> by <@UCREATOR>",
    ],
  );
  assert.equal(update.args.metadata.event_payload.task_ts, "100.1");
  // The button is still replaced by the announcement.
  assert.equal(calls.at(-1).args.ts, "300.1");
});

test("informing a requirement thread updates the requirement's status", async (t) => {
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true }), requirementTask("DONE")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send("/slack/interactions", statusButton("status:inform"));

  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.equal(update.args.metadata.event_payload.status, "DONE");
  assert.match(update.args.blocks[1].text.text, /^\*Status:\* :white_check_mark: Done/);
});

test("a requirement is not changed by a task tracked from it before a newer one", async (t) => {
  const requirement = requirementRoot({ task: true });
  requirement.metadata.event_payload.task_ts = "100.7";
  const calls = mockSlack(t, threads(requirement, requirementTask()));
  await send("/slack/events", threadEvent("<@UBOT> priority low"));
  assert.ok(!calls.some((call) => call.method === "chat.update" && call.args.ts === "200.1"));
});

test("@LUMA priority in the task thread updates the task and its requirement", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true })));
  await send("/slack/events", threadEvent("<@UBOT> priority urgent"));

  assert.deepEqual(calls.map((call) => [call.method, call.args.ts ?? call.args.thread_ts]), [
    ["conversations.replies", "100.1"],
    ["chat.update", "100.1"],
    ["conversations.replies", "200.1"],
    ["chat.update", "200.1"],
    ["chat.postMessage", "100.1"],
  ]);
  assert.equal(calls[1].args.metadata.event_payload.priority, "Urgent");
  assert.match(calls[3].args.blocks[1].text.text, /\*Priority:\* :red_circle: Urgent/);
  assert.equal(calls[4].args.text, "<@UACTOR> set the priority to :red_circle: Urgent.");
});

test("@LUMA priority in a requirement thread updates the task and tells the dev thread", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true })));
  await send(
    "/slack/events",
    threadEvent("<@UBOT> priority low", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );

  const task = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.1");
  assert.equal(task.args.channel, "CDEV");
  assert.equal(task.args.metadata.event_payload.priority, "Low");
  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(
    posts.map((call) => [call.args.channel, call.args.thread_ts, call.args.text]),
    [
      [
        "CDEV",
        "100.1",
        "<@UACTOR> set the priority to :large_green_circle: Low from <https://slack.example/source|the requirement thread>.",
      ],
      ["CEXTERNAL", "200.1", "<@UACTOR> set the priority to :large_green_circle: Low."],
    ],
  );
});

test("@LUMA priority in an external thread without a tracked task says so", async (t) => {
  for (const root of [requirementRoot(), { ts: "200.1" }]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
    await send(
      "/slack/events",
      threadEvent("<@UBOT> priority low", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
    );
    assert.match(calls.at(-1).args.text, /^This thread is not a requirement with a tracked task/);
  }
});

test("@LUMA priority without a valid priority shows a menu for the task", async (t) => {
  for (const text of ["<@UBOT> priority", "<@UBOT> priority soon"]) {
    const calls = mockSlack(t, threads(requirementRoot({ task: true })));
    await send(
      "/slack/events",
      threadEvent(text, { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
    );
    const block = calls.at(-1).args.blocks[0];
    assert.deepEqual(JSON.parse(block.block_id), { channel: "CDEV", ts: "100.1" });
    assert.equal(block.accessory.action_id, "priority:select");
    assert.equal(block.accessory.initial_option.value, "High");
  }
});

test("picking a priority from the menu updates the task and the menu", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true })));
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CEXTERNAL" },
      message: { ts: "200.8", thread_ts: "200.1" },
      actions: [
        {
          action_id: "priority:select",
          block_id: JSON.stringify({ channel: "CDEV", ts: "100.1" }),
          selected_option: { value: "Medium" },
        },
      ],
    }),
  );
  const task = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.1");
  assert.equal(task.args.metadata.event_payload.priority, "Medium");
  assert.ok(calls.some((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV"));
  assert.deepEqual(calls.at(-1).args, {
    channel: "CEXTERNAL",
    ts: "200.8",
    text: "<@UCLICKER> set the priority to :large_yellow_circle: Medium.",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "<@UCLICKER> set the priority to :large_yellow_circle: Medium." },
      },
    ],
  });
});

test("@LUMA due sets, clears or asks for the due date", async (t) => {
  for (const [input, dueDate, reply] of [
    ["5/1/2027", "05/01/2027", "<@UACTOR> set the due date to 05/01/2027."],
    ["2027-02-28", "28/02/2027", "<@UACTOR> set the due date to 28/02/2027."],
    ["none", "", "<@UACTOR> removed the due date."],
  ]) {
    const calls = mockSlack(t, threads(requirementRoot({ task: true })));
    await send("/slack/events", threadEvent(`<@UBOT> due ${input}`));
    assert.equal(calls[1].args.metadata.event_payload.due_date, dueDate, input);
    assert.equal(calls[3].args.metadata.event_payload.due_date, dueDate, input);
    assert.equal(calls.at(-1).args.text, reply, input);
  }

  const calls = mockSlack(t, threads(requirementRoot({ task: true })));
  await send("/slack/events", threadEvent("<@UBOT> due 31/02/2027"));
  const block = calls.at(-1).args.blocks[0];
  assert.equal(block.accessory.type, "datepicker");
  assert.equal(block.accessory.initial_date, "2026-10-31");
  assert.match(block.text.text, /is not a date/);
});

test("picking a due date updates the task", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true })));
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: { ts: "100.8", thread_ts: "100.1" },
      actions: [
        {
          action_id: "due:select",
          block_id: JSON.stringify({ channel: "CDEV", ts: "100.1" }),
          selected_date: "2027-03-15",
        },
      ],
    }),
  );
  assert.equal(calls[1].args.metadata.event_payload.due_date, "15/03/2027");
  assert.equal(calls.at(-1).args.text, "<@UCLICKER> set the due date to 15/03/2027.");
});

test("deleting a task returns its requirement to discussion", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": (args) =>
      args.ts === "200.1"
        ? { messages: [requirementRoot({ task: true })] }
        : args.limit === "1"
          ? { messages: [requirementTask()] }
          : { messages: [{ ts: "100.1", bot_id: "BLUMA" }] },
  });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      actions: [{ action_id: "delete:confirm", value: deleteRequest }],
    }),
  );
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.equal(update.args.metadata.event_payload.status, "DISCUSSION");
  assert.equal(update.args.metadata.event_payload.task_ts, "");
  assert.match(update.args.blocks[2].text.text, /_None yet/);
});

test("parseDate accepts DD/MM/YYYY and YYYY-MM-DD real dates only", () => {
  assert.equal(parseDate("1/2/2027"), "01/02/2027");
  assert.equal(parseDate("01-02-2027"), "01/02/2027");
  assert.equal(parseDate("2027-02-01"), "01/02/2027");
  assert.equal(parseDate("29/02/2027"), "");
  assert.equal(parseDate("13/13/2027"), "");
  assert.equal(parseDate("tomorrow"), "");
});
