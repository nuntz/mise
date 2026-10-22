import { z } from "zod";
import { CATALOGUE, type CatalogueEntry } from "./catalogue";
import { ALLERGENS, Allergen } from "./members";
import { UnitFamily } from "./units";

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

/** The key of an Item in the shipped catalogue (ADR 0009). */
export type ShippedItemId = keyof typeof CATALOGUE;
export const ITEM_IDS = Object.keys(CATALOGUE) as [ShippedItemId, ...ShippedItemId[]];
export const ShippedItemId = z.enum(ITEM_IDS);

/** The key of an Item the Household added, from its row id; never reused. */
export type HouseholdItemId = `household:${number}`;
export const HouseholdItemId = z.custom<HouseholdItemId>(
  (value) => typeof value === "string" && /^household:[1-9]\d*$/.test(value),
  "Not a Household Item",
);

export const ItemId = z.union([ShippedItemId, HouseholdItemId]);
export type ItemId = z.infer<typeof ItemId>;

/** A canonical grocery thing that Ingredients and Staples refer to (ADR 0001). */
export const Item = z.object({
  id: ItemId,
  name: z.string(),
  /** Other names for it; plurals and common adjectives are handled by matching, not listed here. */
  aliases: z.array(z.string()),
  section: StoreSection,
  allergens: z.array(Allergen),
  /** What it is usually measured in. */
  unitFamily: UnitFamily,
});
export type Item = z.infer<typeof Item>;

/** Every shipped Item, in catalogue order. */
export const ITEMS: readonly Item[] = ITEM_IDS.map((id) => {
  const entry: CatalogueEntry = CATALOGUE[id];
  return { ...entry, id, aliases: [...(entry.aliases ?? [])], allergens: [...(entry.allergens ?? [])] };
});

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
export function normaliseItemName(name: string): string {
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

/** A name the Household gave an Item, shipped or its own. */
export type ItemAlias = { item: ItemId; alias: string };

/**
 * The Items a Household's Ingredients can resolve to: the shipped catalogue, plus the Household's own
 * Items and the aliases it added. Where a name of the Household's and a shipped one read the same, the
 * Household's wins (ADR 0009).
 */
export class ItemCatalogue {
  readonly #items = new Map<ItemId, Item>();
  readonly #byName = new Map<string, ItemId>();

  constructor(householdItems: readonly Item[] = [], aliases: readonly ItemAlias[] = []) {
    for (const item of [...ITEMS, ...householdItems]) this.#items.set(item.id, item);
    for (const { item, alias } of aliases) {
      const found = this.#items.get(item);
      if (!found) throw new Error(`No Item ${item} to alias as "${alias}"`);
      this.#items.set(item, { ...found, aliases: [...found.aliases, alias] });
    }
    for (const item of [...ITEMS, ...householdItems]) {
      for (const name of [item.name, ...item.aliases]) this.#name(name, item.id);
    }
    for (const { item, alias } of aliases) this.#name(alias, item);
  }

  #name(name: string, id: ItemId): void {
    this.#byName.set(normaliseItemName(name), id);
  }

  /** Every Item: shipped ones in catalogue order, then the Household's. */
  get items(): Item[] {
    return [...this.#items.values()];
  }

  item(id: ItemId): Item | undefined {
    return this.#items.get(id);
  }

  /** The key of an Item this catalogue has, for reading stored keys; others fail to parse. */
  get knownItemId(): z.ZodType<ItemId> {
    return ItemId.refine((id) => this.#items.has(id), "No such Item");
  }

  /** The Item whose name or alias `text` is, ignoring only case, plurals and punctuation; null if none. */
  named(text: string): ItemId | null {
    return this.#byName.get(normaliseItemName(text)) ?? null;
  }

  /** The Item an Ingredient's name refers to, ignoring case, plurals and descriptive words; null if none. */
  match(name: string): ItemId | null {
    const normalised = normaliseItemName(name);
    const words = normalised.split(" ");
    const keepingForms = words.filter((word) => !DESCRIPTIVE_WORDS.has(word) || FORM_WORDS.has(word)).join(" ");
    const plain = words.filter((word) => !DESCRIPTIVE_WORDS.has(word)).join(" ");
    return this.#byName.get(normalised) ?? this.#byName.get(keepingForms) ?? this.#byName.get(plain) ?? null;
  }
}

/** The shipped Items alone, for a Household that has added none. */
export const SHIPPED_ITEMS = new ItemCatalogue();

/** The shipped Item an Ingredient's name refers to; null if none. */
export function matchItem(name: string): ItemId | null {
  return SHIPPED_ITEMS.match(name);
}

/** A name for an Item: it must keep a letter or digit once normalised, or it would match nothing. */
const ItemName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) => /[\p{L}\p{N}]/u.test(name), "Needs a letter or digit");

/**
 * Adds `text` as an alias of `item`, then resolves every Unresolved Ingredient it now matches, in
 * every Recipe. Lines written later match it too.
 */
export const ResolveIngredientInput = z.object({ text: ItemName, item: ItemId }).strict();

export const ResolveIngredientOutput = z.object({
  item: Item,
  /** How many Ingredients it resolved. */
  resolved: z.number().int().nonnegative(),
});

/**
 * A new Item of the Household's, with the Allergens and Store Section someone chose for it. Every
 * Unresolved Ingredient its name or an alias matches resolves to it.
 */
export const NewItem = z
  .object({
    name: ItemName,
    section: StoreSection,
    /**
     * Each once, in canonical order. Required even when empty: a Recipe trusts them, so "none" must be
     * said, never assumed.
     */
    allergens: z.array(Allergen).transform((chosen) => ALLERGENS.filter((allergen) => chosen.includes(allergen))),
    unitFamily: UnitFamily,
    aliases: z.array(ItemName).max(50).default([]),
  })
  .strict();
export type NewItem = z.output<typeof NewItem>;
