import { env } from "cloudflare:workers";
import { addDays, localDate, type Slot, type ToolResult, type Week, weekdayOf } from "@mise/domain";
import { describe, expect, test } from "vitest";

function freshHousehold() {
  return env.Household.getByName(crypto.randomUUID());
}

/** A Household of Robin, Alex and Sam (Members 1, 2 and 3), whose Weeks start on Monday. */
async function setUpHousehold() {
  const household = freshHousehold();
  await household.callTool("setup_household", {
    name: "The Example Family",
    members: [{ name: "Robin" }, { name: "Alex" }, { name: "Sam" }],
  });
  return household;
}

/** The Week a tool call that is expected to succeed returned. */
function weekOf(result: ToolResult<unknown>): Week {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as Week;
}

function slotOf(week: Week, date: string, meal: Slot["meal"]): Slot {
  const slot = week.slots.find((s) => s.date === date && s.meal === meal);
  if (!slot) throw new Error(`No ${meal} on ${date}`);
  return slot;
}

// Monday 26 October 2026 to Sunday 1 November.
const MONDAY = "2026-10-26";
const TUESDAY = "2026-10-27";

describe("a Week", () => {
  test("nothing planned yet: every meal of every day is unplanned, for all the Members", async () => {
    const household = await setUpHousehold();

    const week = weekOf(await household.callTool("get_week", { date: "2026-10-29" }));

    expect(week.startDate).toBe(MONDAY);
    expect(week.slots.map((slot) => `${slot.date} ${slot.meal}`).slice(0, 4)).toEqual([
      "2026-10-26 breakfast",
      "2026-10-26 lunch",
      "2026-10-26 dinner",
      "2026-10-27 breakfast",
    ]);
    expect(week.slots).toHaveLength(21);
    expect(week.slots.at(-1)).toMatchObject({ date: "2026-11-01", meal: "dinner" });
    expect(slotOf(week, TUESDAY, "dinner")).toEqual({
      date: TUESDAY,
      meal: "dinner",
      kind: "unplanned",
      recipe: null,
      note: null,
      diners: [1, 2, 3],
      dinersAreDefault: true,
      guests: 0,
      guestConstraints: [],
      servings: 3,
      locked: false,
      conflicts: [],
      reason: null,
      cookedAt: null,
      ratings: [],
    });
  });
});

const pasta = { title: "Pasta", baseServings: 4, ingredients: ["400 g spaghetti"] };

describe("setting a Slot", () => {
  test("a Recipe set in a Slot shows in its Week, for the default Diners", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pasta);

    const set = await household.callTool("set_slot", {
      date: TUESDAY,
      meal: "dinner",
      kind: "recipe",
      recipeId: 1,
      note: "Use the fresh basil",
    });

    const slot = {
      date: TUESDAY,
      meal: "dinner",
      kind: "recipe",
      recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
      note: "Use the fresh basil",
      diners: [1, 2, 3],
      dinersAreDefault: true,
      guests: 0,
      guestConstraints: [],
      servings: 3,
      locked: false,
      conflicts: [],
      reason: null,
      cookedAt: null,
      ratings: [],
    };
    expect(set).toEqual({ ok: true, value: slot });
    expect(slotOf(weekOf(await household.callTool("get_week", { date: MONDAY })), TUESDAY, "dinner")).toEqual(slot);
  });

  test("changing the kind drops the Recipe; the note stays unless changed, and null clears it", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pasta);
    await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "recipe", recipeId: 1, note: "Early" });

    const eatingOut = await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "eat_out" });
    const skipped = await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "skip", note: null });

    expect(eatingOut).toMatchObject({ ok: true, value: { kind: "eat_out", recipe: null, note: "Early" } });
    expect(skipped).toMatchObject({ ok: true, value: { kind: "skip", recipe: null, note: null } });
  });

  test("a Recipe is given exactly when the kind is recipe", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pasta);

    const noRecipe = await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "recipe" });
    const strayRecipe = await household.callTool("set_slot", {
      date: TUESDAY,
      meal: "dinner",
      kind: "leftovers",
      recipeId: 1,
    });

    expect(noRecipe).toMatchObject({ ok: false, error: { code: "invalid_input", issues: [{ path: "recipeId" }] } });
    expect(strayRecipe).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  test("a Recipe that doesn't exist is refused, and nothing is stored", async () => {
    const household = await setUpHousehold();

    const refused = await household.callTool("set_slot", {
      date: TUESDAY,
      meal: "dinner",
      kind: "recipe",
      recipeId: 9,
    });

    expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(slotOf(weekOf(await household.callTool("get_week", { date: MONDAY })), TUESDAY, "dinner").kind).toBe(
      "unplanned",
    );
  });

  test("a date that isn't on the calendar is refused", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("set_slot", { date: "2026-02-30", meal: "dinner", kind: "eat_out" })).toMatchObject(
      { ok: false, error: { code: "invalid_input", issues: [{ path: "date" }] } },
    );
  });

  test("deleting a Recipe unplans and unlocks the Slots it was in", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pasta);
    await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "recipe", recipeId: 1 });
    await household.callTool("lock_slot", { date: TUESDAY, meal: "dinner", locked: true });

    await household.callTool("delete_recipe", { id: 1, confirm: true });

    expect(slotOf(weekOf(await household.callTool("get_week", { date: MONDAY })), TUESDAY, "dinner")).toMatchObject({
      kind: "unplanned",
      recipe: null,
      locked: false,
    });
  });

  test("before the Household is set up, there is no Week", async () => {
    expect(await freshHousehold().callTool("get_week", {})).toMatchObject({
      ok: false,
      error: { code: "not_set_up" },
    });
  });
});

