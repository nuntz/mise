import { describe, expect, test } from "bun:test";
import type { Weekday } from "./household";
import { addDays, changeWeekStart, currentWeek, type LocalDate, type WeekCalendar, weekOf, weekStartOf } from "./weeks";

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

/** A Household whose Weeks have always started on Monday. */
const mondays: WeekCalendar = { weekStartsOn: "monday", weekStartChanges: [] };

describe("currentWeek", () => {
  // Monday 26 October 2026, 03:00 UTC: still Sunday evening in Vancouver.
  const mondayInUtc = new Date("2026-10-26T03:00:00Z");

  test("the current Week follows the Household's calendar, not UTC's", () => {
    expect(currentWeek(mondayInUtc, "America/Vancouver", mondays).startDate).toBe("2026-10-19");
    expect(currentWeek(mondayInUtc, "Europe/Paris", mondays).startDate).toBe("2026-10-26");
  });

  test("a Week starting on Sunday has already begun in Vancouver", () => {
    const sundays: WeekCalendar = { weekStartsOn: "sunday", weekStartChanges: [] };
    expect(currentWeek(mondayInUtc, "America/Vancouver", sundays).startDate).toBe("2026-10-25");
  });
});

/** The calendar once Weeks start on `weekStartsOn` from now on. */
function changed(
  calendar: WeekCalendar,
  weekStartsOn: Weekday,
  today: LocalDate,
  created: LocalDate[] = [],
): WeekCalendar {
  return { weekStartsOn, weekStartChanges: changeWeekStart(calendar, weekStartsOn, today, created) };
}

describe("weekOf", () => {
  test("a Week runs seven days from the Household's week start", () => {
    expect(weekOf("2026-10-29", mondays)).toEqual({ startDate: "2026-10-26", endDate: "2026-11-01" });
  });
});

describe("changing the week start", () => {
  // Wednesday 28 October 2026, in the Week of Monday 26 October.
  const wednesday = "2026-10-28";

  test("the current Week runs on until the first Week on the new start day, with no gap or overlap", () => {
    const thursdays = changed(mondays, "thursday", wednesday);

    expect(weekOf(wednesday, thursdays)).toEqual({ startDate: "2026-10-26", endDate: "2026-11-04" });
    expect(weekOf("2026-11-04", thursdays)).toEqual({ startDate: "2026-10-26", endDate: "2026-11-04" });
    expect(weekOf("2026-11-05", thursdays)).toEqual({ startDate: "2026-11-05", endDate: "2026-11-11" });
    expect(weekOf("2026-12-01", thursdays)).toEqual({ startDate: "2026-11-26", endDate: "2026-12-02" });
  });

  test("earlier Weeks keep their dates", () => {
    const thursdays = changed(mondays, "thursday", wednesday);

    expect(weekOf("2026-10-20", thursdays)).toEqual({ startDate: "2026-10-19", endDate: "2026-10-25" });
  });

  test("a Week already planned ahead keeps its dates, and the new start day follows it", () => {
    const thursdays = changed(mondays, "thursday", wednesday, ["2026-10-19", "2026-11-02"]);

    expect(weekOf(wednesday, thursdays)).toEqual({ startDate: "2026-10-26", endDate: "2026-11-01" });
    expect(weekOf("2026-11-03", thursdays)).toEqual({ startDate: "2026-11-02", endDate: "2026-11-11" });
    expect(weekOf("2026-11-12", thursdays)).toEqual({ startDate: "2026-11-12", endDate: "2026-11-18" });
  });

  test("the same start day changes nothing", () => {
    expect(changeWeekStart(mondays, "monday", wednesday, [])).toEqual([]);
  });

  test("changing it again before the change begins replaces that change", () => {
    const saturdays = changed(changed(mondays, "thursday", wednesday), "saturday", wednesday);

    expect(saturdays.weekStartChanges).toHaveLength(1);
    expect(weekOf(wednesday, saturdays)).toEqual({ startDate: "2026-10-26", endDate: "2026-11-06" });
    expect(weekOf("2026-11-07", saturdays)).toEqual({ startDate: "2026-11-07", endDate: "2026-11-13" });
  });

  test("changing it back before the change begins puts the Weeks back as they were", () => {
    expect(changed(changed(mondays, "thursday", wednesday), "monday", wednesday).weekStartChanges).toEqual([]);
  });

  test("changing it while the current Week runs on past seven days keeps today in it", () => {
    const thursdays = changed(mondays, "thursday", wednesday);
    // Tuesday 3 November: the ninth day of the Week of 26 October.
    const backToMondays = changed(thursdays, "monday", "2026-11-03");

    expect(weekOf("2026-11-03", backToMondays)).toEqual({ startDate: "2026-10-26", endDate: "2026-11-08" });
    expect(weekOf("2026-11-09", backToMondays)).toEqual({ startDate: "2026-11-09", endDate: "2026-11-15" });
  });

  test("a later change keeps the Weeks of every earlier one", () => {
    const thursdays = changed(mondays, "thursday", wednesday);
    // Tuesday 1 December, in the Week of Thursday 26 November.
    const sundays = changed(thursdays, "sunday", "2026-12-01");

    expect(weekOf("2026-10-20", sundays)).toEqual({ startDate: "2026-10-19", endDate: "2026-10-25" });
    expect(weekOf("2026-10-30", sundays)).toEqual({ startDate: "2026-10-26", endDate: "2026-11-04" });
    expect(weekOf("2026-11-20", sundays)).toEqual({ startDate: "2026-11-19", endDate: "2026-11-25" });
    expect(weekOf("2026-12-04", sundays)).toEqual({ startDate: "2026-11-26", endDate: "2026-12-05" });
    expect(weekOf("2026-12-07", sundays)).toEqual({ startDate: "2026-12-06", endDate: "2026-12-12" });
  });
});
