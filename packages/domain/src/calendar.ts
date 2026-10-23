import { z } from "zod";
import type { HouseholdSettings } from "./household";
import type { RecipeId } from "./recipes";
import { offsetTransitions, utcOffset } from "./time";
import { addDays, type LocalDate, type Slot } from "./weeks";

/** The secret in the Calendar Feed's URL: whoever has it can read the plan, without signing in. */
export const CalendarToken = z.object({ token: z.string() });
export type CalendarToken = z.infer<typeof CalendarToken>;

/** Where the Calendar Feed is served for `token`. It bypasses Access (ADR 0019). */
export function calendarFeedPath(token: string): string {
  return `/cal/${token}.ics`;
}

/** The token a Calendar Feed path carries, or null if the path is no feed's. */
export function calendarTokenOf(pathname: string): string | null {
  return /^\/cal\/([A-Za-z0-9_-]+)\.ics$/.exec(pathname)?.[1] ?? null;
}

/** Where the PWA opens a Recipe. */
export function recipeLink(origin: string, id: RecipeId): string {
  return `${origin}/?recipe=${id}`;
}

/** How long calendar apps are asked to wait between refreshes. */
const REFRESH_INTERVAL = "PT1H";
/** How long a dinner's event lasts. */
const DINNER_DURATION = "PT1H";

export type CalendarFeedInput = {
  household: Pick<HouseholdSettings, "name" | "timezone" | "dinnerTime">;
  /** The dinner Slots to show; those planned as nothing (unplanned, skipped) get no event. */
  dinners: Slot[];
  /** The Prep-ahead note of each Recipe that has one. */
  prepAhead: ReadonlyMap<RecipeId, string>;
  /** Where Mise is served, for links to Recipes and for event ids. */
  origin: string;
  now: Date;
};

/**
 * The plan as an iCalendar feed (RFC 5545): one event per planned dinner at the Household's dinner
 * time, in its timezone, and one all-day event the day before for a Recipe's Prep-ahead note.
 */
