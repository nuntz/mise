import { env } from "cloudflare:workers";
import type { GroceryList, Item, Recipe, Slot, ToolResult, Week } from "@mise/domain";
import { describe, expect, test } from "vitest";

type Member = { name: string; constraints?: { kind: "allergy"; allergen: string }[] };

/**
 * A Household of the Members given, whose Weeks start on Monday, with a Ready-made lasagna bought for
 * 8 (Recipe 1): its one Ingredient is a Household Item carrying the label's Allergens (ADR 0026).
 * Recipes 2 to 13 are safe for everyone.
 */
async function setUpHousehold(members: Member[], lasagna: Record<string, unknown> = {}) {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family", members });
  succeeded<Item>(
    await household.callTool("create_item", {
      name: "Kirkland lasagna",
      section: "frozen",
      allergens: ["milk", "egg", "wheat"],
      unitFamily: "count",
    }),
  );
  succeeded<Recipe>(
    await household.callTool("create_recipe", {
      title: "Costco lasagna",
      baseServings: 8,
      ingredients: ["1 package Kirkland lasagna"],
      steps: ["Bake covered at 375°F for 90 minutes."],
      effortMinutes: 5,
      course: "main",
      readyMade: true,
      ...lasagna,
    }),
  );
  for (let index = 2; index <= 13; index++) {
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

const LASAGNA = 1;
const FOUR = [{ name: "Robin" }, { name: "Alex" }, { name: "Sam" }, { name: "Jo" }];
// Monday 26 October 2026 and the days after it.
const MONDAY = "2026-10-26";
const TUESDAY = "2026-10-27";
const dinner = (date: string) => ({ date, meal: "dinner" }) as const;

function succeeded<T>(outcome: unknown): T {
  const result = outcome as ToolResult<T>;
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value;
}

async function plan(household: TestHousehold, date: string) {
  succeeded(await household.callTool("set_slot", { ...dinner(date), kind: "recipe", recipeId: LASAGNA }));
}

/** The lasagna lines of the Week's Grocery List, by section, as "amount unit". */
async function lasagnaBought(household: TestHousehold): Promise<Record<string, string[]>> {
  const list = succeeded<GroceryList>(await household.callTool("build_grocery_list", { date: MONDAY }));
  return Object.fromEntries(
    list.sections.flatMap(({ section, lines }) => {
      const lasagna = lines.filter((line) => line.name === "Kirkland lasagna");
      const read = lasagna.map((line) => line.amounts.map(({ amount, unit }) => `${amount.max} ${unit}`).join(" + "));
      return read.length > 0 ? [[section, read]] : [];
    }),
  );
}

function slotOf(week: Week, date: string): Slot {
  return week.slots.find((slot) => slot.date === date && slot.meal === "dinner") as Slot;
}

describe("a Ready-made dish", () => {
  test("is shopped in whole packs, in its Household Item's Store Section", async () => {
    const household = await setUpHousehold(FOUR);

    await plan(household, MONDAY);
    expect(await lasagnaBought(household)).toEqual({ frozen: ["1 package"] });

    await plan(household, TUESDAY);
    expect(await lasagnaBought(household)).toEqual({ frozen: ["1 package"] });

    for (const date of [MONDAY, TUESDAY]) {
      succeeded(await household.callTool("set_guests", { ...dinner(date), guests: 1 }));
    }
    expect(await lasagnaBought(household)).toEqual({ frozen: ["2 package"] });
  });

  test("conflicts with a Diner allergic to what its label says, and is never proposed for their dinner", async () => {
    const household = await setUpHousehold([
      { name: "Robin", constraints: [{ kind: "allergy", allergen: "milk" }] },
      { name: "Alex" },
    ]);

    expect(await household.callTool("get_recipe", { id: LASAGNA })).toMatchObject({
      ok: true,
      value: { readyMade: true, allergens: { kind: "known", allergens: ["milk", "egg", "wheat"] } },
    });
    expect(
      await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: LASAGNA }),
    ).toMatchObject({
      ok: false,
      error: { code: "constraint_conflict", conflicts: [{ who: 1, allergen: "milk", cause: "contains" }] },
    });
    const proposed = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY }));
    const dinners = proposed.slots.filter((slot) => slot.meal === "dinner");
    expect(dinners.some((slot) => slot.recipe !== null)).toBe(true);
    expect(dinners.map((slot) => slot.recipe?.id)).not.toContain(LASAGNA);
  });

  test("that yields Leftovers has them placed by the Proposer like any Recipe's", async () => {
    const household = await setUpHousehold(FOUR.slice(0, 2), {
      yieldsLeftovers: true,
      recurring: { weekday: "monday" },
    });

    const proposed = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY }));

    expect(slotOf(proposed, MONDAY)).toMatchObject({
      recipe: { id: LASAGNA },
      servings: 2,
      cookFor: 4,
      leftovers: [dinner(TUESDAY)],
    });
    expect(slotOf(proposed, TUESDAY)).toMatchObject({ kind: "leftovers", leftoversOf: dinner(MONDAY) });
    // Half the pack for Monday's 2 and Tuesday's 2, so one pack.
    expect(await lasagnaBought(household)).toEqual({ frozen: ["1 package"] });
  });
});
