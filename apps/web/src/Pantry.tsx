import {
  type CheckEvery,
  type DueStaples,
  INGREDIENT_UNITS,
  type IngredientUnit,
  type ItemId,
  type RecipeId,
  STAPLE_LOCATIONS,
  STAPLE_STATUSES,
  type Staple,
  type StapleLocation,
  type StapleStatus,
} from "@mise/domain";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { amountText } from "./Grocery";
import { Icon, type IconName } from "./icons";
import { createItems, itemNamed } from "./items";
import { nameText, t } from "./messages";
import { NeedsConnection } from "./NeedsConnection";

/**
 * How many Staples are due for a check, kept current; zero until loaded or when loading fails.
 * Staples are announced as "grocery".
 */
export function createDueCount(client: MiseClient): () => number {
  const [due, setDue] = createSignal(0);
  // On failure the banner just stays as it was; the next change or reconnect tries again.
  keepFresh(
    client,
    ["grocery"],
    () => client.call("list_due_staples", {}),
    (result) => {
      if (result.ok) setDue(result.value.due);
    },
  );
  return due;
}

/**
 * "Pantry check: 3 Staples", with a way to start it, while any Staple is due. Answers aren't kept to
 * sync later as Grocery ticks are, so offline the check can't be started.
 */
export function PantryBanner(props: { client: MiseClient; online: boolean; onOpen: () => void }) {
  const due = createDueCount(props.client);
  const reasonId = createUniqueId();
  return (
    <Show when={due() > 0}>
      <div class="banner banner-plum banner-nowrap" role="status">
        <p>{due() === 1 ? t("pantry.bannerOne") : t("pantry.banner", { count: String(due()) })}</p>
        <div class="control">
          <button
            type="button"
            disabled={!props.online}
            aria-describedby={props.online ? undefined : reasonId}
            onClick={() => props.onOpen()}
          >
            {t("pantry.checkNow")}
          </button>
          <NeedsConnection id={reasonId} online={props.online} />
        </div>
      </div>
    </Show>
  );
}

/** The pantry check-in, then every Staple and a form to add or change one. */
export function PantryPage(props: { client: MiseClient; locale: string; online: boolean; onWeek: () => void }) {
  return (
    <section class="screen" aria-labelledby="pantry-title">
      <CheckIn client={props.client} locale={props.locale} online={props.online} onWeek={props.onWeek} />
      <StapleList client={props.client} locale={props.locale} online={props.online} />
    </section>
  );
}

/**
 * The Staples due, one card at a time, each answered Stocked, Low or Out. The session asks about the
 * Staples due when it started, so answering one doesn't reshuffle the rest. A Staple found out three
 * times running is suggested for always buying before the next card. Answers aren't kept to sync
 * later, so offline nothing can be answered; a check under way waits on its card for the connection.
 */
