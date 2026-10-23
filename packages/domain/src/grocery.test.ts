import { describe, expect, test } from "bun:test";
import { buildGroceryList, type GroceryDemand, type GroceryRecipe } from "./grocery";
import { parseIngredient } from "./ingredients";
import type { IngredientUnit } from "./units";

/** A Recipe whose Ingredients are read from the lines given, as a hand-entered one's are. */
function recipe(id: number, baseServings: number, lines: string[]): GroceryRecipe {
  return { id, title: `Recipe ${id}`, baseServings, ingredients: lines.map((line) => parseIngredient(line)) };
}

function demand(fields: Partial<GroceryDemand>): GroceryDemand {
  return { slots: [], recipes: [], units: "metric", ...fields };
}

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
  const exactly = (value: number, unit: IngredientUnit | null) => ({ amount: { min: value, max: value }, unit });

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
      { item: null, text: "2 tbsp gochujang", amounts: [], unmeasured: false, recipeIds: [1, 2] },
      { item: "salt", text: null, amounts: [exactly(5, "ml")], unmeasured: true, recipeIds: [1, 2] },
      { item: null, text: "3 tbsp Gochujang", amounts: [], unmeasured: false, recipeIds: [2] },
    ]);
  });

  test("adds ranges end to end, and keeps counts of the same thing together", () => {
    expect(amountsOf("metric", ["2–3 eggs", "1 can chickpeas"], ["1 egg", "2 cans chickpeas"])).toEqual({
      egg: [{ amount: { min: 3, max: 4 }, unit: null }],
      chickpeas: [exactly(3, "can")],
    });
  });
});
