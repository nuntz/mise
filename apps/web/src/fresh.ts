import type { ChangeNotice, ChangeTopic, RecipeId } from "@mise/domain";
import { onCleanup } from "solid-js";
import type { MiseClient } from "./client";

/** What a load is asked for: the Recipes the notices it answers named, and only those, or everything. */
type Asked = ReadonlySet<RecipeId> | "all";

/** One load asked for both. */
const both = (a: Asked, b: Asked): Asked => (a === "all" || b === "all" ? "all" : new Set([...a, ...b]));

/** What a notice asks a load for: a `recipes` notice naming its Recipes asks for those alone. */
const askedBy = (notice: ChangeNotice | undefined): Asked =>
  notice?.topic === "recipes" && notice.recipes ? new Set(notice.recipes) : "all";

export type KeepFreshOptions = {
  /**
   * Whether a notice could change what's kept: one it doesn't want loads nothing. Asked only while no
   * load is in flight, which may have read what the notice changed before it did.
   */
  wanted?: (notice: ChangeNotice) => boolean;
};

/**
 * Loads with `load` as soon as it can, then again whenever any of `topics` changes or the connection
 * comes back (see `MiseClient.subscribe`), until the owner is cleaned up. Returns a way to load again,
 * for when what to load changes; it resolves once the load that answers it has.
 *
 * One load at a time: whatever asks for another while one is in flight waits for it, and however many
 * asked, one more load follows. A burst of change notices so costs the household two loads, not one
 * per notice. Only the latest load may `show` its answer or report `failed`: one overtaken by a notice
 * or a new input is out of date.
 *
 * `load` is handed the Recipes named by the `recipes` notices it answers, when every request it
 * answers named them; otherwise nothing, and anything may have changed. A load overtaken in flight
 * shows nothing, nor does one that fails, so the next answers its requests as well as its own.
 */
export function keepFresh<T>(
  client: MiseClient,
  topics: readonly ChangeTopic[],
  load: (named?: ReadonlySet<RecipeId>) => Promise<T>,
  show: (value: T) => void,
  failed: (error: unknown) => void = () => {},
  { wanted }: KeepFreshOptions = {},
): () => Promise<void> {
  type Load = { asked: Asked; done: Promise<void> };
  let inFlight: Load | undefined;
  let next: Load | undefined;
  /** What a load that failed was asked for, and the next is asked for as well. */
  let owed: Asked | undefined;
  const run = async (asked: Asked) => {
    try {
      const value = await load(asked === "all" ? undefined : asked);
      if (!next) show(value);
    } catch (error) {
      if (next) return;
      owed = asked;
      failed(error);
    }
  };
  const refetch = (request: Asked = "all"): Promise<void> => {
    if (!inFlight) {
      const asked = owed ? both(owed, request) : request;
      owed = undefined;
      const started: Load = { asked, done: run(asked).finally(() => (inFlight = undefined)) };
      inFlight = started;
      return started.done;
    }
    if (next) {
      next.asked = both(next.asked, request);
      return next.done;
    }
    const queued: Load = {
      asked: both(inFlight.asked, request),
      done: inFlight.done.then(() => {
        next = undefined;
        return refetch(queued.asked);
      }),
    };
    next = queued;
    return queued.done;
  };
  onCleanup(
    client.subscribe(topics, (notice) => {
      if (notice && !inFlight && wanted && !wanted(notice)) return;
      void refetch(askedBy(notice));
    }),
  );
  return () => refetch();
}
