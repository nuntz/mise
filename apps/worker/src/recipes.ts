import {
  Ingredient,
  type NewRecipe,
  parseIngredient,
  Recipe,
  type RecipeId,
  type RecipeSummary,
  type Recurrence,
  recipeAllergens,
  type ToolResult,
} from "@mise/domain";
import { readCatalogue } from "./items";
import type { Handlers } from "./tools";

type RecipeRow = {
  id: number;
  title: string;
  base_servings: number;
  effort_minutes: number | null;
  cuisine: string | null;
  main_protein: string | null;
  recurring: string | null;
  yields_leftovers: number;
  prep_ahead: string | null;
  photo_key: string | null;
  created_at: string;
  updated_at: string;
};

type IngredientRow = {
  recipe_id: number;
  raw: string;
  amount_min: number | null;
  amount_max: number | null;
  unit: string | null;
  name: string;
  note: string | null;
  item_id: string | null;
};

type LineRow = { recipe_id: number; text: string };

type RecipeTools =
  | "create_recipe"
  | "get_recipe"
  | "update_recipe"
  | "delete_recipe"
  | "search_recipes"
  | "list_untagged_recipes";

/** The Recipe tools, against the household's SQLite. */
export const recipeHandlers: Pick<Handlers, RecipeTools> = {
  create_recipe: (sql, input) => {
    const now = new Date().toISOString();
    const { id } = sql
      .exec<{ id: number }>(
        `INSERT INTO recipe (title, base_servings, effort_minutes, cuisine, main_protein, recurring,
           yields_leftovers, prep_ahead, photo_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) RETURNING id`,
        input.title,
        input.baseServings,
        input.effortMinutes,
        input.cuisine,
        input.mainProtein,
        recurrenceColumn(input.recurring),
        Number(input.yieldsLeftovers),
        input.prepAhead,
        now,
        now,
      )
      .one();
    writeLists(sql, id, input);
    return { ok: true, value: readRecipe(sql, id) as Recipe };
  },

  get_recipe: (sql, input) => {
    const recipe = readRecipe(sql, input.id);
    return recipe ? { ok: true, value: recipe } : recipeNotFound(input.id);
  },

  update_recipe: (sql, input) => {
    const recipe = readRecipe(sql, input.id);
    if (!recipe) return recipeNotFound(input.id);
    const { id, ingredients: _, ...changes } = input;
    const fields = { ...recipe, ...changes };
    sql.exec(
      `UPDATE recipe SET title = ?, base_servings = ?, effort_minutes = ?, cuisine = ?, main_protein = ?,
         recurring = ?, yields_leftovers = ?, prep_ahead = ?, updated_at = ?
       WHERE id = ?`,
      fields.title,
      fields.baseServings,
      fields.effortMinutes,
      fields.cuisine,
      fields.mainProtein,
      recurrenceColumn(fields.recurring),
      Number(fields.yieldsLeftovers),
      fields.prepAhead,
      new Date().toISOString(),
      id,
    );
    writeLists(sql, id, input);
    return { ok: true, value: readRecipe(sql, id) as Recipe };
  },

  delete_recipe: (sql, input) => {
    const recipe = readRecipe(sql, input.id);
    if (!recipe) return recipeNotFound(input.id);
    for (const table of ["recipe_ingredient", "recipe_step", "recipe_tag"]) {
      sql.exec(`DELETE FROM ${table} WHERE recipe_id = ?`, recipe.id);
    }
    sql.exec("DELETE FROM recipe WHERE id = ?", recipe.id);
    return { ok: true, value: recipe };
  },

  search_recipes: (sql, input) => {
    const query = input.query.toLowerCase();
    const matching = new Set(
      sql
        .exec<{ id: number }>(
          `SELECT id FROM recipe AS r
           WHERE (?1 = ''
               OR instr(lower(r.title), ?1) > 0
               OR EXISTS (SELECT 1 FROM recipe_tag AS t WHERE t.recipe_id = r.id AND instr(t.tag, ?1) > 0)
               OR EXISTS (SELECT 1 FROM recipe_ingredient AS i WHERE i.recipe_id = r.id
                            AND (instr(lower(i.raw), ?1) > 0 OR i.item_id = ?2)))
             AND (?3 IS NULL OR EXISTS (SELECT 1 FROM recipe_tag AS t WHERE t.recipe_id = r.id AND t.tag = ?3))`,
          query,
          readCatalogue(sql).match(query),
          input.tag ?? null,
        )
        .toArray()
        .map((row) => row.id),
    );
    return { ok: true, value: summaries(readRecipes(sql).filter((recipe) => matching.has(recipe.id))) };
  },

  list_untagged_recipes: (sql) => ({
    ok: true,
    value: summaries(readRecipes(sql).filter((recipe) => recipe.cuisine === null || recipe.mainProtein === null)),
  }),
};

/** What a list shows of each Recipe, in title order. */
function summaries(recipes: Recipe[]): RecipeSummary[] {
  return recipes
    .sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id)
    .map(({ id, title, tags, effortMinutes, cuisine, mainProtein, allergens, photoKey }) => ({
      id,
      title,
      tags,
      effortMinutes,
      cuisine,
      mainProtein,
      allergens,
      photoKey,
    }));
}

