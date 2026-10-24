import {
  currentWeek,
  type GroceryAmount,
  type GroceryLine,
  type GroceryList,
  type Household,
  type HouseholdClock,
  type LocalDate,
  nextWeekStart,
  type QueuedChange,
  type StoreSection,
  type TickQueue,
} from "@mise/domain";
import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import { shortDate } from "./dates";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";
import { savedGroceryList } from "./offline";

type GroceryHousehold = HouseholdClock & Pick<Household, "locale" | "storeSections">;

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
  onWeek: () => void;
  /** Told the start of the Week shown. */
  onWeekShown?: (start: LocalDate) => void;
}) {
  const [next, setNext] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const weekShown = (): LocalDate => {
    const current = currentWeek(new Date(), props.household);
    return next() ? nextWeekStart(current) : current.startDate;
  };
  // Undefined until loaded; null while the Week has no Grocery List. The one saved on this device
  // shows until the household answers, or for as long as it can't be reached.
  const [list, setList] = createSignal<GroceryList | null | undefined>(savedGroceryList(weekShown()));
  createEffect(() => props.onWeekShown?.(weekShown()));

  // The list says whether the plan, its Recipes or the Household's Store Sections changed under it.
  const refetch = keepFresh(
    props.client,
    ["grocery", "plan", "recipes", "household"],
    () => props.client.call("get_grocery_list", { date: weekShown() }),
    (result) => {
      setError(!result.ok);
      if (result.ok) setList(result.value);
    },
    // Offline, the saved list stands; reconnecting fetches it again.
    () => setError(props.online),
  );

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

  const [adding, setAdding] = createSignal(false);
  const [reordering, setReordering] = createSignal(false);
  const counts = (shown: GroceryList) => {
    const lines = shown.sections.flatMap((group) => group.lines.map((line) => withPendingTick(line, props.pending)));
    return { total: lines.length, done: lines.filter((line) => line.have).length };
  };

  return (
    <section class="screen" aria-labelledby="grocery-title">
      <header class="page-header">
        <div class="page-header-row">
          <div class="page-heading">
            <p class="overline">{t("grocery.overline")}</p>
            <h1 id="grocery-title">{t("grocery.weekOf", { date: shortDate(weekShown(), props.household.locale) })}</h1>
            <Show when={list()}>
              {(shown) => (
                <p class="meta">
                  {t("grocery.counts", {
                    lines: String(counts(shown()).total),
                    sections: String(shown().sections.length),
                  })}
                </p>
              )}
            </Show>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label={t("grocery.walkingOrder")}
            aria-expanded={reordering()}
            onClick={() => setReordering(!reordering())}
          >
            <Icon name="sort" />
          </button>
        </div>
        <div class="segmented">
          <button type="button" aria-pressed={!next()} onClick={() => show(false)}>
            {t("week.this")}
          </button>
          <button type="button" aria-pressed={next()} onClick={() => show(true)}>
            {t("week.next")}
          </button>
        </div>
        <Show when={list()}>
          <div class="actions">
            <button type="button" class="button-primary" aria-expanded={adding()} onClick={() => setAdding(!adding())}>
              <Icon name="plus" />
              {t("grocery.addLine")}
            </button>
            <button type="button" class="button-secondary" disabled={busy() || !props.online} onClick={build}>
              <Icon name="refresh" />
              {t("grocery.rebuild")}
            </button>
          </div>
        </Show>
      </header>
      <Show when={reordering()}>
        <WalkingOrder client={props.client} sections={props.household.storeSections} online={props.online} />
      </Show>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      <Show when={list() === undefined}>
        <Show when={props.online} fallback={<p class="empty">{t("grocery.notSaved")}</p>}>
          <GroceryLoading />
        </Show>
      </Show>
      <Show when={list() === null}>
        <div class="empty">
          <Icon name="basket" />
          <p class="empty-title">{t("grocery.none")}</p>
          <p>{t("grocery.emptyBody")}</p>
          <button type="button" class="button-primary" disabled={busy() || !props.online} onClick={build}>
            {t("grocery.build")}
          </button>
          <button type="button" class="button-link" onClick={() => props.onWeek()}>
            {t("grocery.reviewWeek")}
          </button>
        </div>
      </Show>
      <Show when={list()}>
        {(shown) => (
          <>
            <Show when={adding()}>
              <AddLine onAdd={(text) => props.queue.add(shown().startDate, text)} />
            </Show>
            <Show when={shown().planChanged}>
              <p class="banner banner-amber" role="alert">
                {t("grocery.planChanged")}
              </p>
            </Show>
            <Show when={shown().staplesChanged}>
              <p class="banner banner-amber" role="alert">
                {t("grocery.staplesChanged")}
              </p>
            </Show>
            <div>
              <For each={shown().sections}>
                {(group) => (
                  <section class="store-section" aria-label={sectionName(group.section)}>
                    <div class="section-head">
                      <h2>{sectionName(group.section)}</h2>
                      <span class="chip">{group.lines.length}</span>
                    </div>
                    <ul class="tick-list">
                      <For each={group.lines}>
                        {(line) => (
                          <LineView
                            line={withPendingTick(line, props.pending)}
                            pending={hasPendingTick(line, props.pending)}
                            locale={props.household.locale}
                            onTick={(have) => props.queue.tick(line.id, have)}
                          />
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </For>
              <Show when={addedOffline(props.pending, shown().startDate)}>
                {(added) => (
                  <section class="store-section" aria-label={t("offline.waiting")}>
                    <div class="section-head">
                      <h2>{t("offline.waiting")}</h2>
                    </div>
                    <ul class="tick-list">
                      <For each={added()}>
                        {(line) => (
                          <li class="tick-row">
                            <label>
                              <span class="tick tick-pending">
                                <input
                                  type="checkbox"
                                  checked={line.have}
                                  onChange={(event) => props.queue.tickAdded(line.key, event.currentTarget.checked)}
                                />
                                <Icon name="clock" class="icon-pending" />
                              </span>
                              <span class="qty" />
                              <span class="item-name">{line.text}</span>
                            </label>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </Show>
            </div>
            <Progress count={counts(shown())} />
          </>
        )}
      </Show>
    </section>
  );
}

/** How many lines are in the basket, kept in view at the bottom while shopping. */
function Progress(props: { count: { done: number; total: number } }) {
  const percent = () => (props.count.total ? (props.count.done / props.count.total) * 100 : 0);
  return (
    <div class="progress">
      <p class="progress-label">
        <span>{t("grocery.progress", { done: String(props.count.done), total: String(props.count.total) })}</span>
        <span>{t("grocery.left", { count: String(props.count.total - props.count.done) })}</span>
      </p>
      <div
        class="bar"
        role="progressbar"
        aria-label={t("grocery.progressLabel")}
        aria-valuemin={0}
        aria-valuemax={props.count.total}
        aria-valuenow={props.count.done}
      >
        {/* The one inline style: a width that is data, not design. */}
        <div style={{ width: `${percent()}%` }} />
      </div>
    </div>
  );
}

/** The list's shape in still blocks while it loads. */
function GroceryLoading() {
  return (
    <div aria-busy="true">
      <p class="visually-hidden">{t("grocery.loading")}</p>
      <For each={[4, 3, 1, 2]}>
        {(rows) => (
          <div aria-hidden="true">
            <div class="section-head">
              <span class="skeleton sk-section" />
            </div>
            <div class="tick-list">
              <For each={Array.from({ length: rows })}>
                {() => (
                  <div class="tick-row">
                    <span class="skeleton sk-tick" />
                    <span class="skeleton sk-qty" />
                    <span class="skeleton sk-item" />
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

function LineView(props: { line: GroceryLine; pending: boolean; locale: string; onTick: (have: boolean) => void }) {
  const detailsId = createUniqueId();
  const amounts = () => props.line.amounts.map((amount) => amountText(amount, props.locale)).join(" + ");
  const details = () =>
    [
      props.line.recipes.length > 0 &&
        t("grocery.for", { recipes: props.line.recipes.map((recipe) => recipe.title).join(", ") }),
      props.line.origin === "recipe" && props.line.item === null && t("grocery.asWritten"),
    ].filter((detail): detail is string => typeof detail === "string");
  return (
    <li class="tick-row">
      <label>
        <span class={props.pending ? "tick tick-pending" : "tick"}>
          <input
            type="checkbox"
            checked={props.line.have}
            aria-describedby={detailsId}
            // Set to what the box now shows; the queue stamps it with the time.
            onChange={(event) => props.onTick(event.currentTarget.checked)}
          />
          <Icon name="check" class="icon-check" />
          <Icon name="clock" class="icon-pending" />
        </span>
        <span class="qty">{amounts()}</span>{" "}
        <span class="item-name">
          {props.line.name}
          <Show when={props.line.unmeasured}>
            {" "}
            <span class="line-meta">{amounts() ? t("grocery.andSome") : t("grocery.some")}</span>
          </Show>
        </span>
      </label>
      <span class="tick-details" id={detailsId}>
        <For each={details()}>{(detail) => <span class="line-meta">{detail}</span>}</For>
        <Show when={props.line.origin === "staple"}>
          <span class="chip">{t("grocery.staple")}</span>
        </Show>
      </span>
    </li>
  );
}

/** Whether a tick of the line is waiting to sync. */
function hasPendingTick(line: GroceryLine, pending: readonly QueuedChange[]): boolean {
  return pending.some((change) => change.kind === "tick" && change.line === line.id);
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
    <form class="slot-form" onSubmit={add}>
      <label>
        {t("grocery.addLine")}
        <input
          ref={(input) => queueMicrotask(() => input.focus())}
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
          maxLength={200}
        />
      </label>
      <button type="submit" class="button-primary">
        {t("grocery.add")}
      </button>
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
    <section class="slot-form stack" aria-labelledby="walking-order">
      <h2 id="walking-order">{t("grocery.walkingOrder")}</h2>
      <p class="meta">{t("grocery.walkingOrderHint")}</p>
      <ol class="reorder">
        <For each={props.sections}>
          {(section, index) => (
            <li>
              <span>{sectionName(section)}</span>
              <button
                type="button"
                class="icon-button"
                disabled={index() === 0 || !props.online}
                aria-label={t("grocery.moveUp", { section: sectionName(section) })}
                onClick={() => move(index(), -1)}
              >
                <Icon name="arrowUp" />
              </button>
              <button
                type="button"
                class="icon-button"
                disabled={index() === props.sections.length - 1 || !props.online}
                aria-label={t("grocery.moveDown", { section: sectionName(section) })}
                onClick={() => move(index(), 1)}
              >
                <Icon name="arrowDown" />
              </button>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}
