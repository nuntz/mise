import { describe, expect, test } from "bun:test";
import { addDays, currentWeekStart, weekStartOf } from "./weeks";

describe("weekStartOf", () => {
  test("a date on the week start starts its own Week", () => {
    // 26 October 2026 is a Monday.
    expect(weekStartOf("2026-10-26", "monday")).toBe("2026-10-26");
  });

  test("a later date belongs to the Week that started on the last week start", () => {
    expect(weekStartOf("2026-11-01", "monday")).toBe("2026-10-26");
    expect(weekStartOf("2026-10-30", "saturday")).toBe("2026-10-24");
  });

  test("a Week can run across months and years", () => {
    expect(weekStartOf("2027-01-02", "sunday")).toBe("2026-12-27");
  });
});

describe("addDays", () => {
  test("counts calendar days, whatever the clocks do", () => {
    // Vancouver leaves PDT on 1 November 2026; calendar dates don't care.
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 7)).toBe("2026-11-08");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("currentWeekStart", () => {
  // Monday 26 October 2026, 03:00 UTC: still Sunday evening in Vancouver.
  const mondayInUtc = new Date("2026-10-26T03:00:00Z");

  test("the current Week follows the Household's calendar, not UTC's", () => {
    expect(currentWeekStart(mondayInUtc, "America/Vancouver", "monday")).toBe("2026-10-19");
    expect(currentWeekStart(mondayInUtc, "Europe/Paris", "monday")).toBe("2026-10-26");
  });

  test("a Week starting on Sunday has already begun in Vancouver", () => {
    expect(currentWeekStart(mondayInUtc, "America/Vancouver", "sunday")).toBe("2026-10-25");
  });
});
