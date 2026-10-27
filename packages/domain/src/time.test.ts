import { describe, expect, test } from "bun:test";
import { localDate, nextOccurrence, offsetTransitions, zonedTimestamp } from "./time";

describe("nextOccurrence", () => {
  test("a time already past today is tomorrow", () => {
    // 05:00 in Vancouver (PDT, UTC-7).
    const now = new Date("2026-10-20T12:00:00Z");

    expect(nextOccurrence(now, "03:00", "America/Vancouver")).toEqual(new Date("2026-10-21T10:00:00Z"));
  });

  test("a time still ahead today is today", () => {
    // 01:00 in Vancouver.
    const now = new Date("2026-10-20T08:00:00Z");

    expect(nextOccurrence(now, "03:00", "America/Vancouver")).toEqual(new Date("2026-10-20T10:00:00Z"));
  });

  test("the night the clocks go back uses the new offset", () => {
    // Vancouver leaves PDT at 02:00 on 1 November 2026; 03:00 that morning is PST (UTC-8).
    const now = new Date("2026-10-31T12:00:00Z");

    expect(nextOccurrence(now, "03:00", "America/Vancouver")).toEqual(new Date("2026-11-01T11:00:00Z"));
  });

  test("a timezone ahead of UTC gets its own calendar day", () => {
    // 05:00 on 21 October in Tokyo (UTC+9), still 20 October in UTC.
    const now = new Date("2026-10-20T20:00:00Z");

    expect(nextOccurrence(now, "03:00", "Asia/Tokyo")).toEqual(new Date("2026-10-21T18:00:00Z"));
  });

  test("a time skipped by the clocks going forward happens just after the change", () => {
    // Athens jumps from 03:00 to 04:00 on 29 March 2026, so 03:00 never shows; 04:00 EEST is 01:00 UTC.
    const now = new Date("2026-03-28T12:00:00Z");

    expect(nextOccurrence(now, "03:00", "Europe/Athens")).toEqual(new Date("2026-03-29T01:00:00Z"));
  });

  test("a skipped time west of UTC also happens just after the change", () => {
    // Vancouver jumps from 02:00 to 03:00 on 8 March 2026; 02:30 becomes 03:30 PDT, 10:30 UTC.
    const now = new Date("2026-03-07T12:00:00Z");

    expect(nextOccurrence(now, "02:30", "America/Vancouver")).toEqual(new Date("2026-03-08T10:30:00Z"));
  });
});

describe("localDate", () => {
  test("is the date on the Household's wall clock, not in UTC", () => {
    expect(localDate(new Date("2026-10-21T03:00:00Z"), "America/Vancouver")).toBe("2026-10-20");
  });
});

describe("offsetTransitions", () => {
  const HOUR = 60 * 60 * 1000;

  test("finds each change of offset in a year, to the minute", () => {
    const year = offsetTransitions(
      "America/Vancouver",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2027-01-01T00:00:00Z"),
    );

    // 02:00 PST on 8 March, and 02:00 PDT on 1 November.
    expect(year).toEqual([
      { at: new Date("2026-03-08T10:00:00Z"), offsetFrom: -8 * HOUR, offsetTo: -7 * HOUR },
      { at: new Date("2026-11-01T09:00:00Z"), offsetFrom: -7 * HOUR, offsetTo: -8 * HOUR },
    ]);
  });

  test("a range that starts mid-minute still finds the change on the minute", () => {
    const [change] = offsetTransitions(
      "America/Vancouver",
      new Date("2026-03-07T10:00:30.500Z"),
      new Date("2026-03-09T00:00:00Z"),
    );

    expect(change?.at).toEqual(new Date("2026-03-08T10:00:00Z"));
  });

  test("a timezone without daylight time has none", () => {
    expect(
      offsetTransitions("Asia/Kolkata", new Date("2026-01-01T00:00:00Z"), new Date("2027-01-01T00:00:00Z")),
    ).toEqual([]);
  });
});

describe("zonedTimestamp", () => {
  test("gives the wall-clock time with the offset in force, on the night the clocks go back", () => {
    // Paris leaves CEST (UTC+2) at 03:00 on 25 October 2026: 23:30 UTC the night before is 01:30 CEST.
    expect(zonedTimestamp(new Date("2026-10-24T23:30:00Z"), "Europe/Paris")).toBe("2026-10-25T01:30:00+02:00");
    // And two hours later, 02:30 CET.
    expect(zonedTimestamp(new Date("2026-10-25T01:30:00Z"), "Europe/Paris")).toBe("2026-10-25T02:30:00+01:00");
  });

  test("west of UTC, and to the second", () => {
    expect(zonedTimestamp(new Date("2026-10-26T15:02:07.999Z"), "America/Vancouver")).toBe("2026-10-26T08:02:07-07:00");
  });

  test("an offset with minutes", () => {
    expect(zonedTimestamp(new Date("2026-10-26T00:00:00Z"), "Asia/Kolkata")).toBe("2026-10-26T05:30:00+05:30");
  });
});
