import { describe, expect, test } from "bun:test";
import { isHardConstraint } from "./members";
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
        voiceMinutesPerDay: 30,
        members: [],
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
    const result = parseToolInput("setup_household", { name: "The Example Family", pets: [] });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  test("a timezone is stored under its canonical IANA name", () => {
    const result = parseToolInput("setup_household", { name: "The Example Family", timezone: "europe/paris" });

    expect(result).toMatchObject({ ok: true, value: { timezone: "Europe/Paris" } });
  });
});

describe("Member Constraints", () => {
  test.each(["allergy", "intolerance", "diet"])("a Hard Constraint (%s) must name an Allergen", (kind) => {
    const result = parseToolInput("add_member", { name: "Alex", constraints: [{ kind, term: "vegetarian" }] });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", issues: [{ path: "constraints.0.allergen" }] },
    });
  });

  test("a Hard Constraint may label its Allergen with a term", () => {
    const constraints = [
      { kind: "allergy", allergen: "peanut", term: "anaphylactic" },
      { kind: "intolerance", allergen: "milk", term: "lactose" },
      { kind: "diet", allergen: "wheat", term: "gluten-free" },
    ];

    expect(parseToolInput("add_member", { name: "Alex", constraints })).toMatchObject({
      ok: true,
      value: { constraints },
    });
  });

  test("an Allergen comes from the canonical list", () => {
    const result = parseToolInput("add_member", {
      name: "Alex",
      constraints: [{ kind: "allergy", allergen: "kryptonite" }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", issues: [{ path: "constraints.0.allergen" }] },
    });
  });

  test("a dislike names an Allergen, a term or both", () => {
    const constraints = [
      { kind: "dislike", allergen: "fish" },
      { kind: "dislike", term: "mushrooms" },
      { kind: "dislike", allergen: "fish", term: "salmon" },
    ];

    expect(parseToolInput("add_member", { name: "Alex", constraints })).toMatchObject({
      ok: true,
      value: { constraints },
    });
  });

  test("a dislike that names nothing is rejected", () => {
    const result = parseToolInput("add_member", {
      name: "Alex",
      constraints: [{ kind: "dislike" }, { kind: "dislike", term: "  " }],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  test("allergy, intolerance and diet are Hard; dislike is Soft", () => {
    expect(isHardConstraint({ kind: "allergy", allergen: "peanut" })).toBe(true);
    expect(isHardConstraint({ kind: "intolerance", allergen: "milk" })).toBe(true);
    expect(isHardConstraint({ kind: "diet", allergen: "wheat" })).toBe(true);
    expect(isHardConstraint({ kind: "dislike", term: "mushrooms" })).toBe(false);
  });
});

describe("Members", () => {
  test("a Member may have no email", () => {
    expect(parseToolInput("add_member", { name: "Sam" })).toEqual({
      ok: true,
      value: { name: "Sam", email: null, constraints: [] },
    });
  });

  test("a Member's email is stored in lower case, as Callers' are", () => {
    expect(parseToolInput("add_member", { name: "Alex", email: "Alex@Example.com" })).toMatchObject({
      ok: true,
      value: { email: "alex@example.com" },
    });
  });

  test("a Member's email must be an email address", () => {
    expect(parseToolInput("add_member", { name: "Alex", email: "alex" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", issues: [{ path: "email" }] },
    });
  });
});
