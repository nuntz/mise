import { z } from "zod";
import { normaliseItemName } from "./items";
import { Recipe } from "./recipes";

/** The sources an import reads; more arrive with the Drive, URL and video imports. */
export const ImportSource = z.enum(["paprika"]);
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
