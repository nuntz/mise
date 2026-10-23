import { describe, expect, test } from "bun:test";
import { parseIngredient, scaleIngredient } from "./ingredients";

/** raw line → [amount (a number or [min, max]), unit, name, note, item]. */
type Row = [string, number | [number, number] | null, string | null, string, string | null, string | null];

/** One test per row, named after the raw line. */
function cases(rows: Row[]) {
  test.each(rows)("%s", (raw, amount, unit, name, note, item) => check([raw, amount, unit, name, note, item]));
}

function check([raw, amount, unit, name, note, item]: Row) {
  const [min, max] = typeof amount === "number" ? [amount, amount] : (amount ?? []);
  expect<unknown>(parseIngredient(raw)).toEqual({
    raw,
    amount: min === undefined ? null : { min, max: max as number },
    unit,
    name,
    note,
    item,
  });
}

describe("amounts", () => {
  cases([
    ["2 cloves garlic, minced", 2, "clove", "garlic", "minced", "garlic"],
    ["3 eggs", 3, null, "eggs", null, "egg"],
    ["1.5 kg potatoes", 1.5, "kg", "potatoes", null, "potato"],
    ["0.25 cup milk", 0.25, "cup", "milk", null, "milk"],
    [".5 tsp salt", 0.5, "tsp", "salt", null, "salt"],
    ["1/2 cup sugar", 0.5, "cup", "sugar", null, "sugar"],
    ["3/4 tsp cumin", 0.75, "tsp", "cumin", null, "cumin"],
    ["½ cup sugar", 0.5, "cup", "sugar", null, "sugar"],
    ["¼ tsp cinnamon", 0.25, "tsp", "cinnamon", null, "cinnamon"],
    ["⅛ tsp cinnamon", 0.125, "tsp", "cinnamon", null, "cinnamon"],
    ["1 1/2 cups flour", 1.5, "cup", "flour", null, "flour"],
    ["1½ cups flour", 1.5, "cup", "flour", null, "flour"],
    ["1 ½ cups flour", 1.5, "cup", "flour", null, "flour"],
    ["1-1/2 cups flour", 1.5, "cup", "flour", null, "flour"],
    ["2 3⁄4 cups flour", 2.75, "cup", "flour", null, "flour"],
    ["2-3 tbsp olive oil", [2, 3], "tbsp", "olive oil", null, "olive_oil"],
    ["2 – 3 tbsp olive oil", [2, 3], "tbsp", "olive oil", null, "olive_oil"],
    ["2 to 3 tbsp olive oil", [2, 3], "tbsp", "olive oil", null, "olive_oil"],
    ["1/2-1 tsp chili flakes", [0.5, 1], "tsp", "chili flakes", null, "chili_flakes"],
    ["1 to 1 ½ cups water", [1, 1.5], "cup", "water", null, "water"],
    ["a pinch of salt", 1, "pinch", "salt", null, "salt"],
    ["an onion", 1, null, "onion", null, "onion"],
    ["salt", null, null, "salt", null, "salt"],
    ["1/0 cup flour", null, null, "1/0 cup flour", null, null],
  ]);
});

describe("units", () => {
  cases([
    ["200g spaghetti", 200, "g", "spaghetti", null, "pasta"],
    ["200 grams spaghetti", 200, "g", "spaghetti", null, "pasta"],
    ["1kg chicken thighs", 1, "kg", "chicken thighs", null, "chicken_thigh"],
    ["500 ml milk", 500, "ml", "milk", null, "milk"],
    ["1 L milk", 1, "l", "milk", null, "milk"],
    ["1 litre water", 1, "l", "water", null, "water"],
    ["1 lb ground beef", 1, "lb", "ground beef", null, "ground_beef"],
    ["2 lbs. ground beef", 2, "lb", "ground beef", null, "ground_beef"],
    ["8 oz. cream cheese", 8, "oz", "cream cheese", null, "cream_cheese"],
    ["1 T butter", 1, "tbsp", "butter", null, "butter"],
    ["1 t salt", 1, "tsp", "salt", null, "salt"],
    ["2 Tbsp. soy sauce", 2, "tbsp", "soy sauce", null, "soy_sauce"],
    ["2 tablespoons soy sauce", 2, "tbsp", "soy sauce", null, "soy_sauce"],
    ["1 tsp. vanilla extract", 1, "tsp", "vanilla extract", null, "vanilla_extract"],
    ["2 c. flour", 2, "cup", "flour", null, "flour"],
    ["4 fl oz white wine", 4, "fl_oz", "white wine", null, "white_wine"],
    ["1 pint cherry tomatoes", 1, "pint", "cherry tomatoes", null, "cherry_tomato"],
    ["1 dash Worcestershire sauce", 1, "dash", "Worcestershire sauce", null, "worcestershire_sauce"],
    ["1 can chickpeas", 1, "can", "chickpeas", null, "chickpeas"],
    ["2 tins chickpeas", 2, "can", "chickpeas", null, "chickpeas"],
    ["1 bunch cilantro", 1, "bunch", "cilantro", null, "cilantro"],
    ["1 head cauliflower", 1, "head", "cauliflower", null, "cauliflower"],
    ["2 stalks celery", 2, "stalk", "celery", null, "celery"],
    ["3 sprigs thyme", 3, "sprig", "thyme", null, "thyme"],
    ["4 slices bacon", 4, "slice", "bacon", null, "bacon"],
    ["1 package firm tofu", 1, "package", "firm tofu", null, "tofu"],
    ["2 cloves of garlic", 2, "clove", "garlic", null, "garlic"],
    ["2 garlic cloves", 2, "clove", "garlic", null, "garlic"],
    ["1 large tomato", 1, null, "large tomato", null, "tomato"],
    ["1 lemon", 1, null, "lemon", null, "lemon"],
    ["2 limes", 2, null, "limes", null, "lime"],
  ]);
});

