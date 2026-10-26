import { callSlack } from "./slack.js";

// Slack's free plan drops old messages, so every task is also recorded in a
// Google Sheet: each channel pair's own spreadsheet, its `sheet` in
// CHANNEL_PAIRS. The Apps Script web app (google-sheet/Code.gs), a script of
// its own that serves every pair, receives one row per change and keeps a
// tab named after the pair up to date. Syncing is skipped when SHEET_URL is
// not configured, and for a pair with no `sheet`.
export function sheetEnabled(env, group) {
  return Boolean(env.SHEET_URL && env.SHEET_SECRET && sheetId(group.sheet));
}

// `group` is the channel pair: its `sheet` picks the spreadsheet, and its
// name the tab. `row` is keyed by the sheet's column headers; "Task ID"
// identifies the row.
export async function sendRow(env, group, row) {
  const response = await fetch(env.SHEET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.SHEET_SECRET, project: group.name, spreadsheetId: sheetId(group.sheet), row }),
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

// Formats a date as DD/MM/YYYY HH:MM in TIMEZONE (UTC by default).
export function formatTime(env, date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: env.TIMEZONE || "UTC",
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

// The spreadsheet's ID in its address (…/spreadsheets/d/<id>/…), or `value`
// itself if it is an ID already, or "" if it is neither.
export function sheetId(value) {
  const match = /\/spreadsheets\/d\/([\w-]{20,})/.exec(value ?? "") ?? /^([\w-]{20,})$/.exec(value ?? "");
  return match ? match[1] : "";
}
