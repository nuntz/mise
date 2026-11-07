import { describe, expect, test } from "bun:test";
import { parseIngredient } from "./ingredients";
import { SHIPPED_ITEMS } from "./items";
import { type SearchableRecipe, searchRecipes } from "./search";

let nextId = 1;

function recipe(title: string, fields: Partial<Omit<SearchableRecipe, "ingredients">> & { lines?: string[] } = {}) {
  const { lines = [], ...rest } = fields;
  return {
    id: nextId++,
    title,
    tags: [],
    cuisine: null,
    mainProtein: null,
    course: null,
    ingredients: lines.map((line) => parseIngredient(line)),
    ...rest,
  } satisfies SearchableRecipe;
}

function titlesFound(recipes: SearchableRecipe[], query: string): string[] {
  return searchRecipes(recipes, query, SHIPPED_ITEMS).map((found) => found.title);
}

describe("searching Recipes", () => {
  test("finds a hyphenated title however the query spells it", () => {
    const recipes = [recipe("Beef and Broccoli Stir-Fry"), recipe("Pancakes")];

    for (const query of ["stir fry", "stir-fry", "Stir Fry"]) {
      expect(titlesFound(recipes, query)).toEqual(["Beef and Broccoli Stir-Fry"]);
    }
  });

  test("finds the words in any order, and each word added narrows what is found", () => {
    const recipes = [recipe("Curry, chicken"), recipe("Chicken soup"), recipe("Lentil curry")];

    expect(titlesFound(recipes, "chicken")).toEqual(["Chicken soup", "Curry, chicken"]);
    expect(titlesFound(recipes, "chicken curry")).toEqual(["Curry, chicken"]);
    expect(titlesFound(recipes, "chicken curry soup")).toEqual([]);
  });

  test("finds words in the tags, Ingredient lines, cuisine, main protein and Course as well as the title", () => {
    const recipes = [
      recipe("Weeknight noodles", {
        tags: ["Grandma's"],
        lines: ["200 g rice noodles", "2 tbsp fish sauce"],
        cuisine: "thai",
        mainProtein: "pork",
        course: "main",
      }),
      recipe("Garlic bread", { course: "side" }),
    ];

    expect(titlesFound(recipes, "grandma fish thai pork main")).toEqual(["Weeknight noodles"]);
    expect(titlesFound(recipes, "side")).toEqual(["Garlic bread"]);
  });

  test("finds a word from its first letters or from its singular, but a singular doesn't start another word", () => {
    const recipes = [
      recipe("Chicken with tomatoes"),
      recipe("Potato salad"),
      recipe("Peanut noodles"),
      recipe("Peas and carrots"),
    ];

    expect(titlesFound(recipes, "chick")).toEqual(["Chicken with tomatoes"]);
    expect(titlesFound(recipes, "tomatoe")).toEqual(["Chicken with tomatoes"]);
    expect(titlesFound(recipes, "tomatos")).toEqual(["Chicken with tomatoes"]);
    expect(titlesFound(recipes, "potatoes")).toEqual(["Potato salad"]);
    expect(titlesFound(recipes, "peas")).toEqual(["Peas and carrots"]);
    expect(titlesFound(recipes, "pea")).toEqual(["Peanut noodles", "Peas and carrots"]);
  });

  test("ignores apostrophes and accents on either side", () => {
    const recipes = [recipe("Grandma’s meatloaf"), recipe("Crème brûlée"), recipe("Jalapeno poppers")];

    expect(titlesFound(recipes, "grandma's")).toEqual(["Grandma’s meatloaf"]);
    expect(titlesFound(recipes, "grandmas")).toEqual(["Grandma’s meatloaf"]);
    expect(titlesFound(recipes, "creme brulee")).toEqual(["Crème brûlée"]);
    expect(titlesFound(recipes, "jalapeño")).toEqual(["Jalapeno poppers"]);
  });

  test("skips the small words of a spoken request, and a query of only those finds every Recipe", () => {
    const recipes = [recipe("Chicken and rice"), recipe("Fish tacos")];

    expect(titlesFound(recipes, "the chicken with rice recipe")).toEqual(["Chicken and rice"]);
    expect(titlesFound(recipes, "the")).toEqual(["Chicken and rice", "Fish tacos"]);
    expect(titlesFound(recipes, "")).toEqual(["Chicken and rice", "Fish tacos"]);
  });

  test("finds a Recipe by an Item it uses, whatever name its line gives the Item", () => {
    const recipes = [
      recipe("Garlic noodles", { lines: ["4 green onions, sliced", "1 cup rice"] }),
      recipe("Fried rice", { lines: ["2 scallions", "3 cups rice"] }),
      recipe("Plain rice", { lines: ["1 cup rice"] }),
    ];

    expect(titlesFound(recipes, "scallions")).toEqual(["Fried rice", "Garlic noodles"]);
    expect(titlesFound(recipes, "green onions")).toEqual(["Fried rice", "Garlic noodles"]);
    expect(titlesFound(recipes, "the green onions")).toEqual(["Fried rice", "Garlic noodles"]);
    expect(titlesFound(recipes, "scallions noodles")).toEqual(["Garlic noodles"]);
  });

  test("lists the Recipes whose title has every word first, then the others, each in title order", () => {
    const recipes = [
      recipe("Zucchini fritters", { tags: ["quick"] }),
      recipe("Quick pickles"),
      recipe("Apple crumble", { tags: ["quick"] }),
      recipe("Quick bread"),
    ];

    expect(titlesFound(recipes, "quick")).toEqual([
      "Quick bread",
      "Quick pickles",
      "Apple crumble",
      "Zucchini fritters",
    ]);
    expect(titlesFound(recipes, "")).toEqual(["Apple crumble", "Quick bread", "Quick pickles", "Zucchini fritters"]);
  });
});
