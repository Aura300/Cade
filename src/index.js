import { dispatch } from "./commands/dispatch.js";
import { parseMessage, parseSlashCommand } from "./commands/parse.js";
import { actions, views } from "./commands/registry.js";
import { callSlack, ephemeral, messageBody, verifySlackRequest } from "./slack.js";

const ROUTES = {
  "/slack/commands": handleSlashCommand,
  "/slack/events": handleEvent,
  "/slack/interactions": handleInteraction,
};

export default {
  async fetch(request, env, ctx) {
    const route = ROUTES[new URL(request.url).pathname];
    if (!route) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!env.SLACK_SIGNING_SECRET) {
      throw new Error("SLACK_SIGNING_SECRET is not configured");
    }

    const body = await request.text();
    if (!(await verifySlackRequest(request, body, env.SLACK_SIGNING_SECRET))) {
      console.warn("Rejected request with an invalid Slack signature");
      return new Response("Invalid signature", { status: 401 });
    }

    // Slack expects an answer within three seconds, so slow work is handed to
    // waitUntil and runs after the response has been sent.
    const context = {
      env,
      waitUntil: (promise) =>
        ctx.waitUntil(
          promise.catch((error) =>
            console.error("Background task failed", { error: error.message }),
          ),
        ),
    };
    return route(body, request, context);
  },
};

// `/luma <command>`: the reply is shown only to the person who ran it.
async function handleSlashCommand(body, request, context) {
  const command = parseSlashCommand(Object.fromEntries(new URLSearchParams(body)));
  const reply = await dispatch(command, context);
  return respond(reply && ephemeral(reply));
}

// Messages in channels Luma is in: commands such as `luma assign @person` are
// run in the background and answered in the message's thread.
async function handleEvent(body, request, context) {
  const envelope = JSON.parse(body);
  if (envelope.type === "url_verification") {
    return Response.json({ challenge: envelope.challenge });
  }
  // Events are acknowledged before they are processed, so a retry means the
  // first delivery is already being handled.
  if (request.headers.has("x-slack-retry-num")) return respond();
  if (envelope.type !== "event_callback" || envelope.event.type !== "message") {
    return respond();
  }

  const botUserId = envelope.authorizations?.[0]?.user_id;
  const command = parseMessage(envelope.event, botUserId);
  if (command) {
    context.waitUntil(
      (async () => {
        const reply = await dispatch(command, context);
        if (!reply) return;
        await callSlack(context.env, "chat.postMessage", {
          channel: command.channel,
          thread_ts: command.threadTs ?? command.ts,
          ...messageBody(reply),
        });
      })(),
    );
  }
  return respond();
}

// Modal submissions and button clicks go to the handler that registered the
// modal's callback_id or the button's action_id.
async function handleInteraction(body, request, context) {
  const payload = JSON.parse(new URLSearchParams(body).get("payload"));
  let id;
  let handler;
  if (payload.type === "view_submission") {
    id = payload.view.callback_id;
    handler = views[id];
  } else if (payload.type === "block_actions") {
    id = payload.actions?.[0]?.action_id;
    handler = actions[id];
  } else {
    return respond();
  }

  if (!handler) {
    console.warn("No handler for interaction", { type: payload.type, id });
    return respond();
  }
  return respond(await handler(payload, context));
}

function respond(result) {
  return result ? Response.json(result) : new Response(null, { status: 200 });
}
