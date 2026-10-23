import {
  type CheckEvery,
  type DueStaples,
  INGREDIENT_UNITS,
  type IngredientUnit,
  type Item,
  normaliseItemName,
  type RecipeId,
  STAPLE_LOCATIONS,
  STAPLE_STATUSES,
  type Staple,
  type StapleLocation,
  type StapleStatus,
} from "@mise/domain";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { MiseClient } from "./client";
import { amountText } from "./Grocery";
import { createItems } from "./items";
import { t } from "./messages";

/**
 * How many Staples are due for a check, kept current; zero until loaded or when loading fails.
 * Staples are announced as "grocery".
 */
export function createDueCount(client: MiseClient): () => number {
  const [due, setDue] = createSignal(0);
  const refetch = async () => {
    try {
      const result = await client.call("list_due_staples", {});
      if (result.ok) setDue(result.value.due);
    } catch {
      // The banner just stays as it was; the next change or reconnect tries again.
    }
  };
  onCleanup(client.subscribe("grocery", refetch));
  return due;
}

/** "Pantry check: 3 Staples", with a way to start it, while any Staple is due. */
export function PantryBanner(props: { client: MiseClient; onOpen: () => void }) {
  const due = createDueCount(props.client);
  return (
    <Show when={due() > 0}>
      <p role="status">
        {due() === 1 ? t("pantry.bannerOne") : t("pantry.banner", { count: String(due()) })}{" "}
        <button type="button" onClick={() => props.onOpen()}>
          {t("pantry.checkNow")}
        </button>
      </p>
    </Show>
  );
}

/** The pantry check-in, then every Staple and a form to add or change one. */
export function PantryPage(props: { client: MiseClient; locale: string }) {
  return (
    <section>
      <h2>{t("pantry.title")}</h2>
      <CheckIn client={props.client} />
      <StapleList client={props.client} locale={props.locale} />
    </section>
  );
}

/**
 * The Staples due, one card at a time. The session asks about the Staples due when it started, so
 * answering one doesn't reshuffle the rest.
 */
