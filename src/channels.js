// CHANNEL_PAIRS links each external channel, where tasks are requested, to the
// channel where those tasks are tracked. Several pairs can run side by side,
// such as the real channels and a pair of test channels.
export function channelPairs(env) {
  const pairs = env.CHANNEL_PAIRS;
  if (
    !Array.isArray(pairs) ||
    !pairs.length ||
    pairs.some((pair) => !pair?.name || !pair?.external || !pair?.tasks)
  ) {
    throw new Error("CHANNEL_PAIRS must list { name, external, tasks } for each pair");
  }
  return pairs;
}

// Returns every channel ID with the given role: "external" or "tasks".
export function channelsWithRole(env, role) {
  return channelPairs(env).map((pair) => pair[role]);
}

// Returns the pair that `channel` (external or tasks) belongs to, or
// undefined when it is in none.
export function findPair(env, channel) {
  return channelPairs(env).find((pair) => pair.external === channel || pair.tasks === channel);
}

// Like findPair, for channels that must be in a pair.
export function pairFor(env, channel) {
  const pair = findPair(env, channel);
  if (!pair) throw new Error(`${channel} is not in CHANNEL_PAIRS`);
  return pair;
}

// Tasks tracked from an external channel go to its paired tasks channel;
// tasks tracked in a tasks channel stay there.
export function tasksChannelFor(env, channel) {
  return pairFor(env, channel).tasks;
}
