import type { ChangeTopic } from "@mise/domain";
import { onCleanup } from "solid-js";
import type { MiseClient } from "./client";

/**
 * Loads with `load` as soon as it can, then again whenever any of `topics` changes or the connection
 * comes back (see `MiseClient.subscribe`), until the owner is cleaned up. Returns a way to load again,
 * for when what to load changes; it resolves once the load that answers it has.
 *
 * One load at a time: whatever asks for another while one is in flight waits for it, and however many
 * asked, one more load follows. A burst of change notices so costs the household two loads, not one
 * per notice. Only the latest load may `show` its answer or report `failed`: one overtaken by a notice
 * or a new input is out of date.
 */
export function keepFresh<T>(
  client: MiseClient,
  topics: readonly ChangeTopic[],
  load: () => Promise<T>,
  show: (value: T) => void,
  failed: (error: unknown) => void = () => {},
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let next: Promise<void> | undefined;
  const run = async () => {
    try {
      const value = await load();
      if (!next) show(value);
    } catch (error) {
      if (!next) failed(error);
    }
  };
  const refetch = (): Promise<void> => {
    if (!inFlight) {
      inFlight = run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    }
    next ??= inFlight.then(() => {
      next = undefined;
      return refetch();
    });
    return next;
  };
  onCleanup(client.subscribe(topics, () => void refetch()));
  return refetch;
}
