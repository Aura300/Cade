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

// The action_ids used more than once in a message's blocks.
function duplicateActionIds(blocks) {
  const ids = blocks.flatMap((block) => [
    ...(block.elements ?? []).map((element) => element.action_id),
    block.accessory?.action_id,
    block.element?.action_id && `${block.block_id}:${block.element.action_id}`,
  ]).filter(Boolean);
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

// Replaces fetch with a fake Slack API. `responses` maps a method name to its
// result; every call is recorded with its decoded arguments. Link preview
// settings are recorded as `previews` rather than with the arguments. Requests to the
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

// The team's own task, tracked with /luma track: no requirement thread.
const ownTask = (people) => {
  const root = rootMessage(people);
  Object.assign(root.metadata.event_payload, { source_channel: "", source_thread_ts: "", source_link: "" });
  return root;
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
    errors: { title: "Enter a task title." },
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
    /^Tracked by <@UCREATOR> from <https:\/\/slack\.example\/source\|the requirement thread>$/,
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
      prs: "",
      created_by: "UCREATOR",
      completed_at: "",
      source_channel: "CEXTERNAL",
      source_thread_ts: "200.1",
      source_link: "https://slack.example/source",
      source_incident: "",
    },
  });

  assert.deepEqual(calls[2].args, { channel: "CDEV", timestamp: "100.1" });
  // The button message becomes the news that it's tracked, with the link, so
  // the thread doesn't grow.
  const text = "<@UCREATOR> tracked this as a task: <https://slack.example/p100|Fix &lt;login&gt;>";
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
  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV");
  assert.match(post.args.blocks[1].text.text, /\*Due:\* _None_$/);
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
  // Reading the requirement and the source link fail too, but only the
  // failed post stops the task.
  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.replies",
    "chat.getPermalink",
    "chat.postMessage",
    "chat.postEphemeral",
  ]);
  assert.equal(calls[3].args.user, "UCREATOR");
  assert.equal(calls[3].args.thread_ts, "200.1");
  assert.match(calls[3].args.text, /could not be created/);
});

test("@LUMA track only works in a requirement thread", async (t) => {
  for (const [overrides, roots] of [
    // A thread Luma did not start.
    [{ ts: "200.5", thread_ts: "200.1" }, [{ ts: "200.1" }]],
    // A top-level message, which has no thread to check.
    [{ ts: "200.5", thread_ts: undefined }, []],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: roots } });
    await send("/slack/events", threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ...overrides }));
    const reply = calls.at(-1).args;
    assert.equal(reply.text, "Use `@LUMA track` in the thread of a requirement started with `/luma requirement`. For the team's own work, use `/luma track` in <#CDEV>.");
    assert.ok(!reply.blocks, "no Track task button");
  }
});

test("a tracked requirement cannot be tracked again", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [requirementRoot({ task: true })] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"]);
  assert.equal(
    calls[1].args.text,
    "This requirement is already tracked as <https://slack.example/p100|Fix login>.",
  );
});

test("a requirement tracked while the form was open is not tracked twice", async (t) => {
  const calls = mockSlack(t, {
    ...createdTask,
    "conversations.replies": { messages: [requirementRoot({ task: true })] },
  });
  await send(
    "/slack/interactions",
    interaction(titleOnlySubmission("Export reports", requirementOrigin)),
  );
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postEphemeral"]);
  assert.equal(calls[1].args.user, "UCREATOR");
  assert.equal(calls[1].args.thread_ts, "200.1");
  assert.match(calls[1].args.text, /^This requirement is already tracked as/);
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
    // No PR yet, so the reviewer isn't named, and isn't notified.
    ["<@UBOT> assign reviewer <@UBOB>", "reviewers", "<@UACTOR> added a reviewer. They'll be asked to review when a PR is linked."],
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

test("@LUMA status updates the task's status", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": { messages: [rootMessage({ developers: "UALICE" })] },
  });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));

  // The second read is the requirement, to show the new status there.
  assert.deepEqual(
    calls.map((call) => call.method),
    ["conversations.replies", "chat.update", "conversations.replies", "reactions.add"],
  );
  const update = calls[1].args;
  assert.equal(update.metadata.event_payload.status, "IN_PROGRESS");
  assert.equal(update.metadata.event_payload.developers, "UALICE");
  assert.match(update.blocks[1].text.text, /^\*Status:\* :large_blue_circle: In progress  ·/);
  // A typed status gets a ✅ on the command, not a reply.
  assert.deepEqual(calls[3].args, { channel: "CDEV", timestamp: "100.5", name: "white_check_mark" });
});

test("@LUMA status DONE unpins the task and reopening pins it again", async (t) => {
  let calls = mockSlack(t, {
    "conversations.replies": { messages: [rootMessage()] },
  });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  // Done unpins the task and its requirement, and is posted in the
  // requirement thread without asking.
  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.replies",
    "chat.update",
    "conversations.replies",
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

  const done = rootMessage();
  done.metadata.event_payload.status = "DONE";
  calls = mockSlack(t, { "conversations.replies": { messages: [done] } });
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
    "conversations.replies",
    "chat.getPermalink",
    "chat.postMessage",
    "pins.add",
    "chat.getPermalink",
    "conversations.replies",
    "chat.update",
  ]);
});

const withStatus = (status) => {
  const root = rootMessage();
  root.metadata.event_payload.status = status;
  return root;
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
    const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
    await send("/slack/events", threadEvent(`<@UBOT> status ${input}`));
    assert.ok(calls.some((call) => call.method === "reactions.add"), input);
    // Reaching Client review or Done adds a note that the requirement thread
    // was told; nothing posted here ever asks anything.
    for (const call of calls.filter((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV")) {
      assert.match(call.args.text, /^Luma (told|asked)/, input);
      assert.equal(call.args.blocks, undefined, input);
    }
  }
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
    "conversations.replies",
    "pins.remove",
    "pins.remove",
    "chat.postMessage",
    "chat.update",
  ]);
  assert.equal(calls[1].args.ts, "100.1");
  assert.equal(calls[1].args.metadata.event_payload.status, "DONE");
  assert.equal(calls[5].args.channel, "CEXTERNAL");
  // The menu becomes the confirmation, saying the requirement thread was told.
  const menu = calls[6].args;
  assert.equal(menu.ts, "100.7");
  assert.equal(menu.text, "<@UPICKER> set the status to :white_check_mark: Done.\nLuma told <https://slack.example/source|the requirement thread> it's :white_check_mark: Done.");
  assert.equal(menu.blocks.length, 1, "no buttons");
});

