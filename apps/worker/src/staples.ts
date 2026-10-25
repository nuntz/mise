import {
  byLocation,
  CheckEvery,
  dueStaples,
  GroceryAmount,
  type ItemId,
  localDate,
  NEW_STAPLE_INTERVAL,
  recordStapleStatus,
  Staple,
  suggestsAlwaysBuy,
  type ToolResult,
} from "@mise/domain";
import { readCatalogue } from "./items";
import { readRecipes } from "./recipes";
import { type Handlers, notSetUp, readSettings } from "./tools";

type StapleRow = {
  item_id: string;
  location: string;
  check_every_days: number | null;
  always_buy: number;
  qty_per_shop: string | null;
  status: string;
  last_checked: string | null;
  out_in_a_row: number;
};

type StapleTools = "upsert_staple" | "remove_staple" | "list_staples" | "list_due_staples" | "record_staple_status";

/** The Staple tools, against the household's SQLite. */
export const stapleHandlers: Pick<Handlers, StapleTools> = {
  upsert_staple: (sql, input) => {
    if (!readSettings(sql)) return notSetUp();
    if (!readCatalogue(sql).item(input.item)) {
      return { ok: false, error: { code: "not_found", message: `No Item ${input.item}` } };
    }
    const [current] = readStaples(sql, input.item);
    writeStaple(sql, { ...(current ?? newStaple(input.item)), ...definedFields(input) });
    return { ok: true, value: readStaples(sql, input.item)[0] as Staple };
  },

  remove_staple: (sql, input) => {
    if (!readSettings(sql)) return notSetUp();
    const [staple] = readStaples(sql, input.item);
    if (!staple) return notAStaple(input.item);
    sql.exec("DELETE FROM staple WHERE item_id = ?", input.item);
    return { ok: true, value: staple };
  },

  list_staples: (sql, input) => {
    if (!readSettings(sql)) return notSetUp();
    if (input.usedBy === undefined) return { ok: true, value: readStaples(sql) };
    const [recipe] = readRecipes(sql, input.usedBy);
    if (!recipe) return { ok: false, error: { code: "not_found", message: `No Recipe with id ${input.usedBy}` } };
    const used = new Set<string | null>(recipe.ingredients.map((ingredient) => ingredient.item));
    return { ok: true, value: readStaples(sql).filter((staple) => used.has(staple.item)) };
  },

  list_due_staples: (sql) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    return {
      ok: true,
      value: dueStaples(readStaples(sql), localDate(new Date(), settings.timezone), settings.timezone),
    };
  },

  record_staple_status: (sql, input) => {
    if (!readSettings(sql)) return notSetUp();
    if (!readCatalogue(sql).item(input.item)) {
      return { ok: false, error: { code: "not_found", message: `No Item ${input.item}` } };
    }
    // "We're out of paprika" needs no Staple first: an Item that is none becomes one, as `upsert_staple` makes it.
    const [staple = newStaple(input.item)] = readStaples(sql, input.item);
    const at = input.at ?? new Date().toISOString();
    // A status recorded later than this one wins, so one synced late from offline changes nothing.
    if (isLatest(staple, at)) writeStaple(sql, recordStapleStatus(staple, input.status, new Date(at).toISOString()));
    return { ok: true, value: readStaples(sql, input.item)[0] as Staple };
  },
};

/** A Staple as an Item first becomes one: in the pantry, stocked, never checked. */
function newStaple(item: ItemId): Omit<Staple, "name" | "suggestAlwaysBuy"> {
  return {
    item,
    location: "pantry",
    checkEvery: NEW_STAPLE_INTERVAL,
    alwaysBuy: false,
    qtyPerShop: null,
    status: "stocked",
    lastChecked: null,
    outInARow: 0,
  };
}

/**
 * Sets the Item's Staple, if it is one, to stocked as of `at`, unless a status was recorded later:
 * the Household has it. Not a check-in's answer, so its interval and its count of 'out' stay.
 */
export function restockStaple(sql: SqlStorage, item: ItemId, at: string): void {
  const [staple] = readStaples(sql, item);
  if (staple && isLatest(staple, at)) {
    writeStaple(sql, { ...staple, status: "stocked", lastChecked: new Date(at).toISOString() });
  }
}

function isLatest(staple: Pick<Staple, "lastChecked">, at: string): boolean {
  return staple.lastChecked === null || Date.parse(staple.lastChecked) <= Date.parse(at);
}

/** The fields an upsert gives, without those it leaves out. */
function definedFields<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function writeStaple(sql: SqlStorage, staple: Omit<Staple, "name" | "suggestAlwaysBuy">): void {
  sql.exec(
    `INSERT OR REPLACE INTO staple
       (item_id, location, check_every_days, always_buy, qty_per_shop, status, last_checked, out_in_a_row)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    staple.item,
    staple.location,
    staple.checkEvery === "every_shop" ? null : staple.checkEvery,
    Number(staple.alwaysBuy),
    staple.qtyPerShop && JSON.stringify(staple.qtyPerShop),
    staple.status,
    staple.lastChecked,
    staple.outInARow,
  );
}

/** Every Staple, by location then name, or just the Item's; parsed, so bad rows throw. */
export function readStaples(sql: SqlStorage, item?: ItemId): Staple[] {
  const catalogue = readCatalogue(sql);
  return sql
    .exec<StapleRow>("SELECT * FROM staple WHERE ? IS NULL OR item_id = ?", item ?? null, item ?? null)
    .toArray()
    .map((row) => {
      const id = catalogue.knownItemId.parse(row.item_id);
      const outInARow = row.out_in_a_row;
      const alwaysBuy = row.always_buy === 1;
      return Staple.parse({
        item: id,
        name: catalogue.item(id)?.name,
        location: row.location,
        checkEvery: CheckEvery.parse(row.check_every_days ?? "every_shop"),
        alwaysBuy,
        qtyPerShop: row.qty_per_shop === null ? null : GroceryAmount.parse(JSON.parse(row.qty_per_shop)),
        status: row.status,
        lastChecked: row.last_checked,
        outInARow,
        suggestAlwaysBuy: suggestsAlwaysBuy({ outInARow, alwaysBuy }),
      });
    })
    .sort((a, b) => byLocation(a, b) || a.name.localeCompare(b.name));
}

function notAStaple<T>(item: ItemId): ToolResult<T> {
  return { ok: false, error: { code: "not_found", message: `${item} is not a Staple` } };
}
