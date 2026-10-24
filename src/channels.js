// CHANNEL_PAIRS links each external channel, where tasks are requested, to the
// channel where those tasks are tracked, and optionally to a channel where
// incidents are tracked. Several pairs can run side by side, such as the real
// channels and a pair of test channels.
const ROLES = ["external", "tasks", "incidents"];

// It is a Worker secret, so a JSON string; a list also works, as tests and
// [vars] in wrangler.toml give it.
export function channelPairs(env) {
  const pairs = typeof env.CHANNEL_PAIRS === "string" ? parsePairs(env.CHANNEL_PAIRS) : env.CHANNEL_PAIRS;
  if (
    !Array.isArray(pairs) ||
    !pairs.length ||
    pairs.some((pair) => !pair?.name || !pair?.external || !pair?.tasks)
  ) {
    throw new Error("CHANNEL_PAIRS must list { name, external, tasks } for each pair");
  }
  return pairs;
}

function parsePairs(json) {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("CHANNEL_PAIRS is not valid JSON");
  }
}

// Returns every channel ID with the given role: "external", "tasks" or
// "incidents". Pairs without an incidents channel have none.
export function channelsWithRole(env, role) {
  return channelPairs(env)
    .map((pair) => pair[role])
    .filter(Boolean);
}

// Returns the pair that `channel` belongs to, in any role, or undefined when
// it is in none.
export function findPair(env, channel) {
  return channelPairs(env).find((pair) => ROLES.some((role) => pair[role] === channel));
}

// Like findPair, for channels that must be in a pair.
export function pairFor(env, channel) {
  const pair = findPair(env, channel);
  if (!pair) throw new Error(`${channel} is not in CHANNEL_PAIRS`);
  return pair;
}

// Returns the role `channel` has in its pair, or undefined when it is in none.
export function roleOf(env, channel) {
  const pair = findPair(env, channel);
  return pair && ROLES.find((role) => pair[role] === channel);
}

// The pair's channel for the team's own tasks and for tracked requirements.
export function tasksChannelFor(env, channel) {
  return pairFor(env, channel).tasks;
}
