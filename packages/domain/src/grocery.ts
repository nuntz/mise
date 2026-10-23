import { z } from "zod";
import type { Units } from "./household";
import { Amount, type Ingredient } from "./ingredients";
import { ItemId, STORE_SECTIONS, StoreSection } from "./items";
import { Recipe, RecipeId } from "./recipes";
import type { StapleStatus } from "./staples";
import { baseSize, householdUnit, IngredientUnit, unitFamily } from "./units";
import { LocalDate } from "./weeks";

/** How much of an Item a line needs, in one unit; null is a bare count ("2 eggs"). */
export const GroceryAmount = z.object({ amount: Amount, unit: IngredientUnit.nullable() });
export type GroceryAmount = z.infer<typeof GroceryAmount>;

/** Where a line came from: the Week's Recipes, a Staple due to be bought, or added by hand. */
export const GroceryOrigin = z.enum(["recipe", "staple", "manual"]);

/** What the Week's Recipes need of one Item, one Unresolved Ingredient as written, or a Staple to buy. */
export const GroceryNeed = z.object({
  origin: GroceryOrigin.exclude(["manual"]),
  /** Null for an Unresolved Ingredient. */
  item: ItemId.nullable(),
  /** The Unresolved Ingredient as written; null when there is an Item. */
  text: z.string().nullable(),
  /** One per unit that can't be combined with the others, in the order first needed. */
  amounts: z.array(GroceryAmount),
  /** Some Recipe uses it without saying how much ("salt to taste"). */
  unmeasured: z.boolean(),
  /** The Recipes that need it, each once, in the order first needed; none for a Staple. */
  recipeIds: z.array(RecipeId),
});
export type GroceryNeed = z.infer<typeof GroceryNeed>;

/** What the builder reads of a Recipe. */
export type GroceryRecipe = Pick<Recipe, "id" | "title" | "baseServings"> & {
  ingredients: Pick<Ingredient, "raw" | "amount" | "unit" | "item">[];
};

/** What the builder reads of a Staple. */
export type GroceryStaple = {
  item: ItemId;
  status: StapleStatus;
  alwaysBuy: boolean;
  qtyPerShop: GroceryAmount | null;
};

/** Whether a Staple is due to be bought: it is low or out, or always bought. */
export function stapleToBuy(staple: Pick<GroceryStaple, "status" | "alwaysBuy">): boolean {
  return staple.alwaysBuy || staple.status !== "stocked";
}

/** What a Week's Grocery List is built from. */
export type GroceryDemand = {
  /** Each Slot of the Week that holds a Recipe, and the Servings it is cooked for. */
  slots: { recipeId: RecipeId; servings: number }[];
  /** At least every Recipe the Slots hold. */
  recipes: GroceryRecipe[];
  /** Every Staple of the Household. */
  staples: GroceryStaple[];
  units: Units;
};

/**
 * What the Week's Recipes need, Ingredient by Ingredient scaled from the Recipe's base Servings to
 * the Slot's, merged by Item: one line per Item. Mass and volume are added up and given in the
 * Household's units; they never convert into each other, and counts add up only when they count
 * the same thing (cloves with cloves). What can't be combined stays on the line as its own amount.
 * Unresolved Ingredients can't be merged or scaled, so each is a line as written.
 *
 * Staples low, out or always bought are added at their usual quantity, unless the Recipes need an
 * amount of the Item, which replaces it. An Ingredient of a Staple's Item without an amount ("salt
 * to taste") adds nothing: the Household keeps it on hand.
 */