test("@LUMA delete and @LUMA remove ask for confirmation", async (t) => {
  for (const name of ["delete", "remove"]) {
    const calls = mockSlack(t, {
      "conversations.replies": { messages: [ownTask()] },
    });
    await send("/slack/events", threadEvent(`<@UBOT> ${name}`));

    assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"]);
    assert.equal(calls[1].args.thread_ts, "100.1");
    const [cancel, button] = calls[1].args.blocks[1].elements;
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

test("confirming deletion removes Luma's replies and then the task", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": (args) =>
      args.limit === "1"
        ? { messages: [ownTask()] }
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
  // The requirement's message shows it's untracked, and whoever confirmed
  // sees the task go: nothing is posted, not even privately.
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("deleting the team's own task posts nothing outside its channel", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": (args) =>
      args.limit === "1" ? { messages: [ownTask()] } : { messages: [{ ts: "100.1", bot_id: "BLUMA" }] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.replies",
    "conversations.replies",
    "chat.delete",
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
    /from <https:\/\/slack\.example\/source\|the requirement thread>/,
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
    "Use `@LUMA assign developer @person` in a task thread in <#CDEV>.",
  );
});

test("@LUMA track outside the external channels points to them", async (t) => {
  // From a paired channel only its pair's channel is named.
  for (const [channel, hint] of [
    ["CDEV", "<#CEXTERNAL>"],
    ["CTESTDEV", "<#CTESTEXT>"],
    ["COTHER", "<#CEXTERNAL> or <#CTESTEXT>"],
  ]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent("<@UBOT> track", { channel }));
    assert.equal(calls[0].args.text, `Use \`@LUMA track\` in ${hint}.`, channel);
  }
});

test("/luma track only works in the dev channels", async (t) => {
  const calls = mockSlack(t);
  const reply = await (await send("/slack/commands", slash("track", "CEXTERNAL"))).json();
  assert.equal(calls.length, 0);
  assert.equal(reply.response_type, "ephemeral");
  assert.equal(reply.text, "Use `/luma track` in <#CDEV>.");
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
  let calls = mockSlack(t, { "conversations.replies": { messages: [requirementRoot()] } });
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
  const made = calls.filter((call) => call.method !== "conversations.replies");
  assert.deepEqual(made[0].args, { channel: "CTESTEXT", message_ts: "200.1" });
  assert.equal(made[1].args.channel, "CTESTDEV");
  assert.deepEqual(made[2].args, { channel: "CTESTDEV", timestamp: "100.1" });
  assert.equal(made[4].args.channel, "CTESTEXT");
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
    // Three lines, one per section, then how to see it again.
    const lines = calls[0].args.text.split("\n");
    assert.deepEqual(
      lines.map((line) => line.split(":*")[0]),
      ["*Start", "*In a task thread", "*Your work", "`@LUMA help` or `/luma help` shows this."],
    );
    assert.match(lines[0], /`\/luma requirement` · `\/luma incident` · `\/luma track` · `@LUMA track`$/);
    // Saying it comes first in a task thread; the commands follow.
    assert.match(lines[1], /^\*In a task thread:\* Just say it: .* Or: `@LUMA assign developer @person`/);
    for (const usage of ["assign developer @person", "unassign developer @person", "status", "priority high", "due 31/12/2026", "pr add <link>", "delete"]) {
      assert.ok(lines[1].includes(`\`@LUMA ${usage}\``), usage);
    }
    assert.equal(lines[2], "*Your work:* `/luma tasks`");
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
      priority: "High",
      due_date: "31/10/2026",
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

test("/luma requirement opens the requirement form in an external channel only", async (t) => {
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
  assert.equal(reply.text, "Use `/luma requirement` in <#CEXTERNAL>.");
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
  assert.equal(calls[0].args.text, "Use `/luma requirement` in <#CEXTERNAL>.");
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
    post.blocks.map((block) => block.text?.text ?? block.elements[0].text),
    [
      "*Requirement:* Export &lt;reports&gt;",
      "*Status:* :speech_balloon: In discussion  ·  *Priority:* :large_orange_circle: High  ·  *Due:* 30/11/2026",
      "Started by <@UCREATOR>\nNot tracked yet. Discuss it in this thread, then send `@LUMA track` here.",
    ],
  );
  assert.equal(post.metadata.event_type, "luma_requirement");
  assert.equal(post.metadata.event_payload.title, "Export <reports>");
  assert.equal(post.metadata.event_payload.status, "DISCUSSION");
  assert.equal(post.metadata.event_payload.priority, "High");
  assert.equal(post.metadata.event_payload.due_date, "30/11/2026");
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
    errors: { title: "Enter a requirement name.", priority: "Select a priority." },
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

  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV");
  assert.equal(post.args.metadata.event_payload.source_thread_ts, "200.1");
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.equal(
    update.args.blocks[1].text.text,
    // The requirement's own priority and due date, not the form's.
    "*Status:* :large_blue_circle: In progress  ·  *Priority:* :large_orange_circle: High  ·  *Due:* 31/10/2026",
  );
  // Who started and who tracked it share the small text, one per line, and
  // the task is linked the way the task links back to the requirement.
  assert.deepEqual(update.args.blocks[2], {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Started by <@UCREATOR>\nTracked by <@UCREATOR> in <https://slack.example/p100|the task thread>",
      },
    ],
  });
  assert.equal(update.args.blocks.length, 3);
  assert.equal(
    post.args.blocks[3].elements[0].text,
    "Tracked by <@UCREATOR> from <https://slack.example/source|the requirement thread>",
  );
  assert.equal(update.args.metadata.event_payload.task_ts, "100.1");
  // The button is still replaced by the announcement.
  assert.equal(calls.at(-1).args.ts, "300.1");
});

test("@LUMA priority and due in a requirement thread change the requirement until it is tracked", async (t) => {
  for (const [text, field, value, reply] of [
    ["<@UBOT> priority urgent", "priority", "Urgent", "<@UACTOR> set the priority to :red_circle: Urgent."],
    ["<@UBOT> due 15/12/2026", "due_date", "15/12/2026", "<@UACTOR> set the due date to 15/12/2026."],
    ["<@UBOT> due none", "due_date", "", "<@UACTOR> removed the due date."],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [requirementRoot()] } });
    await send(
      "/slack/events",
      threadEvent(text, { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
    );
    assert.deepEqual(calls.map((call) => [call.method, call.args.channel]), [
      ["conversations.replies", "CEXTERNAL"],
      ["chat.update", "CEXTERNAL"],
      ["reactions.add", "CEXTERNAL"],
    ], text);
    const update = calls[1].args;
    assert.equal(update.ts, "200.1");
    assert.equal(update.metadata.event_payload[field], value, text);
    assert.equal(update.metadata.event_payload.status, "DISCUSSION");
    assert.deepEqual(calls[2].args, { channel: "CEXTERNAL", timestamp: "200.5", name: "white_check_mark" }, reply);
  }
});

test("a requirement's new priority and due date fill in the track form", async (t) => {
  const requirement = requirementRoot();
  Object.assign(requirement.metadata.event_payload, { priority: "Low", due_date: "15/12/2026" });
  const calls = mockSlack(t, { "conversations.replies": { messages: [requirement] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  const origin = JSON.parse(calls[1].args.blocks[0].elements[0].value);
  assert.equal(origin.priority, "Low");
  assert.equal(origin.dueDate, "15/12/2026");
});

test("@LUMA priority in an external thread Luma did not start says so", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [{ ts: "200.1" }] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> priority low", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"]);
  assert.match(calls[1].args.text, /^This thread is not a requirement\. Use `\/luma requirement`/);
});

test("parseDate accepts DD/MM/YYYY and YYYY-MM-DD real dates only", () => {
  assert.equal(parseDate("1/2/2027"), "01/02/2027");
  assert.equal(parseDate("01-02-2027"), "01/02/2027");
  assert.equal(parseDate("2027-02-01"), "01/02/2027");
  assert.equal(parseDate("29/02/2027"), "");
  assert.equal(parseDate("13/13/2027"), "");
  assert.equal(parseDate("tomorrow"), "");
});

test("Luma's messages never preview the messages they link to", async (t) => {
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

test("@LUMA track in a requirement thread asks only for the title", async (t) => {
  let calls = mockSlack(t, { "conversations.replies": { messages: [requirementRoot()] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  const value = calls[1].args.blocks[0].elements[0].value;
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
    /^\*Priority:\* :large_orange_circle: High  ·  \*Due:\* 31\/10\/2026\nFrom the requirement/,
  );
});

test("a task tracked from a requirement takes the requirement's current priority and due date", async (t) => {
  const requirement = requirementRoot();
  Object.assign(requirement.metadata.event_payload, { priority: "Low", due_date: "15/12/2026" });
  const calls = mockSlack(t, {
    ...createdTask,
    "conversations.replies": { messages: [requirement] },
  });
  const response = await send(
    "/slack/interactions",
    interaction(titleOnlySubmission("Export reports", requirementOrigin)),
  );
  assert.deepEqual(await response.json(), { response_action: "clear" });

  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV");
  assert.equal(post.args.metadata.event_payload.priority, "Low");
  assert.equal(post.args.metadata.event_payload.due_date, "15/12/2026");
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.equal(update.args.metadata.event_payload.status, "IN_PROGRESS");
  assert.equal(update.args.metadata.event_payload.priority, "Low");
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
    const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
    assert.equal(update.args.metadata.event_payload.status, shown, status);
    // Client review and Done are posted in the requirement thread too.
    const posted = calls.some((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL");
    assert.equal(posted, ["CLIENT_REVIEW", "DONE"].includes(status), status);
  }
});

test("@LUMA priority and due in a tracked requirement's thread change the task and tell the team", async (t) => {
  for (const [text, field, value, reply] of [
    ["<@UBOT> priority urgent", "priority", "Urgent", "<@UACTOR> set the priority to :red_circle: Urgent."],
    ["<@UBOT> due 15/12/2026", "due_date", "15/12/2026", "<@UACTOR> set the due date to 15/12/2026."],
    ["<@UBOT> due none", "due_date", "", "<@UACTOR> removed the due date."],
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
      ["conversations.replies", "CEXTERNAL"],
      ["conversations.replies", "CDEV"],
      ["chat.update", "CEXTERNAL"],
      ["chat.update", "CDEV"],
      ["chat.getPermalink", "CEXTERNAL"],
      ["chat.postMessage", "CDEV"],
      ["reactions.add", "CEXTERNAL"],
    ], text);
    assert.equal(calls[2].args.metadata.event_payload[field], value, text);
    assert.equal(calls[3].args.metadata.event_payload[field], value, text);
    assert.equal(calls[5].args.thread_ts, "100.1");
    assert.equal(
      calls[5].args.text,
      `${reply.replace(/\.$/, "")} in <https://slack.example/requirement|the requirement thread>.`,
    );
    // The team is told in the task's thread; the client just gets a ✅.
    assert.equal(calls[6].args.name, "white_check_mark");
  }
});

test("a task tracked from a requirement cannot change its priority or due date in the dev thread", async (t) => {
  for (const text of ["<@UBOT> priority low", "<@UBOT> due 15/12/2026", "<@UBOT> due"]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [requirementTask()] } });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"], text);
    assert.equal(
      calls[1].args.text,
      "The client sets this task's priority and due date. Change them in <https://slack.example/source|the requirement thread>.",
    );
  }
});

test("tasks with no requirement change their priority and due date in the dev thread", async (t) => {
  for (const [text, field, value, reply] of [
    ["<@UBOT> priority low", "priority", "Low", "<@UACTOR> set the priority to :large_green_circle: Low."],
    ["<@UBOT> due 5/1/2027", "due_date", "05/01/2027", "<@UACTOR> set the due date to 05/01/2027."],
    ["<@UBOT> due 2027-02-28", "due_date", "28/02/2027", "<@UACTOR> set the due date to 28/02/2027."],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [ownTask()] } });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), [
      "conversations.replies",
      "chat.update",
      "reactions.add",
    ], text);
    assert.equal(calls[1].args.metadata.event_payload[field], value, text);
    assert.deepEqual(calls[2].args, { channel: "CDEV", timestamp: "100.5", name: "white_check_mark" }, reply);
  }
});

