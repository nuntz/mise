import { addDays, CalendarToken, calendarFeed, localDate, type RecipeId, type ToolResult } from "@mise/domain";
import { type Handlers, notSetUp, readSettings } from "./tools";
import { readSlots } from "./weeks";

type CalendarTools = "get_calendar_token" | "rotate_calendar_token";

/** How far back the feed goes: calendars keep the last few weeks of dinners, not every one ever planned. */
const FEED_PAST_DAYS = 28;

/** The Calendar Feed tools, against the household's SQLite. */
export const calendarHandlers: Pick<Handlers, CalendarTools> = {
  get_calendar_token: (sql) => ({ ok: true, value: readCalendarToken(sql) }),

  rotate_calendar_token: (sql): ToolResult<CalendarToken> => {
    if (!readSettings(sql)) return notSetUp();
    const token = newToken();
    sql.exec("INSERT OR REPLACE INTO calendar_token (id, token) VALUES (1, ?)", token);
    return { ok: true, value: { token } };
  },
};

/** The Calendar Feed token, if one was made; parsed, so a bad row throws. */
export function readCalendarToken(sql: SqlStorage): CalendarToken | null {
  const row = sql.exec<{ token: string }>("SELECT token FROM calendar_token WHERE id = 1").toArray()[0];
  return row ? CalendarToken.parse(row) : null;
}

/**
 * The Calendar Feed (ADR 0019), from four weeks ago on, for the one holding the current token; null
 * for any other token, or before the Household is set up. `origin` is where Mise is served.
 */
export function readCalendarFeed(sql: SqlStorage, token: string, origin: string, now: Date): string | null {
  const current = readCalendarToken(sql);
  if (!current || !sameToken(current.token, token)) return null;
  const settings = readSettings(sql);
  if (!settings) return null;
  const from = addDays(localDate(now, settings.timezone), -FEED_PAST_DAYS);
  const prepAhead = new Map(
    sql
      .exec<{ id: RecipeId; prep_ahead: string }>("SELECT id, prep_ahead FROM recipe WHERE prep_ahead IS NOT NULL")
      .toArray()
      .map((row) => [row.id, row.prep_ahead]),
  );
  return calendarFeed({
    household: settings,
    dinners: readSlots(sql, from).filter((slot) => slot.meal === "dinner"),
    prepAhead,
    origin,
    now,
  });
}

/** 256 random bits, URL-safe. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Compares tokens in constant time, so how long a refusal takes tells nothing about the token. */
function sameToken(expected: string, given: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(given);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}
