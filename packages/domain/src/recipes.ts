import { z } from "zod";
import { Weekday } from "./household";
import { Ingredient } from "./ingredients";
import { type ItemCatalogue, SHIPPED_ITEMS } from "./items";
import { ALLERGENS, Allergen } from "./members";

export const RecipeId = z.number().int().positive();
export type RecipeId = z.infer<typeof RecipeId>;

/** A Recurring Recipe comes back every week, or on one weekday. */
export const Recurrence = z.union([z.literal("weekly"), z.object({ weekday: Weekday }).strict()]);
export type Recurrence = z.infer<typeof Recurrence>;

/**
 * A Recipe's effective Allergens: the union over its Ingredients' Items. Any Unresolved Ingredient
 * makes them unknown, and then `atLeast` is only what the resolved Ingredients contain.
 */
export const RecipeAllergens = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("known"), allergens: z.array(Allergen) }),
  z.object({ kind: z.literal("unknown"), atLeast: z.array(Allergen), unresolved: z.number().int().positive() }),
]);
export type RecipeAllergens = z.infer<typeof RecipeAllergens>;

export function recipeAllergens(
  ingredients: Pick<Ingredient, "item">[],
  catalogue: ItemCatalogue = SHIPPED_ITEMS,
): RecipeAllergens {
  const found = new Set<Allergen>();
  let unresolved = 0;
  for (const ingredient of ingredients) {
    if (ingredient.item === null) unresolved++;
    else {
      const item = catalogue.item(ingredient.item);
      if (!item) throw new Error(`No Item ${ingredient.item}`);
      for (const allergen of item.allergens) found.add(allergen);
    }
  }
  const allergens = ALLERGENS.filter((allergen) => found.has(allergen));
  return unresolved > 0 ? { kind: "unknown", atLeast: allergens, unresolved } : { kind: "known", allergens };
}

/**
 * What a Recipe is served as: a main dish, or one served with or around it. Not the meal of a Slot:
 * pancakes are breakfast whichever meal they are eaten at. Only a main, or a Recipe of unknown
 * Course, is proposed for dinner (ADR 0022).
 */
export const COURSES = ["main", "side", "dessert", "drink", "breakfast", "snack"] as const;
export const Course = z.enum(COURSES);
export type Course = z.infer<typeof Course>;

const Title = z.string().trim().min(1).max(200);
const Label = z.string().trim().min(1).max(100);
/** Lines as typed: trimmed, blank ones dropped. */
const lines = (max: number, length: number) =>
  z
    .array(z.string().max(length))
    .max(max)
    .transform((all) => all.map((line) => line.trim()).filter(Boolean));
export const IngredientLines = lines(200, 500);
const Steps = lines(100, 5000);
/** Tags in lower case, each once. */
const Tags = z
  .array(z.string().trim().toLowerCase().min(1).max(50))
  .max(30)
  .transform((tags) => [...new Set(tags)]);

export const RecipeFields = {
  title: Title,
  baseServings: z.number().int().min(1).max(100),
  steps: Steps,
  tags: Tags,
  /** Cooking time in minutes, or null when unknown. */
  effortMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .nullable(),
  cuisine: Label.nullable(),
  mainProtein: Label.nullable(),
  /** What it is served as, or null when unknown. */
  course: Course.nullable(),
  recurring: Recurrence.nullable(),
  yieldsLeftovers: z.boolean(),
  /** A dish bought finished and only heated, whose one Ingredient is the product (ADR 0026). */
  readyMade: z.boolean(),
  /** What to do the day before, such as "soak the beans". */
  prepAhead: z.string().trim().min(1).max(500).nullable(),
  /** Anything else worth keeping: a description, tips, where it came from. */
  notes: z.string().trim().min(1).max(20_000).nullable(),
};

/**
 * How much the Household liked a Recipe before Mise, carried over from its source. Never "never":
 * only a Rating made in Mise can rule a Recipe out.
 */
export const ImportedPreference = z.enum(["positive", "negative"]);
export type ImportedPreference = z.infer<typeof ImportedPreference>;

/** Where a Recipe came from: typed into Mise, or imported, and then from which Recipe of the source. */
export const RecipeSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({
    kind: z.literal("paprika"),
    /** Paprika's `uid`; importing again updates this Recipe rather than adding another. */
    externalId: z.string(),
    url: z.string().nullable(),
    author: z.string().nullable(),
    /** When the import last wrote it. */
    importedAt: z.iso.datetime(),
  }),
  /** Pasted text an LLM read; the text itself is kept in the Recipe's notes. */
  z.object({ kind: z.literal("text"), importedAt: z.iso.datetime() }),
  /**
   * A link imported: a page (`url`), a TikTok video read from its caption, or an Instagram post kept
   * link-only. Importing the link again updates this Recipe.
   */
  z.object({
    kind: z.enum(["url", "tiktok", "instagram"]),
    /** The page's canonical URL, or the video's. */
    url: z.string(),
    author: z.string().nullable(),
    importedAt: z.iso.datetime(),
  }),
  /** A Google Doc in the Drive folder, an LLM read; syncing the folder again updates this Recipe. */
  z.object({
    kind: z.literal("gdrive"),
    /** Where the Doc opens. */
    url: z.string(),
    importedAt: z.iso.datetime(),
  }),
  /** Screenshots an LLM read together; they are not kept. */
  z.object({ kind: z.literal("screenshot"), importedAt: z.iso.datetime() }),
]);
export type RecipeSource = z.infer<typeof RecipeSource>;