function CheckIn(props: { client: MiseClient; locale: string; online: boolean; onWeek: () => void }) {
  const [due, setDue] = createSignal<DueStaples>();
  const [session, setSession] = createSignal<Staple[]>();
  const [index, setIndex] = createSignal(0);
  const [answers, setAnswers] = createSignal<{ staple: Staple; status: StapleStatus }[]>([]);
  const [suggested, setSuggested] = createSignal<Staple[]>([]);
  const [error, setError] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const reasonId = createUniqueId();

  // Offline, failing to load isn't an error: the start button says why it can't be used.
  keepFresh(
    props.client,
    ["grocery"],
    () => props.client.call("list_due_staples", {}),
    (result) => {
      setError(!result.ok);
      if (result.ok) setDue(result.value);
    },
    () => setError(props.online),
  );

  const start = () => {
    setSession(due()?.staples ?? []);
    setIndex(0);
    setAnswers([]);
    setSuggested([]);
  };

  const answer = async (staple: Staple, status: StapleStatus) => {
    setBusy(true);
    try {
      const result = await props.client.call("record_staple_status", {
        item: staple.item,
        status,
        at: new Date().toISOString(),
      });
      setError(!result.ok);
      if (!result.ok) return;
      if (result.value.suggestAlwaysBuy) setSuggested((all) => [...all, result.value]);
      setAnswers((all) => [...all, { staple, status }]);
      setIndex((at) => at + 1);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const alwaysBuy = async (staple: Staple) => {
    try {
      const result = await props.client.call("upsert_staple", { item: staple.item, alwaysBuy: true });
      setError(!result.ok);
      if (result.ok) dismiss(staple);
    } catch {
      setError(true);
    }
  };
  const dismiss = (staple: Staple) => setSuggested((all) => all.filter((one) => one.item !== staple.item));

  const startButton = () => (
    <div class="control">
      <button
        type="button"
        class="button-primary"
        disabled={!props.online}
        aria-describedby={props.online ? undefined : reasonId}
        onClick={start}
      >
        {t("pantry.start")}
      </button>
      <NeedsConnection id={reasonId} online={props.online} />
    </div>
  );

  const done = () => {
    const staples = session();
    return staples !== undefined && index() >= staples.length && suggested().length === 0;
  };
  const title = () => {
    const staples = session();
    if (done()) return t("pantry.allDone");
    const count = staples?.length ?? due()?.due;
    if (count === undefined) return t("pantry.check");
    if (count === 0) return t("pantry.nothingDueTitle");
    return t("pantry.toCheck", { count: String(count) });
  };

  return (
    <>
      <header class="page-header">
        <div class="page-heading">
          <p class="overline">{t("pantry.overline")}</p>
          <h1 id="pantry-title">{title()}</h1>
          <Show when={done() || (session()?.length ?? due()?.due) !== 0}>
            <p class="meta">{done() ? t("pantry.doneSub") : t("pantry.walk")}</p>
          </Show>
        </div>
      </header>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      <Show
        when={session()}
        fallback={
          <Show
            when={due()}
            fallback={
              <Show when={!props.online} fallback={<Show when={!error()}>{<CheckInLoading />}</Show>}>
                {startButton()}
              </Show>
            }
          >
            {(shown) => (
              <Show
                when={shown().due > 0}
                fallback={
                  <div class="empty">
                    <Icon name="jar" />
                    <p class="empty-title">{t("pantry.nothingDue")}</p>
                    <p>{t("pantry.nothingDueBody")}</p>
                  </div>
                }
              >
                {startButton()}
              </Show>
            )}
          </Show>
        }
      >
        {(staples) => (
          <Show
            when={suggested()[0]}
            fallback={
              <Show when={staples()[index()]} fallback={<CheckInDone answers={answers()} onWeek={props.onWeek} />}>
                {(staple) => (
                  <fieldset class="answers" aria-label={nameText(staple().name)}>
                    <Dots done={index()} count={staples().length} />
                    <p class="visually-hidden">
                      {t("pantry.progress", {
                        index: String(index() + 1),
                        count: String(staples().length),
                        location: t(`location.${staple().location}`),
                      })}
                    </p>
                    <div class="check-card">
                      <div class="check-card-head">
                        <p class="overline">{t(`location.${staple().location}`)}</p>
                        <span class="chip">{intervalText(staple())}</span>
                      </div>
                      <h2 class="check-card-title">{nameText(staple().name)}</h2>
                      <p>{lastCheckedText(staple(), props.locale)}</p>
                    </div>
                    <For each={STAPLE_STATUSES}>
                      {(status) => (
                        <button
                          type="button"
                          class={`answer answer-${status}`}
                          disabled={busy() || !props.online}
                          aria-describedby={props.online ? undefined : reasonId}
                          onClick={() => answer(staple(), status)}
                        >
                          <Icon name={STATUS_ICON[status]} />
                          {t(`staple.${status}`)}
                        </button>
                      )}
                    </For>
                    <NeedsConnection id={reasonId} online={props.online} />
                    <button
                      type="button"
                      class="button-quiet"
                      disabled={busy()}
                      onClick={() => setIndex((at) => at + 1)}
                    >
                      {t("pantry.skip")}
                    </button>
                    <Show when={staples()[index() + 1]}>
                      {(next) => (
                        <p class="next-up">
                          {t("pantry.nextUp", { name: next().name, location: t(`location.${next().location}`) })}
                        </p>
                      )}
                    </Show>
                  </fieldset>
                )}
              </Show>
            }
          >
            {(staple) => (
              <div class="stack">
                <section class="check-card suggest-card" aria-labelledby="suggestion-title">
                  <p class="overline">{t("pantry.suggestion")}</p>
                  <h2 id="suggestion-title" class="check-card-title">
                    {t("pantry.suggestTitle", { name: staple().name })}
                  </h2>
                  <p>{t("pantry.suggestAlwaysBuy", { name: staple().name })}</p>
                </section>
                <div class="control">
                  <button
                    type="button"
                    class="button-primary"
                    disabled={!props.online}
                    aria-describedby={props.online ? undefined : reasonId}
                    onClick={() => alwaysBuy(staple())}
                  >
                    {t("pantry.alwaysBuyIt", { name: staple().name })}
                  </button>
                  <NeedsConnection id={reasonId} online={props.online} />
                </div>
                <button type="button" class="button-secondary" onClick={() => dismiss(staple())}>
                  {t("pantry.keepChecking")}
                </button>
              </div>
            )}
          </Show>
        )}
      </Show>
    </>
  );
}

const STATUS_ICON = { stocked: "check", low: "low", out: "close" } as const satisfies Record<StapleStatus, IconName>;

/** How far through the check-in: done in leaf, the one being asked in plum. */
function Dots(props: { done: number; count: number }) {
  return (
    <div class="dots">
      <div aria-hidden="true">
        <For each={Array.from({ length: props.count })}>
          {(_, at) => <span class={at() < props.done ? "dot-done" : at() === props.done ? "dot-now" : ""} />}
        </For>
      </div>
      <p aria-hidden="true">
        {t("pantry.dots", { index: String(Math.min(props.done + 1, props.count)), count: String(props.count) })}
      </p>
    </div>
  );
}

function CheckInLoading() {
  return (
    <div class="stack" aria-busy="true">
      <p class="visually-hidden">{t("pantry.loading")}</p>
      <div class="check-card" aria-hidden="true">
        <span class="skeleton sk-label" />
        <span class="skeleton sk-card-title" />
        <span class="skeleton sk-body" />
      </div>
      <For each={STAPLE_STATUSES}>{() => <span class="skeleton answer" aria-hidden="true" />}</For>
    </div>
  );
}

/** The check-in answered: how many of each, by name. */
function CheckInDone(props: { answers: { staple: Staple; status: StapleStatus }[]; onWeek: () => void }) {
  const of = (status: StapleStatus) => props.answers.filter((answer) => answer.status === status);
  return (
    <div class="stack">
      <div class="done-mark">
        <Icon name="check" />
      </div>
      <h2 class="check-card-title center">{t("pantry.done")}</h2>
      <ul class="rows">
        <For each={STAPLE_STATUSES.filter((status) => of(status).length > 0)}>
          {(status) => (
            <li>
              <span class={`row-lead status-mark status-${status}`}>
                <Icon name={STATUS_ICON[status]} />
              </span>
              <span class="row-body">
                <strong class="row-title">{t(`pantry.summary.${status}`, { count: String(of(status).length) })}</strong>
                <span class="row-meta">
                  {of(status)
                    .map((answer) => nameText(answer.staple.name))
                    .join(", ")}
                </span>
              </span>
            </li>
          )}
        </For>
      </ul>
      <button type="button" class="button-primary" onClick={() => props.onWeek()}>
        {t("pantry.backToWeek")}
      </button>
    </div>
  );
}

function intervalText(staple: Staple): string {
  return staple.checkEvery === "every_shop"
    ? t("pantry.checkedEveryShop")
    : t("pantry.checkedEvery", { days: String(staple.checkEvery) });
}

/** "Last checked 3 weeks ago: Stocked." */
function lastCheckedText(staple: Staple, locale: string): string {
  if (staple.lastChecked === null) return t("pantry.neverChecked");
  const days = Math.round((Date.now() - Date.parse(staple.lastChecked)) / (24 * 60 * 60 * 1000));
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const when = days < 14 ? relative.format(-days, "day") : relative.format(-Math.round(days / 7), "week");
  return t("pantry.lastChecked", { when, status: t(`staple.${staple.status}`) });
}

/** What the Staple form holds while it is filled in. */
type StapleDraft = {
  name: string;
  location: StapleLocation;
  everyShop: boolean;
  days: string;
  alwaysBuy: boolean;
  quantity: string;
  unit: IngredientUnit | "";
};

const EMPTY_DRAFT: StapleDraft = {
  name: "",
  location: "pantry",
  everyShop: false,
  days: "14",
  alwaysBuy: false,
  quantity: "",
  unit: "",
};

function draftOf(staple: Staple): StapleDraft {
  return {
    name: staple.name,
    location: staple.location,
    everyShop: staple.checkEvery === "every_shop",
    days: staple.checkEvery === "every_shop" ? EMPTY_DRAFT.days : String(staple.checkEvery),
    alwaysBuy: staple.alwaysBuy,
    quantity: staple.qtyPerShop ? String(staple.qtyPerShop.amount.max) : "",
    unit: staple.qtyPerShop?.unit ?? "",
  };
}

/** A Staple's status as a chip: leaf when stocked, amber when low, warn when out. */
export function StapleStatusChip(props: { status: StapleStatus }) {
  return <span class={`chip ${STATUS_CHIP[props.status]}`}>{t(`staple.${props.status}`)}</span>;
}

const STATUS_CHIP = { stocked: "chip-leaf", low: "chip-amber", out: "chip-warn" } as const satisfies Record<
  StapleStatus,
  string
>;

/**
 * Every Staple as a row, each opening in place to change or remove it, and a form to add one.
 * Offline, the rows last loaded stay, but nothing can be saved.
 */
function StapleList(props: { client: MiseClient; locale: string; online: boolean }) {
  // Reconciled by Item, so a refetch keeps each row, and a Staple being edited keeps its draft.
  const [loaded, setLoaded] = createStore<{ staples: Staple[] }>({ staples: [] });
  // A row closes only its own form, so a save that finishes after another row was opened leaves that one open.
  const [editing, setEditing] = createSignal<ItemId>();

  // On failure the list stays as it was; the next change or reconnect tries again.
  keepFresh(
    props.client,
    ["grocery"],
    () => props.client.call("list_staples", {}),
    (result) => {
      if (result.ok) setLoaded("staples", reconcile(result.value, { key: "item" }));
    },
  );

  return (
    <section class="stack" aria-label={t("pantry.staples")}>
      <h2>{t("pantry.staples")}</h2>
      <ul class="rows">
        <For each={loaded.staples} fallback={<li>{t("pantry.noStaples")}</li>}>
          {(staple) => (
            <li>
              <StapleRow
                client={props.client}
                locale={props.locale}
                online={props.online}
                staple={staple}
                editing={editing() === staple.item}
                onEdit={(on) => setEditing((open) => (on ? staple.item : open === staple.item ? undefined : open))}
              />
            </li>
          )}
        </For>
      </ul>
      <AddStaple client={props.client} online={props.online} />
    </section>
  );
}

/** One Staple: its name, how it's kept and checked, and its status; or, while edited, its fields. */
function StapleRow(props: {
  client: MiseClient;
  locale: string;
  online: boolean;
  staple: Staple;
  editing: boolean;
  onEdit: (on: boolean) => void;
}) {
  const [draft, setDraft] = createSignal<StapleDraft>(draftOf(props.staple));
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const saveReasonId = createUniqueId();
  const removeReasonId = createUniqueId();

  const summary = () => {
    const staple = props.staple;
    return [
      t(`location.${staple.location}`),
      staple.alwaysBuy
        ? t("pantry.alwaysBought")
        : staple.checkEvery === "every_shop"
          ? t("pantry.everyShop")
          : t("pantry.everyDays", { days: String(staple.checkEvery) }),
      ...(staple.qtyPerShop ? [t("pantry.perShop", { amount: amountText(staple.qtyPerShop, props.locale) })] : []),
    ].join(" · ");
  };

  const run = async (change: () => Promise<{ ok: boolean }>) => {
    setBusy(true);
    try {
      const result = await change();
      setError(result.ok ? undefined : t("app.error"));
      if (result.ok) props.onEdit(false);
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    return run(() => props.client.call("upsert_staple", stapleOf(props.staple.item, draft())));
  };

  const body = () => (
    <span class="row-body">
      <span class="row-title name">{nameText(props.staple.name)}</span>
      <span class="row-meta">{summary()}</span>
      <span class="chips">
        <StapleStatusChip status={props.staple.status} />
      </span>
    </span>
  );

  return (
    <Show
      when={props.editing}
      fallback={
        <div class="row">
          {body()}
          <div class="row-end">
            <button
              type="button"
              class="button-row"
              aria-label={t("pantry.edit", { name: nameText(props.staple.name) })}
              onClick={() => {
                setDraft(draftOf(props.staple));
                setError(undefined);
                props.onEdit(true);
              }}
            >
              {t("member.edit")}
            </button>
          </div>
        </div>
      }
    >
      <form class="stack" aria-label={t("pantry.edit", { name: nameText(props.staple.name) })} onSubmit={save}>
        {body()}
        <StapleFields draft={draft()} onChange={(fields) => setDraft((current) => ({ ...current, ...fields }))} />
        <Show when={error()}>
          <p class="banner banner-warn" role="alert">
            {error()}
          </p>
        </Show>
        <div class="control">
          <button
            type="submit"
            class="button-primary"
            disabled={busy() || !props.online}
            aria-describedby={props.online ? undefined : saveReasonId}
          >
            {t("pantry.save")}
          </button>
          <NeedsConnection id={saveReasonId} online={props.online} />
        </div>
        <button type="button" class="button-quiet" onClick={() => props.onEdit(false)}>
          {t("pantry.cancel")}
        </button>
        <div class="control">
          <button
            type="button"
            class="button-danger"
            aria-label={t("pantry.remove", { name: nameText(props.staple.name) })}
            disabled={busy() || !props.online}
            aria-describedby={props.online ? undefined : removeReasonId}
            onClick={() => run(() => props.client.call("remove_staple", { item: props.staple.item }))}
          >
            {t("member.remove")}
          </button>
          <NeedsConnection id={removeReasonId} online={props.online} />
        </div>
      </form>
    </Show>
  );
}

/** "Add a Staple": an Item from the catalogue, where it's kept and how often it's checked. */
function AddStaple(props: { client: MiseClient; online: boolean }) {
  const items = createItems(props.client);
  const titleId = createUniqueId();
  const reasonId = createUniqueId();
  const [draft, setDraft] = createSignal<StapleDraft>(EMPTY_DRAFT);
  const [error, setError] = createSignal<string>();
  const change = (fields: Partial<StapleDraft>) => setDraft((current) => ({ ...current, ...fields }));

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    const filled = draft();
    const item = itemNamed(items().values(), filled.name);
    if (!item) {
      setError(t("pantry.noSuchItem", { name: filled.name.trim() }));
      return;
    }
    try {
      const result = await props.client.call("upsert_staple", stapleOf(item.id, filled));
      setError(result.ok ? undefined : t("app.error"));
      if (result.ok) setDraft(EMPTY_DRAFT);
    } catch {
      setError(t("app.error"));
    }
  };

  return (
    <form class="slot-form" aria-labelledby={titleId} onSubmit={add}>
      <h3 id={titleId}>{t("pantry.add")}</h3>
      <label>
        {t("pantry.item")}
        <input
          list="staple-items"
          required
          value={draft().name}
          onInput={(event) => change({ name: event.currentTarget.value })}
        />
      </label>
      <datalist id="staple-items">
        <For each={[...items().values()]}>{(item) => <option value={item.name} />}</For>
      </datalist>
      <StapleFields draft={draft()} onChange={change} />
      <div class="control">
        <button
          type="submit"
          class="button-secondary"
          disabled={!props.online}
          aria-describedby={props.online ? undefined : reasonId}
        >
          {t("pantry.addAction")}
        </button>
        <NeedsConnection id={reasonId} online={props.online} />
      </div>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
    </form>
  );
}

/** The upsert_staple input for an Item from a filled-in draft. */
function stapleOf(item: ItemId, filled: StapleDraft) {
  const quantity = Number(filled.quantity);
  const checkEvery: CheckEvery = filled.everyShop ? "every_shop" : Number(filled.days);
  return {
    item,
    location: filled.location,
    checkEvery,
    alwaysBuy: filled.alwaysBuy,
    qtyPerShop:
      filled.quantity && quantity > 0
        ? { amount: { min: quantity, max: quantity }, unit: filled.unit === "" ? null : filled.unit }
        : null,
  };
}

/** Where a Staple is kept, how often it's checked, whether it's always bought, and how much. */
function StapleFields(props: { draft: StapleDraft; onChange: (fields: Partial<StapleDraft>) => void }) {
  return (
    <>
      <label>
        {t("pantry.location")}
        <select
          value={props.draft.location}
          onChange={(event) => props.onChange({ location: event.currentTarget.value as StapleLocation })}
        >
          <For each={STAPLE_LOCATIONS}>
            {(location) => <option value={location}>{t(`location.${location}`)}</option>}
          </For>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={props.draft.everyShop}
          onChange={(event) => props.onChange({ everyShop: event.currentTarget.checked })}
        />
        {t("pantry.checkEveryShop")}
      </label>
      <label>
        {t("pantry.checkEvery")}
        <input
          type="number"
          min={1}
          max={365}
          disabled={props.draft.everyShop}
          value={props.draft.days}
          onInput={(event) => props.onChange({ days: event.currentTarget.value })}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={props.draft.alwaysBuy}
          onChange={(event) => props.onChange({ alwaysBuy: event.currentTarget.checked })}
        />
        {t("pantry.alwaysBuy")}
      </label>
      <label>
        {t("pantry.quantity")}
        <input
          type="number"
          min={0}
          step="any"
          value={props.draft.quantity}
          onInput={(event) => props.onChange({ quantity: event.currentTarget.value })}
        />
      </label>
      <label>
        {t("pantry.unit")}
        <select
          value={props.draft.unit}
          onChange={(event) => props.onChange({ unit: event.currentTarget.value as IngredientUnit | "" })}
        >
          <option value="">{t("pantry.noUnit")}</option>
          <For each={INGREDIENT_UNITS}>{(unit) => <option value={unit}>{unit.replace("_", " ")}</option>}</For>
        </select>
      </label>
    </>
  );
}

/**
 * After a dinner is cooked: the Staples its Recipe uses, each to mark low or out. Offline, they stay
 * shown but can't be marked.
 */
export function RunOut(props: { client: MiseClient; recipeId: RecipeId; online: boolean }) {
  const [staples, setStaples] = createSignal<Staple[]>([]);
  const [error, setError] = createSignal(false);
  const reasonId = createUniqueId();

  // On failure there's nothing to ask about until the next change or reconnect.
  keepFresh(
    props.client,
    ["grocery"],
    () => props.client.call("list_staples", { usedBy: props.recipeId }),
    (result) => {
      if (result.ok) setStaples(result.value);
    },
  );

  const record = async (staple: Staple, status: StapleStatus) => {
    try {
      const result = await props.client.call("record_staple_status", {
        item: staple.item,
        status,
        at: new Date().toISOString(),
      });
      setError(!result.ok);
    } catch {
      setError(true);
    }
  };

  return (
    <Show when={staples().length > 0}>
      <fieldset aria-label={t("pantry.runOut")}>
        <legend>{t("pantry.runOut")}</legend>
        <ul class="rows">
          <For each={staples()}>
            {(staple) => (
              <li>
                <span class="row-body">
                  <span class="row-title name">{nameText(staple.name)}</span>
                  <span class="row-meta">{t(`location.${staple.location}`)}</span>
                  <span class="chips">
                    <StapleStatusChip status={staple.status} />
                  </span>
                </span>
                <For each={["low", "out"] as const}>
                  {(status) => (
                    <button
                      type="button"
                      class="button-row"
                      aria-label={t(`pantry.record.${status}`, { name: nameText(staple.name) })}
                      aria-pressed={staple.status === status}
                      disabled={!props.online}
                      aria-describedby={props.online ? undefined : reasonId}
                      onClick={() => record(staple, status)}
                    >
                      {t(`staple.${status}`)}
                    </button>
                  )}
                </For>
              </li>
            )}
          </For>
        </ul>
        <NeedsConnection id={reasonId} online={props.online} />
        <Show when={error()}>
          <p class="banner banner-warn" role="alert">
            {t("app.error")}
          </p>
        </Show>
      </fieldset>
    </Show>
  );
}