test("@LUMA priority and due without a valid value show a picker", async (t) => {
  for (const [text, type, initial] of [
    ["<@UBOT> priority", "static_select", "High"],
    ["<@UBOT> priority soon", "static_select", "High"],
    ["<@UBOT> due", "datepicker", "2026-10-31"],
    ["<@UBOT> due 31/02/2027", "datepicker", "2026-10-31"],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [ownTask()] } });
    await send("/slack/events", threadEvent(text));
    const { accessory } = calls.at(-1).args.blocks[0];
    assert.equal(accessory.type, type, text);
    assert.equal(accessory.initial_option?.value ?? accessory.initial_date, initial, text);
  }
});

test("picking from the menu or date picker changes what the picker's thread is about", async (t) => {
  for (const [channel, thread, root, action, field, value] of [
    ["CDEV", "100.1", ownTask(), { action_id: "priority:select", selected_option: { value: "Medium" } }, "priority", "Medium"],
    ["CEXTERNAL", "200.1", requirementRoot(), { action_id: "due:select", selected_date: "2027-03-15" }, "due_date", "15/03/2027"],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
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
      ["conversations.replies", thread],
      ["chat.update", thread],
      ["chat.update", "900.1"],
    ]);
    assert.equal(calls[1].args.metadata.event_payload[field], value);
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
          text: "<@UACTOR> marked this as ready to review.",
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
    ["conversations.replies", "100.1"],
    ["chat.update", "100.1"],
    ["conversations.replies", "200.1"],
    ["chat.update", "200.1"],
    ["pins.remove", "100.1"],
    ["pins.remove", "200.1"],
    ["chat.getPermalink", undefined],
    ["chat.postMessage", "100.1"],
    ["chat.update", "200.9"],
  ]);
  assert.equal(calls[1].args.metadata.event_payload.status, "DONE");
  assert.ok(calls[1].args.metadata.event_payload.completed_at);
  assert.equal(calls[3].args.metadata.event_payload.status, "DONE");
  assert.deepEqual(calls[6].args, { channel: "CEXTERNAL", message_ts: "200.9" });
  assert.equal(calls[7].args.channel, "CDEV");
  assert.equal(
    calls[7].args.text,
    "<@UCLIENT> approved this in <https://slack.example/review|the requirement thread>, so it is now :white_check_mark: Done.",
  );
  assert.deepEqual(calls[8].args, {
    channel: "CEXTERNAL",
    ts: "200.9",
    text: "<@UACTOR> marked this as ready to review.\n<@UCLIENT> approved it.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "<@UACTOR> marked this as ready to review.\n<@UCLIENT> approved it.",
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
  assert.equal(task.args.metadata.event_payload.status, "IN_PROGRESS");
  const requirement = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.equal(requirement.args.metadata.event_payload.status, "IN_PROGRESS");
  // The task was not Done, so its pin stays.
  assert.ok(!calls.some((call) => call.method.startsWith("pins.")));
  const note = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(note.thread_ts, "100.1");
  assert.equal(
    note.text,
    "<@UCLIENT> did not approve this in <https://slack.example/review|the requirement thread>, so it is back to :large_blue_circle: In progress. See the thread for what needs to change.",
  );
  assert.match(calls.at(-1).args.text, /\n<@UCLIENT> did not approve it, so the team will pick it up again\.$/);
});

test("Approve and Not approve do nothing once the task has left Client review", async (t) => {
  for (const actionId of ["status:approve", "status:reject"]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [requirementTask("IN_TESTING")] } });
    await send("/slack/interactions", reviewClick(actionId));
    assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.update"], actionId);
    assert.match(calls[1].args.text, /\nNot applied: the task is now :large_orange_circle: In testing\.$/);
  }
});

test("Approve on a deleted task says so", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [] } });
  await send("/slack/interactions", reviewClick("status:approve"));
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.update"]);
  assert.match(calls[1].args.text, /\nThis task no longer exists\.$/);
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
  assert.equal(note.text, "Luma asked the client to review it in <https://slack.example/source|the requirement thread>.");
});

const requirementDelete = JSON.stringify({
  kind: "requirement",
  channel: "CEXTERNAL",
  ts: "200.1",
  requestedBy: "UCLIENT",
});

test("@LUMA remove in a requirement thread asks for confirmation", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [requirementRoot()] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> remove", { channel: "CEXTERNAL", user: "UCLIENT", ts: "200.5", thread_ts: "200.1" }),
  );

  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"]);
  const prompt = calls[1].args;
  assert.equal(prompt.thread_ts, "200.1");
  assert.equal(
    prompt.text,
    "<@UCLIENT>, delete the requirement *Export reports*? This cannot be undone.",
  );
  const [cancel, confirm] = prompt.blocks[1].elements;
  assert.equal(confirm.text.text, "Delete requirement");
  assert.equal(confirm.confirm.title.text, "Delete requirement?");
  assert.equal(confirm.confirm.deny.text, "Keep requirement");
  assert.deepEqual(JSON.parse(confirm.value), JSON.parse(requirementDelete));
  assert.equal(cancel.action_id, "delete:cancel");
});

test("removing a tracked requirement asks to delete its task too", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [requirementRoot({ task: true })] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> remove", { channel: "CEXTERNAL", user: "UCLIENT", ts: "200.5", thread_ts: "200.1" }),
  );
  const prompt = calls.at(-1).args;
  assert.equal(
    prompt.text,
    "<@UCLIENT>, delete the requirement *Export reports* and its task <https://slack.example/p100|Fix login> in <#CDEV>? This cannot be undone.",
  );
  const [, confirm] = prompt.blocks[1].elements;
  assert.equal(
    confirm.confirm.text.text,
    '"Export reports", its task "Fix login", and Luma\'s replies in both threads will be deleted.',
  );
});

test("@LUMA remove in an external thread Luma did not start says so", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [{ ts: "200.1" }] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> remove", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
  );
  assert.match(calls.at(-1).args.text, /^This thread is not a requirement\./);
});

