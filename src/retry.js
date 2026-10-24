import { publishRequirement } from "./commands/requirement.js";
import { publishTask } from "./commands/track.js";
import { unpostedRequirements, unpostedTasks } from "./db.js";

// Tasks and requirements are stored before they are posted. Any whose post
// Slack refused are posted again here, every few minutes (the cron in
// wrangler.toml), until POST_ATTEMPTS is reached. Requirements go first: an
// incident's task is tracked once its requirement is posted.
export async function retryUnposted(env) {
  const requirements = await unpostedRequirements(env);
  for (const record of requirements) await publishRequirement(env, record);
  const tasks = await unpostedTasks(env);
  for (const record of tasks) await publishTask(env, record);
  if (requirements.length || tasks.length) {
    console.log("Retried posts", { requirements: requirements.length, tasks: tasks.length });
  }
}