describe("Diners and Guests", () => {
  test("changing who's eating rescales the Servings and never changes the Recipe", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pasta);
    await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "recipe", recipeId: 1 });

    const changed = await household.callTool("set_diners", { date: TUESDAY, meal: "dinner", diners: [3, 1] });

    expect(changed).toMatchObject({
      ok: true,
      value: [{ kind: "recipe", recipe: { id: 1 }, diners: [1, 3], dinersAreDefault: false, servings: 2 }],
    });
  });

  test("Diners set for a day apply to all three meals, and only that day", async () => {
    const household = await setUpHousehold();

    const changed = await household.callTool("set_diners", { date: TUESDAY, diners: [1, 2] });

    expect(changed).toMatchObject({
      ok: true,
      value: [
        { meal: "breakfast", diners: [1, 2] },
        { meal: "lunch", diners: [1, 2] },
        { meal: "dinner", diners: [1, 2] },
      ],
    });
    const week = weekOf(await household.callTool("get_week", { date: MONDAY }));
    expect(slotOf(week, TUESDAY, "lunch").servings).toBe(2);
    expect(slotOf(week, MONDAY, "dinner").diners).toEqual([1, 2, 3]);
    expect(slotOf(week, "2026-10-28", "breakfast").diners).toEqual([1, 2, 3]);
  });

  test("a Slot's own Diners can be set after the day's", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_diners", { date: TUESDAY, diners: [1, 2] });

    await household.callTool("set_diners", { date: TUESDAY, meal: "dinner", diners: [1, 2, 3] });

    const week = weekOf(await household.callTool("get_week", { date: MONDAY }));
    expect(slotOf(week, TUESDAY, "lunch").diners).toEqual([1, 2]);
    expect(slotOf(week, TUESDAY, "dinner").diners).toEqual([1, 2, 3]);
  });

  test("nobody can eat; null goes back to the default Diners", async () => {
    const household = await setUpHousehold();

    const nobody = await household.callTool("set_diners", { date: TUESDAY, meal: "dinner", diners: [] });
    const reset = await household.callTool("set_diners", { date: TUESDAY, meal: "dinner", diners: null });

    expect(nobody).toMatchObject({ ok: true, value: [{ diners: [], servings: 0 }] });
    expect(reset).toMatchObject({ ok: true, value: [{ diners: [1, 2, 3], dinersAreDefault: true, servings: 3 }] });
  });

  test("a Member added later eats every Slot that follows the default, and none whose Diners were chosen", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_diners", { date: TUESDAY, meal: "dinner", diners: [1, 2] });

    await household.callTool("add_member", { name: "Jordan" });

    const week = weekOf(await household.callTool("get_week", { date: MONDAY }));
    expect(slotOf(week, MONDAY, "dinner").diners).toEqual([1, 2, 3, 4]);
    expect(slotOf(week, TUESDAY, "dinner").diners).toEqual([1, 2]);
  });

  test("a removed Member stops eating the Slots they were chosen for", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_diners", { date: TUESDAY, meal: "dinner", diners: [1, 2] });

    await household.callTool("remove_member", { id: 2 });

    const week = weekOf(await household.callTool("get_week", { date: MONDAY }));
    expect(slotOf(week, TUESDAY, "dinner")).toMatchObject({ diners: [1], servings: 1 });
  });

  test("a Diner who isn't a Member is refused, and no Diner is changed", async () => {
    const household = await setUpHousehold();

    const refused = await household.callTool("set_diners", { date: TUESDAY, diners: [1, 7] });
    const twice = await household.callTool("set_diners", { date: TUESDAY, diners: [1, 1] });

    expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(twice).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(slotOf(weekOf(await household.callTool("get_week", { date: MONDAY })), TUESDAY, "dinner").diners).toEqual([
      1, 2, 3,
    ]);
  });

  test("Guests add to the Servings and bring their own Constraints", async () => {
    const household = await setUpHousehold();
    const guestConstraints = [{ kind: "allergy", allergen: "peanut" }];

    const set = await household.callTool("set_guests", { date: TUESDAY, meal: "dinner", guests: 2, guestConstraints });
    const fewer = await household.callTool("set_guests", { date: TUESDAY, meal: "dinner", guests: 1 });

    expect(set).toMatchObject({ ok: true, value: { guests: 2, guestConstraints, servings: 5 } });
    expect(fewer).toMatchObject({ ok: true, value: { guests: 1, guestConstraints, servings: 4 } });
  });

  test("a Guest's Hard Constraint must name an Allergen", async () => {
    const household = await setUpHousehold();

    const refused = await household.callTool("set_guests", {
      date: TUESDAY,
      meal: "dinner",
      guests: 1,
      guestConstraints: [{ kind: "allergy", term: "nuts" }],
    });

    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("Locks", () => {
  test("a Slot can be Locked and unlocked, and a Locked Slot can still be edited by hand", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pasta);

    const locked = await household.callTool("lock_slot", { date: TUESDAY, meal: "dinner", locked: true });
    const edited = await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "recipe", recipeId: 1 });
    const unlocked = await household.callTool("lock_slot", { date: TUESDAY, meal: "dinner", locked: false });

    expect(locked).toMatchObject({ ok: true, value: { locked: true, kind: "unplanned" } });
    expect(edited).toMatchObject({ ok: true, value: { locked: true, kind: "recipe" } });
    expect(unlocked).toMatchObject({ ok: true, value: { locked: false, kind: "recipe" } });
  });
});

