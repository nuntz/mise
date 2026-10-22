import { env } from "cloudflare:workers";
import type { Slot, ToolResult } from "@mise/domain";
import { describe, expect, test } from "vitest";

/**
 * A Household of Robin (allergic to peanut), Alex (milk intolerance) and Sam (no Constraints), Members
 * 1, 2 and 3, with Satay (Recipe 1, peanut), Gratin (Recipe 2, milk), Rice (Recipe 3, nothing) and
 * Stew (Recipe 4, peanut and an Unresolved stock cube).
 */
async function setUpHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", {
    name: "The Example Family",
    members: [
      { name: "Robin", constraints: [{ kind: "allergy", allergen: "peanut" }] },
      { name: "Alex", constraints: [{ kind: "intolerance", allergen: "milk", term: "lactose" }] },
      { name: "Sam" },
    ],
  });
  for (const [title, ingredients] of [
    ["Satay", ["2 tbsp peanut butter", "400 g rice"]],
    ["Gratin", ["500 ml milk", "1 kg potatoes"]],
    ["Rice", ["400 g rice"]],
    ["Stew", ["1 cup peanuts", "1 stock cube"]],
  ] as const) {
    await household.callTool("create_recipe", { title, baseServings: 4, ingredients: [...ingredients] });
  }
  return household;
}

const SATAY = 1;
const GRATIN = 2;
const RICE = 3;
const STEW = 4;
const robinsOverride = { who: 1, allergen: "peanut", reason: "Hers without the peanut butter" } as const;
const TUESDAY = "2026-10-27";
const dinner = { date: TUESDAY, meal: "dinner" } as const;

async function slotNow(household: Awaited<ReturnType<typeof setUpHousehold>>): Promise<Slot> {
  const result = (await household.callTool("get_week", { date: TUESDAY })) as ToolResult<{ slots: Slot[] }>;
  if (!result.ok) throw new Error(result.error.message);
  return result.value.slots.find((slot) => slot.date === TUESDAY && slot.meal === "dinner") as Slot;
}

describe("putting a Recipe in a Slot", () => {
  test("a Recipe that conflicts with a Diner's Hard Constraint is refused, naming the person and the Allergen", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: RICE });

    const refused = await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY });

    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "constraint_conflict",
        conflicts: [{ ...dinner, who: 1, allergen: "peanut", constraint: "allergy", cause: "contains" }],
      },
    });
    expect(refused.ok || refused.error.message).toContain("Robin");
    expect(refused.ok || refused.error.message).toContain("peanut");
    expect(await slotNow(household)).toMatchObject({ recipe: { id: RICE }, conflicts: [] });
  });

  test("an explicit override with a reason lets it through, and is stored on the Slot", async () => {
    const household = await setUpHousehold();
    const overrides = [{ who: 1, allergen: "peanut", reason: "We'll make hers without the peanut butter" }];

    const set = await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, overrides });

    const conflicts = [
      {
        who: 1,
        allergen: "peanut",
        constraint: "allergy",
        cause: "contains",
        override: "We'll make hers without the peanut butter",
      },
    ];
    expect(set).toMatchObject({ ok: true, value: { recipe: { id: SATAY }, conflicts } });
    expect((await slotNow(household)).conflicts).toEqual(conflicts);
  });

  test("unknown Allergens fail closed: a Recipe with an Unresolved Ingredient conflicts with every Hard Constraint", async () => {
    const household = await setUpHousehold();

    const refused = await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: STEW });

    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "constraint_conflict",
        conflicts: [
          { who: 1, allergen: "peanut", cause: "contains" },
          { who: 2, allergen: "milk", constraint: "intolerance", cause: "unknown" },
        ],
      },
    });
    expect(refused.ok || refused.error.message).toContain("Unresolved");
  });

  test("an override is for its Recipe: changing the Recipe needs a new one, keeping it doesn't", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, overrides: [robinsOverride] });

    const noteChanged = await household.callTool("set_slot", {
      ...dinner,
      kind: "recipe",
      recipeId: SATAY,
      note: "Early",
    });
    const otherRecipe = await household.callTool("set_slot", {
      ...dinner,
      kind: "recipe",
      recipeId: STEW,
      overrides: [{ who: 2, allergen: "milk", reason: "Checked the stock cube" }],
    });

    expect(noteChanged).toMatchObject({
      ok: true,
      value: { conflicts: [{ who: 1, override: robinsOverride.reason }] },
    });
    expect(otherRecipe).toMatchObject({ ok: false, error: { conflicts: [{ who: 1, allergen: "peanut" }] } });
  });

  test("a Slot that no longer holds a Recipe has no Conflicts, and keeps no override", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, overrides: [robinsOverride] });

    await household.callTool("set_slot", { ...dinner, kind: "eat_out" });
    const back = await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY });

    expect(back).toMatchObject({ ok: false, error: { code: "constraint_conflict" } });
  });

  test("the Recipe, Diners and Guests change together, checked once as the Slot ends up", async () => {
    const household = await setUpHousehold();

    const set = await household.callTool("set_slot", {
      ...dinner,
      kind: "recipe",
      recipeId: SATAY,
      diners: [2, 3],
      guests: 1,
      guestConstraints: [{ kind: "allergy", allergen: "sesame" }],
    });

    expect(set).toMatchObject({
      ok: true,
      value: { recipe: { id: SATAY }, diners: [2, 3], guests: 1, servings: 3, conflicts: [] },
    });
  });
});

