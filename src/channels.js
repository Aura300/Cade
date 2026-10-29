// CHANNEL_PAIRS names each group's tasks channel (the dev channel), where
// the team tracks its work, incidents included. Several groups can run side
// by side, such as the real channel and a test channel. Groups set up
// before may still name an `external` (client) or `incidents` channel; they
// are ignored.
const ROLES = ["tasks"];

// It is a Worker secret, so a JSON string; a list also works, as tests and
// [vars] in wrangler.toml give it.
export function channelPairs(env) {
  const pairs = typeof env.CHANNEL_PAIRS === "string" ? parsePairs(env.CHANNEL_PAIRS) : env.CHANNEL_PAIRS;
  if (
    !Array.isArray(pairs) ||
    !pairs.length ||
    pairs.some((pair) => !pair?.name || !pair?.tasks)
  ) {
    throw new Error("CHANNEL_PAIRS must list { name, tasks } for each group");
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

// Returns every channel ID with the given role: "tasks".
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

// The group's own `suggestions` or `ai` (`key`) for `channel`, or undefined
// when it has none, or `channel` is in no group, so the setting for every
// group applies (see suggesting in intents.js and aiModel in ai.js).
export function groupSetting(env, channel, key) {
  if (!channel) return undefined;
  try {
    return findPair(env, channel)?.[key];
  } catch {
    return undefined;
  }
}

// Returns the role `channel` has in its pair, or undefined when it is in none.
export function roleOf(env, channel) {
  const pair = findPair(env, channel);
  return pair && ROLES.find((role) => pair[role] === channel);
}


// Whether a feature that is off unless turned on is on for `channel`: the
// group's own `key` (true or false), or else the Worker secret `secret`
// ("on" turns it on) for every group. See `pinning` and `canvas` in
// scripts/config.mjs.
export function groupEnabled(env, channel, key, secret) {
  return groupSetting(env, channel, key) ?? env[secret] === "on";
}
