import { env } from "cloudflare:workers";
import type { GroceryList, Item, Slot, ToolResult } from "@mise/domain";
import { describe, expect, test } from "vitest";

/**
 * A Household of Robin (allergic to peanut) and Alex (milk intolerance), Members 1 and 2, with its own
 * Item "mystery masala" (household:1, spices, mustard) and Recipe 1, Dal, which uses it.
 */
async function setUpHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", {
    name: "The Example Family",
    members: [
      { name: "Robin", constraints: [{ kind: "allergy", allergen: "peanut" }] },
      { name: "Alex", constraints: [{ kind: "intolerance", allergen: "milk", term: "lactose" }] },
    ],
  });
  await household.callTool("create_item", {
    name: "mystery masala",
    section: "spices",
    allergens: ["mustard"],
    unitFamily: "volume",
    aliases: ["masala mix"],
  });
  await household.callTool("create_recipe", {
    title: "Dal",
    baseServings: 4,
    ingredients: ["400 g red lentils", "1 tsp mystery masala"],
  });
  return household;
}

type TestHousehold = Awaited<ReturnType<typeof setUpHousehold>>;

const MASALA = "household:1";
const DAL = 1;
const TUESDAY = "2026-10-27";
const dinner = { date: TUESDAY, meal: "dinner" } as const;

function succeeded<T>(outcome: unknown): T {
  const result = outcome as ToolResult<T>;
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value;
}

async function itemNow(household: TestHousehold, id: string): Promise<Item | undefined> {
  return succeeded<Item[]>(await household.callTool("list_items", {})).find((item) => item.id === id);
}

describe("editing a Household Item", () => {
  test("its name, aliases, Store Section, unit family and Allergens can all change", async () => {
    const household = await setUpHousehold();

    const updated = await household.callTool("update_item", {
      id: MASALA,
      name: "panch phoron",
      aliases: ["house masala"],
      section: "international",
      unitFamily: "mass",
      allergens: ["mustard", "sesame"],
    });

    const expected = {
      id: MASALA,
      name: "panch phoron",
      aliases: ["house masala"],
      section: "international",
      unitFamily: "mass",
      allergens: ["sesame", "mustard"],
    };
    expect(updated).toEqual({ ok: true, value: expected });
    expect(await itemNow(household, MASALA)).toEqual(expected);
  });

  test("a name or alias that already names another Item is refused, and nothing changes", async () => {
    const household = await setUpHousehold();
    const before = await itemNow(household, MASALA);

    const byName = await household.callTool("update_item", { id: MASALA, name: "Butter", section: "dairy" });
    const byAlias = await household.callTool("update_item", { id: MASALA, aliases: ["house mix", "eggs"] });

    expect(byName).toMatchObject({ ok: false, error: { code: "name_in_use" } });
    expect(byAlias).toMatchObject({ ok: false, error: { code: "name_in_use" } });
    expect(await itemNow(household, MASALA)).toEqual(before);
  });

  test("it keeps the names it already has, each once", async () => {
    const household = await setUpHousehold();

    const updated = await household.callTool("update_item", {
      id: MASALA,
      name: "Mystery Masalas",
      aliases: ["masala mix", "mystery masala", "Masala Mix"],
    });

    expect(updated).toMatchObject({ ok: true, value: { name: "Mystery Masalas", aliases: ["masala mix"] } });
  });

  test("a name it gains resolves the Unresolved Ingredients it now matches", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { title: "Chana", baseServings: 4, ingredients: ["1 tsp chaat mix"] });

    await household.callTool("update_item", { id: MASALA, aliases: ["chaat mix"] });

    expect(await household.callTool("get_recipe", { id: 2 })).toMatchObject({
      ok: true,
      value: { ingredients: [{ item: MASALA }] },
    });
  });
});

describe("editing a shipped Item", () => {
  test("it can gain aliases and a Store Section of the Household's choosing", async () => {
    const household = await setUpHousehold();

    const updated = await household.callTool("update_item", {
      id: "garam_masala",
      aliases: ["masala"],
      section: "international",
    });

    expect(updated).toEqual({
      ok: true,
      value: {
        id: "garam_masala",
        name: "garam masala",
        aliases: ["masala"],
        section: "international",
        unitFamily: "volume",
        allergens: [],
      },
    });
    expect(await itemNow(household, "garam_masala")).toEqual(succeeded(updated));
  });

  test("the Household's aliases can be replaced, but the ones it ships with stay", async () => {
    const household = await setUpHousehold();
    await household.callTool("update_item", { id: "green_onion", aliases: ["cebollín"] });

    const updated = await household.callTool("update_item", {
      id: "green_onion",
      aliases: ["Spring Onions", "ciboule"],
    });

    expect(updated).toMatchObject({ ok: true, value: { aliases: ["scallion", "spring onion", "ciboule"] } });
  });

  test("choosing its own section again ends the override", async () => {
    const household = await setUpHousehold();
    await household.callTool("update_item", { id: "garam_masala", section: "international" });

    await household.callTool("update_item", { id: "garam_masala", section: "spices" });

    expect(await itemNow(household, "garam_masala")).toMatchObject({ section: "spices" });
  });

  test.each([
    ["Allergens", { allergens: ["mustard"] }],
    ["name", { name: "masala" }],
    ["unit family", { unitFamily: "mass" }],
  ])("its %s cannot change: shipped Items are corrected by release", async (_, change) => {
    const household = await setUpHousehold();
    const before = await itemNow(household, "garam_masala");

    const refused = await household.callTool("update_item", { id: "garam_masala", section: "pantry", ...change });

    expect(refused).toMatchObject({ ok: false, error: { code: "shipped_item" } });
    expect(await itemNow(household, "garam_masala")).toEqual(before);
  });

  test("an Item that doesn't exist is not found", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("update_item", { id: "household:9", name: "x" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("what an edit changes elsewhere", () => {
  async function dinnerNow(household: TestHousehold): Promise<Slot> {
    const week = succeeded<{ slots: Slot[] }>(await household.callTool("get_week", { date: TUESDAY }));
    return week.slots.find((slot) => slot.date === TUESDAY && slot.meal === "dinner") as Slot;
  }

  test("an Allergen edit shows at once on every Recipe that uses the Item and every Slot that plans one", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: DAL });
    expect((await dinnerNow(household)).conflicts).toEqual([]);

    await household.callTool("update_item", { id: MASALA, allergens: ["milk", "mustard"] });

    expect(await household.callTool("get_recipe", { id: DAL })).toMatchObject({
      ok: true,
      value: { allergens: { kind: "known", allergens: ["milk", "mustard"] } },
    });
    expect((await dinnerNow(household)).conflicts).toMatchObject([{ who: 2, allergen: "milk", cause: "contains" }]);

    await household.callTool("update_item", { id: MASALA, allergens: [] });

    expect(await household.callTool("get_recipe", { id: DAL })).toMatchObject({
      ok: true,
      value: { allergens: { kind: "known", allergens: [] } },
    });
    expect((await dinnerNow(household)).conflicts).toEqual([]);
  });

  test("Grocery Lists built after a Store Section edit group the Item under its new section", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner, kind: "recipe", recipeId: DAL });

    await household.callTool("update_item", { id: "dried_lentils", section: "international" });
    await household.callTool("update_item", { id: MASALA, section: "bakery" });
    const list = succeeded<GroceryList>(await household.callTool("build_grocery_list", { date: TUESDAY }));

    expect(list.sections.map(({ section, lines }) => [section, lines.map((line) => line.name)])).toEqual([
      ["bakery", ["mystery masala"]],
      ["international", ["lentils"]],
    ]);
  });
});
