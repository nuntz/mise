import {
  type ImportError,
  type ImportedRecipe,
  ImportFlag,
  ImportRun,
  type ImportSource,
  parseIngredient,
  possibleDuplicate,
} from "@mise/domain";
import { readCatalogue } from "./items";
import { readRecipes, writeLists } from "./recipes";
import type { Handlers } from "./tools";

/**
 * A Recipe read from an export, its photo already stored in R2 under `photoKey`: null when the
 * source has none, undefined when its photo could not be used, so the Recipe keeps the one it has.
 */
export type PreparedRecipe = { recipe: ImportedRecipe; photoKey: string | null | undefined };

type ExistingRow = {
  id: number;
  source_revision: string | null;
  imported_at: string | null;
  edited_in_app_at: string | null;
  photo_key: string | null;
};

type RunRow = {
  id: number;
  source: string;
  started_at: string;
  created: number;
  updated: number;
  skipped: number;
  flagged: number;
};

type ErrorRow = { run_id: number; entry: string | null; message: string };

type FlagRow = {
  id: number;
  run_id: number;
  kind: string;
  recipe_id: number;
  title: string | null;
  duplicate_of: number | null;
  duplicate_title: string | null;
  flagged_at: string;
};

/**
 * Upserts each Recipe on its source id, and logs the run. A Recipe whose revision is unchanged, or
 * that is in the source's trash, is skipped; one edited in Mise since it was imported is flagged for
 * a merge, not overwritten; a new one like a Recipe from another source is created and flagged as a
 * possible duplicate. Nothing is deleted. Returns the run, and the photos updated Recipes no longer show.
 */
