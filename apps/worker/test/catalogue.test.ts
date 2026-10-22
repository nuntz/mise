import { env } from "cloudflare:workers";
import type { ItemId, Recipe, ToolResult } from "@mise/domain";
import { describe, expect, test } from "vitest";

async function setUpHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family" });
  return household;
}

/** The Recipe a tool call that is expected to succeed returned. */
function recipeOf(result: ToolResult<unknown>): Recipe {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as Recipe;
}

/** Common Ingredient lines, as recipe sites write them, and the Item each should resolve to. */
const COMMON_LINES: [line: string, item: ItemId][] = [
  ["3 cloves garlic, minced", "garlic"],
  ["1 large yellow onion, diced", "onion"],
  ["2 tbsp fresh lemon juice", "lemon"],
  ["1 tbsp bottled lime juice", "lime_juice"],
  ["1 lb boneless skinless chicken thighs", "chicken_thigh"],
  ["1 lb ground lamb", "ground_lamb"],
  ["4 slices prosciutto", "prosciutto"],
  ["8 oz shiitake mushrooms, stems removed", "shiitake_mushroom"],
  ["2 cups baby spinach", "spinach"],
  ["1 (15 oz) can black beans, drained and rinsed", "black_beans"],
  ["1 can (14 oz) coconut milk", "coconut_milk"],
  ["1 cup Arborio rice", "arborio_rice"],
  ["1 lb fresh pasta", "fresh_pasta"],
  ["1/2 cup chopped dried apricots", "dried_apricots"],
  ["1/2 cup chopped roasted red peppers", "roasted_red_peppers"],
  ["2 cups all-purpose flour", "flour"],
  ["1 cup whole wheat flour", "whole_wheat_flour"],
  ["1/2 cup almond flour", "almond_flour"],
  ["1 cup buttermilk", "buttermilk"],
  ["1 cup ricotta cheese", "ricotta"],
  ["1 cup shredded Monterey Jack cheese", "monterey_jack"],
  ["½ cup grated Parmesan", "parmesan"],
  ["2 tbsp unsalted butter", "butter"],
  ["1 tsp ground cumin", "cumin"],
  ["1/4 tsp ground nutmeg", "nutmeg"],
  ["1 tsp dried thyme", "thyme"],
  ["2 tbsp capers, drained", "capers"],
  ["1/2 cup Kalamata olives, pitted", "olive"],
  ["1/4 cup toasted pine nuts", "pine_nuts"],
  ["1/2 cup shelled pistachios", "pistachios"],
  ["1 tbsp apple cider vinegar", "apple_cider_vinegar"],
  ["2 tbsp fish sauce", "fish_sauce"],
  ["1 tbsp Worcestershire sauce", "worcestershire_sauce"],
  ["3 tbsp soy sauce", "soy_sauce"],
  ["2 tbsp oyster sauce", "oyster_sauce"],
  ["1 tbsp white miso paste", "miso"],
  ["6 oz lump crab meat", "crab"],
  ["1 lb large shrimp, peeled and deveined", "shrimp"],
  ["2 cups frozen corn", "corn"],
  ["1 tbsp cornstarch", "cornstarch"],
  ["1 cup panko breadcrumbs", "panko"],
  ["1/2 cup unsweetened shredded coconut", "shredded_coconut"],
  ["1/2 cup semi-sweet chocolate chips", "chocolate_chips"],
];

describe("the starter Item catalogue", () => {
  test("a fresh Household resolves common Ingredient lines", async () => {
    const household = await setUpHousehold();

    const recipe = recipeOf(
      await household.callTool("create_recipe", {
        title: "Everything",
        baseServings: 4,
        ingredients: COMMON_LINES.map(([line]) => line),
      }),
    );

    expect(recipe.ingredients.map((ingredient) => [ingredient.raw, ingredient.item])).toEqual(COMMON_LINES);
  });

  test("a dried form with no Item of its own stays Unresolved, not the fresh thing", async () => {
    const household = await setUpHousehold();

    const recipe = recipeOf(
      await household.callTool("create_recipe", {
        title: "Trail mix",
        baseServings: 4,
        ingredients: ["1/2 cup dried mango", "1/2 cup chopped dried figs"],
      }),
    );

    expect(recipe.ingredients.map((ingredient) => ingredient.item)).toEqual([null, null]);
  });

  test("a Caesar dressing's Allergens include its hidden sources", async () => {
    const household = await setUpHousehold();

    const recipe = recipeOf(
      await household.callTool("create_recipe", {
        title: "Caesar dressing",
        baseServings: 4,
        ingredients: [
          "2 anchovy fillets",
          "1 garlic clove",
          "1 egg yolk",
          "1 tsp Dijon mustard",
          "1 tsp Worcestershire sauce",
          "2 tbsp lemon juice",
          "1/2 cup olive oil",
          "1/4 cup grated Parmesan",
        ],
      }),
    );

    expect(recipe.allergens).toEqual({ kind: "known", allergens: ["milk", "egg", "fish", "mustard", "sulphite"] });
  });
});