describe("adding a Diner or a Guest", () => {
  async function satayWithoutRobin() {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, diners: [2, 3] });
    return household;
  }

  test("a Diner whose Hard Constraint conflicts with the Recipe is refused, unless overridden", async () => {
    const household = await satayWithoutRobin();

    const refused = await household.callTool("set_diners", { ...dinner, diners: [1, 2, 3] });
    const overridden = await household.callTool("set_diners", {
      ...dinner,
      diners: [1, 2, 3],
      overrides: [robinsOverride],
    });

    expect(refused).toMatchObject({
      ok: false,
      error: { code: "constraint_conflict", conflicts: [{ ...dinner, who: 1, allergen: "peanut" }] },
    });
    expect(overridden).toMatchObject({
      ok: true,
      value: [{ diners: [1, 2, 3], conflicts: [{ who: 1, override: robinsOverride.reason }] }],
    });
  });

  test("Diners set for a whole day are checked against each meal, and refused as a whole", async () => {
    const household = await satayWithoutRobin();
    const lunch = { date: TUESDAY, meal: "lunch", kind: "recipe", recipeId: GRATIN, diners: [1, 3] } as const;
    expect(await household.callTool("set_slot", lunch)).toMatchObject({ ok: true });

    const refused = await household.callTool("set_diners", { date: TUESDAY, diners: [1, 2] });

    expect(refused).toMatchObject({
      ok: false,
      error: {
        conflicts: [
          { meal: "lunch", who: 2, allergen: "milk" },
          { meal: "dinner", who: 1, allergen: "peanut" },
        ],
      },
    });
    expect((await slotNow(household)).diners).toEqual([2, 3]);
  });

  test("going back to the default Diners adds everyone, so it is checked too", async () => {
    const household = await satayWithoutRobin();

    expect(await household.callTool("set_diners", { ...dinner, diners: null })).toMatchObject({
      ok: false,
      error: { conflicts: [{ who: 1, allergen: "peanut" }] },
    });
  });

  test("Guests whose Hard Constraint conflicts are refused as the Guests, unless overridden", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: RICE });
    await household.callTool("set_diners", { ...dinner, diners: [3] });
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: GRATIN });
    const guestConstraints = [{ kind: "allergy", allergen: "milk" }];

    const refused = await household.callTool("set_guests", { ...dinner, guests: 2, guestConstraints });
    const overridden = await household.callTool("set_guests", {
      ...dinner,
      guests: 2,
      guestConstraints,
      overrides: [{ who: "guests", allergen: "milk", reason: "Their portions with oat milk" }],
    });

    expect(refused).toMatchObject({
      ok: false,
      error: { conflicts: [{ who: "guests", allergen: "milk", constraint: "allergy", cause: "contains" }] },
    });
    expect(refused.ok || refused.error.message).toContain("the Guests");
    expect(overridden).toMatchObject({
      ok: true,
      value: { guests: 2, conflicts: [{ who: "guests", override: "Their portions with oat milk" }] },
    });
  });

  test("taking someone off is never refused, and their override goes with them", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, overrides: [robinsOverride] });

    const off = await household.callTool("set_diners", { ...dinner, diners: [2, 3] });
    const backOn = await household.callTool("set_diners", { ...dinner, diners: [1, 2, 3] });

    expect(off).toMatchObject({ ok: true, value: [{ conflicts: [] }] });
    expect(backOn).toMatchObject({ ok: false, error: { conflicts: [{ who: 1 }] } });
  });

  test("a removed Member's overrides go with them", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, overrides: [robinsOverride] });

    expect(await household.callTool("remove_member", { id: 1 })).toMatchObject({ ok: true });
    expect((await slotNow(household)).conflicts).toEqual([]);
  });
});