describe("clearing a Week", () => {
  test("puts every Slot of that Week back as it started, Locked ones too, and leaves other Weeks alone", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pasta);
    await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "recipe", recipeId: 1 });
    await household.callTool("lock_slot", { date: TUESDAY, meal: "dinner", locked: true });
    await household.callTool("set_guests", {
      date: "2026-11-01",
      meal: "lunch",
      guests: 2,
      guestConstraints: [{ kind: "allergy", allergen: "sesame" }],
    });
    await household.callTool("set_diners", { date: MONDAY, diners: [1] });
    await household.callTool("set_slot", { date: "2026-11-02", meal: "dinner", kind: "eat_out" });

    const cleared = weekOf(await household.callTool("clear_week", { date: "2026-10-30", confirm: true }));

    expect(cleared.startDate).toBe(MONDAY);
    expect(cleared).toEqual(weekOf(await freshWeekOfThree()));
    const next = weekOf(await household.callTool("get_week", { date: "2026-11-02" }));
    expect(slotOf(next, "2026-11-02", "dinner").kind).toBe("eat_out");
  });

  test("needs confirming", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("clear_week", { date: MONDAY })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", issues: [{ path: "confirm" }] },
    });
  });
});

describe("Week boundaries", () => {
  // UTC+14 and UTC-11: 25 hours apart, so never on the same calendar date.
  const KIRITIMATI = "Pacific/Kiritimati";
  const PAGO_PAGO = "Pacific/Pago_Pago";

  test("today's Week is the Household's, by its own timezone and week start", async () => {
    const today = localDate(new Date(), KIRITIMATI);
    const kiritimati = freshHousehold();
    const pagoPago = freshHousehold();
    // Both Weeks start on the weekday it is today in Kiritimati, which hasn't come yet in Pago Pago.
    const weekStartsOn = weekdayOf(today);
    await kiritimati.callTool("setup_household", { name: "Ahead", timezone: KIRITIMATI, weekStartsOn });
    await pagoPago.callTool("setup_household", { name: "Behind", timezone: PAGO_PAGO, weekStartsOn });

    expect(weekOf(await kiritimati.callTool("get_week", {})).startDate).toBe(today);
    expect(weekOf(await pagoPago.callTool("get_week", {})).startDate).toBe(addDays(today, -7));
  });

  test("a Slot on the last day of a Week belongs to it, and the next day starts the next Week", async () => {
    const household = freshHousehold();
    await household.callTool("setup_household", { name: "Sundays", weekStartsOn: "sunday" });
    await household.callTool("set_slot", { date: "2026-10-31", meal: "dinner", kind: "eat_out" });
    await household.callTool("set_slot", { date: "2026-11-01", meal: "dinner", kind: "skip" });

    const week = weekOf(await household.callTool("get_week", { date: "2026-10-25" }));
    const next = weekOf(await household.callTool("get_week", { date: "2026-11-01" }));

    expect(week.slots.at(-1)).toMatchObject({ date: "2026-10-31", meal: "dinner", kind: "eat_out" });
    expect(next.startDate).toBe("2026-11-01");
    expect(next.slots.at(2)).toMatchObject({ date: "2026-11-01", meal: "dinner", kind: "skip" });
  });
});

/** The untouched Week of 26 October in a Household of three. */
async function freshWeekOfThree() {
  return (await setUpHousehold()).callTool("get_week", { date: MONDAY });
}
