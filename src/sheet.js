import { callSlack } from "./slack.js";

// Slack's free plan drops old messages, so every task is also recorded in a
// Google Sheet. The sheet's Apps Script web app (google-sheet/Code.gs) receives
// one row per change and keeps a tab per channel pair, named after the pair,
// up to date. Syncing is skipped when SHEET_URL is not configured.
export function sheetEnabled(env) {
  return Boolean(env.SHEET_URL && env.SHEET_SECRET);
}

// `project` is the channel pair's name, which picks the tab. `row` is keyed
// by the sheet's column headers; "Task ID" identifies the row.
export async function sendRow(env, project, row) {
  const response = await fetch(env.SHEET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.SHEET_SECRET, project, row }),
    redirect: "manual",
  });

  // Apps Script runs doPost before answering, then redirects to a page that
  // holds its reply. On some Google accounts that page returns 404 even though
  // doPost completed, so the redirect itself counts as delivered and the reply
  // is only checked when it can be read.
  if (response.status === 302) {
    const reply = await fetch(response.headers.get("location")).catch(() => null);
    const isJson = reply?.ok && reply.headers.get("content-type")?.includes("json");
    const result = isJson ? await reply.json() : null;
    if (result && !result.ok) throw new Error(`Sheet rejected the row: ${result.error}`);
    return;
  }

  if (!response.ok) throw new Error(`Sheet returned HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`Sheet rejected the row: ${result.error}`);
}

// Returns display names for Slack user IDs, joined with commas. Needs the
// users:read scope; without it, the IDs themselves are used.
export async function userNames(env, ids) {
  const names = await Promise.all(
    ids.map(async (id) => {
      try {
        const { user } = await callSlack(env, "users.info", { user: id });
        return user.profile?.display_name || user.real_name || user.name || id;
      } catch (error) {
        console.warn("Could not look up user", { id, error: error.message });
        return id;
      }
    }),
  );
  return names.join(", ");
}

// Formats a date as DD/MM/YYYY HH:MM in TIMEZONE (Sri Lanka by default).
export function formatTime(env, date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: env.TIMEZONE || "Asia/Colombo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}
