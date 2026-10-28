import { describe, expect, test } from "bun:test";
import { type CalendarFeedInput, calendarFeed, calendarTokenOf } from "./calendar";
import type { Slot } from "./weeks";

function dinner(date: string, title: string, fields: Partial<Slot> = {}): Slot {
  return {
    date,
    meal: "dinner",
    kind: "recipe",
    recipe: { id: 7, title, baseServings: 4, photoKey: null, readyMade: false },
    note: null,
    diners: [1],
    dinersAreDefault: true,
    guests: 0,
    guestConstraints: [],
    servings: 1,
    cookFor: 1,
    leftoversOf: null,
    leftovers: [],
    locked: false,
    conflicts: [],
    reason: null,
    cookedAt: null,
    ratings: [],
    ...fields,
  };
}

function feed(dinners: Slot[], overrides: Partial<CalendarFeedInput> = {}): string {
  return calendarFeed({
    household: { name: "The Example Family", timezone: "America/Vancouver", dinnerTime: "18:00" },
    dinners,
    prepAhead: new Map(),
    origin: "https://example.com",
    now: new Date("2026-10-22T12:00:00Z"),
    ...overrides,
  });
}

/** The content lines, unfolded (RFC 5545 §3.1). */
function unfolded(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split("\r\n");
}

describe("calendarFeed", () => {
  test("ends every line with CRLF and folds long ones at 75 octets, never inside a character", () => {
    const title = `Crème brûlée ${"é".repeat(60)}`;

    const ics = feed([dinner("2026-11-04", title)]);

    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const lines = ics.split("\r\n");
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines.some((line) => line.startsWith(" "))).toBe(true);
    expect(unfolded(ics)).toContain(`SUMMARY:${title}`);
  });

  test("escapes commas, semicolons, backslashes and line breaks in text", () => {
    const ics = feed([dinner("2026-11-04", "Rice, beans; and a \\ slash")]);

    const lines = unfolded(ics);
    expect(lines).toContain("SUMMARY:Rice\\, beans\\; and a \\\\ slash");
    expect(lines.find((line) => line.startsWith("DESCRIPTION:"))).toContain("Servings: 1\\nDiners: 1");
  });

  test("a dinner on each side of a change of clocks is at dinner time, and the zone defines both offsets", () => {
    const ics = feed([dinner("2026-10-28", "Before"), dinner("2026-11-04", "After")]);

    const lines = unfolded(ics);
    expect(lines).toContain("DTSTART;TZID=America/Vancouver:20261028T180000");
    expect(lines).toContain("DTSTART;TZID=America/Vancouver:20261104T180000");
    const zone = lines.slice(lines.indexOf("BEGIN:VTIMEZONE"), lines.indexOf("END:VTIMEZONE") + 1).join("\n");
    // The clocks go back at 02:00 PDT on 1 November, and forward at 02:00 PST on 8 March.
    expect(zone).toContain(
      "BEGIN:STANDARD\nDTSTART:20261101T020000\nTZOFFSETFROM:-0700\nTZOFFSETTO:-0800\nEND:STANDARD",
    );
    expect(zone).toContain(
      "BEGIN:DAYLIGHT\nDTSTART:20260308T020000\nTZOFFSETFROM:-0800\nTZOFFSETTO:-0700\nEND:DAYLIGHT",
    );
  });

  test("gives each dinner a UID that stays the same when the dinner changes", () => {
    const uid = (ics: string) => unfolded(ics).find((line) => line.startsWith("UID:"));

    expect(uid(feed([dinner("2026-11-04", "Chili")]))).toBe("UID:2026-11-04-dinner@example.com");
    expect(uid(feed([dinner("2026-11-04", "Dal")]))).toBe("UID:2026-11-04-dinner@example.com");
  });
});

describe("calendarTokenOf", () => {
  test("reads the token of a feed path, and nothing else", () => {
    expect(calendarTokenOf("/cal/abc_DEF-123.ics")).toBe("abc_DEF-123");
    expect(calendarTokenOf("/cal/.ics")).toBeNull();
    expect(calendarTokenOf("/cal/a/b.ics")).toBeNull();
    expect(calendarTokenOf("/cal/abc.ics/")).toBeNull();
  });
});
