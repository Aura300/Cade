// Intents are plain messages, not commands, that Cade acts on: "@rex please
// look into this", or a pasted pull request link. Handlers declare theirs as
// `intents` (see registry.js), each made with `intent`:
//
//   intent({
//     name,                   // for logs, such as "pr-link"
//     kinds,                  // the `taskStatusChangeDetection` kinds it serves (see
//                             // SUGGESTION_KINDS); off when all are off.
//                             // None: always on, whatever `taskStatusChangeDetection` says
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

import { groupSetting } from "./channels.js";

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

export function intent({ phrases, match, needs = {}, kinds = [], ...rest }) {
  if (!phrases === !match) throw new Error(`Intent ${rest.name} needs either phrases or match.`);
  if (!kinds.every((kind) => SUGGESTION_KINDS.includes(kind))) throw new Error(`Intent ${rest.name} has an unknown kind.`);
  const test = match ?? phraseTest(phrases);
  return { ...rest, needs, kinds, test };
}

export function phraseTest(phrases) {
  const pattern = new RegExp(
    phrases.map((phrase) => (phrase.endsWith("*") ? `\\b(?:${phrase.slice(0, -1)})` : `\\b(?:${phrase})\\b`)).join("|"),
    "i",
  );
  return (message) => pattern.test(message.text);
}

// Whether a message asks rather than tells, such as "have you started on
// this?" or "is it done?": intents that report progress leave those alone.
export function isQuestion(message) {
  return /\?\s*$/.test(message.text);
}

// A message as intents see it, or null for messages Cade never acts on:
// edits, deletions and bot posts (its own included). A reply also sent to the
// channel ("Also send to #channel") is still a reply.
//   text, user, channel, ts, threadTs
//   inThread   whether it's a reply in a thread
//   mentions   the people it mentions, Cade aside
//   botUserId  Cade's own user ID
export function plainMessage(event, botUserId) {
  if ((event.subtype && event.subtype !== "thread_broadcast") || event.bot_id || !event.text) return null;
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

// The kinds of suggestion, as `taskStatusChangeDetection` in cade.config.json names them
// (TASK_STATUS_CHANGE_DETECTION): the proactive agent, reading messages in the threads Cade
// manages. Asking where a message posted on its own in a channel belongs
// isn't one of them, so it stays on with commands (see move.js).
export const SUGGESTION_KINDS = ["pr-links", "hand-offs", "started", "progress", "details"];

// Whether the suggestion kind `kind` is turned on in `channel`'s group: all
// are, unless its `taskStatusChangeDetection`, or else TASK_STATUS_CHANGE_DETECTION for every group, is
// false (none) or lists the kinds that are.
export function suggesting(env, kind, channel) {
  let kinds = groupSetting(env, channel, "taskStatusChangeDetection");
  if (kinds === undefined) {
    try {
      kinds = env.TASK_STATUS_CHANGE_DETECTION === undefined ? true : JSON.parse(env.TASK_STATUS_CHANGE_DETECTION);
    } catch {
      return true;
    }
  }
  if (kinds === true) return true;
  return Array.isArray(kinds) && kinds.includes(kind);
}

// The intents with a kind turned on in `channel`'s group, and those with no
// kind, which always are.
export function intentsOn(env, intents, channel) {
  return intents.filter((candidate) => !candidate.kinds.length || candidate.kinds.some((kind) => suggesting(env, kind, channel)));
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
