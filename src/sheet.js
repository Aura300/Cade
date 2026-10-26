import { callGoogle, googleEnabled } from "./google.js";
import { callSlack } from "./slack.js";

// Slack's free plan drops old messages, so every task is also recorded in a
// Google Sheet: each channel pair's own spreadsheet, its `sheet` in
// CHANNEL_PAIRS, through the Google web app (see google.js), which keeps a
// tab named after the pair up to date, a row per task. Syncing is skipped
// when the web app isn't set up, and for a pair with no `sheet`.
export function sheetEnabled(env, group) {
  return googleEnabled(env) && Boolean(sheetId(group.sheet));
}

// `group` is the channel pair: its `sheet` picks the spreadsheet, and its
// name the tab. `row` is keyed by the sheet's column headers; "Task ID"
// identifies the row. A row needs no reply, so a missing reply page counts
// as delivered.
export async function sendRow(env, group, row) {
  await callGoogle(env, { action: "sheet.row", spreadsheetId: sheetId(group.sheet), project: group.name, row }, { lenient: true });
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
