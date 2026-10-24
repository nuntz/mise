import { z } from "zod";
import { type Item, type ItemCatalogue, ItemId, ItemName, normaliseItemName, StoreSection } from "./items";
import type { Llm } from "./llm";
import { ALLERGENS, Allergen } from "./members";
import { UnitFamily } from "./units";

/**
 * What a Suggestion says an Unresolved Ingredient is (ADR 0023): an existing Item its text is another
 * name for, or a new Item with the Allergens the model thinks it has.
 */
export const SuggestedItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), item: ItemId }).strict(),
  z
    .object({
      kind: z.literal("new"),
      name: ItemName,
      section: StoreSection,
      unitFamily: UnitFamily,
      /** Each once, in canonical order; empty when the model thinks it has none. Only a person's acceptance states them. */
      allergens: z.array(Allergen).transform((chosen) => ALLERGENS.filter((allergen) => chosen.includes(allergen))),
    })
    .strict(),
]);
export type SuggestedItem = z.output<typeof SuggestedItem>;

export const SuggestionId = z.number().int().positive();
export type SuggestionId = z.infer<typeof SuggestionId>;

/**
 * An LLM's guess at the Item the Unresolved Ingredients with this text refer to. It changes nothing
 * until a person accepts it: until then they stay Unresolved, and their Recipes fail closed.
 */
export const Suggestion = z.object({
  id: SuggestionId,
  /** The Unresolved Ingredients' normalised text, as `list_unresolved_ingredients` groups them. */
  text: z.string(),
  suggested: SuggestedItem,
  suggestedAt: z.string(),
});
export type Suggestion = z.infer<typeof Suggestion>;

/** How many names one request to the model asks about. */
export const SUGGESTION_BATCH_SIZE = 40;

/**
 * Asks for Suggestions for the texts given, or without any, for the next batch of Unresolved texts
 * that have never had one. Asking again about a text replaces its Suggestion, even a dismissed one.
 */
export const RequestSuggestionsInput = z
  .object({ texts: z.array(z.string().trim().min(1)).min(1).max(SUGGESTION_BATCH_SIZE).optional() })
  .strict();

export const RequestSuggestionsOutput = z.object({
  /** The Suggestions made, which may be fewer than the texts asked about. */
  suggestions: z.array(Suggestion),
  /** How many Unresolved texts have still never had a Suggestion. */
  remaining: z.number().int().nonnegative(),
});

/**
 * Accepts a Suggestion, or `suggested` in its place when a person changed it, through the same paths
 * as `resolve_ingredient` and `create_item`: every Unresolved Ingredient the text matches resolves.
 */
export const AcceptSuggestionInput = z.object({ id: SuggestionId, suggested: SuggestedItem.optional() }).strict();

export const DismissSuggestionInput = z.object({ id: SuggestionId }).strict();

/** What the model is asked: names of Unresolved Ingredients, and every Item the Household has. */
export type SuggestionRequest = { names: string[]; catalogue: Item[] };

/** The model's answer for one name it was asked about. */
export type SuggestionAnswer = { name: string; suggested: SuggestedItem };

/** The names one request asked about, and the answers kept. */
export type SuggestionBatch = { names: string[]; answers: SuggestionAnswer[] };

/**
 * Asks `llm` about `names` in batches, yielding each batch as its answers come. Only answers the
 * catalogue can hold are kept: one per name asked, of an Item it has. A new Item whose name an Item
 * already has becomes a Suggestion of that Item.
 */
export async function* suggestItems(
  llm: Llm,
  names: readonly string[],
  catalogue: ItemCatalogue,
): AsyncGenerator<SuggestionBatch> {
  for (let start = 0; start < names.length; start += SUGGESTION_BATCH_SIZE) {
    const asked = names.slice(start, start + SUGGESTION_BATCH_SIZE);
    const byNormalised = new Map(asked.map((name) => [normaliseItemName(name), name]));
    const answers = await llm.makeSuggestions({ names: asked, catalogue: catalogue.items });
    const kept = new Map<string, SuggestionAnswer>();
    for (const answer of answers) {
      const name = byNormalised.get(normaliseItemName(answer.name));
      if (name === undefined || kept.has(name)) continue;
      const suggested = fittedToCatalogue(answer.suggested, catalogue);
      if (suggested) kept.set(name, { name, suggested });
    }
    yield { names: asked, answers: asked.flatMap((name) => kept.get(name) ?? []) };
  }
}

/** The Suggestion as the catalogue can hold it, or null if it can't. */
function fittedToCatalogue(suggested: SuggestedItem, catalogue: ItemCatalogue): SuggestedItem | null {
  if (suggested.kind === "existing") return catalogue.item(suggested.item) ? suggested : null;
  const named = catalogue.named(suggested.name);
  return named === null ? suggested : { kind: "existing", item: named };
}
