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

function wallClock(instant: Date, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
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
