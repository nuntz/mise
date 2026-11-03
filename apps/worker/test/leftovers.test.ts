import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { GroceryList, Slot, ToolResult, Week } from "@mise/domain";
import { describe, expect, test } from "vitest";
import { migrate } from "../src/migrations";

/**
 * A Household of Robin (allergic to peanut) and Alex, whose Weeks start on Monday. Recipe 1 is Chili,
 * for 4, which yields Leftovers and comes back every Monday; Recipe 2 is Satay (peanut); Recipes 3
 * to 14 are safe for everyone.
 */
async function setUpHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", {
    name: "The Example Family",
    members: [{ name: "Robin", constraints: [{ kind: "allergy", allergen: "peanut" }] }, { name: "Alex" }],
  });
  await household.callTool("create_recipe", {
    title: "Chili",
    baseServings: 4,
    ingredients: ["400 g ground beef"],
    effortMinutes: 30,
    yieldsLeftovers: true,
    recurring: { weekday: "monday" },
  });
  await household.callTool("create_recipe", {
    title: "Satay",
    baseServings: 4,
    ingredients: ["2 tbsp peanut butter"],
    effortMinutes: 30,
  });
  for (let index = 3; index <= 14; index++) {
    await household.callTool("create_recipe", {
      title: `Rice bowl ${index}`,
      baseServings: 4,
      ingredients: ["400 g rice"],
      effortMinutes: 30,
    });
  }
  return household;
}

type TestHousehold = Awaited<ReturnType<typeof setUpHousehold>>;

const CHILI = 1;
const SATAY = 2;
// Monday 26 October 2026 and the days after it.
const MONDAY = "2026-10-26";
const TUESDAY = "2026-10-27";
const WEDNESDAY = "2026-10-28";
const THURSDAY = "2026-10-29";
const SATURDAY = "2026-10-31";
const dinner = (date: string) => ({ date, meal: "dinner" }) as const;

function succeeded<T>(outcome: unknown): T {
  const result = outcome as ToolResult<T>;
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value;
}

function slotOf(week: Week, date: string): Slot {
  return week.slots.find((slot) => slot.date === date && slot.meal === "dinner") as Slot;
}

async function week(household: TestHousehold): Promise<Week> {
  return succeeded(await household.callTool("get_week", { date: MONDAY }));
}

async function plan(household: TestHousehold, date: string, recipeId: number) {
  succeeded(await household.callTool("set_slot", { ...dinner(date), kind: "recipe", recipeId }));
}

/** The ground beef the Week's Grocery List buys, in grams. */
async function beefBought(household: TestHousehold): Promise<number | undefined> {
  const list = succeeded<GroceryList>(await household.callTool("build_grocery_list", { date: MONDAY }));
  const line = list.sections.flatMap((section) => section.lines).find((other) => other.name === "ground beef");
  return line?.amounts[0]?.amount.min;
}