export function buildGroceryList({ slots, recipes, staples, units }: GroceryDemand): GroceryNeed[] {
  type Adding = GroceryNeed & { totals: Map<string, Total> };
  const needs = new Map<string, Adding>();
  const stapleItems = new Set<string>(staples.map((staple) => staple.item));
  for (const slot of slots) {
    if (slot.servings === 0) continue;
    const recipe = recipes.find((other) => other.id === slot.recipeId);
    if (!recipe) throw new Error(`No Recipe ${slot.recipeId}`);
    const scale = slot.servings / recipe.baseServings;
    for (const ingredient of recipe.ingredients) {
      if (ingredient.item && !ingredient.amount && stapleItems.has(ingredient.item)) continue;
      const key = ingredient.item ?? `raw:${ingredient.raw}`;
      const need: Adding = needs.get(key) ?? {
        origin: "recipe",
        item: ingredient.item,
        text: ingredient.item ? null : ingredient.raw,
        amounts: [],
        unmeasured: false,
        recipeIds: [],
        totals: new Map(),
      };
      needs.set(key, need);
      if (!need.recipeIds.includes(recipe.id)) need.recipeIds.push(recipe.id);
      if (!ingredient.item) continue;
      if (!ingredient.amount) {
        need.unmeasured = true;
        continue;
      }
      const { unit } = ingredient;
      const size = baseSize(unit);
      const measure = measureOf(unit);
      const total = need.totals.get(measure) ?? { unit, min: 0, max: 0 };
      need.totals.set(measure, total);
      total.min += ingredient.amount.min * scale * (size ?? 1);
      total.max += ingredient.amount.max * scale * (size ?? 1);
    }
  }
  const recipeNeeds = [...needs.values()].map(({ totals, ...need }) => ({
    ...need,
    amounts: [...totals].map(([measure, total]) => inHouseholdUnits(units, measure, total)),
  }));
  const stapleNeeds = staples.flatMap((staple): GroceryNeed[] =>
    stapleToBuy(staple) && !needs.has(staple.item)
      ? [
          {
            origin: "staple",
            item: staple.item,
            text: null,
            amounts: staple.qtyPerShop ? [staple.qtyPerShop] : [],
            unmeasured: false,
            recipeIds: [],
          },
        ]
      : [],
  );
  return [...recipeNeeds, ...stapleNeeds];
}

/** An amount being added up: in grams or millilitres when its unit converts, else in that unit. */
type Total = { unit: IngredientUnit | null; min: number; max: number };

/** What amounts add up with: "mass" or "volume" when they convert, else only the same unit. */
function measureOf(unit: IngredientUnit | null): string {
  return unit !== null && baseSize(unit) !== null ? unitFamily(unit) : (unit ?? "each");
}

function inHouseholdUnits(units: Units, measure: string, total: Total): GroceryAmount {
  if (measure !== "mass" && measure !== "volume") {
    return { amount: { min: rounded(total.min), max: rounded(total.max) }, unit: total.unit };
  }
  const unit = householdUnit(units, measure, total.max);
  const size = baseSize(unit) as number;
  // Grams and millilitres are too small to be worth a fraction.
  const round = size === 1 ? (value: number) => (value >= 1 ? Math.round(value) : rounded(value)) : rounded;
  return { amount: { min: round(total.min / size), max: round(total.max / size) }, unit };
}

/** To two decimal places. */
function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A fingerprint of what a Grocery List is built from: which Recipes the Week's Slots hold, for how
 * many, and those Recipes' base Servings and Ingredients. A list built from another plan revision
 * is out of date (ADR 0015).
 */
export function groceryPlanRevision({ slots, recipes }: GroceryDemand): string {
  // Only what the list depends on: which day a dinner is on, or a Slot nobody eats, changes nothing.
  const cooked = slots
    .filter((slot) => slot.servings > 0)
    .sort((a, b) => a.recipeId - b.recipeId || a.servings - b.servings);
  const used = [...new Set(cooked.map((slot) => slot.recipeId))];
  const plan = JSON.stringify({
    slots: cooked.map((slot) => [slot.recipeId, slot.servings]),
    recipes: used.map((id) => {
      const recipe = recipes.find((other) => other.id === id);
      return recipe && [id, recipe.baseServings, recipe.ingredients.map((i) => [i.raw, i.amount, i.unit, i.item])];
    }),
  });
  return hash(plan);
}

/** A 53-bit string hash (cyrb53), in hex: enough to tell plans apart, not a security measure. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * What a line is the same as when the list is rebuilt, so its Have Tick carries over: its Item and
 * units, or its text. Mass and volume count as one unit each, since their unit follows the amount.
 */
