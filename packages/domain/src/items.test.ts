import { describe, expect, test } from "bun:test";
import { ITEM_IDS, ITEMS, type Item, ItemCatalogue, matchItem } from "./items";

/** Every key the catalogue had shipped before the starter catalogue. Stored Ingredients refer to them. */
const SHIPPED_KEYS = [
  "garlic",
  "onion",
  "red_onion",
  "green_onion",
  "shallot",
  "leek",
  "ginger",
  "carrot",
  "celery",
  "potato",
  "sweet_potato",
  "tomato",
  "cherry_tomato",
  "bell_pepper",
  "jalapeno",
  "zucchini",
  "eggplant",
  "cucumber",
  "broccoli",
  "cauliflower",
  "cabbage",
  "spinach",
  "kale",
  "lettuce",
  "mushroom",
  "corn",
  "green_bean",
  "avocado",
  "lemon",
  "lime",
  "apple",
  "banana",
  "basil",
  "cilantro",
  "parsley",
  "thyme",
  "rosemary",
  "mint",
  "dill",
  "chives",
  "chicken_breast",
  "chicken_thigh",
  "whole_chicken",
  "ground_beef",
  "ground_pork",
  "ground_turkey",
  "beef_steak",
  "stewing_beef",
  "pork_chop",
  "pork_tenderloin",
  "bacon",
  "salmon",
  "cod",
  "tuna",
  "anchovy",
  "shrimp",
  "mussels",
  "scallop",
  "egg",
  "milk",
  "butter",
  "heavy_cream",
  "sour_cream",
  "yogurt",
  "cheddar",
  "mozzarella",
  "parmesan",
  "feta",
  "cream_cheese",
  "ghee",
  "tofu",
  "frozen_peas",
  "edamame",
  "rice",
  "brown_rice",
  "pasta",
  "egg_noodles",
  "rice_noodles",
  "couscous",
  "bulgur",
  "quinoa",
  "rolled_oats",
  "dried_lentils",
  "chickpeas",
  "black_beans",
  "kidney_beans",
  "canned_tomatoes",
  "tomato_paste",
  "coconut_milk",
  "olive_oil",
  "vegetable_oil",
  "sesame_oil",
  "peanut_butter",
  "honey",
  "maple_syrup",
  "white_wine",
  "red_wine",
  "water",
  "flour",
  "sugar",
  "brown_sugar",
  "baking_powder",
  "baking_soda",
  "cornstarch",
  "vanilla_extract",
  "almonds",
  "walnuts",
  "pecans",
  "cashews",
  "pine_nuts",
  "peanuts",
  "sesame_seeds",
  "panko",
  "raisins",
  "salt",
  "black_pepper",
  "cumin",
  "paprika",
  "chili_powder",
  "chili_flakes",
  "cinnamon",
  "oregano",
  "turmeric",
  "ground_coriander",
  "bay_leaf",
  "garam_masala",
  "mustard_seeds",
  "dijon_mustard",
  "mustard",
  "mayonnaise",
  "ketchup",
  "soy_sauce",
  "tamari",
  "fish_sauce",
  "oyster_sauce",
  "hoisin_sauce",
  "miso",
  "tahini",
  "worcestershire_sauce",
  "rice_vinegar",
  "red_wine_vinegar",
  "white_wine_vinegar",
  "balsamic_vinegar",
  "sriracha",
];

describe("the Item catalogue", () => {
  test("holds a few hundred Items", () => {
    expect(ITEMS.length).toBeGreaterThanOrEqual(300);
  });

  test("never drops a key it has shipped", () => {
    expect(SHIPPED_KEYS.filter((key) => !(ITEM_IDS as readonly string[]).includes(key))).toEqual([]);
  });

  test("every name and alias matches its own Item, so none is shared by two", () => {
    const mismatched = ITEMS.flatMap((item) =>
      [item.name, ...item.aliases]
        .map((name) => ({ name, expected: item.id, matched: matchItem(name) }))
        .filter(({ expected, matched }) => matched !== expected),
    );
    expect(mismatched).toEqual([]);
  });
});

describe("a Household's Item catalogue", () => {
  const gochujang: Item = {
    id: "household:1",
    name: "gochujang",
    aliases: ["korean chili paste"],
    section: "international",
    allergens: ["soy", "wheat"],
    unitFamily: "volume",
  };
  const catalogue = new ItemCatalogue(
    [gochujang],
    [
      { item: "butter", alias: "beurre" },
      { item: "household:1", alias: "red pepper paste" },
    ],
  );

  test("matches the Household's Items by name and alias, ignoring case, plurals and descriptive words", () => {
    expect(catalogue.match("Gochujang")).toBe("household:1");
    expect(catalogue.match("korean chili pastes")).toBe("household:1");
    expect(catalogue.match("red pepper paste")).toBe("household:1");
  });

  test("matches an alias the Household gave a shipped Item", () => {
    expect(catalogue.match("softened beurre")).toBe("butter");
    expect(catalogue.match("garlic")).toBe("garlic");
  });

  test("lists a shipped Item with the Household's aliases added", () => {
    expect(catalogue.item("butter")?.aliases).toContain("beurre");
    expect(catalogue.item("household:1")).toEqual({
      ...gochujang,
      aliases: ["korean chili paste", "red pepper paste"],
    });
    expect(catalogue.items).toHaveLength(ITEMS.length + 1);
  });

  test("an alias of the Household's wins over the shipped Item of that name", () => {
    const overriding = new ItemCatalogue([gochujang], [{ item: "household:1", alias: "sriracha" }]);

    expect(overriding.match("sriracha")).toBe("household:1");
  });

  test("names the Item a text already is, without dropping descriptive words", () => {
    expect(catalogue.named("Beurre")).toBe("butter");
    expect(catalogue.named("melted beurre")).toBeNull();
  });

  test("the shipped catalogue alone knows nothing of a Household", () => {
    expect(matchItem("gochujang")).toBeNull();
    expect(new ItemCatalogue().item("household:1")).toBeUndefined();
  });
});
