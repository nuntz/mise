import { describe, expect, test } from "bun:test";
import { buildGroceryList, type GroceryDemand, type GroceryRecipe, type GroceryStaple } from "./grocery";
import { parseIngredient } from "./ingredients";
import type { ItemId } from "./items";
import type { IngredientUnit } from "./units";

/** A Recipe whose Ingredients are read from the lines given, as a hand-entered one's are. */
function recipe(id: number, baseServings: number, lines: string[]): GroceryRecipe {
  return { id, title: `Recipe ${id}`, baseServings, ingredients: lines.map((line) => parseIngredient(line)) };
}

function demand(fields: Partial<GroceryDemand>): GroceryDemand {
  return { slots: [], recipes: [], staples: [], units: "metric", ...fields };
}

const exactly = (value: number, unit: IngredientUnit | null) => ({ amount: { min: value, max: value }, unit });

describe("buildGroceryList", () => {
  test("scales each Recipe to the Servings it is cooked for, and merges the same Item", () => {
    const lines = buildGroceryList(
      demand({
        recipes: [recipe(1, 4, ["400 g rice"]), recipe(2, 2, ["100 g rice"])],
        slots: [
          { recipeId: 1, servings: 2 },
          { recipeId: 2, servings: 4 },
        ],
      }),
    );

    expect(lines).toEqual([
      {
        origin: "recipe",
        item: "rice",
        text: null,
        amounts: [{ amount: { min: 400, max: 400 }, unit: "g" }],
        unmeasured: false,
        recipeIds: [1, 2],
      },
    ]);
  });

  /** The amounts the Week needs of each Item, for one Slot of each Recipe at its base Servings. */
  function amountsOf(units: GroceryDemand["units"], ...lines: string[][]) {
    const recipes = lines.map((recipeLines, index) => recipe(index + 1, 1, recipeLines));
    const slots = recipes.map((one) => ({ recipeId: one.id, servings: 1 }));
    return Object.fromEntries(
      buildGroceryList(demand({ recipes, slots, units })).map((need) => [need.item ?? need.text, need.amounts]),
    );
  }

  test("converts mass and volume into metric units, in grams and millilitres up to a kilo or a litre", () => {
    expect(
      amountsOf("metric", ["1 lb rice", "1 cup milk", "1 kg flour"], ["200 g rice", "250 ml milk", "500 g flour"]),
    ).toEqual({
      rice: [exactly(654, "g")],
      milk: [exactly(487, "ml")],
      flour: [exactly(1.5, "kg")],
    });
  });

  test("converts into imperial units: ounces to the pound, teaspoons and tablespoons to the quarter cup", () => {
    expect(
      amountsOf(
        "imperial",
        ["500 g chicken breast", "1 tbsp olive oil", "100 g parmesan", "250 ml milk", "1 ml salt"],
        ["1 tsp olive oil"],
      ),
    ).toEqual({
      chicken_breast: [exactly(1.1, "lb")],
      olive_oil: [exactly(1.33, "tbsp")],
      parmesan: [exactly(3.53, "oz")],
      milk: [exactly(1.06, "cup")],
      salt: [exactly(0.2, "tsp")],
    });
  });

  test("never converts between mass and volume, nor between counts of different things", () => {
    expect(
      amountsOf(
        "metric",
        ["1 cup sugar", "2 cloves garlic", "a pinch of salt"],
        ["100 g sugar", "1 head garlic", "1 tsp salt"],
      ),
    ).toEqual({
      sugar: [exactly(237, "ml"), exactly(100, "g")],
      garlic: [exactly(2, "clove"), exactly(1, "head")],
      salt: [exactly(1, "pinch"), exactly(5, "ml")],
    });
  });

  test("keeps Unresolved Ingredients as written, each line once, and says when an Item is used unmeasured", () => {
    const lines = buildGroceryList(
      demand({
        recipes: [
          recipe(1, 2, ["2 tbsp gochujang", "salt to taste"]),
          recipe(2, 2, ["2 tbsp gochujang", "1 tsp salt", "3 tbsp Gochujang"]),
        ],
        slots: [
          { recipeId: 1, servings: 4 },
          { recipeId: 2, servings: 2 },
          // Nobody eats it, so it needs nothing.
          { recipeId: 2, servings: 0 },
        ],
      }),
    );

    expect(lines).toEqual([
      { origin: "recipe", item: null, text: "2 tbsp gochujang", amounts: [], unmeasured: false, recipeIds: [1, 2] },
      { origin: "recipe", item: "salt", text: null, amounts: [exactly(5, "ml")], unmeasured: true, recipeIds: [1, 2] },
      { origin: "recipe", item: null, text: "3 tbsp Gochujang", amounts: [], unmeasured: false, recipeIds: [2] },
    ]);
  });

  test("adds ranges end to end, and keeps counts of the same thing together", () => {
    expect(amountsOf("metric", ["2–3 eggs", "1 can chickpeas"], ["1 egg", "2 cans chickpeas"])).toEqual({
      egg: [{ amount: { min: 3, max: 4 }, unit: null }],
      chickpeas: [exactly(3, "can")],
    });
  });
});