describe("Leftovers", () => {
  test("the Proposer cooks a Recipe that yields them for the next dinner too, and the list buys for both", async () => {
    const household = await setUpHousehold();

    const proposed = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY }));

    expect(slotOf(proposed, MONDAY)).toMatchObject({
      recipe: { id: CHILI },
      servings: 2,
      cookFor: 4,
      leftovers: [dinner(TUESDAY)],
    });
    expect(slotOf(proposed, TUESDAY)).toMatchObject({
      kind: "leftovers",
      recipe: null,
      leftoversOf: { ...dinner(MONDAY), recipe: { id: CHILI, title: "Chili" } },
      reason: { kind: "leftovers", of: MONDAY },
    });
    // Chili for 4, as written: for Monday's 2 and Tuesday's 2.
    expect(await beefBought(household)).toBe(400);

    // Proposed again, the Leftovers are placed again rather than kept as if decided by hand.
    const again = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY }));
    expect(again.slots).toEqual(proposed.slots);
  });

  test("Leftovers linked by hand scale the earlier Slot, until unlinked", async () => {
    const household = await setUpHousehold();
    await plan(household, MONDAY, CHILI);
    succeeded(await household.callTool("set_guests", { ...dinner(WEDNESDAY), guests: 1 }));

    const linked = succeeded<Slot>(
      await household.callTool("link_leftovers", { ...dinner(WEDNESDAY), of: dinner(MONDAY) }),
    );

    expect(linked).toMatchObject({ kind: "leftovers", servings: 3, leftoversOf: dinner(MONDAY) });
    expect(slotOf(await week(household), MONDAY)).toMatchObject({ cookFor: 5, leftovers: [dinner(WEDNESDAY)] });
    expect(await beefBought(household)).toBe(500);
    // Editing the note keeps them linked.
    succeeded(await household.callTool("set_slot", { ...dinner(WEDNESDAY), kind: "leftovers", note: "Freeze half" }));
    expect(slotOf(await week(household), MONDAY).cookFor).toBe(5);

    succeeded(await household.callTool("link_leftovers", { ...dinner(WEDNESDAY), of: null }));

    expect(slotOf(await week(household), WEDNESDAY)).toMatchObject({ kind: "leftovers", leftoversOf: null });
    expect(slotOf(await week(household), MONDAY)).toMatchObject({ cookFor: 2, leftovers: [] });
    expect(await beefBought(household)).toBe(200);
  });

  test("proposing the Week again keeps a Recipe in the Slot that Leftovers linked by hand come from", async () => {
    const household = await setUpHousehold();
    await plan(household, MONDAY, CHILI);
    await household.callTool("lock_slot", { ...dinner(MONDAY), locked: true });
    await plan(household, TUESDAY, 3);
    succeeded(await household.callTool("link_leftovers", { ...dinner(WEDNESDAY), of: dinner(TUESDAY) }));
    // The rest of the Week eats out, so Tuesday's is the only Rice bowl on the Grocery List.
    for (const date of ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]) {
      succeeded(await household.callTool("set_slot", { ...dinner(date), kind: "eat_out" }));
    }

    const proposed = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY }));

    expect(slotOf(proposed, TUESDAY)).toMatchObject({ kind: "recipe", cookFor: 4, leftovers: [dinner(WEDNESDAY)] });
    expect(slotOf(proposed, TUESDAY).recipe).not.toBeNull();
    expect(slotOf(proposed, WEDNESDAY)).toMatchObject({ kind: "leftovers", leftoversOf: dinner(TUESDAY) });
    // Tuesday's Rice bowl for 4: for Tuesday's 2 and Wednesday's 2.
    const list = succeeded<GroceryList>(await household.callTool("build_grocery_list", { date: MONDAY }));
    const rice = list.sections.flatMap((section) => section.lines).find((line) => line.name === "rice");
    expect(rice?.amounts[0]?.amount.min).toBe(400);
  });

  test("proposing the Week again keeps a Recipe chosen by hand, and the Leftovers linked to it with their Override", async () => {
    const household = await setUpHousehold();
    succeeded(
      await household.callTool("set_slot", { ...dinner(TUESDAY), kind: "recipe", recipeId: SATAY, diners: [2] }),
    );
    succeeded(
      await household.callTool("link_leftovers", {
        ...dinner(WEDNESDAY),
        of: dinner(TUESDAY),
        overrides: [{ who: 1, allergen: "peanut", reason: "Robin's bowl without the sauce" }],
      }),
    );

    const proposed = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY, reroll: true }));

    // Chosen by hand, so the Household's own: no Proposal changes it (ADR 0030).
    expect(slotOf(proposed, TUESDAY)).toMatchObject({
      kind: "recipe",
      recipe: { id: SATAY },
      leftovers: [dinner(WEDNESDAY)],
      reason: null,
    });
    expect(slotOf(proposed, WEDNESDAY)).toMatchObject({
      kind: "leftovers",
      leftoversOf: dinner(TUESDAY),
      conflicts: [expect.objectContaining({ who: 1, allergen: "peanut", override: "Robin's bowl without the sauce" })],
    });
  });

  test("linking Leftovers by hand to a dinner Mise chose makes it the Household's own, which a Re-roll keeps", async () => {
    const household = await setUpHousehold();
    const proposed = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY }));
    const chosen = slotOf(proposed, THURSDAY);
    expect(chosen.reason).toMatchObject({ kind: "chosen" });

    succeeded(await household.callTool("link_leftovers", { ...dinner(SATURDAY), of: dinner(THURSDAY) }));

    expect(slotOf(await week(household), THURSDAY)).toMatchObject({ recipe: chosen.recipe, reason: null });
    for (let roll = 0; roll < 3; roll++) {
      const rerolled = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY, reroll: true }));
      expect(slotOf(rerolled, THURSDAY)).toMatchObject({
        kind: "recipe",
        recipe: chosen.recipe,
        leftovers: [dinner(SATURDAY)],
        reason: null,
      });
      expect(slotOf(rerolled, SATURDAY)).toMatchObject({
        kind: "leftovers",
        leftoversOf: dinner(THURSDAY),
        reason: null,
      });
    }
  });

  test("Leftovers link only to an earlier Slot that holds a Recipe", async () => {
    const household = await setUpHousehold();
    await plan(household, TUESDAY, CHILI);

    expect(await household.callTool("link_leftovers", { ...dinner(MONDAY), of: dinner(TUESDAY) })).toMatchObject({
      ok: false,
      error: { code: "not_earlier" },
    });
    expect(await household.callTool("link_leftovers", { ...dinner(WEDNESDAY), of: dinner(MONDAY) })).toMatchObject({
      ok: false,
      error: { code: "no_recipe" },
    });
  });

  test("whoever eats the Leftovers eats their Recipe, so its Conflicts block as a Recipe's would", async () => {
    const household = await setUpHousehold();
    const alexOnly = [2];
    // Satay on Monday for Alex alone; Robin eating its Leftovers on Tuesday is refused.
    succeeded(
      await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: SATAY, diners: alexOnly }),
    );

    expect(await household.callTool("link_leftovers", { ...dinner(TUESDAY), of: dinner(MONDAY) })).toMatchObject({
      ok: false,
      error: { code: "constraint_conflict", conflicts: [{ ...dinner(TUESDAY), who: 1, allergen: "peanut" }] },
    });

    // Leftovers of Chili, for both, block putting Satay in Monday instead.
    await plan(household, MONDAY, CHILI);
    succeeded(await household.callTool("link_leftovers", { ...dinner(TUESDAY), of: dinner(MONDAY) }));

    expect(await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: SATAY })).toMatchObject({
      ok: false,
      error: { code: "constraint_conflict", conflicts: [{ ...dinner(TUESDAY), who: 1, allergen: "peanut" }] },
    });
    expect(slotOf(await week(household), MONDAY).recipe?.id).toBe(CHILI);
  });

  test("clearing the Week of the Slot they were cooked for unlinks Leftovers in the next Week", async () => {
    const household = await setUpHousehold();
    const sunday = "2026-11-01";
    const nextMonday = "2026-11-02";
    await plan(household, sunday, CHILI);
    succeeded(await household.callTool("link_leftovers", { ...dinner(nextMonday), of: dinner(sunday) }));

    succeeded(await household.callTool("clear_week", { date: MONDAY, confirm: true }));
    await plan(household, sunday, CHILI);

    const next = succeeded<Week>(await household.callTool("get_week", { date: nextMonday }));
    expect(slotOf(next, nextMonday)).toMatchObject({ kind: "leftovers", leftoversOf: null });
    expect(slotOf(await week(household), sunday)).toMatchObject({ cookFor: 2, leftovers: [] });
  });
});

