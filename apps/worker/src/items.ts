import {
  Item,
  ItemCatalogue,
  type ItemId,
  normaliseItemName,
  type ToolResult,
  type UnresolvedGroup,
} from "@mise/domain";
import { z } from "zod";
import type { Handlers } from "./tools";

type ItemRow = { id: number; name: string; section: string; unit_family: string };

type AllergenRow = { item_id: number; allergen: string };

type AliasRow = { item_id: string; alias: string };

type UnresolvedRow = { recipe_id: number; title: string; raw: string; name: string };

type ItemTools = "list_unresolved_ingredients" | "resolve_ingredient" | "create_item" | "list_items";

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
    if (!catalogue.item(input.item)) {
      return { ok: false, error: { code: "not_found", message: `No Item ${input.item}` } };
    }
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
    input.allergens.forEach((allergen, position) => {
      sql.exec("INSERT INTO item_allergen (item_id, position, allergen) VALUES (?, ?, ?)", id, position, allergen);
    });
    const key: ItemId = `household:${id}`;
    // Each name once: an alias that reads the same as the name or an earlier alias adds nothing.
    const names = new Set([normaliseItemName(input.name)]);
    for (const alias of input.aliases) {
      if (names.has(normaliseItemName(alias))) continue;
      names.add(normaliseItemName(alias));
      sql.exec("INSERT INTO item_alias (item_id, alias) VALUES (?, ?)", key, alias);
    }
    const updated = readCatalogue(sql);
    resolveLines(sql, updated);
    return { ok: true, value: updated.item(key) as Item };
  },

  list_items: (sql) => ({ ok: true, value: readCatalogue(sql).items }),
};

/**
 * The Household's Item catalogue: the shipped Items plus its own and the aliases it added. Parsed, so
 * bad rows throw (a `ZodError`), such as an alias of an Item the catalogue does not have.
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
  return new ItemCatalogue(items, aliases);
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

function nameInUse<T>(name: string): ToolResult<T> {
  return { ok: false, error: { code: "name_in_use", message: `"${name}" already names another Item` } };
}
