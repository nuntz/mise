import { describe, expect, test } from "bun:test";
import {
  type CheckedStaple,
  type DueStaple,
  dueStaples,
  NEW_STAPLE_INTERVAL,
  recordStapleStatus,
  type StapleStatus,
  suggestsAlwaysBuy,
} from "./staples";
import { addDays } from "./weeks";

const AT = "2026-10-24T10:00:00.000Z";

function staple(fields: Partial<CheckedStaple> = {}): CheckedStaple {
  return { checkEvery: NEW_STAPLE_INTERVAL, status: "stocked", lastChecked: null, outInARow: 0, ...fields };
}

/** The intervals after answering each status in turn, from a new Staple. */
function intervals(...answers: StapleStatus[]): (number | "every_shop")[] {
  let checked = staple();
  return answers.map((status) => {
    checked = recordStapleStatus(checked, status, AT);
    return checked.checkEvery;
  });
}

describe("recordStapleStatus", () => {
  test("a new Staple is checked every 14 days", () => {
    expect(NEW_STAPLE_INTERVAL).toBe(14);
  });

  test("stocked stretches the interval by half, up to 60 days", () => {
    expect(intervals("stocked", "stocked", "stocked", "stocked", "stocked")).toEqual([21, 32, 48, 60, 60]);
  });

  test("out halves the interval, down to 3 days", () => {
    expect(intervals("out", "out", "out", "out")).toEqual([7, 4, 3, 3]);
  });

  test("low leaves the interval as it is", () => {
    expect(intervals("stocked", "low", "low")).toEqual([21, 21, 21]);
  });

  test("records the status and when it was checked", () => {
    expect(recordStapleStatus(staple(), "low", AT)).toMatchObject({ status: "low", lastChecked: AT });
  });

  test("a Staple checked every shop keeps being checked every shop", () => {
    expect(recordStapleStatus(staple({ checkEvery: "every_shop" }), "out", AT).checkEvery).toBe("every_shop");
  });

  test("counts 'out' in a row; any other answer starts the count again", () => {
    let checked = staple();
    const counts = (["out", "out", "low", "out", "out", "out", "stocked"] as const).map((status) => {
      checked = recordStapleStatus(checked, status, AT);
      return checked.outInARow;
    });
    expect(counts).toEqual([1, 2, 0, 1, 2, 3, 0]);
  });
});

describe("suggestsAlwaysBuy", () => {
  test("after three 'out' in a row, unless it is always bought already", () => {
    expect(suggestsAlwaysBuy({ outInARow: 2, alwaysBuy: false })).toBe(false);
    expect(suggestsAlwaysBuy({ outInARow: 3, alwaysBuy: false })).toBe(true);
    expect(suggestsAlwaysBuy({ outInARow: 4, alwaysBuy: true })).toBe(false);
  });
});

describe("dueStaples", () => {
  // Saturday 24 October 2026, in Vancouver.
  const TODAY = "2026-10-24";
  const TIMEZONE = "America/Vancouver";

  function dueOf(name: string, fields: Partial<DueStaple> = {}): DueStaple {
    return { ...staple(), name, location: "pantry", alwaysBuy: false, ...fields };
  }
  const names = (staples: DueStaple[]) => dueStaples(staples, TODAY, TIMEZONE).staples.map((s) => s.name);

  test("is due once its interval has passed since it was last checked, by the Household's calendar", () => {
    expect(
      names([
        // 14 days before, on the Household's calendar: Vancouver's 10 October, though already the 11th in UTC.
        dueOf("passed", { lastChecked: "2026-10-11T05:00:00.000Z" }),
        dueOf("not yet", { lastChecked: "2026-10-11T08:00:00.000Z" }),
        dueOf("never checked"),
      ]),
    ).toEqual(["never checked", "passed"]);
  });

  test("is due while low, or when checked every shop, once not checked yet today; never when always bought", () => {
    const yesterday = "2026-10-23T20:00:00.000Z";
    // Saturday morning in Vancouver.
    const today = "2026-10-24T16:00:00.000Z";
    expect(
      names([
        dueOf("low", { status: "low", lastChecked: yesterday }),
        dueOf("every shop", { checkEvery: "every_shop", lastChecked: yesterday }),
        dueOf("low, checked today", { status: "low", lastChecked: today }),
        dueOf("every shop, checked today", { checkEvery: "every_shop", lastChecked: today }),
        dueOf("out", { status: "out", lastChecked: yesterday }),
        dueOf("always bought", { alwaysBuy: true, status: "low" }),
      ]),
    ).toEqual(["every shop", "low"]);
  });

  test("a Staple never checked is due, but no more overdue than one due today", () => {
    const daysAgo = (days: number) => `${addDays(TODAY, -days)}T20:00:00.000Z`;
    expect(
      names([
        dueOf("a never checked"),
        dueOf("b overdue", { lastChecked: daysAgo(20) }),
        dueOf("c due today", { lastChecked: daysAgo(14) }),
      ]),
    ).toEqual(["b overdue", "a never checked", "c due today"]);
  });

  test("asks pantry, then fridge, then freezer, the most overdue first", () => {
    const daysAgo = (days: number) => `${addDays(TODAY, -days)}T20:00:00.000Z`;
    expect(
      names([
        dueOf("freezer", { location: "freezer", lastChecked: daysAgo(30) }),
        dueOf("fridge, just due", { location: "fridge", lastChecked: daysAgo(14) }),
        dueOf("fridge, a week overdue", { location: "fridge", lastChecked: daysAgo(21) }),
        dueOf("pantry", { lastChecked: daysAgo(15) }),
      ]),
    ).toEqual(["pantry", "fridge, a week overdue", "fridge, just due", "freezer"]);
  });

  test("asks at most 10, the most overdue, and counts all that are due", () => {
    const staples = Array.from({ length: 12 }, (_, index) =>
      dueOf(`overdue ${index + 1} days`, {
        // The most overdue in the freezer, so the cap doesn't just keep the first location.
        location: index >= 9 ? "freezer" : "pantry",
        lastChecked: `${addDays(TODAY, -15 - index)}T20:00:00.000Z`,
      }),
    );
    const session = dueStaples(staples, TODAY, TIMEZONE);
    expect(session.due).toBe(12);
    expect(session.staples.map((s) => s.name)).toEqual([
      "overdue 9 days",
      "overdue 8 days",
      "overdue 7 days",
      "overdue 6 days",
      "overdue 5 days",
      "overdue 4 days",
      "overdue 3 days",
      "overdue 12 days",
      "overdue 11 days",
      "overdue 10 days",
    ]);
  });
});
