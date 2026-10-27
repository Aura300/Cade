import { publishTask } from "./commands/track.js";
import { unpostedTasks } from "./db.js";

// Tasks are stored before they are posted. Any whose post Slack refused are
// posted again here, every few minutes (the cron in wrangler.toml), until
// POST_ATTEMPTS is reached.
export async function retryUnposted(env) {
  const tasks = await unpostedTasks(env);
  for (const record of tasks) await publishTask(env, record);
  if (tasks.length) console.log("Retried posts", { tasks: tasks.length });
}
