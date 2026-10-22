import {
  ALLERGENS,
  type Allergen,
  type Item,
  type ItemId,
  normaliseItemName,
  STORE_SECTIONS,
  type StoreSection,
  UNIT_FAMILIES,
  type UnitFamily,
  type UnresolvedGroup,
} from "@mise/domain";
import { createSignal, createUniqueId, For, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { createItems } from "./items";
import { t } from "./messages";

/** Unresolved Ingredients grouped by text, most frequent first; each group resolves in one go. */
export function ResolveIngredients(props: { client: MiseClient }) {
  // Reconciled by text, so a refresh after resolving one group keeps what is typed into the others.
  const [loaded, setLoaded] = createStore<{ groups?: UnresolvedGroup[] }>({});
  const [failed, setFailed] = createSignal(false);
  const items = createItems(props.client);

  const refetch = async () => {
    try {
      const result = await props.client.call("list_unresolved_ingredients", {});
      setFailed(!result.ok);
      if (result.ok) setLoaded("groups", reconcile(result.value, { key: "text" }));
    } catch {
      setFailed(true);
    }
  };
  onCleanup(props.client.subscribe("recipes", refetch));

  return (
    <section>
      <h2>{t("resolve.title")}</h2>
      <Show when={failed()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
      <Show when={loaded.groups}>
        {(groups) => (
          <Show when={groups().length > 0} fallback={<p>{t("resolve.none")}</p>}>
            <ul>
              <For each={groups()}>
                {(group) => (
                  <li>
                    <GroupRow client={props.client} group={group} items={items()} />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </section>
  );
}

function GroupRow(props: { client: MiseClient; group: UnresolvedGroup; items: Map<ItemId, Item> }) {
  const [mode, setMode] = createSignal<"idle" | "map" | "create">("idle");
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  /** Runs a tool call; on success the change notice refetches the groups and this one goes. */
  const save = async (call: () => ReturnType<MiseClient["call"]>) => {
    setBusy(true);
    try {
      const result = await call();
      setError(result.ok ? undefined : errorText(result.error, "item"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article aria-label={props.group.text || t("resolve.blank")}>
      <h3>{props.group.text || t("resolve.blank")}</h3>
      <p>
        {t(props.group.count === 1 ? "resolve.countOne" : "resolve.count", {
          count: String(props.group.count),
          recipes: props.group.recipes.map((recipe) => recipe.title).join(", "),
        })}
      </p>
      <ul>
        <For each={props.group.lines}>{(line) => <li>{line}</li>}</For>
      </ul>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Switch>
        {/* A line with no name ("2 cups") can only be fixed by editing its Recipe. */}
        <Match when={props.group.text === ""}>
          <p>{t("resolve.blankHint")}</p>
        </Match>
        <Match when={mode() === "idle"}>
          <button type="button" onClick={() => setMode("map")}>
            {t("resolve.map")}
          </button>
          <button type="button" onClick={() => setMode("create")}>
            {t("resolve.create")}
          </button>
        </Match>
        <Match when={mode() === "map"}>
          <MapForm
            items={props.items}
            busy={busy()}
            onCancel={() => setMode("idle")}
            onPicked={(item) =>
              save(() => props.client.call("resolve_ingredient", { text: props.group.text, item: item.id }))
            }
            onUnknown={() => setError(t("resolve.pickFromList"))}
          />
        </Match>
        <Match when={mode() === "create"}>
          <CreateForm
            text={props.group.text}
            busy={busy()}
            onCancel={() => setMode("idle")}
            onSubmit={(item) => save(() => props.client.call("create_item", item))}
            onNoAllergens={() => setError(t("item.allergensUnstated"))}
          />
        </Match>
      </Switch>
    </article>
  );
}

/** Picks an existing Item by name or alias, suggesting every Item with its Allergens. */
function MapForm(props: {
  items: Map<ItemId, Item>;
  busy: boolean;
  onPicked: (item: Item) => void;
  onUnknown: () => void;
  onCancel: () => void;
}) {
  const list = createUniqueId();
  const [name, setName] = createSignal("");

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const wanted = normaliseItemName(name());
    const item = [...props.items.values()].find((candidate) =>
      [candidate.name, ...candidate.aliases].some((known) => normaliseItemName(known) === wanted),
    );
    if (item) props.onPicked(item);
    else props.onUnknown();
  };

  return (
    <form onSubmit={submit}>
      <label>
        {t("resolve.item")}
        <input list={list} value={name()} onInput={(e) => setName(e.currentTarget.value)} required />
      </label>
      <datalist id={list}>
        <For each={[...props.items.values()]}>
          {(item) => <option value={item.name}>{allergenSummary(item.allergens)}</option>}
        </For>
      </datalist>
      <button type="submit" disabled={props.busy}>
        {t("resolve.mapSubmit")}
      </button>
      <button type="button" onClick={() => props.onCancel()}>
        {t("resolve.cancel")}
      </button>
    </form>
  );
}

type NewItemDraft = {
  name: string;
  section: StoreSection;
  unitFamily: UnitFamily;
  allergens: Allergen[];
  aliases: string[];
};

/** A new Item named after the group; the group's text becomes an alias if the name differs. */
function CreateForm(props: {
  text: string;
  busy: boolean;
  onSubmit: (item: NewItemDraft) => void;
  onNoAllergens: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = createSignal(props.text);
  const [section, setSection] = createSignal<StoreSection>("pantry");
  const [unitFamily, setUnitFamily] = createSignal<UnitFamily>("count");
  const [allergens, setAllergens] = createSignal<Allergen[]>([]);
  // Every Recipe using the Item trusts its Allergens, so "none" is ticked, never assumed.
  const [none, setNone] = createSignal(false);

  const toggle = (allergen: Allergen, on: boolean) =>
    setAllergens((chosen) => (on ? [...chosen, allergen] : chosen.filter((a) => a !== allergen)));

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (allergens().length === 0 && !none()) {
      props.onNoAllergens();
      return;
    }
    const aliases = normaliseItemName(name()) === normaliseItemName(props.text) ? [] : [props.text];
    props.onSubmit({
      name: name().trim(),
      section: section(),
      unitFamily: unitFamily(),
      allergens: allergens(),
      aliases,
    });
  };

  return (
    <form onSubmit={submit}>
      <label>
        {t("item.name")}
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} required />
      </label>
      <label>
        {t("item.section")}
        <select value={section()} onChange={(e) => setSection(e.currentTarget.value as StoreSection)}>
          <For each={STORE_SECTIONS}>{(value) => <option value={value}>{t(`section.${value}`)}</option>}</For>
        </select>
      </label>
      <label>
        {t("item.unitFamily")}
        <select value={unitFamily()} onChange={(e) => setUnitFamily(e.currentTarget.value as UnitFamily)}>
          <For each={UNIT_FAMILIES}>{(value) => <option value={value}>{t(`unitFamily.${value}`)}</option>}</For>
        </select>
      </label>
      <fieldset>
        <legend>{t("item.allergens")}</legend>
        <p>{t("item.allergensHint")}</p>
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
      </fieldset>
      <button type="submit" disabled={props.busy}>
        {t("resolve.createSubmit")}
      </button>
      <button type="button" onClick={() => props.onCancel()}>
        {t("resolve.cancel")}
      </button>
    </form>
  );
}

function allergenSummary(allergens: Allergen[]): string {
  return allergens.length > 0
    ? allergens.map((allergen) => t(`allergen.${allergen}`)).join(", ")
    : t("item.noAllergens");
}
