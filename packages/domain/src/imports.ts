import { z } from "zod";
import { normaliseItemName } from "./items";
import type { RecipeReading } from "./llm";
import { ImportedPreference, IngredientLines, Recipe, RecipeFields, RecipeId } from "./recipes";

/** The sources an import reads; Drive arrives with its own import. */
export const ImportSource = z.enum(["paprika", "text", "url", "tiktok", "instagram", "screenshot"]);
export type ImportSource = z.infer<typeof ImportSource>;

/** Something an import could not read: a file of the export, or the export itself (`entry` null). */
export const ImportError = z.object({ entry: z.string().nullable(), message: z.string() });
export type ImportError = z.infer<typeof ImportError>;

const Count = z.number().int().nonnegative();

/**
 * The log of one import. Running the same file again creates and updates nothing: every Recipe in
 * it is skipped (or, if it was already flagged, skipped without being flagged again). The exception
 * is a Recipe deleted in Mise since, which the import creates again, by design.
 */
export const ImportRun = z.object({
  id: z.number().int().positive(),
  source: ImportSource,
  startedAt: z.iso.datetime(),
  created: Count,
  updated: Count,
  /** Unchanged since the last import, or in the source's trash. */
  skipped: Count,
  /** Changed in the source but edited in Mise, so left alone; or created as a possible duplicate. */
  flagged: Count,
  errors: z.array(ImportError),
});
export type ImportRun = z.infer<typeof ImportRun>;

const RecipeRef = Recipe.pick({ id: true, title: true });

/** A Recipe read from a source, mapped onto Mise's fields, before it is stored. */
export const ImportedRecipe = z.object({
  /** The source's id for it (Paprika's `uid`): imports upsert on it. */
  externalId: z.string().min(1),
  /** Changes whenever the source's copy does (Paprika's `hash`, else a hash of the entry). */
  revision: z.string().min(1),
  title: RecipeFields.title,
  baseServings: RecipeFields.baseServings,
  ingredients: IngredientLines,
  steps: RecipeFields.steps,
  tags: RecipeFields.tags,
  effortMinutes: RecipeFields.effortMinutes,
  cuisine: RecipeFields.cuisine,
  mainProtein: RecipeFields.mainProtein,
  course: RecipeFields.course,
  notes: RecipeFields.notes,
  url: z.string().trim().min(1).max(2000).nullable(),
  author: z.string().trim().min(1).max(200).nullable(),
  importedPreference: ImportedPreference.nullable(),
  /** In the source's trash: never created, but never deleted either. */
  inTrash: z.boolean(),
});
export type ImportedRecipe = z.infer<typeof ImportedRecipe>;

/**
 * A Recipe an import left for someone to look at. `merge`: the source changed a Recipe edited in
 * Mise since, so the import did not overwrite it. `duplicate`: a new Recipe looks like one from
 * another source (`duplicateOf`); both are kept.
 */
export const ImportFlag = z.object({
  id: z.number().int().positive(),
  runId: z.number().int().positive(),
  kind: z.enum(["merge", "duplicate"]),
  recipe: RecipeRef,
  duplicateOf: RecipeRef.nullable(),
  flaggedAt: z.iso.datetime(),
});
export type ImportFlag = z.infer<typeof ImportFlag>;

/** The id `PUT …/imports/paprika` gave the uploaded file. */
export const RunPaprikaImportInput = z.object({ upload: z.uuid() }).strict();

/** Where an uploaded export waits in R2 until it is imported. */
export function importUploadKey(upload: string): string {
  return `imports/${upload}.paprikarecipes`;
}

/**
 * Whether two Recipes are probably the same dish: the same title once normalised, and at least
 * half the Ingredients of the shorter list in common (by Item, or by name while Unresolved).
 */
export function possibleDuplicate(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (normaliseItemName(a.title) !== normaliseItemName(b.title)) return false;
  const ours = ingredientKeys(a);
  const theirs = ingredientKeys(b);
  if (ours.size === 0 || theirs.size === 0) return true;
  const shared = [...ours].filter((key) => theirs.has(key)).length;
  return shared * 2 >= Math.min(ours.size, theirs.size);
}

export type DuplicateCandidate = Pick<Recipe, "title"> & {
  ingredients: Pick<Recipe["ingredients"][number], "item" | "name">[];
};

function ingredientKeys(recipe: DuplicateCandidate): Set<string> {
  return new Set(
    recipe.ingredients.map((ingredient) => ingredient.item ?? `name:${normaliseItemName(ingredient.name)}`),
  );
}

/** Servings when the source doesn't say. */
export const FALLBACK_SERVINGS = 4;

/** The longest text `import_text` reads: what a Recipe's notes, which keep it, can hold. */
export const MAX_PASTED_TEXT = 20_000;