describe("buildGroceryList with Staples", () => {
  const staple = (item: ItemId, fields: Partial<GroceryStaple> = {}): GroceryStaple => ({
    item,
    status: "stocked",
    alwaysBuy: false,
    qtyPerShop: null,
    ...fields,
  });
  const dozen = { amount: { min: 12, max: 12 }, unit: null };

  test("adds those low, out or always bought, at their usual quantity", () => {
    const lines = buildGroceryList(
      demand({
        staples: [
          staple("egg", { status: "low", qtyPerShop: dozen }),
          staple("rice", { status: "out" }),
          staple("milk", { alwaysBuy: true, qtyPerShop: exactly(2, "l") }),
          staple("flour"),
        ],
      }),
    );

    expect(lines).toEqual([
      { origin: "staple", item: "egg", text: null, amounts: [dozen], unmeasured: false, recipeIds: [] },
      { origin: "staple", item: "rice", text: null, amounts: [], unmeasured: false, recipeIds: [] },
      { origin: "staple", item: "milk", text: null, amounts: [exactly(2, "l")], unmeasured: false, recipeIds: [] },
    ]);
  });

  test("the Recipes' demand for the Item replaces the usual quantity", () => {
    const lines = buildGroceryList(
      demand({
        recipes: [recipe(1, 2, ["3 eggs"])],
        slots: [{ recipeId: 1, servings: 4 }],
        staples: [staple("egg", { alwaysBuy: true, qtyPerShop: dozen })],
      }),
    );

    expect(lines).toEqual([
      { origin: "recipe", item: "egg", text: null, amounts: [exactly(6, null)], unmeasured: false, recipeIds: [1] },
    ]);
  });

  test("Ingredients of a Staple's Item without an amount add nothing", () => {
    const lines = buildGroceryList(
      demand({
        recipes: [recipe(1, 1, ["salt to taste", "olive oil, for drizzling", "1 tbsp olive oil", "black pepper"])],
        slots: [{ recipeId: 1, servings: 1 }],
        staples: [staple("salt"), staple("olive_oil"), staple("black_pepper", { status: "out", qtyPerShop: dozen })],
      }),
    );

    expect(lines).toEqual([
      // What it measures is still needed, but no longer "and some to taste": the Staple covers that.
      {
        origin: "recipe",
        item: "olive_oil",
        text: null,
        amounts: [exactly(15, "ml")],
        unmeasured: false,
        recipeIds: [1],
      },
      // Out, so bought at its usual quantity.
      { origin: "staple", item: "black_pepper", text: null, amounts: [dozen], unmeasured: false, recipeIds: [] },
    ]);
  });
});
