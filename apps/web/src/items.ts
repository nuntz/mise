import type { Item, ItemId } from "@mise/domain";
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
