// Intents are plain messages, not commands, that Cade acts on: "@rex please
// look into this", or a pasted pull request link. Handlers declare theirs as
// `intents` (see registry.js), each made with `intent`:
//
//   intent({
//     name,                   // for logs, such as "hand-off:tester"
//     order,                  // lower is checked first; the first match wins
//     phrases,                // words that signal it, or…
//     match(message),         // …a test of the message, true when it matches
//     needs: { thread, mention },  // true to only match in a thread, or
//                                  // only when someone is mentioned
//     handle(message, context),    // what to do, in the background
//   })
//
// Phrases match whole words, case aside: "work on" doesn't match "work
// only". A phrase ending in "*" matches the start of a word: "test*" matches
// "test", "tested" and "testing". Phrases are regular expressions, so "(this|it)"
// works too. Intents should only ever ask, privately, before changing
// anything, since a phrase can match a message that didn't mean it.

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

export function intent({ phrases, match, needs = {}, ...rest }) {
  if (!phrases === !match) throw new Error(`Intent ${rest.name} needs either phrases or match.`);
  const test = match ?? phraseTest(phrases);
  return { ...rest, needs, test };
}

function phraseTest(phrases) {
  const pattern = new RegExp(
    phrases.map((phrase) => (phrase.endsWith("*") ? `\\b(?:${phrase.slice(0, -1)})` : `\\b(?:${phrase})\\b`)).join("|"),
    "i",
  );
  return (message) => pattern.test(message.text);
}

// A message as intents see it, or null for messages Cade never acts on:
// edits, deletions and bot posts (its own included).
//   text, user, channel, ts, threadTs
//   inThread   whether it's a reply in a thread
//   mentions   the people it mentions, Cade aside
//   botUserId  Cade's own user ID
export function plainMessage(event, botUserId) {
  if (event.subtype || event.bot_id || !event.text) return null;
  const mentions = [...new Set([...event.text.matchAll(USER_MENTION)].map(([, id]) => id))].filter(
    (id) => id !== botUserId,
  );
  return {
    text: event.text,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    inThread: Boolean(event.thread_ts) && event.thread_ts !== event.ts,
    mentions,
    botUserId,
  };
}

// The first intent, by order, that matches the message, or undefined.
export function findIntent(intents, message) {
  return [...intents]
    .sort((a, b) => a.order - b.order)
    .find(
      (candidate) =>
        (!candidate.needs.thread || message.inThread) &&
        (!candidate.needs.mention || message.mentions.length) &&
        candidate.test(message),
    );
}
