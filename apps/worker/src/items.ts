import {
  type Allergen,
  Item,
  ItemCatalogue,
  type ItemId,
  normaliseItemName,
  SHIPPED_ITEMS,
  ShippedItemId,
  StoreSection,
  type ToolResult,
  type UnresolvedGroup,
} from "@mise/domain";
import { z } from "zod";
import type { Handlers } from "./tools";

type ItemRow = { id: number; name: string; section: string; unit_family: string };

type AllergenRow = { item_id: number; allergen: string };

type AliasRow = { item_id: string; alias: string };

type UnresolvedRow = { recipe_id: number; title: string; raw: string; name: string };

type ItemTools = "list_unresolved_ingredients" | "resolve_ingredient" | "create_item" | "update_item" | "list_items";

/** The Item tools, against the household's SQLite. */
export const itemHandlers: Pick<Handlers, ItemTools> = {
  list_unresolved_ingredients: (sql) => {
    const rows = sql
      .exec<UnresolvedRow>(
        `SELECT i.recipe_id, r.title, i.raw, i.name FROM recipe_ingredient AS i JOIN recipe AS r ON r.id = i.recipe_id
         WHERE i.item_id IS NULL ORDER BY i.recipe_id, i.position`,
      )
      .toArray();
    const groups = new Map<string, UnresolvedGroup>();
    for (const row of rows) {
      const text = normaliseItemName(row.name);
      const group = groups.get(text) ?? { text, count: 0, lines: [], recipes: [] };
      group.count++;
      group.lines.push(row.raw);
      if (!group.recipes.some((recipe) => recipe.id === row.recipe_id)) {
        group.recipes.push({ id: row.recipe_id, title: row.title });
      }
      groups.set(text, group);
    }
    const sorted = [...groups.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    return { ok: true, value: sorted };
  },

  resolve_ingredient: (sql, input) => {
    const catalogue = readCatalogue(sql);
    if (!catalogue.item(input.item)) return itemNotFound(input.item);
    const named = catalogue.named(input.text);
    if (named !== null && named !== input.item) return nameInUse(input.text);
    if (named === null) sql.exec("INSERT INTO item_alias (item_id, alias) VALUES (?, ?)", input.item, input.text);
    const updated = readCatalogue(sql);
    return { ok: true, value: { item: updated.item(input.item) as Item, resolved: resolveLines(sql, updated) } };
  },

  create_item: (sql, input) => {
    const catalogue = readCatalogue(sql);
    const taken = [input.name, ...input.aliases].find((name) => catalogue.named(name) !== null);
    if (taken !== undefined) return nameInUse(taken);
    const { id } = sql
      .exec<{ id: number }>(
        "INSERT INTO item (name, section, unit_family) VALUES (?, ?, ?) RETURNING id",
        input.name,
        input.section,
        input.unitFamily,
      )
      .one();
    writeAllergens(sql, id, input.allergens);
    const key: ItemId = `household:${id}`;
    writeAliases(sql, key, [input.name], input.aliases);
    const updated = readCatalogue(sql);
    resolveLines(sql, updated);
    return { ok: true, value: updated.item(key) as Item };
  },

  update_item: (sql, input) => {
    const catalogue = readCatalogue(sql);
    const item = catalogue.item(input.id);
    if (!item) return itemNotFound(input.id);
    const shipped = SHIPPED_ITEMS.item(input.id);
    if (shipped && (input.name !== undefined || input.unitFamily !== undefined || input.allergens !== undefined)) {
      return {
        ok: false,
        error: {
          code: "shipped_item",
          message: `${shipped.name} ships with Mise: only its aliases and Store Section can change`,
        },
      };
    }
    const taken = [input.name, ...(input.aliases ?? [])].find((name) => {
      const named = name === undefined ? null : catalogue.named(name);
      return named !== null && named !== input.id;
    });
    if (taken !== undefined) return nameInUse(taken);

    const name = input.name ?? item.name;
    if (shipped) {
      if (input.section !== undefined) {
        sql.exec("DELETE FROM item_section WHERE item_id = ?", input.id);
        if (input.section !== shipped.section) {
          sql.exec("INSERT INTO item_section (item_id, section) VALUES (?, ?)", input.id, input.section);
        }
      }
    } else {
      const row = householdRowId(input.id);
      sql.exec(
        "UPDATE item SET name = ?, section = ?, unit_family = ? WHERE id = ?",
        name,
        input.section ?? item.section,
        input.unitFamily ?? item.unitFamily,
        row,
      );
      if (input.allergens) writeAllergens(sql, row, input.allergens);
    }
    if (input.aliases) {
      sql.exec("DELETE FROM item_alias WHERE item_id = ?", input.id);
      writeAliases(sql, input.id, shipped ? [shipped.name, ...shipped.aliases] : [name], input.aliases);
    }
    const updated = readCatalogue(sql);
    resolveLines(sql, updated);
    return { ok: true, value: updated.item(input.id) as Item };
  },

  list_items: (sql) => ({ ok: true, value: readCatalogue(sql).items }),
};

export function itemNotFound<T>(id: ItemId): ToolResult<T> {
  return { ok: false, error: { code: "not_found", message: `No Item ${id}` } };
}

/**
 * The Household's Item catalogue: the shipped Items plus its own, the aliases it added and the Store
 * Sections it chose for shipped ones. Parsed, so bad rows throw (a `ZodError`), such as an alias of an
 * Item the catalogue does not have.
 */
export function readCatalogue(sql: SqlStorage): ItemCatalogue {
  const allergens = sql
    .exec<AllergenRow>("SELECT item_id, allergen FROM item_allergen ORDER BY item_id, position")
    .toArray();
  const items = sql
    .exec<ItemRow>("SELECT id, name, section, unit_family FROM item ORDER BY id")
    .toArray()
    .map((row) =>
      Item.parse({
        id: `household:${row.id}`,
        name: row.name,
        aliases: [],
        section: row.section,
        allergens: allergens.filter((allergen) => allergen.item_id === row.id).map(({ allergen }) => allergen),
        unitFamily: row.unit_family,
      }),
    );
  const Alias = z.object({ item: new ItemCatalogue(items).knownItemId, alias: z.string().min(1) });
  const aliases = sql
    .exec<AliasRow>("SELECT item_id, alias FROM item_alias ORDER BY id")
    .toArray()
    .map((row) => Alias.parse({ item: row.item_id, alias: row.alias }));
  const Override = z.object({ item: ShippedItemId, section: StoreSection });
  const sections = sql
    .exec<{ item_id: string; section: string }>("SELECT item_id, section FROM item_section ORDER BY item_id")
    .toArray()
    .map((row) => Override.parse({ item: row.item_id, section: row.section }));
  return new ItemCatalogue(items, aliases, sections);
}

/** Resolves every Unresolved Ingredient that `catalogue` now matches. Returns how many it resolved. */
function resolveLines(sql: SqlStorage, catalogue: ItemCatalogue): number {
  const lines = sql
    .exec<{ recipe_id: number; position: number; name: string }>(
      "SELECT recipe_id, position, name FROM recipe_ingredient WHERE item_id IS NULL",
    )
    .toArray();
  let resolved = 0;
  for (const line of lines) {
    const item = catalogue.match(line.name);
    if (item === null) continue;
    sql.exec(
      "UPDATE recipe_ingredient SET item_id = ? WHERE recipe_id = ? AND position = ?",
      item,
      line.recipe_id,
      line.position,
    );
    resolved++;
  }
  return resolved;
}

/** Replaces a Household Item's Allergens. */
function writeAllergens(sql: SqlStorage, row: number, allergens: readonly Allergen[]): void {
  sql.exec("DELETE FROM item_allergen WHERE item_id = ?", row);
  allergens.forEach((allergen, position) => {
    sql.exec("INSERT INTO item_allergen (item_id, position, allergen) VALUES (?, ?, ?)", row, position, allergen);
  });
}

/**
 * Adds the Household's aliases of an Item, each name once: an alias that reads the same as one of
 * `own` (the names the Item already has) or an earlier alias adds nothing.
 */
function writeAliases(sql: SqlStorage, item: ItemId, own: readonly string[], aliases: readonly string[]): void {
  const names = new Set(own.map(normaliseItemName));
  for (const alias of aliases) {
    if (names.has(normaliseItemName(alias))) continue;
    names.add(normaliseItemName(alias));
    sql.exec("INSERT INTO item_alias (item_id, alias) VALUES (?, ?)", item, alias);
  }
}

/** The row of a Household Item's key. */
function householdRowId(id: ItemId): number {
  return Number(id.slice("household:".length));
}

function nameInUse<T>(name: string): ToolResult<T> {
  return { ok: false, error: { code: "name_in_use", message: `"${name}" already names another Item` } };
}
