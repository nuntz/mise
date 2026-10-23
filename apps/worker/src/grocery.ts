import {
  buildGroceryList,
  GroceryAmount,
  type GroceryDemand,
  GroceryLine,
  type GroceryList,
  type GroceryNeed,
  GroceryOrigin,
  type GrocerySection,
  groceryLineKey,
  groceryPlanRevision,
  groupGroceryLines,
  type HouseholdSettings,
  type ItemCatalogue,
  LocalDate,
  parseIngredient,
  RecipeId,
  StoreSection,
  stapleToBuy,
  storeSectionOrder,
  type ToolResult,
  weekStartOf,
} from "@mise/domain";
import { z } from "zod";
import { readCatalogue } from "./items";
import { readRecipes } from "./recipes";
import { readStaples, restockStaple } from "./staples";
import { type Handlers, notSetUp, readSettings } from "./tools";
import { readWeek, storeWeek, weekNamedBy } from "./weeks";

type LineRow = {
  id: number;
  start_date: string;
  origin: string;
  item_id: string | null;
  text: string | null;
  amounts: string;
  unmeasured: number;
  recipe_ids: string;
  have: number;
  have_at: string | null;
};

/** A line as stored: what was built or typed, without the names and section it is shown with. */
type StoredLine = Pick<GroceryLine, "id" | "origin" | "item" | "amounts" | "unmeasured" | "have" | "haveAt"> & {
  startDate: LocalDate;
  text: string | null;
  recipeIds: RecipeId[];
};

type GroceryTools =
  | "build_grocery_list"
  | "get_grocery_list"
  | "set_have_tick"
  | "add_grocery_line"
  | "set_store_section_order";