test("confirming a requirement's deletion removes Luma's replies and then the requirement", async (t) => {
  const calls = mockSlack(t, {
    "conversations.replies": (args) =>
      args.limit === "1"
        ? { messages: [requirementRoot()] }
        : {
            messages: [
              { ts: "200.1", bot_id: "BLUMA" },
              { ts: "200.2", user: "UCLIENT" },
              { ts: "200.3", bot_id: "BLUMA" },
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
  const root = requirementRoot({ task });
  Object.assign(root.metadata.event_payload, {
    title: "Checkout is down",
    priority: "Urgent",
    due_date: "Immediate",
    incident: "true",
    task_channel: task ? "CINC" : "",
  });
  return root;
};

const incidentTask = (status = "TODO") => {
  const root = requirementTask(status);
  Object.assign(root.metadata.event_payload, {
    title: "Checkout is down",
    priority: "Urgent",
    due_date: "Immediate",
  });
  return root;
};

test("/luma incident opens a form that asks only what the incident is", async (t) => {
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

test("/luma incident needs an incidents channel and works only in external channels", async (t) => {
  for (const [channel, text] of [
    ["CTESTEXT", /^Incidents aren't set up for this channel yet/],
    ["CDEV", /^Use `\/luma incident` in <#CEXTERNAL>\.$/],
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
    "conversations.replies": { messages: [incidentRoot({ task: false })] },
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
  assert.equal(root.blocks[0].text.text, "*Incident:* Checkout is down");
  assert.match(root.blocks[2].elements[0].text, /^Reported by <@UCLIENT>\n/);
  assert.equal(root.metadata.event_payload.incident, "true");
  assert.equal(root.metadata.event_payload.priority, "Urgent");
  assert.equal(root.metadata.event_payload.due_date, "Immediate");

  // The task, in the incidents channel, pinned, linking back to the incident.
  const task = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CINC");
  assert.equal(
    task.args.blocks[1].text.text,
    "*Status:* :white_circle: To do  ·  *Priority:* :red_circle: Urgent  ·  *Due:* Immediate",
  );
  assert.equal(task.args.metadata.event_payload.source_thread_ts, "200.1");
  assert.equal(task.args.metadata.event_payload.source_thread_ts, "200.1");
  assert.equal(task.args.metadata.event_payload.source_incident, "true");
  assert.equal(
    task.args.blocks[3].elements[0].text,
    "Tracked by <@UCLIENT> from <https://slack.example/source|the incident thread>",
  );
  assert.ok(calls.some((call) => call.method === "pins.add" && call.args.channel === "CINC"));
  assert.ok(!calls.some((call) => call.args.channel === "CDEV"), "nothing goes to the dev channel");

  // The incident message then links to the task and shows In progress.
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.equal(
    update.args.blocks[1].text.text,
    "*Status:* :large_blue_circle: In progress  ·  *Priority:* :red_circle: Urgent  ·  *Due:* Immediate",
  );
  assert.equal(update.args.metadata.event_payload.task_channel, "CINC");
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
    errors: { title: "Describe the incident." },
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
        "Incidents are always :red_circle: Urgent and due Immediate, so their priority and due date can't be changed.",
      );
    }
  }
});

test("the incidents channel runs the task commands like the dev channel", async (t) => {
  let calls = mockSlack(t, threads(incidentRoot(), incidentTask("IN_TESTING")));
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UBOB>", { channel: "CINC" }), {}, incidentEnv);
  assert.equal(calls[1].args.channel, "CINC");
  assert.equal(calls[1].args.metadata.event_payload.developers, "UBOB");

  // Client review asks whoever reported the incident, as for requirements.
  calls = mockSlack(t, {
    ...threads(incidentRoot(), incidentTask("IN_TESTING")),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send("/slack/events", threadEvent("<@UBOT> status client review", { channel: "CINC" }), {}, incidentEnv);
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.equal(update.args.metadata.event_payload.status, "CLIENT_REVIEW");
  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL");
  assert.match(review.args.text, /\n<@UCREATOR>, please review it/);
  assert.equal(review.args.blocks[1].elements[0].action_id, "status:approve");
});

test("an incident whose task was deleted is tracked again in the incidents channel", async (t) => {
  let calls = mockSlack(t, { "conversations.replies": { messages: [incidentRoot({ task: false })] } });
  await send(
    "/slack/events",
    threadEvent("<@UBOT> track", { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" }),
    {},
    incidentEnv,
  );
  const origin = JSON.parse(calls[1].args.blocks[0].elements[0].value);
  assert.equal(origin.incident, true);

  calls = mockSlack(t, {
    ...createdTask,
    "chat.postMessage": (args) =>
      args.channel === "CINC" ? { channel: "CINC", ts: "100.1" } : { ts: "300.1" },
    "conversations.replies": { messages: [incidentRoot({ task: false })] },
  });
  await send(
    "/slack/interactions",
    interaction(titleOnlySubmission("Checkout is down", { ...origin, promptTs: "300.1" })),
    {},
    incidentEnv,
  );
  const task = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CINC");
  assert.ok(task, "the task goes to the incidents channel");
  assert.equal(task.args.metadata.event_payload.priority, "Urgent");
  assert.equal(task.args.metadata.event_payload.due_date, "Immediate");
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
  const root = rootMessage();
  root.metadata.event_payload.source_channel = "";
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  const pins = calls.filter((call) => call.method.startsWith("pins."));
  assert.deepEqual(pins.map((call) => call.args.channel), ["CDEV"]);
});

// A pinned task's message as pins.list returns it.
const historyTask = (ts, fields) => {
  const root = rootMessage();
  root.ts = ts;
  Object.assign(root.metadata.event_payload, fields);
  return root;
};

// Each channel's pinned messages; other channels have none. Slash command
// answers sent later go to RESPONSE_URL, recorded as the "respond" method.
const RESPONSE_URL = "https://hooks.slack.com/commands/T1/1/abc";
const pinsIn = (byChannel) => ({
  "auth.test": { url: "https://acme.slack.com/" },
  "pins.list": (args) => ({
    items: (byChannel[args.channel] ?? []).map((message) => ({ type: "message", message })),
  }),
});

// Runs `/luma <text>` from `channel` as UACTOR and returns its immediate
// answer, the calls made, and the answer sent later through the response_url.
async function tasksCommand(t, text, channel, responses, environment = env) {
  const calls = mockSlack(t, responses);
  const fakeFetch = globalThis.fetch;
  let later;
  globalThis.fetch = async (url, init) => {
    if (url === RESPONSE_URL) {
      later = JSON.parse(init.body);
      return new Response("ok");
    }
    return fakeFetch(url, init);
  };
  const form = new URLSearchParams(slash(text, channel));
  form.set("response_url", RESPONSE_URL);
  const response = await send("/slack/commands", form.toString(), {}, environment);
  globalThis.fetch = fakeFetch;
  return { now: await response.text(), calls, later };
}

test("/luma tasks in a group's channel shows its open tasks by role, only to you", async (t) => {
  const { now, calls, later } = await tasksCommand(t, "tasks", "CDEV", pinsIn({
    CDEV: [
      historyTask("100.1", { title: "Low task", priority: "Low", developers: "UACTOR" }),
      historyTask("100.2", { title: "High task", priority: "High", due_date: "05/11/2026", developers: "UACTOR,UBOB" }),
      historyTask("100.3", { title: "High, sooner", priority: "High", due_date: "01/11/2026", developers: "UACTOR" }),
      historyTask("100.4", { title: "Done task", status: "DONE", developers: "UACTOR" }),
      historyTask("100.5", { title: "Not mine", developers: "UBOB" }),
      historyTask("100.6", { title: "Review me", reviewers: "UACTOR", status: "IN_REVIEW" }),
      { ts: "100.7", text: "a chat message" },
    ],
    CINC: [
      historyTask("100.8", { title: "Checkout is down", priority: "Urgent", due_date: "Immediate", developers: "UACTOR" }),
    ],
    // Another group's task is left out.
    CTESTDEV: [historyTask("100.9", { title: "Test task", developers: "UACTOR" })],
  }), incidentEnv);

  // Slack is answered at once; the list follows, only to you.
  assert.equal(now, "");
  assert.equal(later.response_type, "ephemeral");
  // Nothing is posted or pinned anywhere.
  assert.ok(!calls.some((call) => ["chat.postMessage", "pins.add"].includes(call.method)));
  // Only the group's channels' pins are read.
  const read = calls.filter((call) => call.method === "pins.list").map((call) => call.args.channel);
  assert.deepEqual(read.sort(), ["CDEV", "CINC"]);
  // Pins with a task's details are not loaded again; only the pinned chat
  // message, which has none, is checked.
  const loaded = calls.filter((call) => call.method === "conversations.replies");
  assert.deepEqual(loaded.map((call) => call.args.ts), ["100.7"]);

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
      `• *Incident:* <${thread("CINC", "100.8")}|Checkout is down>  ·  :white_circle: To do  ·  :red_circle: Urgent  ·  Due Immediate`,
      `• <${thread("CDEV", "100.3")}|High, sooner>  ·  :white_circle: To do  ·  :large_orange_circle: High  ·  Due 01/11/2026`,
      `• <${thread("CDEV", "100.2")}|High task>  ·  :white_circle: To do  ·  :large_orange_circle: High  ·  Due 05/11/2026`,
      `• <${thread("CDEV", "100.1")}|Low task>  ·  :white_circle: To do  ·  :large_green_circle: Low  ·  Due 31/10/2026`,
    ].join("\n"),
  );
  assert.equal(
    reviewing.text.text,
    `*Reviewing (1)*\n• <${thread("CDEV", "100.6")}|Review me>  ·  :large_purple_circle: In review  ·  :large_orange_circle: High  ·  Due 31/10/2026`,
  );
  assert.equal(testing.text.text, "*Testing*\n_Nothing assigned._");
});

test("/luma tasks in an external or incidents channel shows that channel's group", async (t) => {
  for (const channel of ["CEXTERNAL", "CINC"]) {
    const { later } = await tasksCommand(t, "tasks", channel, pinsIn({
      CDEV: [historyTask("100.1", { developers: "UACTOR" })],
      CTESTDEV: [historyTask("100.2", { developers: "UACTOR" })],
    }), incidentEnv);
    assert.equal(later.text, "You have 1 open aura300 task.", channel);
  }
});

test("/luma tasks outside every group shows each group in turn", async (t) => {
  const { later } = await tasksCommand(t, "tasks", "CRANDOM", pinsIn({
    CDEV: [historyTask("100.1", { developers: "UACTOR" })],
    CTESTDEV: [historyTask("100.2", { testers: "UACTOR" }), historyTask("100.3", { testers: "UACTOR" })],
  }));
  assert.equal(later.text, "You have 1 open aura300 task. You have 2 open test tasks.");
  assert.deepEqual(
    later.blocks.map((block) => (block.type === "header" ? block.text.text : block.type)),
    ["Your aura300 tasks", "section", "section", "section", "divider", "Your test tasks", "section", "section", "section"],
  );
});

test("/luma tasks with a role shows only that role", async (t) => {
  const pins = pinsIn({
    CDEV: [
      historyTask("100.1", { title: "Build it", developers: "UACTOR" }),
      historyTask("100.2", { title: "Review it", reviewers: "UACTOR" }),
      historyTask("100.3", { title: "Both", developers: "UACTOR", testers: "UACTOR" }),
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

test("/luma tasks with a role and no such tasks says so", async (t) => {
  const { later } = await tasksCommand(t, "tasks review", "CDEV", pinsIn({
    CDEV: [historyTask("100.1", { developers: "UACTOR" })],
  }));
  assert.equal(later.text, "You have no open aura300 reviewing tasks.");
  assert.equal(later.blocks[0].text.text, "Your aura300 tasks: Reviewing");
});

test("/luma tasks with anything else says what it takes", async (t) => {
  // Group names are not taken any more: the channel picks the group.
  for (const word of ["mars", "aura300"]) {
    const { now, calls, later } = await tasksCommand(t, `tasks ${word}`, "CDEV", pinsIn({}));
    assert.deepEqual(JSON.parse(now), {
      response_type: "ephemeral",
      text: `"${word}" is not a role. Use \`/luma tasks\` for all your tasks, or \`/luma tasks development\`, \`review\` or \`testing\` for one role.`,
    });
    assert.equal(calls.length, 0);
    assert.equal(later, undefined);
  }
});
test("someone with no open tasks in the group is told so", async (t) => {
  const { later } = await tasksCommand(t, "tasks", "CDEV", pinsIn({
    CDEV: [historyTask("100.1", { developers: "UBOB" })],
  }));
  assert.equal(later.text, "You have no open aura300 tasks.");
  assert.equal(later.blocks[1].text.text, "You have no open tasks.");
});

test("a pin without the task's details loads the task", async (t) => {
  // As pins.list may return it: the metadata's type without its payload, or
  // no metadata at all.
  for (const pinned of [
    { ts: "100.1", text: "Fix login", metadata: { event_type: "luma_task" } },
    { ts: "100.1", text: "Fix login" },
  ]) {
    const { calls, later } = await tasksCommand(t, "tasks", "CDEV", {
      ...pinsIn({ CDEV: [pinned] }),
      "conversations.replies": { messages: [historyTask("100.1", { testers: "UACTOR" })] },
    });
    const load = calls.find((call) => call.method === "conversations.replies").args;
    assert.equal(load.ts, "100.1");
    assert.equal(load.include_all_metadata, "true");
    assert.equal(later.text, "You have 1 open aura300 task.");
  }
});

test("@LUMA tasks points to /luma tasks", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> tasks"));
  assert.equal(calls[0].args.text, "Use `/luma tasks`.");
});

const PR = "https://github.com/acme/project-helper/pull/42";
const MR = "https://gitlab.com/acme/web/web-app/-/merge_requests/118";

test("@LUMA pr add links pull requests on one line above who tracked it", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}/files> <${MR}|the MR> ${PR}`));

  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.update", "chat.postMessage"]);
  const { blocks, metadata } = calls[1].args;
  // Stored without the /files tab, and only once.
  assert.equal(metadata.event_payload.prs, `${PR},${MR}`);
  assert.equal(blocks[3].text.text, `*PRs:* <${PR}|project-helper/42>, <${MR}|web-app/118>`);
  assert.equal(blocks[4].type, "context");
  assert.match(blocks[4].elements[0].text, /^Tracked by/);
  assert.match(calls[2].args.text, new RegExp(`^<@UACTOR> linked <${PR}\\|project-helper/42>, <${MR}\\|web-app/118> and moved the task to :large_purple_circle: In review\\.\\n`));
});

test("tasks without pull requests show no PRs line", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));
  assert.equal(calls[1].args.blocks.length, 4);
  assert.equal(calls[1].args.blocks[3].type, "context");
});

test("@LUMA pr add skips pull requests already linked", async (t) => {
  const root = rootMessage();
  root.metadata.event_payload.prs = PR;
  let calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}> <${MR}>`));
  assert.equal(calls[1].args.metadata.event_payload.prs, `${PR},${MR}`);
  assert.match(calls[2].args.text, new RegExp(`^<@UACTOR> linked <${MR}\\|web-app/118> and moved the task to :large_purple_circle: In review\\.\\n`));

  calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"]);
  assert.equal(calls[1].args.text, "Those pull requests are already linked to this task.");
});

test("@LUMA pr remove unlinks pull requests", async (t) => {
  const root = rootMessage();
  root.metadata.event_payload.prs = `${PR},${MR}`;
  let calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.equal(calls[1].args.metadata.event_payload.prs, MR);
  assert.equal(calls[1].args.blocks[3].text.text, `*PRs:* <${MR}|web-app/118>`);
  assert.equal(calls[2].args.text, `<@UACTOR> unlinked <${PR}|project-helper/42>.`);

  // Removing the last one removes the PRs line.
  root.metadata.event_payload.prs = PR;
  calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.equal(calls[1].args.metadata.event_payload.prs, "");
  assert.equal(calls[1].args.blocks[3].type, "context");

  calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.equal(calls.at(-1).args.text, "Those pull requests aren't linked to this task.");
});

test("@LUMA pr needs add or remove and a pull request link", async (t) => {
  for (const [text, reply] of [
    [`<@UBOT> pr <${PR}>`, "Use `@LUMA pr add <link>` or `@LUMA pr remove <link>`."],
    ["<@UBOT> pr", "Use `@LUMA pr add <link>` or `@LUMA pr remove <link>`."],
    ["<@UBOT> pr add", "Paste the pull request's link: Use `@LUMA pr add <link>` or `@LUMA pr remove <link>`."],
    [
      "<@UBOT> pr add <https://github.com/acme/project-helper/issues/3>",
      "That's not a pull request link: https://github.com/acme/project-helper/issues/3",
    ],
  ]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"], text);
    assert.equal(calls[0].args.text, reply, text);
  }
});

test("@LUMA pr works in incidents channels but not in external ones", async (t) => {
  let calls = mockSlack(t, threads(incidentRoot(), incidentTask()));
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`, { channel: "CINC" }), {}, incidentEnv);
  assert.equal(calls[1].args.channel, "CINC");
  assert.equal(calls[1].args.metadata.event_payload.prs, PR);

  calls = mockSlack(t);
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`, { channel: "CEXTERNAL" }));
  assert.equal(calls[0].args.text, "Use `@LUMA pr add <link>` in a task thread in <#CDEV>.");
});

test("pull requests on GitHub, GitLab and Bitbucket are read as reponame/number", async () => {
  const { parsePullRequest } = await import("../src/tasks.js");
  assert.deepEqual(parsePullRequest(`${PR}/files`), { url: PR, repo: "project-helper", number: "42" });
  assert.equal(parsePullRequest(MR).repo, "web-app");
  assert.deepEqual(parsePullRequest("https://bitbucket.org/acme/api/pull-requests/7"), {
    url: "https://bitbucket.org/acme/api/pull-requests/7",
    repo: "api",
    number: "7",
  });
  assert.equal(parsePullRequest("https://github.com/acme/project-helper/issues/3"), null);
});

test("linking a PR asks the task's reviewers to review it", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage({ reviewers: "URIA,UREX" })] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.equal(
    calls[2].args.text,
    `<@UACTOR> linked <${PR}|project-helper/42> and moved the task to :large_purple_circle: In review.\n<@URIA>, <@UREX>, please review <${PR}|project-helper/42>.`,
  );
  assert.equal(calls[2].args.blocks, undefined, "no picker");
});

test("linking a PR with no reviewer asks who should review it", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  const prompt = calls[2].args;
  assert.equal(
    prompt.text,
    `<@UACTOR> linked <${PR}|project-helper/42> and moved the task to :large_purple_circle: In review.\nThere's no reviewer yet. Who should review it?`,
  );
  const block = prompt.blocks[0];
  assert.equal(block.accessory.type, "multi_users_select");
  assert.equal(block.accessory.action_id, "pr:reviewers");
  assert.deepEqual(JSON.parse(block.block_id), [PR]);
});

test("choosing reviewers assigns them and asks them to review", async (t) => {
  const root = rootMessage();
  root.metadata.event_payload.prs = PR;
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
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
    ["conversations.replies", "100.1"],
    ["chat.update", "100.1"],
    ["chat.update", "100.8"],
  ]);
  assert.equal(calls[1].args.metadata.event_payload.reviewers, "URIA");
  assert.equal(
    calls[2].args.text,
    // Just the request; whoever chose sees the picker become it.
    `<@URIA>, please review <${PR}|project-helper/42>.`,
  );
  assert.equal(calls[2].args.blocks.length, 1, "the picker is gone");
});

test("assigning a reviewer once a PR is linked asks them to review it", async (t) => {
  const root = rootMessage();
  root.metadata.event_payload.prs = `${PR},${MR}`;
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA>"));
  assert.equal(calls[1].args.metadata.event_payload.reviewers, "URIA");
  assert.equal(
    calls[2].args.text,
    `<@URIA>, please review <${PR}|project-helper/42>, <${MR}|web-app/118>.`,
  );
});

test("reviewers added before a PR are not named, so not notified", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA> <@UREX>"));
  const reply = calls[2].args.text;
  assert.equal(reply, "<@UACTOR> added 2 reviewers. They'll be asked to review when a PR is linked.");
  assert.ok(!reply.includes("URIA") && !reply.includes("UREX"));
});

// A plain (non-command) reply in the task's thread, as UACTOR.
const threadReply = (text, overrides = {}) => threadEvent(text, overrides);

// Clicks a button on Luma's private "link these PRs?" question.
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
      sent.push(JSON.parse(init.body));
      return new Response("ok");
    }
    return fakeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = fakeFetch;
  });
  return sent;
}

