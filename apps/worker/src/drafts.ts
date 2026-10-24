import type { Recipe, RecipeId, ToolResult } from "@mise/domain";
import { readImportFlags } from "./imports";
import { readRecipe, readRecipes } from "./recipes";
import type { Handlers } from "./tools";

/**
 * The Draft Recipe tools, against the household's SQLite; `import_text` asks the model, so the
 * household runs it. A Draft is discarded as any Recipe is deleted, with `delete_recipe`.
 */
export const draftHandlers: Pick<Handlers, "list_drafts" | "accept_draft"> = {
  list_drafts: (sql) => {
    const duplicates = readImportFlags(sql).filter((flag) => flag.kind === "duplicate");
    const drafts = readRecipes(sql)
      .filter((recipe) => recipe.draft)
      .reverse()
      .map((recipe) => ({
        recipe,
        duplicateOf: duplicates.flatMap((flag) =>
          flag.recipe.id === recipe.id && flag.duplicateOf ? [flag.duplicateOf] : [],
        ),
      }));
    return { ok: true, value: drafts };
  },

  /** Not an edit in Mise: a later import of its source may still update it. */
  accept_draft: (sql, input) => {
    const draft = readDraft(sql, input.id);
    if (!draft) return draftNotFound(input.id);
    sql.exec("UPDATE recipe SET draft = 0, updated_at = ? WHERE id = ?", new Date().toISOString(), draft.id);
    return { ok: true, value: readRecipe(sql, draft.id) as Recipe };
  },
};

function readDraft(sql: SqlStorage, id: RecipeId): Recipe | null {
  const recipe = readRecipe(sql, id);
  return recipe?.draft ? recipe : null;
}

function draftNotFound<T>(id: RecipeId): ToolResult<T> {
  return { ok: false, error: { code: "not_found", message: `No Draft Recipe with id ${id}` } };
}
