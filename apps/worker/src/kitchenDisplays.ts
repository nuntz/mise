import { addDays, type DaySheet, daySheet, KitchenDisplay, localDate, type Recipe, type RecipeId } from "@mise/domain";
import { readPrepAhead } from "./calendar";
import { readRecipe } from "./recipes";
import { newToken, tokenHash } from "./tokens";
import { type Handlers, readSettings } from "./tools";
import { readSlots } from "./weeks";

type KitchenDisplayTools = "list_kitchen_displays" | "add_kitchen_display" | "revoke_kitchen_display";

type KitchenDisplayRow = { id: number; label: string; added_at: string; last_used_at: string | null };

/** The Kitchen Display tools, against the household's SQLite. */
export const kitchenDisplayHandlers: Pick<Handlers, KitchenDisplayTools> = {
  list_kitchen_displays: (sql) => ({ ok: true, value: readKitchenDisplays(sql) }),

  // Pairing needs no set-up Household: the Day Sheet says when it isn't, and the display waits.
  add_kitchen_display: (sql, input) => {
    const token = newToken();
    const { id } = sql
      .exec<{ id: number }>(
        "INSERT INTO kitchen_display (label, token_hash, added_at) VALUES (?, ?, ?) RETURNING id",
        input.label,
        tokenHash(token),
        new Date().toISOString(),
      )
      .one();
    return { ok: true, value: { ...(readKitchenDisplay(sql, id) as KitchenDisplay), token } };
  },

  revoke_kitchen_display: (sql, input) => {
    const display = readKitchenDisplay(sql, input.id);
    if (!display) return { ok: false, error: { code: "not_found", message: "No such Kitchen Display" } };
    sql.exec("DELETE FROM kitchen_display WHERE id = ?", input.id);
    return { ok: true, value: display };
  },
};

/** Every Kitchen Display, oldest first; parsed, so a bad row throws. */
export function readKitchenDisplays(sql: SqlStorage): KitchenDisplay[] {
  return sql
    .exec<KitchenDisplayRow>("SELECT id, label, added_at, last_used_at FROM kitchen_display ORDER BY id")
    .toArray()
    .map(kitchenDisplayOf);
}

function readKitchenDisplay(sql: SqlStorage, id: number): KitchenDisplay | null {
  return readKitchenDisplays(sql).find((display) => display.id === id) ?? null;
}

function kitchenDisplayOf(row: KitchenDisplayRow): KitchenDisplay {
  return KitchenDisplay.parse({ id: row.id, label: row.label, addedAt: row.added_at, lastUsedAt: row.last_used_at });
}

/** What the Day Sheet route answers: refused, waiting on set-up, or the Day Sheet. */
export type DaySheetAnswer =
  | { status: "unauthorized" }
  | { status: "not_set_up" }
  | { status: "ok"; daySheet: DaySheet };

/**
 * Today's Day Sheet for the Kitchen Display holding `token`, which is marked as used; refused for
 * any other token. A token is looked up by its hash, so how long a refusal takes tells nothing about it.
 */
export function readDaySheet(sql: SqlStorage, token: string, now: Date): DaySheetAnswer {
  const [display] = sql
    .exec<{ id: number }>("SELECT id FROM kitchen_display WHERE token_hash = ?", tokenHash(token))
    .toArray();
  if (!display) return { status: "unauthorized" };
  sql.exec("UPDATE kitchen_display SET last_used_at = ? WHERE id = ?", now.toISOString(), display.id);
  const settings = readSettings(sql);
  if (!settings) return { status: "not_set_up" };
  const date = localDate(now, settings.timezone);
  // Today's Slots with their Recipes; tomorrow's only for the Prep-ahead notes due today.
  const slots = readSlots(sql, date, addDays(date, 1));
  const recipes = new Map<RecipeId, Recipe>();
  for (const slot of slots) {
    const recipe = slot.date === date && slot.recipe ? readRecipe(sql, slot.recipe.id) : null;
    if (recipe) recipes.set(recipe.id, recipe);
  }
  return {
    status: "ok",
    daySheet: daySheet({ household: settings, slots, recipes, prepAhead: readPrepAhead(sql), now }),
  };
}
