import { z } from "zod";

/** What a unit measures. Amounts convert within a family, never across. */
export const UNIT_FAMILIES = ["mass", "volume", "count"] as const;
export const UnitFamily = z.enum(UNIT_FAMILIES);
export type UnitFamily = z.infer<typeof UnitFamily>;

/**
 * Every unit an Ingredient can be measured in, with the spellings recipes use for it. Matched
 * ignoring case, except the one-letter `T` (tablespoon) and `t` (teaspoon). Stored Ingredients refer
 * to the keys, so never rename or remove one.
 */
const UNIT_TABLE = {
  mg: { family: "mass", aliases: ["mg", "milligram", "milligrams"] },
  g: { family: "mass", aliases: ["g", "gr", "gram", "grams", "gramme", "grammes"] },
  kg: { family: "mass", aliases: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"] },
  oz: { family: "mass", aliases: ["oz", "ounce", "ounces"] },
  lb: { family: "mass", aliases: ["lb", "lbs", "pound", "pounds"] },

  ml: { family: "volume", aliases: ["ml", "mls", "millilitre", "millilitres", "milliliter", "milliliters"] },
  cl: { family: "volume", aliases: ["cl", "centilitre", "centilitres", "centiliter", "centiliters"] },
  dl: { family: "volume", aliases: ["dl", "decilitre", "decilitres", "deciliter", "deciliters"] },
  l: { family: "volume", aliases: ["l", "litre", "litres", "liter", "liters"] },
  tsp: { family: "volume", aliases: ["t", "tsp", "tsps", "teaspoon", "teaspoons"] },
  tbsp: { family: "volume", aliases: ["T", "tbsp", "tbsps", "tbs", "tbl", "tablespoon", "tablespoons"] },
  cup: { family: "volume", aliases: ["c", "cup", "cups"] },
  fl_oz: { family: "volume", aliases: ["fl oz", "fl. oz", "fluid ounce", "fluid ounces"] },
  pint: { family: "volume", aliases: ["pt", "pint", "pints"] },
  quart: { family: "volume", aliases: ["qt", "quart", "quarts"] },
  gallon: { family: "volume", aliases: ["gal", "gallon", "gallons"] },
  pinch: { family: "volume", aliases: ["pinch", "pinches"] },
  dash: { family: "volume", aliases: ["dash", "dashes"] },

  piece: { family: "count", aliases: ["piece", "pieces", "pc", "pcs"] },
  clove: { family: "count", aliases: ["clove", "cloves"] },
  can: { family: "count", aliases: ["can", "cans", "tin", "tins"] },
  jar: { family: "count", aliases: ["jar", "jars"] },
  bottle: { family: "count", aliases: ["bottle", "bottles"] },
  package: { family: "count", aliases: ["package", "packages", "pkg", "pkgs", "packet", "packets", "pack", "packs"] },
  bunch: { family: "count", aliases: ["bunch", "bunches"] },
  head: { family: "count", aliases: ["head", "heads"] },
  stalk: { family: "count", aliases: ["stalk", "stalks", "rib", "ribs"] },
  sprig: { family: "count", aliases: ["sprig", "sprigs"] },
  slice: { family: "count", aliases: ["slice", "slices"] },
  sheet: { family: "count", aliases: ["sheet", "sheets"] },
  stick: { family: "count", aliases: ["stick", "sticks"] },
  handful: { family: "count", aliases: ["handful", "handfuls"] },
} as const satisfies Record<string, { family: UnitFamily; aliases: readonly string[] }>;

export type IngredientUnit = keyof typeof UNIT_TABLE;
export const INGREDIENT_UNITS = Object.keys(UNIT_TABLE) as [IngredientUnit, ...IngredientUnit[]];
export const IngredientUnit = z.enum(INGREDIENT_UNITS);

export function unitFamily(unit: IngredientUnit): UnitFamily {
  return UNIT_TABLE[unit].family;
}

/** Spellings that only match exactly as written. */
const CASE_SENSITIVE = new Set(["T", "t"]);

const unitsByAlias = new Map<string, IngredientUnit>();
for (const unit of INGREDIENT_UNITS) {
  for (const alias of UNIT_TABLE[unit].aliases) {
    unitsByAlias.set(CASE_SENSITIVE.has(alias) ? alias : alias.toLowerCase(), unit);
  }
}

/** Longest aliases first, so "fl oz" wins over "fl" and "tbsp" over "t". */
const aliasesLongestFirst = [...unitsByAlias.keys()].sort((a, b) => b.length - a.length);

/**
 * The unit `text` starts with, and the text after it. A unit ends at a space, a full stop or the end
 * of the text, so "garlic" does not start with "g".
 */
export function readUnit(text: string): { unit: IngredientUnit; rest: string } | null {
  for (const alias of aliasesLongestFirst) {
    const head = text.slice(0, alias.length);
    const matches = CASE_SENSITIVE.has(alias) ? head === alias : head.toLowerCase() === alias;
    if (!matches) continue;
    const after = text.slice(alias.length);
    if (after !== "" && !/^[\s.,)]/.test(after)) continue;
    const unit = unitsByAlias.get(alias) as IngredientUnit;
    return { unit, rest: after.replace(/^\.?\s*/, "") };
  }
  return null;
}

/** The count unit a name ends with ("garlic cloves"), so it can be read as the unit instead. */
export function trailingCountUnit(name: string): { unit: IngredientUnit; rest: string } | null {
  const match = /^(.+?)\s+(\S+)$/.exec(name);
  if (!match) return null;
  const [, rest, last] = match as unknown as [string, string, string];
  const unit = unitsByAlias.get(last.toLowerCase());
  return unit && unitFamily(unit) === "count" ? { unit, rest } : null;
}