describe("notes", () => {
  cases([
    ["1 onion, finely chopped", 1, null, "onion", "finely chopped", "onion"],
    ["2 cups flour (sifted)", 2, "cup", "flour", "sifted", "flour"],
    [
      "1 (14 oz) can black beans, drained and rinsed",
      1,
      "can",
      "black beans",
      "14 oz; drained and rinsed",
      "black_beans",
    ],
    ["1 (400 ml) can coconut milk", 1, "can", "coconut milk", "400 ml", "coconut_milk"],
    ["salt, to taste", null, null, "salt", "to taste", "salt"],
    ["black pepper to taste", null, null, "black pepper", "to taste", "black_pepper"],
    ["fresh basil, for garnish", null, null, "fresh basil", "for garnish", "basil"],
    ["chopped parsley for serving", null, null, "chopped parsley", "for serving", "parsley"],
    ["1/4 cup walnuts (optional)", 0.25, "cup", "walnuts", "optional", "walnuts"],
    ["2 tbsp butter, divided", 2, "tbsp", "butter", "divided", "butter"],
    ["1 cup cheddar, grated, plus more for topping", 1, "cup", "cheddar", "grated, plus more for topping", "cheddar"],
    ["3 carrots - peeled and diced", 3, null, "carrots", "peeled and diced", "carrot"],
  ]);
});

describe("Item matching", () => {
  cases([
    ["2 Large Eggs", 2, null, "Large Eggs", null, "egg"],
    ["3 EGGS", 3, null, "EGGS", null, "egg"],
    ["1 cup Frozen Peas", 1, "cup", "Frozen Peas", null, "frozen_peas"],
    ["2 cups baby spinach", 2, "cup", "baby spinach", null, "spinach"],
    ["4 scallions", 4, null, "scallions", null, "green_onion"],
    ["2 tomatoes", 2, null, "tomatoes", null, "tomato"],
    ["1 cup blueberries", 1, "cup", "blueberries", null, "blueberry"],
    ["2 cups fresh cherry tomatoes", 2, "cup", "fresh cherry tomatoes", null, "cherry_tomato"],
    ["1 lb boneless skinless chicken breasts", 1, "lb", "boneless skinless chicken breasts", null, "chicken_breast"],
    ["1 tbsp freshly grated ginger", 1, "tbsp", "freshly grated ginger", null, "ginger"],
    ["1 cup heavy whipping cream", 1, "cup", "heavy whipping cream", null, "heavy_cream"],
    ["2 tbsp extra-virgin olive oil", 2, "tbsp", "extra-virgin olive oil", null, "olive_oil"],
    ["1 tsp dried oregano", 1, "tsp", "dried oregano", null, "oregano"],
    ["2 jalapeños", 2, null, "jalapeños", null, "jalapeno"],
    ["1 cup sour cream", 1, "cup", "sour cream", null, "sour_cream"],
    ["1 cup ice cream", 1, "cup", "ice cream", null, null],
    ["2 slices bread", 2, "slice", "bread", null, null],
    ["salt and pepper", null, null, "salt and pepper", null, null],
    ["juice of 1 lemon", null, null, "juice of 1 lemon", null, null],
    ["1 tsp crushed red pepper", 1, "tsp", "crushed red pepper", null, "chili_flakes"],
    ["", null, null, "", null, null],
  ]);
});

describe("scaling for the amount cooked", () => {
  const scaled = (raw: string, by: number) => scaleIngredient(parseIngredient(raw), by).amount;

  test("by 1 the amount stays exactly as written", () => {
    expect(scaled("0.3 cup milk", 1)).toEqual({ min: 0.3, max: 0.3 });
  });

  test("cups and spoons round to the nearest quarter or third", () => {
    expect(scaled("1 cup rice", 1.5)).toEqual({ min: 1.5, max: 1.5 });
    expect(scaled("1 cup rice", 4 / 3)).toEqual({ min: 4 / 3, max: 4 / 3 });
    expect(scaled("1 tsp cumin", 0.7)).toEqual({ min: 2 / 3, max: 2 / 3 });
  });

  test("whole things, counted or in pieces, round to halves", () => {
    expect(scaled("3 eggs", 1.5)).toEqual({ min: 4.5, max: 4.5 });
    expect(scaled("3 bell peppers", 1.75)).toEqual({ min: 5, max: 5 });
    expect(scaled("2 cloves garlic", 0.7)).toEqual({ min: 1.5, max: 1.5 });
    expect(scaled("1 onion", 0.3)).toEqual({ min: 0.5, max: 0.5 });
  });

  test("a small amount never rounds away to nothing", () => {
    expect(scaled("1 pinch salt", 0.1)).toEqual({ min: 0.125, max: 0.125 });
  });

  test("grams and millilitres round to whole numbers, and to fives from 100", () => {
    expect(scaled("250 g flour", 1.5)).toEqual({ min: 375, max: 375 });
    expect(scaled("400 ml stock", 1.33)).toEqual({ min: 530, max: 530 });
    expect(scaled("15 g butter", 1.5)).toEqual({ min: 23, max: 23 });
  });

  test("kilos and litres keep one decimal", () => {
    expect(scaled("1.5 kg pork shoulder", 1.5)).toEqual({ min: 2.3, max: 2.3 });
  });

  test("a range scales both ends", () => {
    expect(scaled("2-3 tbsp soy sauce", 2)).toEqual({ min: 4, max: 6 });
  });

  test("a line with no amount is left as it is", () => {
    const ingredient = parseIngredient("salt to taste");
    expect(scaleIngredient(ingredient, 2)).toEqual(ingredient);
  });
});
