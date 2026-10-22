import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

function freshHousehold() {
  return env.Household.getByName(crypto.randomUUID());
}

async function setUpHousehold() {
  const household = freshHousehold();
  await household.callTool("setup_household", { name: "The Example Family" });
  return household;
}

describe("listing Unresolved Ingredients", () => {
  test("groups lines by their normalised text, most frequent first", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", {
      title: "Toast",
      baseServings: 2,
      ingredients: ["2 slices sourdough bread", "1 tbsp butter", "1 tbsp Mystery Spread"],
    });
    await household.callTool("create_recipe", {
      title: "Crackers",
      baseServings: 2,
      ingredients: ["10 crackers", "2 tbsp mystery spreads, softened"],
    });
    await household.callTool("create_recipe", {
      title: "Bagel",
      baseServings: 1,
      ingredients: ["1 bagel", "1 tbsp mystery spread"],
    });

    const listed = await household.callTool("list_unresolved_ingredients", {});

    expect(listed).toEqual({
      ok: true,
      value: [
        {
          text: "mystery spread",
          count: 3,
          lines: ["1 tbsp Mystery Spread", "2 tbsp mystery spreads, softened", "1 tbsp mystery spread"],
          recipes: [
            { id: 1, title: "Toast" },
            { id: 2, title: "Crackers" },
            { id: 3, title: "Bagel" },
          ],
        },
        { text: "bagel", count: 1, lines: ["1 bagel"], recipes: [{ id: 3, title: "Bagel" }] },
        { text: "cracker", count: 1, lines: ["10 crackers"], recipes: [{ id: 2, title: "Crackers" }] },
        {
          text: "sourdough bread",
          count: 1,
          lines: ["2 slices sourdough bread"],
          recipes: [{ id: 1, title: "Toast" }],
        },
      ],
    });
  });
});

