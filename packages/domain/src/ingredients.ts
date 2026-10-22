import { z } from "zod";
import { type ItemCatalogue, ItemId, SHIPPED_ITEMS } from "./items";
import { IngredientUnit, readUnit, trailingCountUnit } from "./units";

/** How much of something: a single number has `min` equal to `max`; "2–3" is a range. */
export const Amount = z.object({ min: z.number().positive(), max: z.number().positive() });
export type Amount = z.infer<typeof Amount>;

/**
 * One line of a Recipe: the line as written, and what the parser read from it. `item` is the Item it
 * refers to, or null for an Unresolved Ingredient, whose Allergens are unknown.
 */
export const Ingredient = z.object({
  raw: z.string(),
  amount: Amount.nullable(),
  unit: IngredientUnit.nullable(),
  /** The thing itself, as written, without the amount, unit and notes. */
  name: z.string(),
  note: z.string().nullable(),
  item: ItemId.nullable(),
});
export type Ingredient = z.infer<typeof Ingredient>;

/** Phrases at the end of a line that say how or whether to use it, not what it is. */
const TRAILING_NOTE = /\s+(to taste|for (?:garnish|serving|topping|drizzling|greasing)|optional|divided)$/i;

/**
 * Reads an Ingredient line such as "2 cloves garlic, minced", matching it against `catalogue`.
 * Deterministic; never fails.
 */
export function parseIngredient(raw: string, catalogue: ItemCatalogue = SHIPPED_ITEMS): Ingredient {
  const notes: string[] = [];
  // "(14 oz)", "(optional)": wherever they are, in the order written.
  let text = raw
    .replace(/\(([^)]*)\)/g, (_, note: string) => {
      if (note.trim()) notes.push(note.trim());
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();

  // Everything after the first comma, or after a spaced dash that isn't a range ("2 – 3"):
  // "onion, finely chopped", "carrots - diced".
  const separator = NOTE_SEPARATOR.exec(text);
  if (separator) {
    notes.push(text.slice(separator.index + separator[0].length).trim());
    text = text.slice(0, separator.index).trim();
  }
  const trailing = TRAILING_NOTE.exec(text);
  if (trailing) {
    notes.push(trailing[1] as string);
    text = text.slice(0, trailing.index).trim();
  }

  const read = readAmount(text);
  const amount = read?.amount ?? null;
  if (read) text = read.rest;

  let unit: IngredientUnit | null = null;
  const unitRead = readUnit(text) ?? (amount ? trailingCountUnit(text) : null);
  if (unitRead) {
    unit = unitRead.unit;
    text = unitRead.rest.replace(/^of\s+/i, "");
  }

  const name = text.trim();
  return {
    raw,
    amount,
    unit,
    name,
    note: notes.length > 0 ? notes.join("; ") : null,
    item: catalogue.match(name),
  };
}

const UNICODE_FRACTIONS: Record<string, number> = {
  "½": 1 / 2,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 1 / 4,
  "¾": 3 / 4,
  "⅕": 1 / 5,
  "⅖": 2 / 5,
  "⅗": 3 / 5,
  "⅘": 4 / 5,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 1 / 8,
  "⅜": 3 / 8,
  "⅝": 5 / 8,
  "⅞": 7 / 8,
};

const VULGAR = `[${Object.keys(UNICODE_FRACTIONS).join("")}]`;
/** "1/2" or "3⁄4" (with the fraction slash). */
const SLASHED = String.raw`\d+\s*[/⁄]\s*\d+`;
const FRACTION = `(?:${SLASHED}|${VULGAR})`;
/**
 * One number: a mixed number ("1 1/2", "1-1/2", "1½", "1 ½"), a fraction, or a decimal or integer.
 * A hyphen directly between a whole number and a fraction makes a mixed number, not a range.
 */
const NUMBER = String.raw`(?:\d+(?:\s+|-)?${FRACTION}|${FRACTION}|\d*\.\d+|\d+(?:\.\d*)?)`;
const RANGE_SEPARATOR = String.raw`\s*[-–—]\s*|\s+to\s+`;
const NOTE_SEPARATOR = new RegExp(`,|(?<!\\d|${VULGAR})\\s[-–—]\\s`, "u");
const AMOUNT = new RegExp(String.raw`^(${NUMBER})(?:(?:${RANGE_SEPARATOR})(${NUMBER}))?(?=\s|$|\p{L})\s*`, "u");

/** The amount `text` starts with ("2", "1 ½", "2–3", "a"), and the text after it. */
function readAmount(text: string): { amount: Amount; rest: string } | null {
  const match = AMOUNT.exec(text);
  if (match) {
    const min = numberValue(match[1] as string);
    const max = match[2] === undefined ? min : numberValue(match[2]);
    // "1/0" is no amount at all.
    if (min > 0 && Number.isFinite(max) && max >= min)
      return { amount: { min, max }, rest: text.slice(match[0].length) };
  }
  const article = /^an?\s+/i.exec(text);
  if (article) return { amount: { min: 1, max: 1 }, rest: text.slice(article[0].length) };
  return null;
}

function numberValue(text: string): number {
  const vulgar = new RegExp(`^(\\d*)\\s*-?\\s*(${VULGAR})$`, "u").exec(text);
  if (vulgar) return Number(vulgar[1] || 0) + (UNICODE_FRACTIONS[vulgar[2] as string] as number);
  const slashed = /^(?:(\d+)(?:\s+|-))?(\d+)\s*[/⁄]\s*(\d+)$/.exec(text);
  if (slashed) return Number(slashed[1] ?? 0) + Number(slashed[2]) / Number(slashed[3]);
  return Number(text);
}