export const Recipe = z.object({
  id: RecipeId,
  ...RecipeFields,
  ingredients: z.array(Ingredient),
  allergens: RecipeAllergens,
  /** The R2 key of its photo, if it has one. */
  photoKey: z.string().nullable(),
  source: RecipeSource,
  importedPreference: ImportedPreference.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * A Draft Recipe: read by an LLM and not yet accepted by a person, so never proposed, planned or
   * shopped. Editing it is editing any Recipe; `accept_draft` makes it a Recipe like the others.
   */
  draft: z.boolean(),
  /** When someone last changed it in Mise; an import never overwrites a Recipe changed since. */
  editedInAppAt: z.iso.datetime().nullable(),
  /** The date of the latest Slot it was cooked for; null if it never was. */
  lastCookedAt: z.iso.date().nullable(),
  /** How many Slots it was cooked for. */
  cookCount: z.number().int().nonnegative(),
});
export type Recipe = z.infer<typeof Recipe>;

/**
 * A link-only Draft: a link Mise could not read a recipe from, kept with its title (and photo, if
 * the page had one) until someone adds the recipe's text.
 */
export function isLinkOnly(recipe: Pick<Recipe, "draft" | "source" | "ingredients">): boolean {
  return recipe.draft && linkOf(recipe) !== null && recipe.ingredients.length === 0;
}

/** The link a Recipe was imported from, as a page or a video; null for any other source. */
export function linkOf(recipe: Pick<Recipe, "source">): string | null {
  const { source } = recipe;
  return source.kind === "url" || source.kind === "tiktok" || source.kind === "instagram" ? source.url : null;
}

/** What a search lists for each Recipe. */
export const RecipeSummary = Recipe.pick({
  id: true,
  title: true,
  tags: true,
  effortMinutes: true,
  cuisine: true,
  mainProtein: true,
  course: true,
  readyMade: true,
  allergens: true,
  photoKey: true,
});
export type RecipeSummary = z.infer<typeof RecipeSummary>;

/** A hand-entered Recipe: Ingredients are given as lines and parsed by Mise. */
export const NewRecipe = z
  .object({
    title: RecipeFields.title,
    baseServings: RecipeFields.baseServings,
    ingredients: IngredientLines,
    steps: RecipeFields.steps.default([]),
    tags: RecipeFields.tags.default([]),
    effortMinutes: RecipeFields.effortMinutes.default(null),
    cuisine: RecipeFields.cuisine.default(null),
    mainProtein: RecipeFields.mainProtein.default(null),
    course: RecipeFields.course.default(null),
    recurring: RecipeFields.recurring.default(null),
    yieldsLeftovers: RecipeFields.yieldsLeftovers.default(false),
    readyMade: RecipeFields.readyMade.default(false),
    prepAhead: RecipeFields.prepAhead.default(null),
    notes: RecipeFields.notes.default(null),
  })
  .strict();
export type NewRecipe = z.output<typeof NewRecipe>;

/** Changes only the fields given; lists given replace the old ones. */
export const UpdateRecipeInput = z
  .object({
    id: RecipeId,
    title: RecipeFields.title.optional(),
    baseServings: RecipeFields.baseServings.optional(),
    ingredients: IngredientLines.optional(),
    steps: RecipeFields.steps.optional(),
    tags: RecipeFields.tags.optional(),
    effortMinutes: RecipeFields.effortMinutes.optional(),
    cuisine: RecipeFields.cuisine.optional(),
    mainProtein: RecipeFields.mainProtein.optional(),
    course: RecipeFields.course.optional(),
    recurring: RecipeFields.recurring.optional(),
    yieldsLeftovers: RecipeFields.yieldsLeftovers.optional(),
    readyMade: RecipeFields.readyMade.optional(),
    prepAhead: RecipeFields.prepAhead.optional(),
    notes: RecipeFields.notes.optional(),
  })
  .strict();

export const GetRecipeInput = z.object({ id: RecipeId }).strict();

/** Deleting is destructive, so the caller must say they confirmed it. */
export const DeleteRecipeInput = z.object({ id: RecipeId, confirm: z.literal(true) }).strict();

/**
 * Finds Recipes whose title, a tag or an Ingredient matches `query` (empty: every Recipe), and that
 * carry `tag` if given. An Ingredient matches by its line or by its Item, so "scallions" finds
 * "4 green onions".
 */
export const SearchRecipesInput = z
  .object({
    query: z.string().trim().max(200).default(""),
    tag: z.string().trim().toLowerCase().min(1).max(50).optional(),
  })
  .strict();

/**
 * Unresolved Ingredients that read the same once normalised (case, plurals, punctuation), so that
 * one decision resolves them all. `text` is that normalised text.
 */
export const UnresolvedGroup = z.object({
  text: z.string(),
  /** How many lines read this way, across every Recipe. */
  count: z.number().int().positive(),
  /** The lines as written. */
  lines: z.array(z.string()),
  /** The Recipes they come from, each once. */
  recipes: z.array(Recipe.pick({ id: true, title: true })),
});
export type UnresolvedGroup = z.infer<typeof UnresolvedGroup>;
