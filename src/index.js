import { dispatch, dispatchSlash } from "./commands/dispatch.js";
import { parseMessage, parseSlashCommand } from "./commands/parse.js";
import { actions, intents, reactions, shortcuts, views } from "./commands/registry.js";
import { findIntent, intentsOn, plainMessage } from "./intents.js";
import { retryUnposted } from "./retry.js";
import { callSlack, messageBody, verifySlackRequest } from "./slack.js";

const ROUTES = {
  "/slack/events": handleEvent,
  "/slack/interactions": handleInteraction,
  "/slack/commands": handleSlashCommand,
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

  // The cron in wrangler.toml: posts tasks and requirements Slack refused.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(retryUnposted(env));
  },
};

// Messages in channels Cade is in: commands such as `@Cade assign @person` are
// run in the background and answered in the message's thread.
async function handleEvent(body, request, context) {
  const envelope = JSON.parse(body);
  if (envelope.type === "url_verification") {
    return Response.json({ challenge: envelope.challenge });
  }
  // Events are acknowledged before they are processed, so a retry means the
  // first delivery is already being handled.
  if (request.headers.has("x-slack-retry-num")) return respond();
  if (envelope.type !== "event_callback") return respond();
  const botUserId = envelope.authorizations?.[0]?.user_id;

  // An emoji added to a message can ask Cade to do something with it (see
  // the handlers' `reactions`). Cade's own reactions never do.
  if (envelope.event.type === "reaction_added") {
    const { event } = envelope;
    if (event.item?.type === "message" && event.user !== botUserId) {
      for (const handle of reactions) context.waitUntil(handle(event, context));
    }
    return respond();
  }
  if (envelope.event.type !== "message") return respond();

  const command = parseMessage(envelope.event, botUserId);
  if (command) {
    context.waitUntil(
      (async () => {
        const reply = await dispatch(command, context);
        if (!reply) return;
        const post = (body) =>
          callSlack(context.env, "chat.postMessage", {
            channel: command.channel,
            thread_ts: command.threadTs ?? command.ts,
            ...messageBody(body),
          });
        // An acknowledgement (see acknowledge) reacts to the command instead.
        if (reply.reaction) {
          await callSlack(context.env, "reactions.add", {
            channel: command.channel,
            timestamp: command.ts,
            name: reply.reaction,
          });
          if (reply.note) await post(reply.note);
          return;
        }
        await post(reply);
      })(),
    );
  } else {
    // Plain messages can still mean something: see intents.js.
    const message = plainMessage(envelope.event, botUserId);
    // Kinds turned off in `suggestions` aren't considered (see suggesting).
    const meant = message && findIntent(intentsOn(context.env, intents), message);
    if (meant) context.waitUntil(meant.handle(message, context));
  }
  return respond();
}

// `/cade name …` slash commands. They run before Slack is answered, so that a
// modal can be opened with the command's trigger_id, which expires after
// three seconds. Replies are shown only to the person who sent the command.
async function handleSlashCommand(body, request, context) {
  const command = parseSlashCommand(new URLSearchParams(body));
  const reply = await dispatchSlash(command, context);
  return respond(reply && { response_type: "ephemeral", ...messageBody(reply) });
}

// Modal submissions, button clicks and message shortcuts (Cade's items in a
// message's ⋯ → More actions) go to the handler that registered the modal's
// callback_id, the button's action_id or the shortcut's callback_id.
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
  } else if (payload.type === "message_action") {
    id = payload.callback_id;
    handler = shortcuts[id];
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
