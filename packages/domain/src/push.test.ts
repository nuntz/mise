import { describe, expect, test } from "bun:test";
import { proposalWeekOn } from "./push";
import { changeWeekStart, type WeekCalendar } from "./weeks";

/** A Household whose Weeks have always started on Monday. 2 November 2026 is a Monday. */
const mondays: WeekCalendar = { weekStartsOn: "monday", weekStartChanges: [] };

describe("proposalWeekOn", () => {
  test("the Week is proposed two days before it starts", () => {
    expect(proposalWeekOn("2026-10-31", mondays)).toBe("2026-11-02");
  });

  test("no other day proposes a Week", () => {
    for (const today of ["2026-10-29", "2026-10-30", "2026-11-01", "2026-11-02", "2026-11-03"]) {
      expect(proposalWeekOn(today, mondays)).toBeNull();
    }
  });

  test("a Week starting on Sunday is proposed on Friday", () => {
    expect(proposalWeekOn("2026-10-30", { weekStartsOn: "sunday", weekStartChanges: [] })).toBe("2026-11-01");
  });

  test("after a change of week start, the Week is proposed two days before the new start day", () => {
    // On Wednesday 28 October, Weeks move to Thursdays: the current Week runs on to Wednesday 4 November.
    const thursdays: WeekCalendar = {
      weekStartsOn: "thursday",
      weekStartChanges: changeWeekStart(mondays, "thursday", "2026-10-28", []),
    };

    // Monday 2 November no longer starts a Week, so Saturday proposes nothing.
    expect(proposalWeekOn("2026-10-31", thursdays)).toBeNull();
    expect(proposalWeekOn("2026-11-03", thursdays)).toBe("2026-11-05");
    expect(proposalWeekOn("2026-11-10", thursdays)).toBe("2026-11-12");
  });

  test("a Week that runs on is proposed once, before the Week after it", () => {
    const thursdays: WeekCalendar = {
      weekStartsOn: "thursday",
      weekStartChanges: changeWeekStart(mondays, "thursday", "2026-10-28", []),
    };
    const days = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
    const proposed = [...days, "2026-11-02", "2026-11-03", "2026-11-04"].map((day) => proposalWeekOn(day, thursdays));
    expect(proposed.filter((week) => week !== null)).toEqual(["2026-11-05"]);
  });
});