/** The Grocery List tools, against the household's SQLite. */
export const groceryHandlers: Pick<Handlers, GroceryTools> = {
  build_grocery_list: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const start = weekNamedBy(settings, input.date);
    const demand = readDemand(sql, settings, start);
    storeWeek(sql, start);

    // A line still needed keeps its id, and so its Have Tick: matched by Item and units, or by text.
    const previous = new Map(
      readGroceryLines(sql, start)
        .filter((line) => line.origin !== "manual")
        .map((line) => [groceryLineKey(line), line]),
    );
    const kept: number[] = [];
    for (const need of buildGroceryList(demand)) {
      const match = previous.get(groceryLineKey(need));
      previous.delete(groceryLineKey(need));
      if (match) {
        sql.exec(
          "UPDATE grocery_line SET origin = ?, item_id = ?, text = ?, amounts = ?, unmeasured = ?, recipe_ids = ? WHERE id = ?",
          ...needColumns(need),
          match.id,
        );
        kept.push(match.id);
      } else {
        const { id } = sql
          .exec<{ id: number }>(
            `INSERT INTO grocery_line (start_date, origin, item_id, text, amounts, unmeasured, recipe_ids, have)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
            start,
            ...needColumns(need),
          )
          .one();
        kept.push(id);
      }
    }
    // Lines no Recipe or Staple needs any more go; those added by hand stay.
    sql.exec(
      `DELETE FROM grocery_line WHERE start_date = ? AND origin != 'manual'
       AND id NOT IN (SELECT value FROM json_each(?))`,
      start,
      JSON.stringify(kept),
    );
    sql.exec(
      "UPDATE week SET grocery_built_at = ?, grocery_plan_revision = ? WHERE start_date = ?",
      new Date().toISOString(),
      groceryPlanRevision(demand),
      start,
    );
    return { ok: true, value: readGroceryList(sql, settings, start) as GroceryList };
  },

  get_grocery_list: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    return { ok: true, value: readGroceryList(sql, settings, weekNamedBy(settings, input.date)) };
  },

  set_have_tick: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const [line] = readGroceryLines(sql, undefined, input.line);
    if (!line) return lineNotFound(input.line);
    // A tick set later than this one wins, so one synced late from offline changes nothing.
    if (line.haveAt === null || Date.parse(line.haveAt) <= Date.parse(input.at)) {
      sql.exec(
        "UPDATE grocery_line SET have = ?, have_at = ? WHERE id = ?",
        Number(input.have),
        new Date(input.at).toISOString(),
        line.id,
      );
      // Had, so a Staple of its Item is stocked; not having it says nothing about how it stands.
      if (input.have && line.item !== null) restockStaple(sql, line.item, input.at);
    }
    return { ok: true, value: shownLine(sql, settings, line.startDate, line.id) };
  },

  add_grocery_line: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const start = weekStartOf(input.date, settings.weekStartsOn);
    if (readGroceryBuilds(sql, start).length === 0) {
      return {
        ok: false,
        error: { code: "not_built", message: `Build the Grocery List of the Week of ${start} first` },
      };
    }
    if (input.key !== undefined) {
      const [added] = sql
        .exec<{ id: number; start_date: LocalDate }>(
          "SELECT id, start_date FROM grocery_line WHERE client_key = ?",
          input.key,
        )
        .toArray();
      if (added) return { ok: true, value: shownLine(sql, settings, added.start_date, added.id) };
    }
    const { item } = parseIngredient(input.text, readCatalogue(sql));
    const { id } = sql
      .exec<{ id: number }>(
        `INSERT INTO grocery_line (start_date, origin, item_id, text, amounts, unmeasured, recipe_ids, have, client_key)
         VALUES (?, 'manual', ?, ?, '[]', 0, '[]', 0, ?) RETURNING id`,
        start,
        item,
        input.text,
        input.key ?? null,
      )
      .one();
    return { ok: true, value: shownLine(sql, settings, start, id) };
  },

  set_store_section_order: (sql, input) => {
    if (!readSettings(sql)) return notSetUp();
    sql.exec("DELETE FROM store_section");
    input.sections.forEach((section, position) => {
      sql.exec("INSERT INTO store_section (position, section) VALUES (?, ?)", position, section);
    });
    return { ok: true, value: readStoreSections(sql) };
  },
};

/** Every Store Section in the Household's walking order. */
export function readStoreSections(sql: SqlStorage): StoreSection[] {
  const rows = sql.exec<{ section: string }>("SELECT section FROM store_section ORDER BY position").toArray();
  return storeSectionOrder(rows.map((row) => StoreSection.parse(row.section)));
}

/**
 * What the Week's Grocery List is built from: its Slots with a Recipe, each for what it is cooked for
 * (its Leftovers too, even those in the next Week), those Recipes, and the Household's Staples.
 */
function readDemand(sql: SqlStorage, settings: HouseholdSettings, start: LocalDate): GroceryDemand {
  const slots = readWeek(sql, start).slots.flatMap((slot) =>
    slot.recipe ? [{ recipeId: slot.recipe.id, servings: slot.cookFor }] : [],
  );
  const used = new Set(slots.map((slot) => slot.recipeId));
  return {
    slots,
    recipes: readRecipes(sql).filter((recipe) => used.has(recipe.id)),
    staples: readStaples(sql),
    units: settings.units,
  };
}

function needColumns(need: GroceryNeed): [string, string | null, string | null, string, number, string] {
  return [
    need.origin,
    need.item,
    need.text,
    JSON.stringify(need.amounts),
    Number(need.unmeasured),
    JSON.stringify(need.recipeIds),
  ];
}

/** What a Week stores about its Grocery List, once built. */
const BuiltRecord = z.object({ startDate: LocalDate, builtAt: z.iso.datetime(), planRevision: z.string() });
type BuiltRecord = z.infer<typeof BuiltRecord>;

/** When each Week's Grocery List, or the one starting on `start`, was built and from what; parsed, so bad rows throw. */
export function readGroceryBuilds(sql: SqlStorage, start?: LocalDate): BuiltRecord[] {
  return sql
    .exec<{ start_date: string; grocery_built_at: string; grocery_plan_revision: string }>(
      `SELECT start_date, grocery_built_at, grocery_plan_revision FROM week
       WHERE grocery_built_at IS NOT NULL AND (? IS NULL OR start_date = ?) ORDER BY start_date`,
      start ?? null,
      start ?? null,
    )
    .toArray()
    .map((row) =>
      BuiltRecord.parse({
        startDate: row.start_date,
        builtAt: row.grocery_built_at,
        planRevision: row.grocery_plan_revision,
      }),
    );
}

/** The Week's Grocery List as shown, against the plan as it is now; null until it is built. */
function readGroceryList(sql: SqlStorage, settings: HouseholdSettings, start: LocalDate): GroceryList | null {
  const [built] = readGroceryBuilds(sql, start);
  if (!built) return null;
  const catalogue = readCatalogue(sql);
  const demand = readDemand(sql, settings, start);
  const lines = readGroceryLines(sql, start);
  const listed = new Set(lines.map((line) => line.item));
  return {
    startDate: start,
    builtAt: built.builtAt,
    planChanged: built.planRevision !== groceryPlanRevision(demand),
    staplesChanged: demand.staples.some((staple) => stapleToBuy(staple) && !listed.has(staple.item)),
    sections: groupGroceryLines(shownLines(sql, catalogue, lines), readStoreSections(sql)),
  };
}

function shownLine(sql: SqlStorage, settings: HouseholdSettings, start: LocalDate, id: number): GroceryLine {
  const lines = readGroceryList(sql, settings, start)?.sections.flatMap((section) => section.lines) ?? [];
  return lines.find((line) => line.id === id) as GroceryLine;
}

/** Lines with their names, Recipes and sections, as the list shows them. */
function shownLines(
  sql: SqlStorage,
  catalogue: ItemCatalogue,
  lines: StoredLine[],
): (GroceryLine & { section: GrocerySection })[] {
  const titles = new Map(
    sql
      .exec<{ id: number; title: string }>("SELECT id, title FROM recipe")
      .toArray()
      .map((row) => [row.id, row.title]),
  );
  return lines.map(({ startDate: _, text, recipeIds, ...line }) => {
    const item = line.item === null ? undefined : catalogue.item(line.item);
    return {
      ...line,
      // A line added by hand shows what was typed; one built for an Item, the Item's name.
      name: line.origin === "manual" || !item ? (text ?? "") : item.name,
      // A Recipe deleted since the list was built no longer needs anything.
      recipes: recipeIds.flatMap((id) => {
        const title = titles.get(id);
        return title === undefined ? [] : [{ id, title }];
      }),
      section: item?.section ?? "other",
    };
  });
}

/** The stored lines of the Week starting on `start`, or of every Week, or just line `id`; parsed, so bad rows throw. */
export function readGroceryLines(sql: SqlStorage, start?: LocalDate, id?: number): StoredLine[] {
  const itemId = readCatalogue(sql).knownItemId;
  return sql
    .exec<LineRow>(
      `SELECT * FROM grocery_line WHERE (? IS NULL OR start_date = ?) AND (? IS NULL OR id = ?) ORDER BY id`,
      start ?? null,
      start ?? null,
      id ?? null,
      id ?? null,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      startDate: LocalDate.parse(row.start_date),
      origin: GroceryOrigin.parse(row.origin),
      item: row.item_id === null ? null : itemId.parse(row.item_id),
      text: row.text,
      amounts: z.array(GroceryAmount).parse(JSON.parse(row.amounts)),
      unmeasured: row.unmeasured === 1,
      recipeIds: z.array(RecipeId).parse(JSON.parse(row.recipe_ids)),
      have: row.have === 1,
      haveAt: GroceryLine.shape.haveAt.parse(row.have_at),
    }));
}

function lineNotFound<T>(id: number): ToolResult<T> {
  return { ok: false, error: { code: "not_found", message: `No Grocery List line with id ${id}` } };
}
