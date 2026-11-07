import { type ItemCatalogue, type ItemId, singular } from "./items";
import type { Recipe } from "./recipes";

/** What a search reads of a Recipe. */
export type SearchableRecipe = Pick<
  Recipe,
  "id" | "title" | "tags" | "cuisine" | "mainProtein" | "course" | "ingredients"
>;

/**
 * The words of a text as search compares them: lower case, without accents or apostrophes, and
 * split on anything else but letters and digits, so "Stir-Fry" is "stir fry" and "Grandma's" is
 * "grandmas".
 */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\p{M}'’]/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Words a spoken request is full of that say nothing about which Recipe: skipped in a query. */
const FILLER_WORDS = new Set(["a", "an", "and", "the", "with", "of", "in", "on", "for", "recipe"]);

/**
 * Whether a word of the query finds a word of a Recipe: as its first letters, so "chick" finds
 * "chicken" while someone types, or as the same singular, so "tomatos" finds "tomatoes". A
 * singular is not taken as first letters, so "peas" doesn't find "peanut".
 */
function wordMatches(queryWord: string, word: string): boolean {
  return word.startsWith(queryWord) || singular(queryWord) === singular(word);
}

/** The texts of a Recipe a search looks in. */
function fieldsOf(recipe: SearchableRecipe): string[] {
  return [
    recipe.title,
    ...recipe.tags,
    ...recipe.ingredients.map((ingredient) => ingredient.raw),
    recipe.cuisine ?? "",
    recipe.mainProtein ?? "",
    recipe.course ?? "",
  ];
}

/**
 * The Recipes `query` finds, its filler words skipped: those using the Item the whole query names,
 * so "the green onions" finds "2 scallions", and those in which every word of the query finds a
 * word or names an Item used. Those whose title has every word come first, then the others, each
 * in title order; a query with no words finds every Recipe.
 */
export function searchRecipes<R extends SearchableRecipe>(
  recipes: readonly R[],
  query: string,
  catalogue: ItemCatalogue,
): R[] {
  const terms = wordsOf(query).filter((word) => !FILLER_WORDS.has(word));
  const termItems = terms.map((term) => catalogue.match(term));
  const queryItem = terms.length > 0 ? catalogue.match(terms.join(" ")) : null;
  const allFound = (words: string[], items: ReadonlySet<ItemId | null> = new Set()) =>
    terms.every((term, index) => {
      const item = termItems[index] ?? null;
      return (item !== null && items.has(item)) || words.some((word) => wordMatches(term, word));
    });
  const found = recipes.filter((recipe) => {
    const items = new Set(recipe.ingredients.map((ingredient) => ingredient.item));
    return (queryItem !== null && items.has(queryItem)) || allFound(wordsOf(fieldsOf(recipe).join(" ")), items);
  });
  const byTitle = (a: R, b: R) => a.title.localeCompare(b.title) || a.id - b.id;
  const inTitle = found.filter((recipe) => allFound(wordsOf(recipe.title)));
  return [...inTitle.sort(byTitle), ...found.filter((recipe) => !inTitle.includes(recipe)).sort(byTitle)];
}