describe("Leftovers linked by hand before ADR 0030", () => {
  test("the dinner they are of loses its reason, and Leftovers Mise placed leave theirs alone", async () => {
    const household = await setUpHousehold();
    const proposed = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY }));
    succeeded(await household.callTool("link_leftovers", { ...dinner(SATURDAY), of: dinner(THURSDAY) }));
    // As linking by hand left it before: Thursday still a Suggestion.
    await runInDurableObject(household, async (_household, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO slot_reason (date, meal, reason) VALUES (?, 'dinner', ?)",
        THURSDAY,
        JSON.stringify(slotOf(proposed, THURSDAY).reason),
      );
      sql.exec("DELETE FROM schema_version WHERE version >= 31");
      // Migration 31 again, and only it.
      migrate(state.storage, 31);
    });

    const after = await week(household);

    expect(slotOf(after, THURSDAY)).toMatchObject({ recipe: slotOf(proposed, THURSDAY).recipe, reason: null });
    // Monday's Chili, with the Leftovers Mise placed on Tuesday, is still Mise's Suggestion.
    expect(slotOf(after, MONDAY)).toMatchObject({ recipe: { id: CHILI }, leftovers: [dinner(TUESDAY)] });
    expect(slotOf(after, MONDAY).reason).toEqual(slotOf(proposed, MONDAY).reason);
    expect(slotOf(after, MONDAY).reason).not.toBeNull();
  });
});
