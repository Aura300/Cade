// Slack rejects requests whose signature timestamp is older than five minutes,
// which stops captured requests from being replayed later.
const SIGNATURE_MAX_AGE_SECONDS = 60 * 5;

const encoder = new TextEncoder();

export async function verifySlackRequest(request, body, signingSecret) {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature") ?? "";
  const match = /^v0=([0-9a-f]{64})$/.exec(signature);
  if (!timestamp || !match) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const expected = new Uint8Array(
    match[1].match(/../g).map((byte) => parseInt(byte, 16)),
  );
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    encoder.encode(`v0:${timestamp}:${body}`),
  );
}

// Luma's messages link to other messages, such as "tracked a task: <link>".
// Slack would preview each link as a copy of the linked message, repeating
// the task card, so previews are turned off for everything Luma posts.
const NO_PREVIEWS = { unfurl_links: false, unfurl_media: false };
const POSTING_METHODS = ["chat.postMessage", "chat.update"];

// Read methods such as conversations.replies do not accept JSON bodies, so
// every call is form-encoded with object arguments sent as JSON strings.
export async function callSlack(env, method, args) {
  if (!env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is not configured");
  }

  const form = new URLSearchParams();
  const fields = POSTING_METHODS.includes(method) ? { ...NO_PREVIEWS, ...args } : args;
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    form.set(name, typeof value === "string" ? value : JSON.stringify(value));
  }

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Slack ${method} returned HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack ${method} failed: ${data.error}`);
  }
  return data;
}

export function escapeSlack(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Answers a slash command after the fact, through the response_url Slack
// sent with it, which works for 30 minutes. An ephemeral answer is shown only
// to the person who sent the command.
export async function respondLater(responseUrl, body) {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", ...body }),
  });
  if (!response.ok) throw new Error(`Slack response_url returned HTTP ${response.status}`);
}

// Replies are either plain text or a message body such as { text, blocks }.
export function messageBody(reply) {
  return typeof reply === "string" ? { text: reply } : reply;
}

export function plainText(text) {
  return { type: "plain_text", text };
}

export function mrkdwn(text) {
  return { type: "mrkdwn", text };
}

export function mentions(users) {
  return users.map((id) => `<@${id}>`).join(", ");
}