export function groceryLineKey(line: Pick<GroceryNeed, "item" | "text" | "amounts">): string {
  if (line.item === null) return `text:${(line.text ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;
  const measures = [...new Set(line.amounts.map((amount) => measureOf(amount.unit)))].sort();
  return `item:${line.item}:${measures.join(",")}`;
}

/** Where a line goes: its Item's Store Section, or "other" when it has no Item. */
export const GrocerySection = z.union([StoreSection, z.literal("other")]);
export type GrocerySection = z.infer<typeof GrocerySection>;

export const GroceryLine = z.object({
  id: z.number().int().positive(),
  origin: GroceryOrigin,
  item: ItemId.nullable(),
  /** The Item's name; for a line without one, its text as written. */
  name: z.string(),
  amounts: z.array(GroceryAmount),
  unmeasured: z.boolean(),
  /** The Recipes that need it; none for a Staple's line or one added by hand. */
  recipes: z.array(Recipe.pick({ id: true, title: true })),
  /** Its Have Tick: the Household already has it. */
  have: z.boolean(),
  /** When the Have Tick was last set, either way; null if never. */
  haveAt: z.iso.datetime().nullable(),
});
export type GroceryLine = z.infer<typeof GroceryLine>;

export const GroceryList = z.object({
  startDate: LocalDate,
  builtAt: z.iso.datetime(),
  /** The plan has changed since the list was built; rebuilding brings it up to date. */
  planChanged: z.boolean(),
  /** A Staple has become due to be bought that the list has no line for; rebuilding adds it. */
  staplesChanged: z.boolean(),
  /** Sections with lines, in the Household's walking order, then "other"; lines by name. */
  sections: z.array(z.object({ section: GrocerySection, lines: z.array(GroceryLine) })),
});
export type GroceryList = z.infer<typeof GroceryList>;

/**
 * The Household's Store Sections in walking order: those it ordered, then the rest in their usual
 * order.
 */
export function storeSectionOrder(ordered: readonly StoreSection[]): StoreSection[] {
  return [...ordered, ...STORE_SECTIONS.filter((section) => !ordered.includes(section))];
}

/** Lines grouped by section in walking order, "other" last, each section's lines by name. */
export function groupGroceryLines(
  lines: (GroceryLine & { section: GrocerySection })[],
  order: readonly StoreSection[],
): GroceryList["sections"] {
  return [...storeSectionOrder(order), "other" as const].flatMap((section) => {
    const inSection = lines
      .filter((line) => line.section === section)
      .map(({ section: _, ...line }) => line)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    return inSection.length > 0 ? [{ section, lines: inSection }] : [];
  });
}

/**
 * Builds the Week's Grocery List from its plan as it is now. Rebuilding keeps lines added by hand,
 * and the Have Tick of every line still needed; lines no Recipe needs any more go.
 */
export const BuildGroceryListInput = z.object({ date: LocalDate.optional() }).strict();

/** A Week is named by any date in it; without one, the Week the Household is in today. */
export const GetGroceryListInput = z.object({ date: LocalDate.optional() }).strict();

/**
 * Sets a line's Have Tick to `have`, as of `at`: a tick set at or after `at` wins, so ticks made
 * offline and synced late never undo a later one. Ticking a line of a Staple's Item sets the Staple
 * to stocked, as of `at`, unless its status was recorded later.
 */
export const SetHaveTickInput = z
  .object({ line: z.number().int().positive(), have: z.boolean(), at: z.iso.datetime() })
  .strict();

/**
 * Adds a line by hand, such as "2 lemons"; it goes in the section of the Item it names, if any.
 * Added again under the same `key`, it is the same line, so a device retrying an add made offline
 * doesn't add it twice.
 */
export const AddGroceryLineInput = z
  .object({ date: LocalDate, text: z.string().trim().min(1).max(200), key: z.uuid().optional() })
  .strict();

/** Puts the Store Sections given first, in that order; the rest follow in their usual order. */
export const SetStoreSectionOrderInput = z
  .object({
    sections: z
      .array(StoreSection)
      .refine((all) => new Set(all).size === all.length, { message: "Name a Store Section only once" }),
  })
  .strict();
