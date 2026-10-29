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
  const { id } = succeeded<Recipe>(await household.callTool("create_ready_made_recipe", KIRKLAND));
  if (Object.keys(lasagna).length > 0) succeeded(await household.callTool("update_recipe", { id, ...lasagna }));
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

const KIRKLAND = {
  title: "Costco lasagna",
  product: "Kirkland lasagna",
  baseServings: 8,
  allergens: ["wheat", "milk", "egg"],
  section: "frozen",
  steps: ["Bake covered at 375°F for 90 minutes."],
  effortMinutes: 5,
};

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
    // The Week says so, for the Slot and for its Leftovers.
    expect(slotOf(proposed, MONDAY).recipe).toMatchObject({ readyMade: true });
    expect(slotOf(proposed, TUESDAY).leftoversOf?.recipe).toMatchObject({ readyMade: true });
    // Half the pack for Monday's 2 and Tuesday's 2, so one pack.
    expect(await lasagnaBought(household)).toEqual({ frozen: ["1 package"] });
  });
});

describe("adding a Ready-made dish", () => {
  async function household() {
    const fresh = env.Household.getByName(crypto.randomUUID());
    await fresh.callTool("setup_household", { name: "The Example Family", members: [{ name: "Robin" }] });
    return fresh;
  }

  async function householdItems(household: TestHousehold): Promise<Item[]> {
    const items = succeeded<Item[]>(await household.callTool("list_items", {}));
    return items.filter((item) => item.id.startsWith("household:"));
  }

  test("creates the product's Household Item and a Ready-made main whose one Ingredient it is", async () => {
    const fresh = await household();

    const lasagna = succeeded<Recipe>(await fresh.callTool("create_ready_made_recipe", KIRKLAND));

    const [item] = await householdItems(fresh);
    expect(item).toMatchObject({
      name: "Kirkland lasagna",
      section: "frozen",
      allergens: ["milk", "egg", "wheat"],
      unitFamily: "count",
    });
    expect(lasagna).toMatchObject({
      title: "Costco lasagna",
      baseServings: 8,
      readyMade: true,
      course: "main",
      effortMinutes: 5,
      steps: ["Bake covered at 375°F for 90 minutes."],
      ingredients: [{ raw: "1 package Kirkland lasagna", amount: { min: 1, max: 1 }, unit: "package", item: item?.id }],
      allergens: { kind: "known", allergens: ["milk", "egg", "wheat"] },
    });
  });

  test("yields Leftovers when it says so, and none unless it does", async () => {
    const fresh = await household();

    const lasagna = succeeded<Recipe>(
      await fresh.callTool("create_ready_made_recipe", { ...KIRKLAND, yieldsLeftovers: true }),
    );
    const pie = succeeded<Recipe>(
      await fresh.callTool("create_ready_made_recipe", {
        title: "Tourtière",
        product: "Frozen tourtière",
        baseServings: 6,
        allergens: ["wheat"],
      }),
    );

    expect(lasagna.yieldsLeftovers).toBe(true);
    expect(pie.yieldsLeftovers).toBe(false);
  });

  test("names the Item as the line reads it, so a product written with a note still resolves", async () => {
    const fresh = await household();

    const lasagna = succeeded<Recipe>(
      await fresh.callTool("create_ready_made_recipe", { ...KIRKLAND, product: "Kirkland lasagna (family size)" }),
    );

    expect((await householdItems(fresh)).map((item) => item.name)).toEqual(["Kirkland lasagna"]);
    expect(lasagna.ingredients).toMatchObject([
      { raw: "1 package Kirkland lasagna (family size)", note: "family size", item: expect.any(String) },
    ]);
    expect(lasagna.allergens).toEqual({ kind: "known", allergens: ["milk", "egg", "wheat"] });
  });

  test("uses an Item the product already names, with its Allergens, without asking for them", async () => {
    const fresh = await household();
    await fresh.callTool("create_ready_made_recipe", KIRKLAND);

    const again = succeeded<Recipe>(
      await fresh.callTool("create_ready_made_recipe", {
        title: "Lasagna night",
        product: "kirkland lasagnas",
        baseServings: 8,
      }),
    );

    expect(await householdItems(fresh)).toHaveLength(1);
    expect(again.allergens).toEqual({ kind: "known", allergens: ["milk", "egg", "wheat"] });
  });

  test("a new product's Allergens must be stated, even when it has none", async () => {
    const fresh = await household();
    const { allergens: _, ...unstated } = KIRKLAND;

    expect(await fresh.callTool("create_ready_made_recipe", unstated)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", issues: [{ path: "allergens" }] },
    });
    expect(succeeded(await fresh.callTool("create_ready_made_recipe", { ...KIRKLAND, allergens: [] }))).toMatchObject({
      allergens: { kind: "known", allergens: [] },
    });
  });

  test("a refused Recipe leaves no Item behind", async () => {
    const fresh = await household();

    expect(await fresh.callTool("create_ready_made_recipe", { ...KIRKLAND, effortMinutes: -1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(await fresh.callTool("create_ready_made_recipe", { ...KIRKLAND, title: "   " })).toMatchObject({
      ok: false,
    });
    expect(await householdItems(fresh)).toEqual([]);
  });

  test("refuses a product that names an Item weighed or measured, not bought whole", async () => {
    const fresh = await household();

    expect(await fresh.callTool("create_ready_made_recipe", { ...KIRKLAND, product: "chicken breasts" })).toMatchObject(
      { ok: false, error: { code: "measured_item" } },
    );
    expect(await householdItems(fresh)).toEqual([]);
  });
});
