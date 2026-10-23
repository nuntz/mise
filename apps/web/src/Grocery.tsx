import {
  addDays,
  currentWeekStart,
  type GroceryAmount,
  type GroceryLine,
  type GroceryList,
  type Household,
  type LocalDate,
  type QueuedChange,
  type StoreSection,
  type TickQueue,
} from "@mise/domain";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { MiseClient } from "./client";
import { t } from "./messages";
import { savedGroceryList } from "./offline";

type GroceryHousehold = Pick<Household, "timezone" | "weekStartsOn" | "locale" | "storeSections">;

/**
 * The Week's Grocery List, by Store Section in walking order, with Have Ticks, the Staples due to be
 * bought and lines added by hand. Ticks and added lines go through `queue`, so they work offline;
 * the changes still `pending` show on the list as made.
 */
export function GroceryPage(props: {
  client: MiseClient;
  household: GroceryHousehold;
  queue: TickQueue;
  pending: readonly QueuedChange[];
  online: boolean;
}) {
  const [next, setNext] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // Only the latest fetch may show its list, whatever order the answers arrive in.
  let latest = 0;

  const weekShown = (): LocalDate => {
    const start = currentWeekStart(new Date(), props.household.timezone, props.household.weekStartsOn);
    return next() ? addDays(start, 7) : start;
  };
  // Undefined until loaded; null while the Week has no Grocery List. The one saved on this device
  // shows until the household answers, or for as long as it can't be reached.
  const [list, setList] = createSignal<GroceryList | null | undefined>(savedGroceryList(weekShown()));

  const refetch = async () => {
    const fetch = ++latest;
    try {
      const result = await props.client.call("get_grocery_list", { date: weekShown() });
      if (fetch !== latest) return;
      setError(!result.ok);
      if (result.ok) setList(result.value);
    } catch {
      // Offline, the saved list stands; the open notice on reconnect fetches it again.
      if (fetch === latest) setError(props.online);
    }
  };
  // The list says whether the plan, its Recipes or the Household's Store Sections changed under it.
  for (const topic of ["grocery", "plan", "recipes", "household"] as const) {
    onCleanup(props.client.subscribe(topic, refetch));
  }

  const show = (showNext: boolean) => {
    setNext(showNext);
    setList(savedGroceryList(weekShown()));
    void refetch();
  };

  /** Runs a tool call; on success the change notice refetches the list. */
  const run = async (call: () => Promise<{ ok: boolean }>) => {
    setBusy(true);
    try {
      setError(!(await call()).ok);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const build = () => run(() => props.client.call("build_grocery_list", { date: weekShown() }));

  return (
    <section>
      <h2>{t("grocery.title")}</h2>
      <nav>
        <button type="button" aria-pressed={!next()} onClick={() => show(false)}>
          {t("week.this")}
        </button>
        <button type="button" aria-pressed={next()} onClick={() => show(true)}>
          {t("week.next")}
        </button>
      </nav>
      <Show when={error()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
      <Show when={list() === undefined && !props.online}>
        <p>{t("grocery.notSaved")}</p>
      </Show>
      <Show when={list() === null}>
        <p>{t("grocery.none")}</p>
        <button type="button" disabled={busy() || !props.online} onClick={build}>
          {t("grocery.build")}
        </button>
      </Show>
      <Show when={list()}>
        {(shown) => (
          <>
            <Show when={shown().planChanged}>
              <p role="alert">{t("grocery.planChanged")}</p>
            </Show>
            <Show when={shown().staplesChanged}>
              <p role="alert">{t("grocery.staplesChanged")}</p>
            </Show>
            <button type="button" disabled={busy() || !props.online} onClick={build}>
              {t("grocery.rebuild")}
            </button>
            <For each={shown().sections}>
              {(group) => (
                <section aria-label={sectionName(group.section)}>
                  <h3>{sectionName(group.section)}</h3>
                  <ul>
                    <For each={group.lines}>
                      {(line) => (
                        <li>
                          <LineView
                            line={withPendingTick(line, props.pending)}
                            locale={props.household.locale}
                            onTick={(have) => props.queue.tick(line.id, have)}
                          />
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
            <Show when={addedOffline(props.pending, shown().startDate)}>
              {(added) => (
                <section aria-label={t("offline.waiting")}>
                  <h3>{t("offline.waiting")}</h3>
                  <ul>
                    <For each={added()}>
                      {(line) => (
                        <li>
                          <label>
                            <input
                              type="checkbox"
                              checked={line.have}
                              onChange={(event) => props.queue.tickAdded(line.key, event.currentTarget.checked)}
                            />
                            {line.text}
                          </label>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </Show>
            <AddLine onAdd={(text) => props.queue.add(shown().startDate, text)} />
          </>
        )}
      </Show>
      <WalkingOrder client={props.client} sections={props.household.storeSections} online={props.online} />
    </section>
  );
}

function LineView(props: { line: GroceryLine; locale: string; onTick: (have: boolean) => void }) {
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={props.line.have}
          // Set to what the box now shows; the queue stamps it with the time.
          onChange={(event) => props.onTick(event.currentTarget.checked)}
        />
        {lineText(props.line, props.locale)}
      </label>
      <Show when={props.line.origin === "staple"}>
        <small>{t("grocery.staple")}</small>
      </Show>
      <Show when={props.line.origin === "recipe" && props.line.item === null}>
        <small>{t("grocery.asWritten")}</small>
      </Show>
      <Show when={props.line.recipes.length > 0}>
        <small>{t("grocery.for", { recipes: props.line.recipes.map((recipe) => recipe.title).join(", ") })}</small>
      </Show>
    </>
  );
}

/** The line as its latest tick not yet sent leaves it. */
function withPendingTick(line: GroceryLine, pending: readonly QueuedChange[]): GroceryLine {
  let have = line.have;
  for (const change of pending) if (change.kind === "tick" && change.line === line.id) have = change.have;
  return have === line.have ? line : { ...line, have };
}

/** The lines added to the Week of `startDate` and not sent yet, each as its latest tick leaves it; false if none. */
function addedOffline(pending: readonly QueuedChange[], startDate: LocalDate) {
  const added = pending.flatMap((change) =>
    change.kind === "add" && change.date === startDate ? [{ key: change.key, text: change.text, have: false }] : [],
  );
  for (const change of pending) {
    if (change.kind !== "tickAdded") continue;
    const line = added.find((each) => each.key === change.key);
    if (line) line.have = change.have;
  }
  return added.length > 0 && added;
}

/** "salt: 2–3 ml, and some to taste"; a line with nothing measured is just its name. */
function lineText(line: GroceryLine, locale: string): string {
  const amounts = line.amounts.map((amount) => amountText(amount, locale)).join(" + ");
  if (!amounts) return line.unmeasured ? t("grocery.someOf", { name: line.name }) : line.name;
  return `${line.name}: ${line.unmeasured ? t("grocery.andSome", { amounts }) : amounts}`;
}

export function amountText({ amount, unit }: GroceryAmount, locale: string): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const value =
    amount.min === amount.max ? number.format(amount.min) : `${number.format(amount.min)}–${number.format(amount.max)}`;
  return unit === null ? value : `${value} ${unit.replace("_", " ")}`;
}

function sectionName(section: StoreSection | "other"): string {
  return section === "other" ? t("grocery.other") : t(`section.${section}`);
}

/** Adds a line by hand; it is queued like a tick, so it can be added offline. */
function AddLine(props: { onAdd: (text: string) => void }) {
  const [text, setText] = createSignal("");

  const add = (event: SubmitEvent) => {
    event.preventDefault();
    if (!text().trim()) return;
    props.onAdd(text().trim());
    setText("");
  };

  return (
    <form onSubmit={add}>
      <label>
        {t("grocery.addLine")}
        <input value={text()} onInput={(event) => setText(event.currentTarget.value)} maxLength={200} />
      </label>
      <button type="submit">{t("grocery.add")}</button>
    </form>
  );
}

/** The Household's Store Sections in the order it walks its store, each movable up or down. */
function WalkingOrder(props: { client: MiseClient; sections: StoreSection[]; online: boolean }) {
  const move = (index: number, by: -1 | 1) => {
    const sections = [...props.sections];
    const [section] = sections.splice(index, 1) as [StoreSection];
    sections.splice(index + by, 0, section);
    void props.client.call("set_store_section_order", { sections });
  };

  return (
    <details>
      <summary>{t("grocery.walkingOrder")}</summary>
      <ol>
        <For each={props.sections}>
          {(section, index) => (
            <li>
              {sectionName(section)}
              <button
                type="button"
                disabled={index() === 0 || !props.online}
                aria-label={t("grocery.moveUp", { section: sectionName(section) })}
                onClick={() => move(index(), -1)}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={index() === props.sections.length - 1 || !props.online}
                aria-label={t("grocery.moveDown", { section: sectionName(section) })}
                onClick={() => move(index(), 1)}
              >
                ↓
              </button>
            </li>
          )}
        </For>
      </ol>
    </details>
  );
}