describe("Conflicts that arise elsewhere", () => {
  test("a Constraint added later shows on the Slot, and blocks neither an unrelated edit nor the fix", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: RICE });
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, diners: [2, 3] });
    await household.callTool("update_member_constraints", {
      id: 3,
      constraints: [{ kind: "allergy", allergen: "peanut" }],
    });

    const shown = await slotNow(household);
    const noted = await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, note: "Early" });
    const fixed = await household.callTool("set_diners", { ...dinner, diners: [2] });

    expect(shown.conflicts).toEqual([
      { who: 3, allergen: "peanut", constraint: "allergy", cause: "contains", override: null },
    ]);
    expect(noted).toMatchObject({ ok: true, value: { conflicts: [{ who: 3, override: null }] } });
    expect(fixed).toMatchObject({ ok: true, value: [{ conflicts: [] }] });
  });
});

describe("check_slot_constraints", () => {
  test("says what a change would conflict with, without making it", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: RICE });

    const checked = await household.callTool("check_slot_constraints", {
      ...dinner,
      recipeId: STEW,
      guests: 1,
      guestConstraints: [{ kind: "diet", allergen: "wheat" }],
    });

    expect(checked).toEqual({
      ok: true,
      value: [
        { who: 1, allergen: "peanut", constraint: "allergy", cause: "contains", override: null },
        { who: 2, allergen: "milk", constraint: "intolerance", cause: "unknown", override: null },
        { who: "guests", allergen: "wheat", constraint: "diet", cause: "unknown", override: null },
      ],
    });
    expect(await slotNow(household)).toMatchObject({ recipe: { id: RICE }, guests: 0 });
  });

  test("with nothing changed, it is the Slot's Conflicts, overrides included", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, overrides: [robinsOverride] });

    expect(await household.callTool("check_slot_constraints", dinner)).toEqual({
      ok: true,
      value: [
        { who: 1, allergen: "peanut", constraint: "allergy", cause: "contains", override: robinsOverride.reason },
      ],
    });
    expect(await household.callTool("check_slot_constraints", { ...dinner, recipeId: null })).toEqual({
      ok: true,
      value: [],
    });
  });
});

describe("overrides that outlive their reason", () => {
  test("an override given while the Allergens were unknown stops covering once they are known to be there", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", {
      ...dinner,
      kind: "recipe",
      recipeId: STEW,
      overrides: [robinsOverride, { who: 2, allergen: "milk", reason: "Checked the stock cube's label" }],
    });

    await household.callTool("create_item", {
      name: "stock cube",
      section: "pantry",
      allergens: ["milk"],
      unitFamily: "count",
    });

    expect((await slotNow(household)).conflicts).toEqual([
      { who: 1, allergen: "peanut", constraint: "allergy", cause: "contains", override: robinsOverride.reason },
      { who: 2, allergen: "milk", constraint: "intolerance", cause: "contains", override: null },
    ]);
  });

  test("a Constraint taken away and given back needs a new override", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: SATAY, overrides: [robinsOverride] });

    await household.callTool("update_member_constraints", { id: 1, constraints: [] });
    await household.callTool("update_member_constraints", {
      id: 1,
      constraints: [{ kind: "allergy", allergen: "peanut" }],
    });

    expect((await slotNow(household)).conflicts).toEqual([
      { who: 1, allergen: "peanut", constraint: "allergy", cause: "contains", override: null },
    ]);
  });
});
