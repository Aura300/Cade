import { mentions } from "./slack.js";
import { STATUSES, prLink, unsentPrs } from "./tasks.js";

// What Cade says in a task's thread when its people, pull requests or
// status change, in one place so they read alike. Each change is one
// message: the record of what changed and who changed it, "<@ann> assigned
// <@rex> as developer.", then on the next line what it means for those it
// names, "<@rex>, could you pick this up when you get a chance? Thanks!".
// The record keeps a log of every change in the thread, and the record's
// mention notifies them anyway, so the request comes with it, in the same
// message, rather than as a ping of its own.
//
// Someone who assigns or removes themselves is named as "themselves", and
// isn't asked or told anything: they made the change. Nor is anyone `told`
// already, by the message a suggested change came from: they're named by
// their Slack name, { [id]: name }, rather than mentioned, which would
// notify them again.
//
// People are only asked when there's something for them to do now (see
// onTheirPlate): reviewers when there are PRs to review, testers when the
// task is In testing, developers until it's Done. Those removed are only
// told when they would have been asked.
//
// Every flow and the messages it posts are on the website's
// docs/notifications.html: keep it in step.

// ---- Acknowledgements ----

export function assigned(user, people, role, told = {}) {
  return `<@${user}> assigned ${named(user, people, told)} as ${role}.`;
}

// `role` null: removed from every role.
export function unassigned(user, people, role, told = {}) {
  return `<@${user}> removed ${named(user, people, told)} ${role ? `as ${role}` : "from this task"}.`;
}

// `people` as named by `user`: "themselves" first if they're among them,
// then the others, by name if they've been `told` already, by mention if
// not.
function named(user, people, told) {
  const others = people.filter((id) => id !== user);
  const self = others.length < people.length ? ["themselves"] : [];
  const names = others.map((id) => told[id] ?? `<@${id}>`);
  return [...self, ...(names.length ? [names.join(", ")] : [])].join(" and ");
}

// Those of `people` to ask or tell something: not `user`, who made the
// change, nor anyone `told` already.
export function toAsk(people, user, told = {}) {
  return people.filter((id) => id !== user && !(id in told));
}

export function linked(user, urls, moved) {
  const status = moved ? ` and moved the task to ${STATUSES.IN_REVIEW}` : "";
  return `<@${user}> linked ${urls.map(prLink).join(", ")}${status}.`;
}

export function unlinked(user, urls) {
  return `<@${user}> unlinked ${urls.map(prLink).join(", ")}.`;
}

export function statusChanged(user, status) {
  return `<@${user}> set the status to ${STATUSES[status]}.`;
}

export function movedTo(user, status) {
  return `<@${user}> moved the task to ${STATUSES[status]}.`;
}

// ---- Requests ----

// What `role` has to do on `task` now, as the PRs for reviewers, or null
// when there's nothing: reviewers review the PRs not yet sent for approval,
// testers test it once it's In testing, and developers work on it until
// it's Done.
function onTheirPlate(task, role) {
  if (task.status === "DONE") return null;
  if (role === "reviewer") return unsentPrs(task).length ? unsentPrs(task) : null;
  if (role === "tester") return task.status === "IN_TESTING" ? [] : null;
  return [];
}

// The request to people `user` just assigned to `role`, but not `user`
// themselves or anyone `told` already, or null when there's no one to ask or nothing for them to do
// yet.
export function requestIfDue(task, people, role, user, told) {
  const others = toAsk(people, user, told);
  const prs = others.length ? onTheirPlate(task, role) : null;
  return prs && request(others, role, prs);
}

// The note to people `user` just removed from `role`, or every role (`role`
// null), but not `user` themselves or anyone `told` already, or null when there's no one to tell or
// they'd have had nothing to do.
export function noLongerIfDue(task, people, role, user, told) {
  const others = toAsk(people, user, told);
  const due = role ? onTheirPlate(task, role) : [];
  return others.length && due && task.status !== "DONE" ? noLonger(others, role) : null;
}

// What each role is asked to do; reviewers are asked about pull requests.
const ASKS = {
  developer: () => "pick this up",
  reviewer: (prs) => `review ${prs.map(prLink).join(", ")}`,
  tester: () => "give this a test",
};

// Asks `people` to do `role`'s part; `prs` are what reviewers review.
export function request(people, role, prs = []) {
  return `${mentions(people)}, could you ${ASKS[role](prs)} when you get a chance? Thanks!`;
}

// Tells people removed from a role, or from every role (`role` null), that
// they no longer need to do it.
export function noLonger(people, role) {
  return `${mentions(people)}, there's no need to ${ASKED[role] ?? ASKED.developer} anymore. Thanks!`;
}

// What each role does, for questions about a hand-off and for telling people
// they no longer need to.
export const ASKED = {
  developer: "work on this",
  reviewer: "review this",
  tester: "test this",
};

// One message from parts of { log, notes }: every change first, so they read
// together as the thread's log, then what they mean for whom. Empty if
// nothing changed.
export function oneMessage(...parts) {
  return [...parts.flatMap((part) => part.log), ...parts.flatMap((part) => part.notes)].join("\n");
}
