import { describe, expect, test } from "bun:test";
import { parseToolInput } from "./tools";

describe("parseToolInput", () => {
  test("setting up a Household with only a name fills in the defaults", () => {
    const result = parseToolInput("setup_household", { name: "The Example Family" });

    expect(result).toEqual({
      ok: true,
      value: {
        name: "The Example Family",
        timezone: "America/Vancouver",
        dinnerTime: "18:00",
        weekStartsOn: "monday",
        units: "metric",
        locale: "en-CA",
      },
    });
  });

  test("an unknown tool is rejected", () => {
    const result = parseToolInput("make_dinner_appear", {});

    expect(result).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
  });

  test("names inherited from Object are not tools", () => {
    expect(parseToolInput("toString", {})).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
  });

  test("an unknown timezone is rejected with the field that failed", () => {
    const result = parseToolInput("setup_household", { name: "The Example Family", timezone: "Mars/Olympus_Mons" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", issues: [{ path: "timezone" }] },
    });
  });

  test("a Household needs a name", () => {
    const result = parseToolInput("setup_household", { name: "   " });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input", issues: [{ path: "name" }] } });
  });

  test("a dinner time must be a 24-hour HH:MM", () => {
    const result = parseToolInput("setup_household", { name: "The Example Family", dinnerTime: "6pm" });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input", issues: [{ path: "dinnerTime" }] } });
  });

  test("unexpected fields are rejected rather than silently dropped", () => {
    const result = parseToolInput("setup_household", { name: "The Example Family", members: [] });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
