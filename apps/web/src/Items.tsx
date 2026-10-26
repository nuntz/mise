import {
  ALLERGENS,
  type Allergen,
  type Item,
  SHIPPED_ITEMS,
  STORE_SECTIONS,
  type StoreSection,
  UNIT_FAMILIES,
  type UnitFamily,
} from "@mise/domain";
import { createMemo, createSignal, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { nameMatches } from "./items";
import { t } from "./messages";

/** Every Item, shipped or the Household's own, searchable, each edited in place. */
export function ItemsSettings(props: { client: MiseClient }) {
  // Reconciled by id, so a refresh after saving one Item keeps another's form as it is being filled in.
  const [loaded, setLoaded] = createStore<{ items?: Item[] }>({});
  const [failed, setFailed] = createSignal(false);
  const [query, setQuery] = createSignal("");

  keepFresh(
    props.client,
    ["recipes"],
    () => props.client.call("list_items", {}),
    (result) => {
      setFailed(!result.ok);
      if (result.ok) setLoaded("items", reconcile(result.value, { key: "id" }));
    },
    () => setFailed(true),
  );

  const shown = createMemo(() => {
    return (loaded.items ?? []).filter((item) => nameMatches([item.name, ...item.aliases], query(), "part"));
  });

  return (
    <section>
      <h2>{t("items.title")}</h2>
      <p>{t("items.intro")}</p>
      <Show when={failed()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
      <label>
        {t("items.search")}
        <input type="search" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <Show when={loaded.items}>
        <Show when={shown().length > 0} fallback={<p>{t("items.none")}</p>}>
          <ul class="rows">
            <For each={shown()}>
              {(item) => (
                <li>
                  <ItemRow client={props.client} item={item} />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}

function ItemRow(props: { client: MiseClient; item: Item }) {
  const [editing, setEditing] = createSignal(false);
  const shipped = () => SHIPPED_ITEMS.item(props.item.id);

  return (
    <article class="row" aria-label={props.item.name}>
      <div class="row-body">
        <h4 class="row-title">{props.item.name}</h4>
        <p class="row-meta">{shipped() ? t("items.shipped") : t("items.yours")}</p>
        <p class="row-meta">
          {t("items.summary", {
            section: t(`section.${props.item.section}`),
            allergens: allergenList(props.item.allergens) || t("item.noAllergens"),
          })}
        </p>
        <Show when={props.item.aliases.length > 0}>
          <p class="row-meta">{t("items.aliases", { aliases: props.item.aliases.join(", ") })}</p>
        </Show>
      </div>
      <Show
        when={editing()}
        fallback={
          <button type="button" class="button-row" onClick={() => setEditing(true)}>
            {t("items.edit")}
          </button>
        }
      >
        <ItemForm client={props.client} item={props.item} onDone={() => setEditing(false)} />
      </Show>
    </article>
  );
}

/**
 * Edits an Item. A Household Item can change in every field. A shipped one only gains aliases and
 * a Store Section of the Household's (ADR 0009). Allergens taken away are confirmed, and all of them
 * only by saying it has none, as when the Item was created: every Recipe using it trusts them.
 */
function ItemForm(props: { client: MiseClient; item: Item; onDone: () => void }) {
  const shipped = SHIPPED_ITEMS.item(props.item.id);
  const ownAliases = shipped
    ? props.item.aliases.filter((alias) => !shipped.aliases.includes(alias))
    : props.item.aliases;
  const [name, setName] = createSignal(props.item.name);
  const [aliases, setAliases] = createSignal(ownAliases.join(", "));
  const [section, setSection] = createSignal<StoreSection>(props.item.section);
  const [unitFamily, setUnitFamily] = createSignal<UnitFamily>(props.item.unitFamily);
  const [allergens, setAllergens] = createSignal<Allergen[]>([...props.item.allergens]);
  // An Item that had none already said so.
  const [none, setNone] = createSignal(props.item.allergens.length === 0);
  const [confirmed, setConfirmed] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  const removed = () => props.item.allergens.filter((allergen) => !allergens().includes(allergen));
  const removedList = () => allergenList(removed());
  const toggle = (allergen: Allergen, on: boolean) =>
    setAllergens((chosen) =>
      on ? ALLERGENS.filter((a) => a === allergen || chosen.includes(a)) : chosen.filter((a) => a !== allergen),
    );

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!shipped) {
      if (allergens().length === 0 && !none()) return setError(t("item.allergensUnstated"));
      if (allergens().length > 0 && removed().length > 0 && confirmed() !== removedList()) {
        return setError(t("items.removalUnconfirmed", { allergens: removedList() }));
      }
    }
    const names = aliases()
      .split(",")
      .map((alias) => alias.trim())
      .filter(Boolean);
    setBusy(true);
    try {
      const result = await props.client.call(
        "update_item",
        shipped
          ? { id: props.item.id, aliases: names, section: section() }
          : {
              id: props.item.id,
              name: name().trim(),
              aliases: names,
              section: section(),
              unitFamily: unitFamily(),
              allergens: allergens(),
            },
      );
      if (result.ok) props.onDone();
      else setError(errorText(result.error, "item"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={!shipped}>
        <label>
          {t("item.name")}
          <input value={name()} onInput={(e) => setName(e.currentTarget.value)} required />
        </label>
      </Show>
      <label>
        {t("item.otherNames")}
        <input value={aliases()} onInput={(e) => setAliases(e.currentTarget.value)} />
      </label>
      <small>
        {shipped && shipped.aliases.length > 0
          ? t("items.otherNamesShipped", { aliases: shipped.aliases.join(", ") })
          : t("items.otherNamesHint")}
      </small>
      <label>
        {t("item.section")}
        <select value={section()} onChange={(e) => setSection(e.currentTarget.value as StoreSection)}>
          <For each={STORE_SECTIONS}>{(value) => <option value={value}>{t(`section.${value}`)}</option>}</For>
        </select>
      </label>
      <Show when={!shipped}>
        <label>
          {t("item.unitFamily")}
          <select value={unitFamily()} onChange={(e) => setUnitFamily(e.currentTarget.value as UnitFamily)}>
            <For each={UNIT_FAMILIES}>{(value) => <option value={value}>{t(`unitFamily.${value}`)}</option>}</For>
          </select>
        </label>
        <fieldset>
          <legend>{t("item.allergens")}</legend>
          <p>{t("items.allergensHint")}</p>
          <For each={ALLERGENS}>
            {(allergen) => (
              <label>
                <input
                  type="checkbox"
                  checked={allergens().includes(allergen)}
                  disabled={none()}
                  onChange={(e) => toggle(allergen, e.currentTarget.checked)}
                />
                {t(`allergen.${allergen}`)}
              </label>
            )}
          </For>
          <label>
            <input
              type="checkbox"
              checked={none()}
              disabled={allergens().length > 0}
              onChange={(e) => setNone(e.currentTarget.checked)}
            />
            {t("item.allergensNone")}
          </label>
          <Show when={allergens().length > 0 && removed().length > 0}>
            <label>
              <input
                type="checkbox"
                checked={confirmed() === removedList()}
                onChange={(e) => setConfirmed(e.currentTarget.checked ? removedList() : "")}
              />
              {t("items.confirmRemoval", { allergens: removedList() })}
            </label>
          </Show>
        </fieldset>
      </Show>
      <Show when={shipped}>
        {(item) => (
          <>
            <small>{t("items.shippedSection", { section: t(`section.${item().section}`) })}</small>
            <p>{t("items.shippedAllergens")}</p>
          </>
        )}
      </Show>
      <button type="submit" disabled={busy()}>
        {t("items.save")}
      </button>
      <button type="button" onClick={() => props.onDone()}>
        {t("items.cancel")}
      </button>
    </form>
  );
}

function allergenList(allergens: readonly Allergen[]): string {
  return allergens.map((allergen) => t(`allergen.${allergen}`)).join(", ");
}