export function runImport(
  sql: SqlStorage,
  source: ImportSource,
  startedAt: string,
  prepared: PreparedRecipe[],
  errors: ImportError[],
): { run: ImportRun; replacedPhotos: string[] } {
  const { id: runId } = sql
    .exec<{ id: number }>(
      `INSERT INTO import_run (source, started_at, created, updated, skipped, flagged)
       VALUES (?, ?, 0, 0, 0, 0) RETURNING id`,
      source,
      startedAt,
    )
    .one();
  const counts = { created: 0, updated: 0, skipped: 0, flagged: 0 };
  const replacedPhotos: string[] = [];
  const catalogue = readCatalogue(sql);
  // Candidates for a duplicate: Recipes from other sources, as they were before this run.
  const others = readRecipes(sql).filter((recipe) => recipe.source.kind !== source);

  // `flagged` counts Recipes, however many flags each gets.
  const flag = (kind: ImportFlag["kind"], recipeId: number, duplicateOf: number | null, revision: string | null) => {
    sql.exec(
      `INSERT INTO import_flag (run_id, kind, recipe_id, duplicate_of, source_revision, flagged_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      runId,
      kind,
      recipeId,
      duplicateOf,
      revision,
      startedAt,
    );
  };

  for (const { recipe, photoKey } of prepared) {
    const [existing] = sql
      .exec<ExistingRow>(
        `SELECT id, source_revision, imported_at, edited_in_app_at, photo_key FROM recipe
         WHERE source_kind = ? AND source_id = ?`,
        source,
        recipe.externalId,
      )
      .toArray();

    if (!existing) {
      if (recipe.inTrash) {
        counts.skipped++;
        continue;
      }
      const id = insertRecipe(sql, source, recipe, photoKey ?? null, startedAt);
      counts.created++;
      const candidate = {
        title: recipe.title,
        ingredients: recipe.ingredients.map((line) => parseIngredient(line, catalogue)),
      };
      const duplicates = others.filter((other) => possibleDuplicate(candidate, other));
      for (const other of duplicates) flag("duplicate", id, other.id, null);
      if (duplicates.length > 0) counts.flagged++;
      continue;
    }

    if (existing.source_revision === recipe.revision || recipe.inTrash) {
      counts.skipped++;
      continue;
    }
    if (existing.edited_in_app_at !== null && existing.edited_in_app_at > (existing.imported_at ?? "")) {
      const alreadyFlagged =
        sql
          .exec(
            "SELECT 1 FROM import_flag WHERE kind = 'merge' AND recipe_id = ? AND source_revision = ?",
            existing.id,
            recipe.revision,
          )
          .toArray().length > 0;
      if (alreadyFlagged) counts.skipped++;
      else {
        flag("merge", existing.id, null, recipe.revision);
        counts.flagged++;
      }
      continue;
    }
    const newPhoto = photoKey === undefined ? existing.photo_key : photoKey;
    updateRecipe(sql, existing.id, recipe, newPhoto, startedAt);
    if (existing.photo_key !== null && existing.photo_key !== newPhoto) replacedPhotos.push(existing.photo_key);
    counts.updated++;
  }

  sql.exec(
    "UPDATE import_run SET created = ?, updated = ?, skipped = ?, flagged = ? WHERE id = ?",
    counts.created,
    counts.updated,
    counts.skipped,
    counts.flagged,
    runId,
  );
  errors.forEach((error, position) => {
    sql.exec(
      "INSERT INTO import_error (run_id, position, entry, message) VALUES (?, ?, ?, ?)",
      runId,
      position,
      error.entry,
      error.message,
    );
  });
  return { run: readImportRuns(sql, runId)[0] as ImportRun, replacedPhotos };
}

function insertRecipe(
  sql: SqlStorage,
  source: ImportSource,
  recipe: ImportedRecipe,
  photoKey: string | null,
  now: string,
): number {
  const { id } = sql
    .exec<{ id: number }>(
      `INSERT INTO recipe (title, base_servings, effort_minutes, cuisine, main_protein, recurring, yields_leftovers,
         prep_ahead, notes, photo_key, source_kind, source_id, source_revision, source_url, source_author,
         imported_at, imported_preference, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      recipe.title,
      recipe.baseServings,
      recipe.effortMinutes,
      recipe.cuisine,
      recipe.mainProtein,
      recipe.notes,
      photoKey,
      source,
      recipe.externalId,
      recipe.revision,
      recipe.url,
      recipe.author,
      now,
      recipe.importedPreference,
      now,
      now,
    )
    .one();
  writeLists(sql, id, recipe);
  return id;
}

/** Brings a Recipe up to the source's copy, leaving the fields only Mise has (recurring, leftovers, prep ahead). */
function updateRecipe(sql: SqlStorage, id: number, recipe: ImportedRecipe, photoKey: string | null, now: string) {
  sql.exec(
    `UPDATE recipe SET title = ?, base_servings = ?, effort_minutes = ?, cuisine = ?, main_protein = ?, notes = ?,
       photo_key = ?, source_revision = ?, source_url = ?, source_author = ?, imported_at = ?,
       imported_preference = ?, updated_at = ?
     WHERE id = ?`,
    recipe.title,
    recipe.baseServings,
    recipe.effortMinutes,
    recipe.cuisine,
    recipe.mainProtein,
    recipe.notes,
    photoKey,
    recipe.revision,
    recipe.url,
    recipe.author,
    now,
    recipe.importedPreference,
    now,
    id,
  );
  writeLists(sql, id, recipe);
}

/** Import runs, newest first, or just the one with `id`; parsed, so bad rows throw. */
export function readImportRuns(sql: SqlStorage, id?: number): ImportRun[] {
  const only = [id ?? null, id ?? null];
  const errors = sql
    .exec<ErrorRow>(
      "SELECT run_id, entry, message FROM import_error WHERE ? IS NULL OR run_id = ? ORDER BY run_id, position",
      ...only,
    )
    .toArray();
  return sql
    .exec<RunRow>("SELECT * FROM import_run WHERE ? IS NULL OR id = ? ORDER BY id DESC", ...only)
    .toArray()
    .map((row) =>
      ImportRun.parse({
        id: row.id,
        source: row.source,
        startedAt: row.started_at,
        created: row.created,
        updated: row.updated,
        skipped: row.skipped,
        flagged: row.flagged,
        errors: errors.filter((error) => error.run_id === row.id).map(({ entry, message }) => ({ entry, message })),
      }),
    );
}

/** Every import flag, newest first; parsed, so bad rows throw. */
export function readImportFlags(sql: SqlStorage): ImportFlag[] {
  return sql
    .exec<FlagRow>(
      `SELECT f.id, f.run_id, f.kind, f.recipe_id, r.title, f.duplicate_of, d.title AS duplicate_title, f.flagged_at
       FROM import_flag AS f LEFT JOIN recipe AS r ON r.id = f.recipe_id LEFT JOIN recipe AS d ON d.id = f.duplicate_of
       ORDER BY f.id DESC`,
    )
    .toArray()
    .map((row) =>
      ImportFlag.parse({
        id: row.id,
        runId: row.run_id,
        kind: row.kind,
        recipe: { id: row.recipe_id, title: row.title },
        duplicateOf: row.duplicate_of === null ? null : { id: row.duplicate_of, title: row.duplicate_title },
        flaggedAt: row.flagged_at,
      }),
    );
}

/** The import tools that only read, against the household's SQLite. */
export const importHandlers: Pick<Handlers, "list_import_runs" | "list_import_flags"> = {
  list_import_runs: (sql) => ({ ok: true, value: readImportRuns(sql) }),
  list_import_flags: (sql) => ({ ok: true, value: readImportFlags(sql) }),
};