function CheckIn(props: { client: MiseClient }) {
  const [due, setDue] = createSignal<DueStaples>();
  const [session, setSession] = createSignal<Staple[]>();
  const [index, setIndex] = createSignal(0);
  const [suggested, setSuggested] = createSignal<Staple[]>([]);
  const [error, setError] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const refetch = async () => {
    try {
      const result = await props.client.call("list_due_staples", {});
      if (result.ok) setDue(result.value);
    } catch {
      setError(true);
    }
  };
  onCleanup(props.client.subscribe("grocery", refetch));

  const start = () => {
    setSession(due()?.staples ?? []);
    setIndex(0);
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
      if (result.ok) setSuggested((all) => all.filter((one) => one.item !== staple.item));
    } catch {
      setError(true);
    }
  };

  return (
    <section>
      <h3>{t("pantry.check")}</h3>
      <Show when={error()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
      <Show
        when={session()}
        fallback={
          <Show when={due()}>
            {(shown) => (
              <Show when={shown().due > 0} fallback={<p>{t("pantry.nothingDue")}</p>}>
                <p>{shown().due === 1 ? t("pantry.dueOne") : t("pantry.due", { count: String(shown().due) })}</p>
                <button type="button" onClick={start}>
                  {t("pantry.start")}
                </button>
              </Show>
            )}
          </Show>
        }
      >
        {(staples) => (
          <Show when={staples()[index()]} fallback={<p>{t("pantry.done")}</p>}>
            {(staple) => (
              <fieldset aria-label={staple().name}>
                <legend>{staple().name}</legend>
                <p>
                  {t("pantry.progress", {
                    index: String(index() + 1),
                    count: String(staples().length),
                    location: t(`location.${staple().location}`),
                  })}
                </p>
                <For each={STAPLE_STATUSES}>
                  {(status) => (
                    <button type="button" disabled={busy()} onClick={() => answer(staple(), status)}>
                      {t(`staple.${status}`)}
                    </button>
                  )}
                </For>
              </fieldset>
            )}
          </Show>
        )}
      </Show>
      <For each={suggested()}>
        {(staple) => (
          <p>
            {t("pantry.suggestAlwaysBuy", { name: staple.name })}{" "}
            <button type="button" onClick={() => alwaysBuy(staple)}>
              {t("pantry.alwaysBuyIt", { name: staple.name })}
            </button>
          </p>
        )}
      </For>
    </section>
  );
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

/** The Item a name or alias names, matched as Item names are. */
function itemNamed(items: Iterable<Item>, name: string): Item | undefined {
  const wanted = normaliseItemName(name);
  return [...items].find((item) => [item.name, ...item.aliases].some((one) => normaliseItemName(one) === wanted));
}

/** Every Staple, each to change or remove, and a form to add one or change one. */
function StapleList(props: { client: MiseClient; locale: string }) {
  const items = createItems(props.client);
  const [staples, setStaples] = createSignal<Staple[]>([]);
  const [draft, setDraft] = createSignal<StapleDraft>(EMPTY_DRAFT);
  const [error, setError] = createSignal<string>();

  const refetch = async () => {
    try {
      const result = await props.client.call("list_staples", {});
      if (result.ok) setStaples(result.value);
    } catch {
      // The list stays as it was; the next change or reconnect tries again.
    }
  };
  onCleanup(props.client.subscribe("grocery", refetch));

  const change = (fields: Partial<StapleDraft>) => setDraft((current) => ({ ...current, ...fields }));

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const filled = draft();
    const item = itemNamed(items().values(), filled.name);
    if (!item) {
      setError(t("pantry.noSuchItem", { name: filled.name.trim() }));
      return;
    }
    const quantity = Number(filled.quantity);
    const checkEvery: CheckEvery = filled.everyShop ? "every_shop" : Number(filled.days);
    try {
      const result = await props.client.call("upsert_staple", {
        item: item.id,
        location: filled.location,
        checkEvery,
        alwaysBuy: filled.alwaysBuy,
        qtyPerShop:
          filled.quantity && quantity > 0
            ? { amount: { min: quantity, max: quantity }, unit: filled.unit === "" ? null : filled.unit }
            : null,
      });
      setError(result.ok ? undefined : t("app.error"));
      if (result.ok) setDraft(EMPTY_DRAFT);
    } catch {
      setError(t("app.error"));
    }
  };

  const remove = async (staple: Staple) => {
    try {
      setError((await props.client.call("remove_staple", { item: staple.item })).ok ? undefined : t("app.error"));
    } catch {
      setError(t("app.error"));
    }
  };

  const summary = (staple: Staple) =>
    [
      staple.name,
      t(`location.${staple.location}`),
      staple.alwaysBuy
        ? t("pantry.alwaysBought")
        : staple.checkEvery === "every_shop"
          ? t("pantry.everyShop")
          : t("pantry.everyDays", { days: String(staple.checkEvery) }),
      t(`staple.${staple.status}`),
      ...(staple.qtyPerShop ? [t("pantry.perShop", { amount: amountText(staple.qtyPerShop, props.locale) })] : []),
    ].join(" · ");

  return (
    <section aria-label={t("pantry.staples")}>
      <h3>{t("pantry.staples")}</h3>
      <ul>
        <For each={staples()} fallback={<li>{t("pantry.noStaples")}</li>}>
          {(staple) => (
            <li>
              <span>{summary(staple)}</span>
              <button
                type="button"
                aria-label={t("pantry.edit", { name: staple.name })}
                onClick={() => setDraft(draftOf(staple))}
              >
                {t("member.edit")}
              </button>
              <button
                type="button"
                aria-label={t("pantry.remove", { name: staple.name })}
                onClick={() => remove(staple)}
              >
                {t("member.remove")}
              </button>
            </li>
          )}
        </For>
      </ul>
      <form aria-label={t("pantry.form")} onSubmit={save}>
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
        <label>
          {t("pantry.location")}
          <select
            value={draft().location}
            onChange={(event) => change({ location: event.currentTarget.value as StapleLocation })}
          >
            <For each={STAPLE_LOCATIONS}>
              {(location) => <option value={location}>{t(`location.${location}`)}</option>}
            </For>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft().everyShop}
            onChange={(event) => change({ everyShop: event.currentTarget.checked })}
          />
          {t("pantry.checkEveryShop")}
        </label>
        <label>
          {t("pantry.checkEvery")}
          <input
            type="number"
            min={1}
            max={365}
            disabled={draft().everyShop}
            value={draft().days}
            onInput={(event) => change({ days: event.currentTarget.value })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft().alwaysBuy}
            onChange={(event) => change({ alwaysBuy: event.currentTarget.checked })}
          />
          {t("pantry.alwaysBuy")}
        </label>
        <label>
          {t("pantry.quantity")}
          <input
            type="number"
            min={0}
            step="any"
            value={draft().quantity}
            onInput={(event) => change({ quantity: event.currentTarget.value })}
          />
        </label>
        <label>
          {t("pantry.unit")}
          <select
            value={draft().unit}
            onChange={(event) => change({ unit: event.currentTarget.value as IngredientUnit | "" })}
          >
            <option value="">{t("pantry.noUnit")}</option>
            <For each={INGREDIENT_UNITS}>{(unit) => <option value={unit}>{unit.replace("_", " ")}</option>}</For>
          </select>
        </label>
        <button type="submit">{t("pantry.save")}</button>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </form>
    </section>
  );
}

/** After a dinner is cooked: the Staples its Recipe uses, each to mark low or out. */
export function RunOut(props: { client: MiseClient; recipeId: RecipeId }) {
  const [staples, setStaples] = createSignal<Staple[]>([]);
  const [error, setError] = createSignal(false);

  const refetch = async () => {
    try {
      const result = await props.client.call("list_staples", { usedBy: props.recipeId });
      if (result.ok) setStaples(result.value);
    } catch {
      // Nothing to ask about until the next change or reconnect.
    }
  };
  onCleanup(props.client.subscribe("grocery", refetch));

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
        <For each={staples()}>
          {(staple) => (
            <p>
              {staple.name}: {t(`staple.${staple.status}`)}
              <For each={["low", "out"] as const}>
                {(status) => (
                  <button
                    type="button"
                    aria-label={`${staple.name}: ${t(`staple.${status}`)}`}
                    aria-pressed={staple.status === status}
                    onClick={() => record(staple, status)}
                  >
                    {t(`staple.${status}`)}
                  </button>
                )}
              </For>
            </p>
          )}
        </For>
        <Show when={error()}>
          <p role="alert">{t("app.error")}</p>
        </Show>
      </fieldset>
    </Show>
  );
}
