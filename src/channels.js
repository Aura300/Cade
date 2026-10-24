// CHANNEL_PAIRS links each external channel, where tasks are requested, to the
// channel where those tasks are tracked. Several pairs can run side by side,
// such as the real channels and a pair of test channels.
export function channelPairs(env) {
  const pairs = env.CHANNEL_PAIRS;
  if (
    !Array.isArray(pairs) ||
    !pairs.length ||
    pairs.some((pair) => !pair?.external || !pair?.tasks)
  ) {
    throw new Error("CHANNEL_PAIRS must list { external, tasks } channel IDs");
  }
  return pairs;
}

// Returns every channel ID with the given role: "external" or "tasks".
export function channelsWithRole(env, role) {
  return channelPairs(env).map((pair) => pair[role]);
}

// Tasks tracked from an external channel go to its paired tasks channel;
// tasks tracked in a tasks channel stay there.
export function tasksChannelFor(env, channel) {
  const pair = channelPairs(env).find(
    (pair) => pair.external === channel || pair.tasks === channel,
  );
  if (!pair) throw new Error(`${channel} is not in CHANNEL_PAIRS`);
  return pair.tasks;
}
