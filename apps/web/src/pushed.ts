import { type Accessor, createSignal, onCleanup } from "solid-js";

/**
 * Pages pushed over an index, such as a Household section over the Household page: opening one pushes
 * a history entry, so the phone's back gesture (a `popstate`) returns to the page under it. `key`
 * names this index in the history state, so pages pushed over a pushed page keep the one below.
 * `initial` opens at once, pushed like any other. Only entries this index pushed count: `home`, and
 * leaving the index, take them off history, so back doesn't land on a page that's no longer there.
 */
export function createPushedPages<T extends string>(
  key: string,
  initial?: T,
): { page: Accessor<T | undefined>; open: (page: T) => void; back: () => void; home: () => void } {
  const id = crypto.randomUUID();
  const [idKey, depthKey] = [`${key}:id`, `${key}:depth`];
  const [page, setPage] = createSignal<T | undefined>();
  const state = (): Record<string, unknown> => history.state ?? {};
  /** How many of this index's pages are on history under the current entry, it included. */
  const depth = (from = state()) => (from[idKey] === id ? (from[depthKey] as number) : 0);

  const open = (to: T) => {
    history.pushState({ ...state(), [key]: to, [idKey]: id, [depthKey]: depth() + 1 }, "");
    setPage(() => to);
    window.scrollTo?.({ top: 0 });
  };
  const home = () => {
    if (depth()) history.go(-depth());
  };
  const onPop = (event: PopStateEvent) => setPage(() => (depth(event.state ?? {}) ? event.state[key] : undefined));
  window.addEventListener("popstate", onPop);
  onCleanup(() => {
    window.removeEventListener("popstate", onPop);
    home();
  });
  if (initial) open(initial);

  return { page, open, back: () => history.back(), home };
}
