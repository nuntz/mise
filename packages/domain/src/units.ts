import { z } from "zod";
import type { Units } from "./household";

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
 * The unit `text` starts with, as written, and the text after it. A unit ends at a space, a full
 * stop or the end of the text, so "garlic" does not start with "g".
 */
export function readUnit(text: string): { unit: IngredientUnit; written: string; rest: string } | null {
  for (const alias of aliasesLongestFirst) {
    const head = text.slice(0, alias.length);
    const matches = CASE_SENSITIVE.has(alias) ? head === alias : head.toLowerCase() === alias;
    if (!matches) continue;
    const after = text.slice(alias.length);
    if (after !== "" && !/^[\s.,)]/.test(after)) continue;
    const unit = unitsByAlias.get(alias) as IngredientUnit;
    return { unit, written: head, rest: after.replace(/^\.?\s*/, "") };
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

/** Spellings that are abbreviations, written the same for one or many, even those ending in s. */
const ABBREVIATIONS = new Set(["kgs", "lbs", "mls", "tsps", "tbsps", "pkgs", "pcs"]);

/** Each spelling's other number, from the table: can ↔ cans, tin ↔ tins, bunch ↔ bunches. */
const otherNumber = new Map<string, { singular: string; plural: string }>();
for (const unit of INGREDIENT_UNITS) {
  const aliases: readonly string[] = UNIT_TABLE[unit].aliases;
  for (const singular of aliases) {
    const plural = aliases.find((alias) => alias === `${singular}s` || alias === `${singular}es`);
    if (!plural || ABBREVIATIONS.has(plural)) continue;
    const pair = { singular, plural };
    otherNumber.set(singular, pair);
    otherNumber.set(plural, pair);
  }
}

/**
 * A unit as the cook wrote it, made singular or plural: "can" → "cans", "Tins" → "Tin". Symbols and
 * abbreviations (g, tbsp, lbs) are the same either way.
 */
export function unitInNumber(written: string, plural: boolean): string {
  const pair = otherNumber.get(written.toLowerCase());
  if (!pair) return written;
  const word = plural ? pair.plural : pair.singular;
  return written[0] === written[0]?.toUpperCase() ? word[0]?.toUpperCase() + word.slice(1) : word;
}

/**
 * What one of each unit that converts is, in grams or millilitres. A pinch or a dash is no measured
 * amount, and counts of different things are different things, so those convert to nothing.
 */
const BASE_SIZES: Partial<Record<IngredientUnit, number>> = {
  mg: 0.001,
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
  ml: 1,
  cl: 10,
  dl: 100,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  cup: 236.5882365,
  fl_oz: 29.5735295625,
  pint: 473.176473,
  quart: 946.352946,
  gallon: 3785.411784,
};

/** How many grams or millilitres one `unit` is; null for a unit that doesn't convert. */
export function baseSize(unit: IngredientUnit | null): number | null {
  return unit === null ? null : (BASE_SIZES[unit] ?? null);
}

/** Units bought only whole: nobody buys half a package, can or jar (ADR 0026). */
const PACKAGED_UNITS: readonly IngredientUnit[] = ["package", "can", "jar"];

export function isPackagedUnit(unit: IngredientUnit | null): boolean {
  return unit !== null && PACKAGED_UNITS.includes(unit);
}

/**
 * The units a Household shops in, smallest first, each used from its size up: grams to the kilo,
 * millilitres to the litre; ounces to the pound, teaspoons and tablespoons to the quarter cup.
 */
const HOUSEHOLD_UNITS: Record<Units, Record<"mass" | "volume", IngredientUnit[]>> = {
  metric: { mass: ["g", "kg"], volume: ["ml", "l"] },
  imperial: { mass: ["oz", "lb"], volume: ["tsp", "tbsp", "cup"] },
};
const QUARTER_CUP = (BASE_SIZES.cup as number) / 4;

/** Whether `unit` is one the Household shops in. */
export function isHouseholdUnit(units: Units, unit: IngredientUnit | null): boolean {
  const { mass, volume } = HOUSEHOLD_UNITS[units];
  return unit !== null && (mass.includes(unit) || volume.includes(unit));
}

/** The unit of the Household's to give `base` grams or millilitres in. */
export function householdUnit(units: Units, family: "mass" | "volume", base: number): IngredientUnit {
  const [smallest, ...larger] = HOUSEHOLD_UNITS[units][family] as [IngredientUnit, ...IngredientUnit[]];
  let chosen = smallest;
  for (const unit of larger) {
    // Floating-point sums land just under a size they add up to exactly.
    const from = unit === "cup" ? QUARTER_CUP : (BASE_SIZES[unit] as number);
    if (base >= from - 1e-9) chosen = unit;
  }
  return chosen;
}
