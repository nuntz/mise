/** The next instant after `now` at which the wall clock in `timezone` reads `localTime` (HH:MM). */
export function nextOccurrence(now: Date, localTime: string, timezone: string): Date {
  const [hour, minute] = localTime.split(":").map(Number) as [number, number];
  const today = wallClock(now, timezone);
  for (let days = 0; ; days++) {
    const candidate = zonedInstant(Date.UTC(today.year, today.month - 1, today.day + days, hour, minute), timezone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
}

/** The calendar date, YYYY-MM-DD, that the wall clock in `timezone` shows at `instant`. */
export function localDate(instant: Date, timezone: string): string {
  const { year, month, day } = wallClock(instant, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** One formatter per timezone: building one is far slower than using it. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: Date, timezone: string): WallClock {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** How far the wall clock in `timezone` is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timezone: string): number {
  const clock = wallClock(new Date(instant), timezone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** A change of a timezone's offset from UTC: at `at`, the clocks go from `offsetFrom` to `offsetTo` (milliseconds). */
export type OffsetTransition = { at: Date; offsetFrom: number; offsetTo: number };

/** How far the wall clock in `timezone` is ahead of UTC at `instant`, in milliseconds. */
export function utcOffset(instant: Date, timezone: string): number {
  return offsetAt(instant.getTime(), timezone);
}

/**
 * `instant` as RFC 3339 to the second, in the wall-clock time of `timezone` with its UTC offset
 * then, such as 2026-10-25T01:30:00+02:00.
 */
export function zonedTimestamp(instant: Date, timezone: string): string {
  const offset = Math.round(utcOffset(instant, timezone) / MINUTE_MS);
  const local = new Date(Math.floor(instant.getTime() / 1000) * 1000 + offset * MINUTE_MS);
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${local.toISOString().slice(0, 19)}${sign}${hours}:${minutes}`;
}

/**
 * Every change of `timezone`'s offset after `from` and up to `to`, to the minute. Changes are found
 * a day apart at most, so two in one day count as one (or none, if they cancel out).
 */
export function offsetTransitions(timezone: string, from: Date, to: Date): OffsetTransition[] {
  const transitions: OffsetTransition[] = [];
  // Offsets change on the minute, so the search steps from one whole minute to the next.
  let before = Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS;
  let offsetBefore = offsetAt(before, timezone);
  while (before < to.getTime()) {
    const after = Math.min(before + DAY_MS, to.getTime());
    const offsetAfter = offsetAt(after, timezone);
    if (offsetAfter !== offsetBefore) {
      // `low` is the last whole minute known to show the old offset; the change is after it, by `high`.
      let low = before;
      let high = after;
      while (high - low > MINUTE_MS) {
        const middle = low + Math.max(1, Math.floor((high - low) / 2 / MINUTE_MS)) * MINUTE_MS;
        if (offsetAt(middle, timezone) === offsetBefore) low = middle;
        else high = middle;
      }
      transitions.push({ at: new Date(low + MINUTE_MS), offsetFrom: offsetBefore, offsetTo: offsetAfter });
    }
    before = after;
    offsetBefore = offsetAfter;
  }
  return transitions;
}

/**
 * The instant at which `timezone` shows a wall-clock time, given as if it were UTC milliseconds.
 * A time shown twice when the clocks go back is its first showing; a time skipped when they go
 * forward lands just after the change.
 */
function zonedInstant(wallClockAsUtc: number, timezone: string): Date {
  const offsetBefore = offsetAt(wallClockAsUtc - DAY_MS, timezone);
  const offsetAfter = offsetAt(wallClockAsUtc + DAY_MS, timezone);
  for (const offset of [offsetBefore, offsetAfter]) {
    const instant = wallClockAsUtc - offset;
    if (offsetAt(instant, timezone) === offset) return new Date(instant);
  }
  return new Date(wallClockAsUtc - offsetBefore);
}