describe("resolving a group to an existing Item", () => {
  test("resolves every line with that text, in every Recipe, and updates their Allergens", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", {
      title: "Toast",
      baseServings: 2,
      ingredients: ["1 tbsp beurre", "1 tbsp honey"],
    });
    await household.callTool("create_recipe", {
      title: "Crêpes",
      baseServings: 4,
      ingredients: ["2 tbsp Beurre, melted", "1 cup flour", "1 tbsp mystery spread"],
    });

    const resolved = await household.callTool("resolve_ingredient", { text: "beurre", item: "butter" });

    expect(resolved).toMatchObject({
      ok: true,
      value: { item: { id: "butter", aliases: expect.arrayContaining(["beurre"]) }, resolved: 2 },
    });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: true,
      value: {
        ingredients: [{ raw: "1 tbsp beurre", item: "butter" }, { item: "honey" }],
        allergens: { kind: "known", allergens: ["milk"] },
      },
    });
    expect(await household.callTool("get_recipe", { id: 2 })).toMatchObject({
      ok: true,
      value: {
        ingredients: [{ item: "butter" }, { item: "flour" }, { item: null }],
        allergens: { kind: "unknown", atLeast: ["milk", "wheat"], unresolved: 1 },
      },
    });
    expect(await household.callTool("list_unresolved_ingredients", {})).toMatchObject({
      ok: true,
      value: [{ text: "mystery spread" }],
    });
  });

  test("lines written later with that text resolve too", async () => {
    const household = await setUpHousehold();
    await household.callTool("resolve_ingredient", { text: "beurre", item: "butter" });

    const created = await household.callTool("create_recipe", {
      title: "Toast",
      baseServings: 2,
      ingredients: ["1 tbsp softened beurre"],
    });

    expect(created).toMatchObject({
      ok: true,
      value: { ingredients: [{ item: "butter" }], allergens: { kind: "known", allergens: ["milk"] } },
    });
  });

  test("refuses a text with no letter or digit", async () => {
    const household = await setUpHousehold();

    const resolved = await household.callTool("resolve_ingredient", { text: "---", item: "butter" });

    expect(resolved).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  test("refuses a text that already names another Item", async () => {
    const household = await setUpHousehold();

    const resolved = await household.callTool("resolve_ingredient", { text: "Butter", item: "olive_oil" });

    expect(resolved).toMatchObject({ ok: false, error: { code: "name_in_use" } });
  });

  test("refuses an Item the catalogue does not have", async () => {
    const household = await setUpHousehold();

    const resolved = await household.callTool("resolve_ingredient", { text: "beurre", item: "household:7" });

    expect(resolved).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("creating an Item from a group", () => {
  test("adds the Item and resolves every line it names, giving those Recipes its Allergens", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", {
      title: "Bibimbap",
      baseServings: 4,
      ingredients: ["2 cups rice", "2 tbsp gochujang"],
    });
    await household.callTool("create_recipe", {
      title: "Tteokbokki",
      baseServings: 2,
      ingredients: ["3 tbsp Korean red pepper paste", "1 tbsp sugar"],
    });

    const created = await household.callTool("create_item", {
      name: "Gochujang",
      section: "international",
      allergens: ["wheat", "soy"],
      unitFamily: "volume",
      aliases: ["korean red pepper paste"],
    });

    expect(created).toEqual({
      ok: true,
      value: {
        id: "household:1",
        name: "Gochujang",
        aliases: ["korean red pepper paste"],
        section: "international",
        allergens: ["wheat", "soy"],
        unitFamily: "volume",
      },
    });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: true,
      value: {
        ingredients: [{ item: "rice" }, { item: "household:1" }],
        allergens: { kind: "known", allergens: ["wheat", "soy"] },
      },
    });
    expect(await household.callTool("get_recipe", { id: 2 })).toMatchObject({
      ok: true,
      value: { allergens: { kind: "known", allergens: ["wheat", "soy"] } },
    });
    expect(await household.callTool("list_unresolved_ingredients", {})).toEqual({ ok: true, value: [] });
  });

  test("needs its Allergens stated, so leaving them out never makes a Recipe look safe", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { title: "Tea", baseServings: 1, ingredients: ["1 tsp matcha"] });

    const created = await household.callTool("create_item", {
      name: "matcha",
      section: "beverages",
      unitFamily: "volume",
    });

    expect(created).toMatchObject({ ok: false, error: { code: "invalid_input", issues: [{ path: "allergens" }] } });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: true,
      value: { allergens: { kind: "unknown" } },
    });
  });

  test("a created Item stated to have no Allergens makes its Recipes' Allergens known", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { title: "Tea", baseServings: 1, ingredients: ["1 tsp matcha"] });

    await household.callTool("create_item", {
      name: "matcha",
      section: "beverages",
      allergens: [],
      unitFamily: "volume",
    });

    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: true,
      value: { allergens: { kind: "known", allergens: [] } },
    });
  });

  test("refuses a name or alias that already names an Item", async () => {
    const household = await setUpHousehold();

    const named = await household.callTool("create_item", {
      name: "eggs",
      section: "dairy",
      allergens: ["egg"],
      unitFamily: "count",
    });
    const aliased = await household.callTool("create_item", {
      name: "duck egg",
      section: "dairy",
      allergens: ["egg"],
      unitFamily: "count",
      aliases: ["Egg"],
    });

    expect(named).toMatchObject({ ok: false, error: { code: "name_in_use" } });
    expect(aliased).toMatchObject({ ok: false, error: { code: "name_in_use" } });
    expect(await household.callTool("list_items", {})).not.toMatchObject({
      value: expect.arrayContaining([expect.objectContaining({ name: "duck egg" })]),
    });
  });

  test("is listed with the shipped Items", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_item", {
      name: "matcha",
      section: "beverages",
      allergens: [],
      unitFamily: "volume",
    });
    await household.callTool("resolve_ingredient", { text: "beurre", item: "butter" });

    const listed = await household.callTool("list_items", {});

    expect(listed).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        { id: "household:1", name: "matcha", aliases: [], section: "beverages", allergens: [], unitFamily: "volume" },
        expect.objectContaining({ id: "butter", aliases: expect.arrayContaining(["beurre"]) }),
      ]),
    });
  });
});