/** Replaces a Recipe's Ingredients, steps and tags with those given, parsing each Ingredient line. */
function writeLists(
  sql: SqlStorage,
  id: RecipeId,
  lists: Partial<Pick<NewRecipe, "ingredients" | "steps" | "tags">>,
): void {
  if (lists.ingredients) {
    sql.exec("DELETE FROM recipe_ingredient WHERE recipe_id = ?", id);
    const catalogue = readCatalogue(sql);
    lists.ingredients.forEach((line, position) => {
      const ingredient = parseIngredient(line, catalogue);
      sql.exec(
        `INSERT INTO recipe_ingredient (recipe_id, position, raw, amount_min, amount_max, unit, name, note, item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        position,
        ingredient.raw,
        ingredient.amount?.min ?? null,
        ingredient.amount?.max ?? null,
        ingredient.unit,
        ingredient.name,
        ingredient.note,
        ingredient.item,
      );
    });
  }
  if (lists.steps) {
    sql.exec("DELETE FROM recipe_step WHERE recipe_id = ?", id);
    lists.steps.forEach((text, position) => {
      sql.exec("INSERT INTO recipe_step (recipe_id, position, text) VALUES (?, ?, ?)", id, position, text);
    });
  }
  if (lists.tags) {
    sql.exec("DELETE FROM recipe_tag WHERE recipe_id = ?", id);
    lists.tags.forEach((tag, position) => {
      sql.exec("INSERT INTO recipe_tag (recipe_id, position, tag) VALUES (?, ?, ?)", id, position, tag);
    });
  }
}

function readRecipe(sql: SqlStorage, id: RecipeId): Recipe | null {
  return readRecipes(sql, id)[0] ?? null;
}

/** Every Recipe in the order they were added, or just the one with `id`; parsed, so bad rows throw. */
export function readRecipes(sql: SqlStorage, id?: RecipeId): Recipe[] {
  const only = [id ?? null, id ?? null];
  const rows = sql.exec<RecipeRow>("SELECT * FROM recipe WHERE ? IS NULL OR id = ? ORDER BY id", ...only).toArray();
  const ingredients = groupByRecipe(
    sql
      .exec<IngredientRow>(
        `SELECT recipe_id, raw, amount_min, amount_max, unit, name, note, item_id FROM recipe_ingredient
         WHERE ? IS NULL OR recipe_id = ? ORDER BY recipe_id, position`,
        ...only,
      )
      .toArray(),
  );
  const steps = groupByRecipe(
    sql
      .exec<LineRow>(
        `SELECT recipe_id, text FROM recipe_step WHERE ? IS NULL OR recipe_id = ? ORDER BY recipe_id, position`,
        ...only,
      )
      .toArray(),
  );
  const tags = groupByRecipe(
    sql
      .exec<LineRow>(
        `SELECT recipe_id, tag AS text FROM recipe_tag WHERE ? IS NULL OR recipe_id = ? ORDER BY recipe_id, position`,
        ...only,
      )
      .toArray(),
  );
  const catalogue = readCatalogue(sql);
  // Refuses an Item the Household's catalogue does not have.
  const StoredIngredient = Ingredient.extend({ item: catalogue.knownItemId.nullable() });
  return rows.map((row) => {
    // Parsed before the Allergens are derived, so an unknown Item fails here as invalid data.
    const parsed = (ingredients.get(row.id) ?? []).map((ingredient) =>
      StoredIngredient.parse(ingredientOf(ingredient)),
    );
    return Recipe.parse({
      id: row.id,
      title: row.title,
      baseServings: row.base_servings,
      ingredients: parsed,
      steps: (steps.get(row.id) ?? []).map((step) => step.text),
      tags: (tags.get(row.id) ?? []).map((tag) => tag.text),
      effortMinutes: row.effort_minutes,
      cuisine: row.cuisine,
      mainProtein: row.main_protein,
      recurring: recurrenceOf(row.recurring),
      yieldsLeftovers: row.yields_leftovers === 1,
      prepAhead: row.prep_ahead,
      photoKey: row.photo_key,
      allergens: recipeAllergens(parsed, catalogue),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });
}

function ingredientOf(row: IngredientRow): unknown {
  return {
    raw: row.raw,
    amount: row.amount_min === null ? null : { min: row.amount_min, max: row.amount_max ?? row.amount_min },
    unit: row.unit,
    name: row.name,
    note: row.note,
    item: row.item_id,
  };
}

function groupByRecipe<T extends { recipe_id: number }>(rows: T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const row of rows) groups.set(row.recipe_id, [...(groups.get(row.recipe_id) ?? []), row]);
  return groups;
}

function recurrenceColumn(recurring: Recurrence | null): string | null {
  if (recurring === null) return null;
  return recurring === "weekly" ? "weekly" : recurring.weekday;
}

function recurrenceOf(column: string | null): Recurrence | null {
  if (column === null) return null;
  return column === "weekly" ? "weekly" : ({ weekday: column } as Recurrence);
}

function recipeNotFound<T>(id: RecipeId): ToolResult<T> {
  return { ok: false, error: { code: "not_found", message: `No Recipe with id ${id}` } };
}

/**
 * Points a Recipe at a new photo, or at none. Returns the key it pointed at before, or undefined
 * when there is no such Recipe.
 */
export function setPhotoKey(
  sql: SqlStorage,
  id: RecipeId,
  key: string | null,
): { previous: string | null } | undefined {
  const [row] = sql.exec<{ photo_key: string | null }>("SELECT photo_key FROM recipe WHERE id = ?", id).toArray();
  if (!row) return undefined;
  sql.exec("UPDATE recipe SET photo_key = ?, updated_at = ? WHERE id = ?", key, new Date().toISOString(), id);
  return { previous: row.photo_key };
}

/** The key of a Recipe's photo; null when it has none, undefined when there is no such Recipe. */
export function photoKeyOf(sql: SqlStorage, id: RecipeId): string | null | undefined {
  const [row] = sql.exec<{ photo_key: string | null }>("SELECT photo_key FROM recipe WHERE id = ?", id).toArray();
  return row?.photo_key;
}
