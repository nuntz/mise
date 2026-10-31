import { describe, expect, test } from "bun:test";
import { parseIngredient, scaledLine, scaledLines, scaleIngredient } from "./ingredients";

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

describe("a Recipe's lines for the number eating", () => {
  const recipe = (lines: string[], readyMade: boolean) => ({
    ingredients: lines.map((line) => parseIngredient(line)),
    baseServings: 4,
    readyMade,
  });

  test("a Ready-made dish is heated whole: never part of a package", () => {
    const dumplings = recipe(["1 package frozen vegetable dumplings"], true);
    expect(scaledLines(dumplings, 3, "en-CA")).toEqual(["1 package frozen vegetable dumplings"]);
    expect(scaledLines(dumplings, 6, "en-CA")).toEqual(["2 packages frozen vegetable dumplings"]);
  });

  test("a Ready-made dish's range rounds up at both ends, whatever its unit", () => {
    expect(scaledLines(recipe(["1-2 rotisserie chickens"], true), 3, "en-CA")).toEqual(["1–2 rotisserie chickens"]);
  });

  test("an ordinary Recipe still uses part of a can", () => {
    expect(scaledLines(recipe(["1 can tomatoes"], false), 3, "en-CA")).toEqual(["½ can tomatoes"]);
  });
});

describe("a scaled line agrees with its amount", () => {
  const line = (raw: string, by: number, whole = false) => scaledLine(parseIngredient(raw), by, "en-CA", whole);

  test("its unit is made plural, in the cook's own spelling", () => {
    expect(line("1 can tomatoes", 2)).toBe("2 cans tomatoes");
    expect(line("1 tin tomatoes", 2)).toBe("2 tins tomatoes");
    expect(line("1 pack tofu", 2)).toBe("2 packs tofu");
    expect(line("1 clove garlic", 3)).toBe("3 cloves garlic");
  });

  test("a unit at the end of the name is the word made plural", () => {
    expect(line("1 garlic clove", 2)).toBe("2 garlic cloves");
    expect(line("4 garlic cloves, minced", 0.25)).toBe("1 garlic clove, minced");
  });

  test("with no unit, the thing counted is made plural", () => {
    expect(line("1 onion", 2)).toBe("2 onions");
    expect(line("an egg", 3)).toBe("3 eggs");
    expect(line("1 large onion, diced", 2)).toBe("2 large onions, diced");
    expect(line("1 peach", 2)).toBe("2 peaches");
    expect(line("1 berry", 2)).toBe("2 berries");
  });

  test("scaled down, the thing counted is made singular", () => {
    expect(line("2 onions", 0.5)).toBe("1 onion");
    expect(line("4 peaches", 0.25)).toBe("1 peach");
    expect(line("2 berries", 0.5)).toBe("1 berry");
  });

  test("a thing already plural, or already singular, stays as written", () => {
    expect(line("2 eggs", 2)).toBe("4 eggs");
    expect(line("1 onion", 0.5)).toBe("½ onion");
    // A unit Mise doesn't know, so the name is taken as counted: it is plural already.
    expect(line("1 bag frozen peas", 2)).toBe("2 bag frozen peas");
    expect(line("1 box tomatoes", 2)).toBe("2 box tomatoes");
    expect(line("2 bags frozen potato", 0.5)).toBe("1 bags frozen potato");
  });

  test("irregular words have their own plurals, even before the name", () => {
    expect(line("1 potato", 2)).toBe("2 potatoes");
    expect(line("2 tomatoes", 0.5)).toBe("1 tomato");
    expect(line("1 bay leaf", 2)).toBe("2 bay leaves");
    expect(line("2 leaves basil", 0.5)).toBe("1 leaf basil");
    expect(line("1 loaf sourdough", 2)).toBe("2 loaves sourdough");
  });

  test("a potato or tomato before the name says what kind, not how many", () => {
    expect(line("1 potato bun", 2)).toBe("2 potato buns");
    expect(line("2 tomato wedges", 0.5)).toBe("1 tomato wedge");
  });

  test("a Ready-made dish's package agrees too", () => {
    expect(line("1 package frozen vegetable dumplings", 1.5, true)).toBe("2 packages frozen vegetable dumplings");
  });

  test("a line rewritten from its parts agrees too", () => {
    expect(line("(about) 1 cup flour", 2)).toBe("2 cups flour, about");
    expect(line("(about) 1 onion", 2)).toBe("2 onions, about");
  });

  test("unscaled, the line is exactly as written", () => {
    expect(line("1 cans  tomatoes", 1)).toBe("1 cans  tomatoes");
    expect(line("salt to taste", 2)).toBe("salt to taste");
  });

  test("scaled down, a plural unit is made singular", () => {
    expect(line("2 cups flour", 0.5)).toBe("1 cup flour");
    expect(line("2 cans tomatoes", 0.25)).toBe("½ can tomatoes");
  });

  test("more than one at most is plural", () => {
    expect(line("1 cup flour", 1.5)).toBe("1½ cups flour");
    expect(line("1 cup flour", 0.5)).toBe("½ cup flour");
    expect(line("1–2 cups flour", 0.5)).toBe("½–1 cup flour");
    expect(line("1 cup flour", 2.5)).toBe("2½ cups flour");
  });

  test("symbols and abbreviations are written the same for one or many", () => {
    expect(line("1 tbsp oil", 2)).toBe("2 tbsp oil");
    expect(line("100 g butter", 2)).toBe("200 g butter");
    expect(line("1 lb beef", 2)).toBe("2 lb beef");
    expect(line("2 lbs beef", 0.5)).toBe("1 lbs beef");
    expect(line("1 T. sugar", 2)).toBe("2 T. sugar");
  });

  test("a name after a unit, and the note, stay as written", () => {
    expect(line("1 can tomatoes, drained", 2)).toBe("2 cans tomatoes, drained");
    expect(line("1 (14 oz) can tomatoes", 2)).toBe("2 (14 oz) cans tomatoes");
  });
});