test("pull requests pasted into a task's thread are offered for linking, privately", async (t) => {
  const root = rootMessage();
  root.metadata.event_payload.prs = MR;
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadReply(`Fixed in <${PR}> and <${MR}>, see <https://example.com/doc>`));

  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postEphemeral"]);
  const question = calls[1].args;
  assert.equal(question.user, "UACTOR");
  assert.equal(question.thread_ts, "100.1");
  // Only the PR that isn't linked yet is offered.
  assert.equal(question.text, `You posted <${PR}|project-helper/42>. Link it to this task?`);
  const [link, skip] = question.blocks[1].elements;
  assert.equal(link.text.text, "Link PR");
  assert.equal(link.action_id, "pr:suggest-link");
  assert.equal(skip.text.text, "Not now");
  assert.deepEqual(JSON.parse(link.value), { channel: "CDEV", ts: "100.1", mentioned: [], urls: [PR], reviewers: [] });
});

test("messages without unlinked pull requests are left alone", async (t) => {
  const linked = rootMessage();
  linked.metadata.event_payload.prs = PR;
  for (const [text, overrides, root] of [
    ["Looks good, no links here", {}, rootMessage()],
    [`Already linked <${PR}>`, {}, linked],
    // Not in a thread, not in a team channel, or not a task's thread.
    [`See <${PR}>`, { thread_ts: undefined }, rootMessage()],
    [`See <${PR}>`, { channel: "CEXTERNAL" }, rootMessage()],
    [`See <${PR}>`, {}, { ts: "100.1" }],
    // Luma's own messages and edits.
    [`See <${PR}>`, { bot_id: "BLUMA" }, rootMessage()],
    [`See <${PR}>`, { subtype: "message_changed" }, rootMessage()],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${JSON.stringify(overrides)}`);
  }
});

test("@LUMA pr add is a command, not a suggestion", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage({ reviewers: "URIA" })] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("Link PRs links them, posts only what is new and removes the question", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage({ reviewers: "URIA" })] } });
  const sent = recordResponses(t);
  const response = await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.equal(response.status, 200);

  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.update", "chat.postMessage"]);
  assert.equal(calls[1].args.metadata.event_payload.prs, PR);
  assert.equal(calls[2].args.thread_ts, "100.1");
  // No "linked" line: whoever clicked posted the link. The thread hears the
  // status change, and the reviewer the message didn't mention is asked.
  assert.equal(
    calls[2].args.text,
    `<@UACTOR> moved the task to :large_purple_circle: In review.\n<@URIA>, please review <${PR}|project-helper/42>.`,
  );
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Link PRs on a task with no reviewer asks who should review", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.blocks[0].accessory.action_id, "pr:reviewers");
});

test("Link PRs after someone else linked them just removes the question", async (t) => {
  const root = rootMessage();
  root.metadata.event_payload.prs = PR;
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  const sent = recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies"]);
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
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage({ reviewers: "URIA" })] } });
  // URIA is already a reviewer and Luma is not a person to add.
  await send("/slack/events", threadReply(`<@UREX> <@URIA> <@UBOT> can you look at <${PR}>?`));

  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(
    question.text,
    `You posted <${PR}|project-helper/42> and mentioned <@UREX>. Link it to this task and add <@UREX> as reviewer?`,
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
  const root = rootMessage();
  root.metadata.event_payload.prs = PR;
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadReply(`<@UREX> <@URIA> please look at <${PR}>`));

  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.text, `Add <@UREX>, <@URIA> as reviewers of <${PR}|project-helper/42>?`);
  const [add, skip] = question.blocks[1].elements;
  assert.equal(add.text.text, "Add reviewers");
  assert.equal(add.value, suggestionValue({ mentioned: ["UREX", "URIA"], reviewers: ["UREX", "URIA"] }));
  assert.equal(skip.text.text, "Not now");
});

test("mentions without a PR link are not offered as reviewers", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadReply("<@UREX> can you help with this?"));
  assert.equal(calls.length, 0);
});

test("Link and add reviewer asks only the reviewers the message did not mention", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage({ reviewers: "URIA" })] } });
  const sent = recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ mentioned: ["UREX"], urls: [PR], reviewers: ["UREX"] })));

  const update = calls.find((call) => call.method === "chat.update").args;
  assert.equal(update.metadata.event_payload.reviewers, "URIA,UREX");
  assert.equal(update.metadata.event_payload.prs, PR);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  // UREX was mentioned in the message, so only URIA is asked.
  assert.equal(
    post.text,
    `<@UACTOR> moved the task to :large_purple_circle: In review.\n<@URIA>, please review <${PR}|project-helper/42>.`,
  );
  assert.equal(sent.length, 1);
});

test("Add reviewers on an already linked PR adds them and posts nothing", async (t) => {
  const root = rootMessage();
  root.metadata.event_payload.prs = PR;
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  const sent = recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ mentioned: ["UREX"], reviewers: ["UREX"] })));

  const update = calls.find((call) => call.method === "chat.update").args;
  assert.equal(update.metadata.event_payload.reviewers, "UREX");
  // The message already asked UREX; the card shows them as reviewer.
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.equal(sent.length, 1);
});

test("Just link leaves the mentioned people out", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage({ reviewers: "URIA" })] } });
  recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ urls: [PR] })));
  const update = calls.find((call) => call.method === "chat.update").args;
  assert.equal(update.metadata.event_payload.reviewers, "URIA");
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
    const calls = mockSlack(t, { "conversations.replies": { messages: [withStatus(from)] } });
    await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
    assert.equal(calls[1].args.metadata.event_payload.status, to, from);
    const said = calls[2].args.text.includes("moved the task to :large_purple_circle: In review");
    assert.equal(said, moved, from);
    // Pins only change with Done, so none here.
    assert.ok(!calls.some((call) => call.method.startsWith("pins.")), from);
  }
});

test("removing a PR leaves the status alone", async (t) => {
  const root = withStatus("IN_REVIEW");
  root.metadata.event_payload.prs = PR;
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.equal(calls[1].args.metadata.event_payload.status, "IN_REVIEW");
});

const assignValue = (role, people, moveTo = null) =>
  JSON.stringify({ channel: "CDEV", ts: "100.1", role, people, moveTo });

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
    ["<@UREX> can you look into this?", "developer", "developer", "work on this"],
    ["<@UREX> Could you pick this up", "developer", "developer", "work on this"],
    ["<@UREX> please review this fix", "reviewer", "reviewer", "review this"],
  ]) {
    // In review already, so only the assignment is offered.
    const calls = mockSlack(t, { "conversations.replies": { messages: [withStatus("IN_REVIEW")] } });
    await send("/slack/events", threadReply(text));
    const question = calls.find((call) => call.method === "chat.postEphemeral")?.args;
    assert.ok(question, text);
    assert.equal(question.user, "UACTOR");
    assert.equal(question.thread_ts, "100.1");
    assert.equal(question.text, `You asked <@UREX> to ${asked}. Assign them as ${label}?`, text);
    const [assign, skip] = question.blocks[1].elements;
    assert.equal(assign.text.text, `Assign as ${label}`, text);
    assert.equal(assign.value, assignValue(role, ["UREX"]), text);
    assert.equal(skip.text.text, "Not now");
  }
});

test("hand-offs leave alone people already in the role, Luma and plain chat", async (t) => {
  for (const [text, root] of [
    ["<@UREX> please start working on this", (() => {
      const root = withStatus("IN_PROGRESS");
      root.metadata.event_payload.developers = "UREX";
      return root;
    })()],
    ["<@UBOT> please look into this", rootMessage()],
    ["<@UREX> thanks, looks great", rootMessage()],
    ["please start working on this", rootMessage()],
    ["<@UREX> please look into this", { ts: "100.1" }],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
    await send("/slack/events", threadReply(text));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), text);
  }
  // In an external thread that isn't a requirement, nothing is offered.
  const calls = mockSlack(t, { "conversations.replies": { messages: [{ ts: "100.1" }] } });
  await send("/slack/events", threadReply("<@UREX> please look into this", { channel: "CEXTERNAL" }));
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies"]);
});

test("a message with a PR link gets the PR question, not a hand-off one", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadReply(`<@UREX> please review <${PR}>`));
  const questions = calls.filter((call) => call.method === "chat.postEphemeral");
  assert.equal(questions.length, 1);
  assert.equal(questions[0].args.blocks[1].elements[0].action_id, "pr:suggest-link");
});

test("Assign as developer adds them and posts nothing", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage({ developers: "UALICE" })] } });
  const sent = recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("developer", ["UREX", "UBOB"])));

  const update = calls.find((call) => call.method === "chat.update").args;
  assert.equal(update.metadata.event_payload.developers, "UALICE,UREX,UBOB");
  // The card shows them; the thread hears nothing more.
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Assign as reviewer posts nothing, PR or not", async (t) => {
  for (const prs of ["", PR]) {
    const root = rootMessage();
    root.metadata.event_payload.prs = prs;
    const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
    recordResponses(t);
    await send("/slack/interactions", clickAssign("assign:suggest", assignValue("reviewer", ["UREX"])));
    assert.equal(calls.find((call) => call.method === "chat.update").args.metadata.event_payload.reviewers, "UREX");
    // The message that asked them to review was the request.
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"), prs || "no PR");
  }
});

test("Assign after they were assigned anyway, or Not now, just removes the question", async (t) => {
  for (const [actionId, root] of [
    ["assign:suggest", rootMessage({ developers: "UREX" })],
    ["assign:suggest-skip", rootMessage()],
  ]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
    const sent = recordResponses(t);
    await send("/slack/interactions", clickAssign(actionId, assignValue("developer", ["UREX"])));
    assert.ok(!calls.some((call) => ["chat.update", "chat.postMessage"].includes(call.method)), actionId);
    assert.equal(sent.length, 1, actionId);
  }
});

test("Just link works like the other link button", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage({ reviewers: "URIA" })] } });
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
  const update = calls.find((call) => call.method === "chat.update").args;
  assert.equal(update.metadata.event_payload.prs, PR);
  assert.equal(update.metadata.event_payload.reviewers, "URIA");
});

test("handing a task to testing offers to assign the tester and move it to In testing", async (t) => {
  for (const text of ["<@UTESS> please test it on staging", "<@UTESS> can you QA this"]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
    await send("/slack/events", threadReply(text));
    const question = calls.find((call) => call.method === "chat.postEphemeral").args;
    assert.equal(
      question.text,
      "You asked <@UTESS> to test this. Assign them as tester and move the task to :large_orange_circle: In testing?",
      text,
    );
    const [assign] = question.blocks[1].elements;
    assert.equal(assign.text.text, "Assign and move to In testing");
    assert.equal(assign.value, assignValue("tester", ["UTESS"], "IN_TESTING"));
  }
});

test("a tester assigned ahead of time is offered just the move to In testing", async (t) => {
  const root = withStatus("IN_REVIEW");
  root.metadata.event_payload.testers = "UTESS";
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadReply("<@UTESS> ready for testing"));
  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.text, "You asked <@UTESS> to test this. Move the task to :large_orange_circle: In testing?");
  const [move] = question.blocks[1].elements;
  assert.equal(move.text.text, "Move to In testing");
  assert.equal(move.value, assignValue("tester", [], "IN_TESTING"));
});

test("a testing hand-off once testing has started only offers the assignment", async (t) => {
  for (const status of ["IN_TESTING", "CLIENT_REVIEW", "DONE"]) {
    let calls = mockSlack(t, { "conversations.replies": { messages: [withStatus(status)] } });
    await send("/slack/events", threadReply("<@UTESS> please test this"));
    const question = calls.find((call) => call.method === "chat.postEphemeral").args;
    assert.equal(question.text, "You asked <@UTESS> to test this. Assign them as tester?", status);
    assert.equal(question.blocks[1].elements[0].value, assignValue("tester", ["UTESS"]));

    // With the tester already there, there's nothing to ask.
    const root = withStatus(status);
    root.metadata.event_payload.testers = "UTESS";
    calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
    await send("/slack/events", threadReply("<@UTESS> please test this"));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), status);
  }
});

test("Assign and move to In testing assigns the tester and moves the task", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("IN_REVIEW")));
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("tester", ["UTESS"], "IN_TESTING")));

  const task = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.1").args;
  assert.equal(task.metadata.event_payload.testers, "UTESS");
  assert.equal(task.metadata.event_payload.status, "IN_TESTING");
  // The client still sees In progress.
  const requirement = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1");
  assert.equal(requirement?.args.metadata.event_payload.status ?? "IN_PROGRESS", "IN_PROGRESS");
  assert.ok(!calls.some((call) => call.method.startsWith("pins.")));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.text, "<@UACTOR> moved the task to :large_orange_circle: In testing.");
});

test("Move to In testing moves a task whose tester was assigned ahead of time", async (t) => {
  const root = withStatus("IN_PROGRESS");
  root.metadata.event_payload.testers = "UTESS";
  const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("tester", [], "IN_TESTING")));
  const task = calls.find((call) => call.method === "chat.update").args;
  assert.equal(task.metadata.event_payload.status, "IN_TESTING");
  assert.equal(task.metadata.event_payload.testers, "UTESS");
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UACTOR> moved the task to :large_orange_circle: In testing.",
  );
});

test("a task that moved on before the click is not moved back to testing", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [withStatus("CLIENT_REVIEW")] } });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("tester", ["UTESS"], "IN_TESTING")));
  const task = calls.find((call) => call.method === "chat.update").args;
  assert.equal(task.metadata.event_payload.status, "CLIENT_REVIEW");
  assert.equal(calls.find((call) => call.method === "chat.update").args.metadata.event_payload.testers, "UTESS");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("@LUMA assign tester never changes the status", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [withStatus("IN_PROGRESS")] } });
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UTESS>"));
  assert.equal(calls[1].args.metadata.event_payload.status, "IN_PROGRESS");
  assert.equal(calls[1].args.metadata.event_payload.testers, "UTESS");
});

test("handing a To do task to a developer offers to move it to In progress", async (t) => {
  // A new developer: assign and move.
  let calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadReply("<@UREX> please start working on this"));
  let question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(
    question.text,
    "You asked <@UREX> to work on this. Assign them as developer and move the task to :large_blue_circle: In progress?",
  );
  assert.equal(question.blocks[1].elements[0].text.text, "Assign and move to In progress");
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", ["UREX"], "IN_PROGRESS"));

  // Assigned ahead of time: just the move.
  calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage({ developers: "UREX" })] } });
  await send("/slack/events", threadReply("<@UREX> you can start working on this now"));
  question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.text, "You asked <@UREX> to work on this. Move the task to :large_blue_circle: In progress?");
  assert.equal(question.blocks[1].elements[0].text.text, "Move to In progress");
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", [], "IN_PROGRESS"));
});

test("a developer hand-off once work has started only offers the assignment", async (t) => {
  for (const status of ["IN_PROGRESS", "IN_REVIEW", "IN_TESTING", "DONE"]) {
    const calls = mockSlack(t, { "conversations.replies": { messages: [withStatus(status)] } });
    await send("/slack/events", threadReply("<@UREX> please look into this"));
    const question = calls.find((call) => call.method === "chat.postEphemeral").args;
    assert.equal(question.text, "You asked <@UREX> to work on this. Assign them as developer?", status);
  }
});

test("Assign and move to In progress assigns the developer and moves the task", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("developer", ["UREX"], "IN_PROGRESS")));
  const task = calls.find((call) => call.method === "chat.update").args;
  assert.equal(task.metadata.event_payload.developers, "UREX");
  assert.equal(task.metadata.event_payload.status, "IN_PROGRESS");
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UACTOR> moved the task to :large_blue_circle: In progress.",
  );
});

test("a task started before the click is not moved again", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [withStatus("IN_REVIEW")] } });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("developer", ["UREX"], "IN_PROGRESS")));
  assert.equal(calls.find((call) => call.method === "chat.update").args.metadata.event_payload.status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("@LUMA assign developer never changes the status", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [rootMessage()] } });
  await send("/slack/events", threadEvent("<@UBOT> assign developer <@UREX>"));
  assert.equal(calls[1].args.metadata.event_payload.status, "TODO");
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
      "<@UACTOR> marked this as :white_check_mark: Done.",
      from,
    );
    assert.equal(post.blocks.length, 1, "no buttons");
    // The command gets a ✅, and a note that the requirement thread was told.
    assert.ok(calls.some((call) => call.method === "reactions.add"), from);
    assert.equal(calls.at(-1).args.channel, "CDEV", from);
    assert.equal(calls.at(-1).args.text, "Luma told <https://slack.example/source|the requirement thread> it's :white_check_mark: Done.", from);
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
  const calls = mockSlack(t, { "conversations.replies": { messages: [withStatus("IN_REVIEW")] } });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.text, `There's no reviewer yet. Who should review <${PR}|project-helper/42>?`);
  assert.equal(post.blocks[0].accessory.action_id, "pr:reviewers");
});

// A message in the requirement thread at 200.1, as UACTOR.
const requirementReply = (text) => threadEvent(text, { channel: "CEXTERNAL", ts: "200.5", thread_ts: "200.1" });

test("asking a developer to start from an untracked requirement offers to track and assign", async (t) => {
  const calls = mockSlack(t, { "conversations.replies": { messages: [requirementRoot()] } });
  await send("/slack/events", requirementReply("<@UREX> can you start working on this?"));

  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.channel, "CEXTERNAL");
  assert.equal(question.thread_ts, "200.1");
  assert.equal(question.user, "UACTOR");
  assert.equal(question.text, "You asked <@UREX> to work on this. Track it as a task and assign them as developer?");
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
    const calls = mockSlack(t, { "conversations.replies": { messages: [requirementRoot()] } });
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
  const calls = mockSlack(t, { ...createdTask, "conversations.replies": { messages: [requirementRoot()] } });
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
  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV").args;
  assert.equal(post.metadata.event_payload.developers, "UREX");
  assert.equal(post.metadata.event_payload.status, "IN_PROGRESS");
  // The requirement shows In progress and links to the task.
  const requirement = calls.find((call) => call.method === "chat.update" && call.args.ts === "200.1").args;
  assert.equal(requirement.metadata.event_payload.status, "IN_PROGRESS");
  assert.equal(requirement.metadata.event_payload.task_ts, "100.1");
});

test("asking a developer to start on a tracked requirement offers to assign them to its task", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("TODO")));
  await send("/slack/events", requirementReply("<@UREX> please start working on this"));

  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.thread_ts, "200.1");
  assert.equal(
    question.text,
    "You asked <@UREX> to work on this. Assign them as developer of <https://slack.example/p100|Fix login> and move the task to :large_blue_circle: In progress?",
  );
  // The button changes the task in the dev channel.
  assert.equal(question.blocks[1].elements[0].value, assignValue("developer", ["UREX"], "IN_PROGRESS"));
});

