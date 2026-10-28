import {
  ALLERGENS,
  type Allergen,
  type Item,
  type ItemId,
  SHIPPED_ITEMS,
  STORE_SECTIONS,
  type StoreSection,
  storeSectionOrder,
  UNIT_FAMILIES,
  type UnitFamily,
} from "@mise/domain";
import { createMemo, createSignal, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { allergenSummary } from "./AllergenPicker";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { nameMatches } from "./items";
import { nameText, t } from "./messages";

/**
 * Every Item, shipped or the Household's own, as rows under their Store Section in the Household's
 * walking order, searchable by name or alias, each edited in place, one at a time.
 */
export function ItemsSettings(props: { client: MiseClient; sections: readonly StoreSection[] }) {
  // Reconciled by id, so a refresh after saving one Item keeps another's form as it is being filled in.
  const [loaded, setLoaded] = createStore<{ items?: Item[] }>({});
  const [failed, setFailed] = createSignal(false);
  const [query, setQuery] = createSignal("");
  // A row closes only its own form, so a save that finishes after another row was opened leaves that one open.
  const [editing, setEditing] = createSignal<ItemId>();

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

  const groups = createMemo(() => {
    const shown = (loaded.items ?? []).filter((item) => nameMatches([item.name, ...item.aliases], query(), "part"));
    return storeSectionOrder(props.sections)
      .map((section) => ({ section, items: shown.filter((item) => item.section === section) }))
      .filter((group) => group.items.length > 0);
  });

  return (
    <section>
      <h2>{t("items.title")}</h2>
      <div class="ai-note" role="note">
        <span class="chip chip-plum">{t("items.aiDrafted")}</span>
        <p>{t("items.intro")}</p>
      </div>
      <Show when={failed()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      <label>
        {t("items.search")}
        <input type="search" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <Show when={loaded.items}>
        <Show when={groups().length > 0} fallback={<p>{t("items.none")}</p>}>
          <For each={groups()}>
            {(group) => (
              <section class="item-section" aria-label={sectionName(group.section)}>
                <div class="section-head">
                  <h3>{sectionName(group.section)}</h3>
                  <span class="chip">{group.items.length}</span>
                </div>
                <ul class="rows">
                  <For each={group.items}>
                    {(item) => (
                      <li>
                        <ItemRow
                          client={props.client}
                          item={item}
                          editing={editing() === item.id}
                          onEdit={(on) => setEditing((open) => (on ? item.id : open === item.id ? undefined : open))}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </Show>
      </Show>
    </section>
  );
}

function ItemRow(props: { client: MiseClient; item: Item; editing: boolean; onEdit: (editing: boolean) => void }) {
  const name = () => nameText(props.item.name);
  const body = () => (
    <span class="row-body">
      <span class="row-title name">{name()}</span>
      <span class="row-meta">{itemMeta(props.item)}</span>
    </span>
  );

  return (
    <article class="row" aria-label={name()}>
      <Show
        when={props.editing}
        fallback={
          <button
            type="button"
            class="row row-open"
            aria-label={t("items.editName", { name: name() })}
            onClick={() => props.onEdit(true)}
          >
            {body()}
            <span class="row-end">
              <Icon name="chevronRight" />
            </span>
          </button>
        }
      >
        {body()}
        <ItemForm client={props.client} item={props.item} onDone={() => props.onEdit(false)} />
      </Show>
    </article>
  );
}

/** "Produce · No Allergens · also garlic clove": its Store Section, its Allergens and its other names. */
function itemMeta(item: Item): string {
  const params = {
    section: sectionName(item.section),
    allergens: allergenSummary(item.allergens),
    aliases: item.aliases.join(", "),
  };
  return item.aliases.length > 0 ? t("items.summaryAliases", params) : t("items.summary", params);
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
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
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
      <div class="actions">
        <button type="submit" class="button-primary" disabled={busy()}>
          {t("items.save")}
        </button>
        <button type="button" class="button-quiet" onClick={() => props.onDone()}>
          {t("items.cancel")}
        </button>
      </div>
    </form>
  );
}

function sectionName(section: StoreSection): string {
  return t(`section.${section}`);
}

function allergenList(allergens: readonly Allergen[]): string {
  return allergens.map((allergen) => t(`allergen.${allergen}`)).join(", ");
}