/**
 * Pasted text (a caption, a message, a Doc's contents), for the model to read into a Draft Recipe;
 * or into the link-only Draft `draft`, to fill it.
 */
export const ImportTextInput = z
  .object({ text: z.string().trim().min(1).max(MAX_PASTED_TEXT), draft: RecipeId.optional() })
  .strict();

export const ImportTextOutput = z.object({
  run: ImportRun,
  /** The Draft made, or the Recipe the same text made before; null when the text holds no recipe. */
  recipe: RecipeRef.nullable(),
});

/**
 * The Recipe an import makes of pasted text the model read: its lines as the model copied them, its
 * Course as the model guessed it (ADR 0022 amendment), and the text itself in its notes, so a person
 * can check the guess against it. Keyed on the text, so pasting the same text again is skipped.
 */
export function importedFromText(text: string, reading: Extract<RecipeReading, { isRecipe: true }>): ImportedRecipe {
  const key = `text:${contentHash(text)}`;
  return importedFromReading(reading, {
    externalId: key,
    revision: key,
    notes: text.slice(0, MAX_PASTED_TEXT),
    url: null,
  });
}

/** What the model read, as a Recipe from the source named by `from`. */
export function importedFromReading(
  reading: Extract<RecipeReading, { isRecipe: true }>,
  from: Pick<ImportedRecipe, "externalId" | "revision" | "notes" | "url">,
): ImportedRecipe {
  const clip = (lines: string[], most: number, length: number) =>
    lines.slice(0, most).map((line) => line.slice(0, length));
  return ImportedRecipe.parse({
    ...from,
    title: reading.title.slice(0, 200),
    baseServings: Math.min(reading.servings ?? FALLBACK_SERVINGS, 100),
    ingredients: clip(reading.ingredients, 200, 500),
    steps: clip(reading.steps, 100, 5000),
    tags: [],
    effortMinutes: reading.minutes !== null && reading.minutes <= 24 * 60 ? reading.minutes : null,
    cuisine: null,
    mainProtein: null,
    course: reading.course,
    author: null,
    importedPreference: null,
    inTrash: false,
  });
}

/** The image types a screenshot may be: those the model reads. */
export const SCREENSHOT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ScreenshotType = (typeof SCREENSHOT_TYPES)[number];

export function isScreenshotType(type: string | null): type is ScreenshotType {
  return (SCREENSHOT_TYPES as readonly (string | null)[]).includes(type);
}
/**
 * The largest screenshot the model takes, the most read together, and their largest size together:
 * what one request to the model can carry once they are base64.
 */
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_SCREENSHOTS = 10;
export const MAX_SCREENSHOTS_BYTES = 20 * 1024 * 1024;

/** Where an uploaded screenshot waits in R2 until `import_screenshots` reads it. */
export function screenshotUploadKey(upload: string): string {
  return `imports/${upload}.screenshot`;
}

/**
 * The ids `PUT …/imports/screenshots` gave the uploaded screenshots, in the order to read them; or
 * with `draft`, to fill that link-only Draft.
 */
export const ImportScreenshotsInput = z
  .object({ uploads: z.array(z.uuid()).min(1).max(MAX_SCREENSHOTS), draft: RecipeId.optional() })
  .strict();

/**
 * The Recipe an import makes of screenshots the model read together, keyed on their contents (the
 * SHA-256 of each, in order), so that the same screenshots read again are skipped.
 */
export function importedFromScreenshots(
  digests: string[],
  reading: Extract<RecipeReading, { isRecipe: true }>,
): ImportedRecipe {
  const key = `screenshot:${contentHash(digests.join(","))}`;
  return importedFromReading(reading, { externalId: key, revision: key, notes: null, url: null });
}

/** A link to a recipe page, to import. */
export const ImportUrlInput = z
  .object({
    url: z
      .string()
      .trim()
      .max(2000)
      .pipe(z.url({ protocol: /^https?$/ })),
  })
  .strict();

export const ImportUrlOutput = z.object({
  run: ImportRun,
  /**
   * The Recipe the link made or updated, or the one it made before: a Recipe, a Draft the model
   * read, or a link-only Draft (`linkOnly`) waiting for the recipe's text.
   */
  recipe: RecipeRef.extend({ draft: z.boolean(), linkOnly: z.boolean() }),
});

/** A Draft Recipe waiting on a person, with the Recipes an import flagged it as a possible duplicate of. */
export const Draft = z.object({ recipe: Recipe, duplicateOf: z.array(RecipeRef) });
export type Draft = z.infer<typeof Draft>;

export const DraftInput = z.object({ id: RecipeId }).strict();

/** A short, stable hash of an entry's text (cyrb53), for exports whose Recipes carry no `hash`. */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