test("a task tracked with Track and assign is announced in the requirement thread", async (t) => {
  const calls = mockSlack(t, { ...createdTask, "conversations.replies": { messages: [requirementRoot()] } });
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
  assert.equal(post.text, "<@UCREATOR> tracked this as a task: <https://slack.example/p100|Export reports>");
});

test("a reported incident is not announced as tracked", async (t) => {
  const calls = mockSlack(t, {
    "chat.postMessage": (args) => (args.channel === "CINC" ? { channel: "CINC", ts: "100.1" } : { ts: "200.1" }),
    "conversations.replies": { messages: [incidentRoot({ task: false })] },
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
  const calls = mockSlack(t, { "conversations.replies": { messages: [ownTask()] } });
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
  assert.equal(calls.at(-1).args.text, "<@UPICKER> set the status to :large_purple_circle: In review.");
});

test("other typed statuses get only the ✅", async (t) => {
  const calls = mockSlack(t, threads(requirementRoot({ task: true }), requirementTask("TODO")));
  await send("/slack/events", threadEvent("<@UBOT> status in review"));
  assert.equal(calls.at(-1).method, "reactions.add");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("Client review lists the task's PRs for the client, and keeps them after a decision", async (t) => {
  const task = requirementTask("IN_TESTING");
  task.metadata.event_payload.prs = `${PR},${MR}`;
  const calls = mockSlack(t, {
    ...threads(requirementRoot({ task: true }), task),
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  await send("/slack/events", threadEvent("<@UBOT> status client review"));

  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CEXTERNAL").args;
  const announced = [
    "<@UACTOR> marked this as ready to review.",
    `*PRs:* <${PR}|project-helper/42>, <${MR}|web-app/118>`,
  ].join("\n");
  assert.equal(
    review.blocks[0].text.text,
    `${announced}\n<@UCREATOR>, please review it and approve it, or say what needs to change.`,
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
    "conversations.replies": (args) => {
      if (args.limit === "1") return { messages: [args.ts === "200.1" ? requirementRoot({ task: true }) : requirementTask()] };
      return { messages: [{ ts: args.ts, bot_id: "BLUMA" }, { ts: `${args.ts.split(".")[0]}.3`, bot_id: "BLUMA" }] };
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
  for (const [root, environment, channel, text] of [
    [requirementTask(), env, "CDEV", "This task belongs to a requirement. Remove it from <https://slack.example/source|its thread> with `@LUMA remove`, which removes both."],
    [incidentTask(), incidentEnv, "CINC", "This task belongs to an incident. Remove it from <https://slack.example/source|its thread> with `@LUMA remove`, which removes both."],
  ]) {
    if (channel === "CINC") root.metadata.event_payload.source_incident = "true";
    const calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
    await send("/slack/events", threadEvent("<@UBOT> remove", { channel }), {}, environment);
    assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postMessage"], channel);
    assert.equal(calls[1].args.text, text);
  }
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
    "<@UACTOR> marked this as ready to review.\n<@UCREATOR>, please review it and approve it, or say what needs to change.",
  );
  assert.ok(!review.text.includes("slack.example/p100"));
  // No link to look up for it.
  assert.ok(!calls.some((call) => call.method === "chat.getPermalink" && call.args.channel === "CDEV"));
});
