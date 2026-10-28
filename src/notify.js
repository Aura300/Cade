import { mentions } from "./slack.js";
import { PRIORITIES, STATUSES, prLink, unsentPrs } from "./tasks.js";

// What Cade says in a task's thread when its people, pull requests or
// status change, in one place so they read alike. Each change is one
// message: the record of what changed and who changed it, "<@ann> assigned
// <@rex> as owner.", then on the next line what it means for those it
// names, "<@rex>, could you pick this up when you get a chance? Thanks!".
// The record keeps a log of every change in the thread, and the record's
// mention notifies them anyway, so the request comes with it, in the same
// message, rather than as a ping of its own.
//
// Someone who assigns or removes themselves is named as "themselves", and
// isn't asked or told anything: they made the change. Nor is anyone `told`
// already, by the message a suggested change came from, { [id]: null }: they
// are still named by mention in the change log, but get no request of their
// own, as that message was one.
//
// People are only asked when there's something for them to do now (see
// onTheirPlate): reviewers when there are PRs to review, testers when the
// task is In testing, owners until it's Done. Those removed are only
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
// then the others, by mention.
function named(user, people, told) {
  const others = people.filter((id) => id !== user);
  const self = others.length < people.length ? ["themselves"] : [];
  const names = others.map((id) => `<@${id}>`);
  return [...self, ...(names.length ? [names.join(", ")] : [])].join(" and ");
}

// Those of `people` to ask or tell something: not `user`, who made the
// change, nor anyone `told` already.
export function toAsk(people, user, told = {}) {
  return people.filter((id) => id !== user && !(id in told));
}

export function linked(user, urls) {
  return `<@${user}> linked ${urls.map(prLink).join(", ")}.`;
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

export function priorityChanged(user, priority) {
  return `<@${user}> set the priority to ${PRIORITIES[priority]} ${priority}.`;
}

export function dueDateChanged(user, dueDate) {
  return dueDate ? `<@${user}> set the due date to ${dueDate}.` : `<@${user}> removed the due date.`;
}

// ---- From a change ----

// A change is what changeTask (commands/changes.js) says it actually did:
//   { user, told, task, people: [{ role, added, removed }], prs: { added,
//     removed }, priority: { from, to }, dueDate: { from, to }, status: {
//     from, to } }
// with only what changed, and `task` as it now is. The acknowledgement
// and the requests are both read from it, so each says what happened and
// nothing else.

// The change log: a line for each thing that changed, who changed it.
export function changeLog({ user, told, people, prs, priority, dueDate, status }) {
  return [
    prs?.added.length && linked(user, prs.added),
    prs?.removed.length && unlinked(user, prs.removed),
    ...people.flatMap(({ role, added, removed }) => [
      added.length && assigned(user, added, role, told),
      removed.length && unassigned(user, removed, role, told),
    ]),
    priority && priorityChanged(user, priority.to),
    dueDate && dueDateChanged(user, dueDate.to),
    status && statusChanged(user, status.to),
  ].filter(Boolean);
}

// What the change means for people, a note for each person, not for each
// field: a person asked to do several things is asked once, "pick this up
// and review web/12", and people asked the same share a note. They are:
//   - asked: reviewers kept, about pull requests added; people added to a
//     role, when there's something for them to do now (see onTheirPlate);
//     testers, when the task reached In testing;
//   - told they needn't, when removed from a role they'd been asked to do,
//     by the task as it was before the change.
// Never `user`, who made the change, nor anyone `told` already.
export function changeRequests({ user, told, task, people, prs, status }) {
  const asks = new Map();
  const ask = (ids, role, forPrs = []) => {
    for (const id of toAsk(ids, user, told)) {
      const mine = asks.get(id) ?? [];
      if (!mine.some((one) => one.role === role)) asks.set(id, [...mine, { role, prs: forPrs }]);
    }
  };
  const reviewersAdded = people.find(({ role }) => role === "reviewer")?.added ?? [];
  if (prs?.added.length) ask(task.people.reviewer.filter((id) => !reviewersAdded.includes(id)), "reviewer", prs.added);
  for (const { role, added } of people) {
    const due = onTheirPlate(task, role);
    if (due) ask(added, role, due);
  }
  // All of the testers, those just added too.
  if (status?.to === "IN_TESTING") ask(task.people.tester, "tester");

  const before = {
    ...task,
    status: status?.from ?? task.status,
    prs: [...task.prs.filter((url) => !prs?.added.includes(url)), ...(prs?.removed ?? [])],
  };
  const needless = new Map();
  for (const { role, removed } of people) {
    if (!onTheirPlate(before, role)) continue;
    for (const id of toAsk(removed, user, told)) needless.set(id, [...(needless.get(id) ?? []), role]);
  }

  return [
    ...grouped([...asks].map(([id, mine]) => [id, askedTo(mine)]), (who, what) => `${who}, could you ${what} when you get a chance? Thanks!`),
    ...grouped([...needless].map(([id, roles]) => [id, roles.map((role) => ASKED[role]).join(" or ")]), (who, what) => `${who}, there's no need to ${what} anymore. Thanks!`),
  ];
}

// "pick this up and review web/12": what `asks`, as { role, prs }, ask of one person.
function askedTo(asks) {
  const parts = ["owner", "reviewer", "tester"].flatMap((role) => asks.filter((one) => one.role === role).map((one) => ASKS[role](one.prs)));
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
}

// One note for each distinct `what` of [id, what] pairs, for all who share it.
function grouped(pairs, note) {
  const byWhat = new Map();
  for (const [id, what] of pairs) byWhat.set(what, [...(byWhat.get(what) ?? []), id]);
  return [...byWhat].map(([what, ids]) => note(mentions(ids), what));
}

// The thread's one message about a change: the log, then the requests.
export function changeMessage(change) {
  return [...changeLog(change), ...changeRequests(change)].join("\n");
}

// ---- Requests ----

// What `role` has to do on `task` now, as the PRs for reviewers, or null
// when there's nothing: reviewers review the PRs not yet sent for approval,
// testers test it once it's In testing, and owners work on it until
// it's Done.
function onTheirPlate(task, role) {
  if (task.status === "DONE") return null;
  if (role === "reviewer") return unsentPrs(task).length ? unsentPrs(task) : null;
  if (role === "tester") return task.status === "IN_TESTING" ? [] : null;
  return [];
}

// What each role is asked to do; reviewers are asked about pull requests.
const ASKS = {
  owner: () => "pick this up",
  reviewer: (prs) => `review ${prs.map(prLink).join(", ")}`,
  tester: () => "give this a test",
};

// Asks `people` to do `role`'s part; `prs` are what reviewers review.
export function request(people, role, prs = []) {
  return `${mentions(people)}, could you ${ASKS[role](prs)} when you get a chance? Thanks!`;
}

// What each role does, for questions about a hand-off and for telling people
// they no longer need to.
export const ASKED = {
  owner: "work on this",
  reviewer: "review this",
  tester: "test this",
};
