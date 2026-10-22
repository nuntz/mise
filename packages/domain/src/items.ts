import { z } from "zod";
import { CATALOGUE, type CatalogueEntry } from "./catalogue";
import type { Allergen } from "./members";
import type { UnitFamily } from "./units";

/** Areas of the store. The Household will order them in walking order. */
export const STORE_SECTIONS = [
  "produce",
  "bakery",
  "meat",
  "seafood",
  "dairy",
  "frozen",
  "pantry",
  "baking",
  "spices",
  "condiments",
  "international",
  "beverages",
] as const;
export const StoreSection = z.enum(STORE_SECTIONS);
export type StoreSection = z.infer<typeof StoreSection>;

/** A canonical grocery thing that Ingredients and Staples refer to (ADR 0001). */
export type Item = {
  id: string;
  name: string;
  /** Other names for it; plurals and common adjectives are handled by matching, not listed here. */
  aliases: readonly string[];
  section: StoreSection;
  allergens: readonly Allergen[];
  /** What it is usually measured in. */
  unitFamily: UnitFamily;
};

export type ItemId = keyof typeof CATALOGUE;
export const ITEM_IDS = Object.keys(CATALOGUE) as [ItemId, ...ItemId[]];
export const ItemId = z.enum(ITEM_IDS);

/** Every Item, in catalogue order. */
export const ITEMS: readonly Item[] = ITEM_IDS.map((id) => {
  const entry: CatalogueEntry = CATALOGUE[id];
  return { aliases: [], allergens: [], ...entry, id };
});

export function itemById(id: ItemId): Item {
  return ITEMS.find((item) => item.id === id) as Item;
}

/**
 * Descriptive words that say which form of a thing it is. A form can carry Allergens the plain thing
 * doesn't (fresh pasta has egg), so matching keeps them on its second try and drops them only on its
 * last. "Dried" is never dropped: dried fruit is often sulphited, so "dried figs" matches only an Item
 * that names that form, and stays Unresolved otherwise.
 */
const FORM_WORDS = new Set(["fresh", "whole", "raw", "frozen", "canned", "cooked", "uncooked", "roasted", "toasted"]);

/**
 * Words that describe an Ingredient's state or size rather than which Item it is. Matching tries the
 * name as written first, so an alias that includes one ("ground beef", "fresh ginger") still wins.
 */
const DESCRIPTIVE_WORDS = new Set([
  ...FORM_WORDS,
  "freshly",
  "large",
  "medium",
  "small",
  "big",
  "extra",
  "jumbo",
  "ripe",
  "cold",
  "warm",
  "chopped",
  "minced",
  "diced",
  "sliced",
  "grated",
  "shredded",
  "crushed",
  "peeled",
  "halved",
  "quartered",
  "finely",
  "roughly",
  "coarsely",
  "thinly",
  "packed",
  "lightly",
  "softened",
  "melted",
  "room-temperature",
  "boneless",
  "skinless",
  "organic",
  "bottled",
  "unsweetened",
  "unsalted",
  "salted",
  "shelled",
  "pitted",
  "seedless",
  "plain",
]);

/** A name reduced to what matching compares: lower case, single spaces, every word singular. */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}%'\- ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

/**
 * The singular of an English word, by the common rules. It need not be right, only consistent:
 * aliases go through it too, so "olives" and "olive" agree even though both become "olive".
 */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (/(sh|ch|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

const itemsByName = new Map<string, ItemId>();
for (const item of ITEMS) {
  for (const name of [item.name, ...item.aliases]) itemsByName.set(normalise(name), item.id as ItemId);
}

/** The Item an Ingredient's name refers to, ignoring case, plurals and descriptive words; null if none. */
export function matchItem(name: string): ItemId | null {
  const normalised = normalise(name);
  const words = normalised.split(" ");
  const keepingForms = words.filter((word) => !DESCRIPTIVE_WORDS.has(word) || FORM_WORDS.has(word)).join(" ");
  const plain = words.filter((word) => !DESCRIPTIVE_WORDS.has(word)).join(" ");
  return itemsByName.get(normalised) ?? itemsByName.get(keepingForms) ?? itemsByName.get(plain) ?? null;
}
