import type { ChangeTopic } from "@mise/domain";
import { onCleanup } from "solid-js";
import type { MiseClient } from "./client";

/**
 * Loads with `load` as soon as it can, then again whenever any of `topics` changes or the connection
 * comes back (see `MiseClient.subscribe`), until the owner is cleaned up. Only the latest load may
 * `show` its answer or report `failed`, whatever order the answers arrive in. Returns a way to load
 * again, for when what to load changes.
 */
export function keepFresh<T>(
  client: MiseClient,
  topics: readonly ChangeTopic[],
  load: () => Promise<T>,
  show: (value: T) => void,
  failed: (error: unknown) => void = () => {},
): () => Promise<void> {
  let latest = 0;
  const refetch = async () => {
    const attempt = ++latest;
    try {
      const value = await load();
      if (attempt === latest) show(value);
    } catch (error) {
      if (attempt === latest) failed(error);
    }
  };
  onCleanup(client.subscribe(topics, () => void refetch()));
  return refetch;
}
