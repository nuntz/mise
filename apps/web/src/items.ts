import { type Item, type ItemId, normaliseItemName } from "@mise/domain";
import { createSignal } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";

/**
 * Every Item, shipped or the Household's own, kept current. Items change with the Recipes that resolve
 * to them, so they refetch on the same topic. Empty until loaded or when loading fails.
 */
export function createItems(client: MiseClient): () => Map<ItemId, Item> {
  const [items, setItems] = createSignal(new Map<ItemId, Item>());
  // On failure the lines show their Item's key; the next change or reconnect tries again.
  keepFresh(
    client,
    ["recipes"],
    () => client.call("list_items", {}),
    (result) => {
      if (result.ok) setItems(new Map(result.value.map((item) => [item.id, item])));
    },
  );
  return items;
}

/**
 * Whether `text` is one of `names` (an Item's name and aliases, say), or with "part" is in one of
 * them, matched as Item names are.
 */
export function nameMatches(names: readonly string[], text: string, match: "whole" | "part"): boolean {
  const wanted = normaliseItemName(text);
  return names.some((name) =>
    match === "whole" ? normaliseItemName(name) === wanted : normaliseItemName(name).includes(wanted),
  );
}

/** The Item a name or alias names, matched as Item names are. */
export function itemNamed(items: Iterable<Item>, name: string): Item | undefined {
  return [...items].find((item) => nameMatches([item.name, ...item.aliases], name, "whole"));
}