export function calendarFeed({ household, dinners, prepAhead, origin, now }: CalendarFeedInput): string {
  const { timezone } = household;
  const host = new URL(origin).host;
  const stamp = utcStamp(now);
  const planned = dinners.filter((slot) => title(slot) !== null);
  const events = planned.flatMap((slot) => {
    const dinner = [
      "BEGIN:VEVENT",
      `UID:${slot.date}-dinner@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${timezone}:${basicDate(slot.date)}T${household.dinnerTime.replace(":", "")}00`,
      `DURATION:${DINNER_DURATION}`,
      `SUMMARY:${escapeText(title(slot) ?? "")}`,
      `DESCRIPTION:${escapeText(description(slot, origin))}`,
      ...linkedRecipe(slot).map((id) => `URL:${recipeLink(origin, id)}`),
      "END:VEVENT",
    ];
    const note = slot.kind === "recipe" && slot.recipe ? prepAhead.get(slot.recipe.id) : undefined;
    if (!note || !slot.recipe) return [dinner];
    const prep = [
      "BEGIN:VEVENT",
      `UID:${slot.date}-prep@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${basicDate(addDays(slot.date, -1))}`,
      `DTEND;VALUE=DATE:${basicDate(slot.date)}`,
      `SUMMARY:${escapeText(`Prep ahead: ${slot.recipe.title}`)}`,
      `DESCRIPTION:${escapeText(`${note}\nFor tomorrow's dinner.\nRecipe: ${recipeLink(origin, slot.recipe.id)}`)}`,
      `URL:${recipeLink(origin, slot.recipe.id)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ];
    return [prep, dinner];
  });

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mise//Calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${escapeText(household.name)}`,
    `X-WR-CALNAME:${escapeText(household.name)}`,
    `X-WR-TIMEZONE:${timezone}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH_INTERVAL}`,
    `X-PUBLISHED-TTL:${REFRESH_INTERVAL}`,
    ...vtimezone(
      timezone,
      planned.map((slot) => slot.date),
      now,
    ),
    ...events.flat(),
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

function title(slot: Slot): string | null {
  if (slot.kind === "recipe") return slot.recipe?.title ?? null;
  if (slot.kind === "leftovers") return "Leftovers";
  if (slot.kind === "eat_out") return "Eating out";
  return null;
}

/** The Recipe a Slot's event links to: its own, or for Leftovers the one they were cooked from. */
function linkedRecipe(slot: Slot): RecipeId[] {
  const recipe = slot.kind === "leftovers" ? slot.leftoversOf?.recipe : slot.recipe;
  return recipe ? [recipe.id] : [];
}

/**
 * Kept short: how many eat it and how many Conflicts it has, never who or which Allergens, since
 * anyone with the link can read the feed. The details are in Mise, a link away.
 */
function description(slot: Slot, origin: string): string {
  const lines = [`Servings: ${slot.servings}`, `Diners: ${slot.diners.length}`];
  if (slot.conflicts.length > 0) lines.push(`Conflicts: ${slot.conflicts.length}, see Mise for details`);
  for (const id of linkedRecipe(slot)) lines.push(`Recipe: ${recipeLink(origin, id)}`);
  return lines.join("\n");
}

/**
 * The timezone's definition, for every year an event falls in: what its offset was at the start of
 * the first year, then each change of offset. Offsets above the lowest seen are daylight time.
 */
function vtimezone(timezone: string, dates: LocalDate[], now: Date): string[] {
  const sorted = [...dates].sort();
  const year = now.getUTCFullYear();
  // The prep-ahead event the day before can fall in the previous year.
  const firstYear = sorted[0] ? Number(addDays(sorted[0], -1).slice(0, 4)) : year;
  const lastYear = Number(sorted.at(-1)?.slice(0, 4) ?? year);
  const start = new Date(Date.UTC(firstYear, 0, 1));
  const end = new Date(Date.UTC(lastYear + 1, 0, 1));
  const initial = utcOffset(start, timezone);
  const transitions = offsetTransitions(timezone, start, end);
  const standard = Math.min(initial, ...transitions.map((transition) => transition.offsetTo));

  const observance = (at: Date, offsetFrom: number, offsetTo: number) => {
    const kind = offsetTo > standard ? "DAYLIGHT" : "STANDARD";
    return [
      `BEGIN:${kind}`,
      // Local time, as the clocks read just before the change.
      `DTSTART:${utcStamp(new Date(at.getTime() + offsetFrom)).slice(0, -1)}`,
      `TZOFFSETFROM:${offsetText(offsetFrom)}`,
      `TZOFFSETTO:${offsetText(offsetTo)}`,
      `END:${kind}`,
    ];
  };
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${timezone}`,
    ...observance(start, initial, initial),
    ...transitions.flatMap(({ at, offsetFrom, offsetTo }) => observance(at, offsetFrom, offsetTo)),
    "END:VTIMEZONE",
  ];
}

/** An offset as iCalendar writes it: +HHMM, or +HHMMSS when it has seconds. */
function offsetText(offset: number): string {
  const sign = offset < 0 ? "-" : "+";
  const seconds = Math.abs(offset) / 1000;
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  const hhmm = `${pad(seconds / 3600)}${pad((seconds % 3600) / 60)}`;
  return `${sign}${hhmm}${seconds % 60 ? pad(seconds % 60) : ""}`;
}

/** YYYYMMDD. */
function basicDate(date: LocalDate): string {
  return date.replaceAll("-", "");
}

/** YYYYMMDDTHHMMSSZ. */
function utcStamp(instant: Date): string {
  return `${instant.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** A TEXT value, escaped (RFC 5545 §3.3.11). */
function escapeText(value: string): string {
  return value.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
}

const encoder = new TextEncoder();

/** Folds a content line to at most 75 octets per line, never inside a character (RFC 5545 §3.1). */
function fold(line: string): string {
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    // Continuation lines start with a space, which counts.
    if (octets + size > 75) {
      parts.push(current);
      current = " ";
      octets = 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n");
}
