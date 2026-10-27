import { type Accessor, createSignal, onCleanup } from "solid-js";

/**
 * Pushes held back while a traversal `home` started is still to run. History runs it later, to the
 * entry it aimed at when started, so it would take off an entry pushed in the meantime. Each push
 * names the index it's for; undefined when no traversal is pending, for any index.
 */
let held: { index: string; push: () => void }[] | undefined;
/** What each index does once history has moved, held pushes already on it. */
const afterTraversal = new Set<() => void>();
window.addEventListener("popstate", () => {
  const pushes = held ?? [];
  held = undefined;
  for (const { push } of pushes) push();
  for (const moved of afterTraversal) moved();
});

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
    const push = () => history.pushState({ ...state(), [key]: to, [idKey]: id, [depthKey]: depth() + 1 }, "");
    if (held) held.push({ index: id, push });
    else push();
    setPage(() => to);
    window.scrollTo?.({ top: 0 });
  };
  /** Takes back this index's held pushes, if any: they'd be pages no longer open. */
  const unhold = () => {
    if (held) held = held.filter((entry) => entry.index !== id);
  };
  const home = () => {
    unhold();
    if (held) setPage(undefined);
    else if (depth()) {
      held = [];
      history.go(-depth());
    }
  };
  const moved = () => setPage(() => (depth() ? (history.state[key] as T) : undefined));
  afterTraversal.add(moved);
  onCleanup(() => {
    afterTraversal.delete(moved);
    home();
  });
  if (initial) open(initial);

  return { page, open, back: () => history.back(), home };
}
