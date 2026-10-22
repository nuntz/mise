import type { Item, ItemId } from "@mise/domain";
import { createSignal, onCleanup } from "solid-js";
import type { MiseClient } from "./client";

/**
 * Every Item, shipped or the Household's own, kept current. Items change with the Recipes that resolve
 * to them, so they refetch on the same topic. Empty until loaded or when loading fails.
 */
export function createItems(client: MiseClient): () => Map<ItemId, Item> {
  const [items, setItems] = createSignal(new Map<ItemId, Item>());
  const refetch = async () => {
    try {
      const result = await client.call("list_items", {});
      if (result.ok) setItems(new Map(result.value.map((item) => [item.id, item])));
    } catch {
      // The lines then show their Item's key; the next change or reconnect tries again.
    }
  };
  onCleanup(client.subscribe("recipes", refetch));
  return items;
}
