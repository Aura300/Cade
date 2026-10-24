import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { parseMessage } from "../src/commands/parse.js";
import { parseDueDate } from "../src/tasks.js";

const SIGNING_SECRET = "test-signing-secret";
const env = {
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  CHANNEL_PAIRS: [
    { external: "CEXTERNAL", tasks: "CDEV" },
    { external: "CTESTEXT", tasks: "CTESTDEV" },
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
async function send(path, body, headers = {}) {
  const pending = [];
  const request = new Request(`https://worker.example.net${path}`, {
    method: "POST",
    headers: { ...(await sign(body)), ...headers },
    body,
  });
  const response = await worker.fetch(request, env, {
    waitUntil: (promise) => pending.push(promise),
  });
  await Promise.all(pending);
  return response;
}

const interaction = (payload) =>
  new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

// Replaces fetch with a fake Slack API. `responses` maps a method name to its
// result; every call is recorded with its decoded arguments.
function mockSlack(t, responses = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
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
        due_date: { value: { value: values.dueDate ?? null } },
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
      due_date: "10/31",
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

test("modal submission rejects an invalid due date", async (t) => {
  const calls = mockSlack(t);
  const response = await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", dueDate: "13/01", priority: "High" })),
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(await response.json(), {
    response_action: "errors",
    errors: { due_date: "Use MM/DD, for example 10/31." },
  });
});

test("modal submission posts the task and replaces the button with the announcement", async (t) => {
  const calls = mockSlack(t, createdTask);
  const response = await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix <login>", dueDate: "1/5", priority: "Urgent" })),
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
    "*Status:* :white_circle: To do  ·  *Priority:* :red_circle: Urgent  ·  *Due:* 01/05",
  );
  assert.equal(
    post.blocks[2].text.text,
    "*Developer:* _Unassigned_  ·  *Reviewer:* _Unassigned_  ·  *Tester:* _Unassigned_",
  );
  assert.equal(post.blocks[3].type, "context");
  assert.match(
    post.blocks[3].elements[0].text,
    /^Tracked by <@UCREATOR> from <https:\/\/slack\.example\/source\|the request thread> · /,
  );
  assert.deepEqual(post.metadata, {
    event_type: "luma_task",
    event_payload: {
      title: "Fix <login>",
      priority: "Urgent",
      status: "TODO",
      due_date: "01/05",
      developers: "",
      reviewers: "",
      testers: "",
      created_by: "UCREATOR",
      source_channel: "CEXTERNAL",
      source_thread_ts: "200.1",
      source_link: "https://slack.example/source",
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

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "chat.postMessage");
  assert.equal(calls[0].args.channel, "CEXTERNAL");
  assert.equal(calls[0].args.thread_ts, "200.1");
  const button = calls[0].args.blocks[0].elements[0];
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
  assert.equal(payload.due_date, "10/31");
  assert.deepEqual(calls[2].args, {
    channel: "CDEV",
    thread_ts: "100.1",
    text: "<@UACTOR> assigned <@UBOB>, <@UALICE> as developer.",
  });
});

test("@LUMA assign works for each role, in any word order", async (t) => {
  for (const [text, key] of [
    ["<@UBOT> assign reviewer <@UBOB>", "reviewers"],
    ["<@UBOT> assign tester <@UBOB>", "testers"],
    ["<@UBOT> assign <@UBOB> as Tester", "testers"],
    ["<@UBOT> assign developers <@UBOB>", "developers"],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
    await send("/slack/events", threadEvent(text));
    assert.equal(calls[1].args.metadata.event_payload[key], "UBOB", text);
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

test("@LUMA track outside an external channel points to them", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> track", { channel: "CDEV" }));
  assert.equal(calls[0].args.text, "Use `@LUMA track` in <#CEXTERNAL> or <#CTESTEXT>.");
});

test("tasks tracked from the test channel go to the test tasks channel", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> track", { channel: "CTESTEXT" }));
  assert.equal(calls[0].args.blocks[0].elements[0].action_id, "track:open");

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

test("parseDueDate normalizes and validates MM/DD", () => {
  assert.equal(parseDueDate("1/5"), "01/05");
  assert.equal(parseDueDate("12/31"), "12/31");
  assert.equal(parseDueDate("02/29"), "02/29");
  assert.equal(parseDueDate("02/30"), null);
  assert.equal(parseDueDate("00/10"), null);
  assert.equal(parseDueDate("2026-10-31"), null);
});
