import {
  ALLERGENS,
  type Allergen,
  type Item,
  type ItemId,
  normaliseItemName,
  STORE_SECTIONS,
  type StoreSection,
  type SuggestedItem,
  type Suggestion,
  UNIT_FAMILIES,
  type UnitFamily,
  type UnresolvedGroup,
} from "@mise/domain";
import { createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { createItems, itemNamed } from "./items";
import { t } from "./messages";

/**
 * Unresolved Ingredients grouped by text, most frequent first; each group resolves in one go, by hand
 * or by accepting the model's Suggestion for it.
 */
export function ResolveIngredients(props: { client: MiseClient }) {
  // Reconciled by text, so a refresh after resolving one group keeps what is typed into the others.
  const [loaded, setLoaded] = createStore<{ groups?: UnresolvedGroup[] }>({});
  const [failed, setFailed] = createSignal(false);
  const [suggestions, setSuggestions] = createSignal(new Map<string, Suggestion>());
  const items = createItems(props.client);

  // Without Suggestions the screen still resolves by hand; the next change or reconnect tries again.
  keepFresh(
    props.client,
    ["recipes"],
    () => props.client.call("list_suggestions", {}),
    (result) => {
      if (result.ok) setSuggestions(new Map(result.value.map((suggestion) => [suggestion.text, suggestion])));
    },
  );

  keepFresh(
    props.client,
    ["recipes"],
    () => props.client.call("list_unresolved_ingredients", {}),
    (result) => {
      setFailed(!result.ok);
      if (result.ok) setLoaded("groups", reconcile(result.value, { key: "text" }));
    },
    () => setFailed(true),
  );

  return (
    <section>
      <h2>{t("resolve.title")}</h2>
      <Show when={failed()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
      <Show when={loaded.groups}>
        {(groups) => (
          <Show when={groups().length > 0} fallback={<p>{t("resolve.none")}</p>}>
            <SuggestAll client={props.client} />
            <ul>
              <For each={groups()}>
                {(group) => (
                  <li>
                    <GroupRow
                      client={props.client}
                      group={group}
                      items={items()}
                      suggestion={suggestions().get(group.text)}
                    />
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

/**
 * Asks the model for Suggestions for every Unresolved text never asked about, one batch per call, until
 * none is left. Each batch's Suggestions show as it comes, through the change notices.
 */
function SuggestAll(props: { client: MiseClient }) {
  // `remaining` is known once the first batch is back.
  const [status, setStatus] = createSignal<{
    state: "idle" | "asking" | "done" | "failed";
    made: number;
    remaining?: number;
  }>({ state: "idle", made: 0 });

  const run = async () => {
    let made = 0;
    setStatus({ state: "asking", made });
    try {
      for (;;) {
        const result = await props.client.call("request_suggestions", {});
        if (!result.ok) {
          setStatus({ state: "failed", made });
          return;
        }
        made += result.value.suggestions.length;
        if (result.value.remaining === 0) break;
        setStatus({ state: "asking", made, remaining: result.value.remaining });
      }
      setStatus({ state: "done", made });
    } catch {
      setStatus({ state: "failed", made });
    }
  };

  return (
    <div>
      <p>{t("suggest.intro")}</p>
      <button type="button" disabled={status().state === "asking"} onClick={() => void run()}>
        {t("suggest.all")}
      </button>
      <Switch>
        <Match when={status().state === "asking"}>
          <p role="status">
            {status().remaining === undefined
              ? t("suggest.asking")
              : t("suggest.left", { remaining: String(status().remaining) })}
          </p>
        </Match>
        <Match when={status().state === "done"}>
          <p role="status">{t("suggest.done", { count: String(status().made) })}</p>
        </Match>
        <Match when={status().state === "failed"}>
          <p role="alert">{t("suggest.failed", { count: String(status().made) })}</p>
        </Match>
      </Switch>
    </div>
  );
}

function GroupRow(props: {
  client: MiseClient;
  group: UnresolvedGroup;
  items: Map<ItemId, Item>;
  suggestion: Suggestion | undefined;
}) {
  const [mode, setMode] = createSignal<"idle" | "map" | "create" | "edit">("idle");
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
      <Show when={props.group.text !== "" && props.suggestion}>
        {(suggestion) => (
          <SuggestionPanel
            suggestion={suggestion()}
            items={props.items}
            actions={mode() === "idle" && !busy()}
            onAccept={() => save(() => props.client.call("accept_suggestion", { id: suggestion().id }))}
            onEdit={() => setMode("edit")}
            onDismiss={() => save(() => props.client.call("dismiss_suggestion", { id: suggestion().id }))}
          />
        )}
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
        <Match when={mode() === "edit" && props.suggestion}>
          {(suggestion) => {
            const accept = (suggested: SuggestedItem) =>
              save(() => props.client.call("accept_suggestion", { id: suggestion().id, suggested }));
            const suggested = suggestion().suggested;
            return suggested.kind === "existing" ? (
              <MapForm
                items={props.items}
                initial={props.items.get(suggested.item)?.name}
                submitLabel={t("suggestion.accept")}
                busy={busy()}
                onCancel={() => setMode("idle")}
                onPicked={(item) => accept({ kind: "existing", item: item.id })}
                onUnknown={() => setError(t("resolve.pickFromList"))}
              />
            ) : (
              <CreateForm
                text={props.group.text}
                initial={suggested}
                submitLabel={t("suggestion.accept")}
                busy={busy()}
                onCancel={() => setMode("idle")}
                onSubmit={({ name, section, unitFamily, allergens }) =>
                  accept({ kind: "new", name, section, unitFamily, allergens })
                }
                onNoAllergens={() => setError(t("item.allergensUnstated"))}
              />
            );
          }}
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

/**
 * What the model suggests for a group, marked as AI-drafted (ADR 0023): nothing changes until a person
 * accepts it, as it is or edited.
 */
function SuggestionPanel(props: {
  suggestion: Suggestion;
  items: Map<ItemId, Item>;
  /** False while the group is being edited or saved. */
  actions: boolean;
  onAccept: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}) {
  const heading = createUniqueId();
  const summary = () => {
    const suggested = props.suggestion.suggested;
    if (suggested.kind === "new") {
      return t("suggestion.new", {
        name: suggested.name,
        section: t(`section.${suggested.section}`),
        allergens:
          suggested.allergens.length > 0
            ? suggested.allergens.map((allergen) => t(`allergen.${allergen}`)).join(", ")
            : t("suggestion.noAllergens"),
      });
    }
    const item = props.items.get(suggested.item);
    return t("suggestion.existing", {
      item: item?.name ?? suggested.item,
      allergens: item ? allergenSummary(item.allergens) : "?",
    });
  };

  return (
    <section aria-labelledby={heading}>
      <h4 id={heading}>{t("suggestion.label")}</h4>
      <p>{t("suggestion.disclosure")}</p>
      <p>{summary()}</p>
      <Show when={props.actions}>
        {/* "None" must be said by a person (ADR 0009): a new Item without Allergens is accepted from Edit. */}
        <Show when={props.suggestion.suggested.kind === "existing" || props.suggestion.suggested.allergens.length > 0}>
          <button type="button" onClick={() => props.onAccept()}>
            {t("suggestion.accept")}
          </button>
        </Show>
        <button type="button" onClick={() => props.onEdit()}>
          {t("suggestion.edit")}
        </button>
        <button type="button" onClick={() => props.onDismiss()}>
          {t("suggestion.dismiss")}
        </button>
      </Show>
    </section>
  );
}

/** Picks an existing Item by name or alias, suggesting every Item with its Allergens. */
function MapForm(props: {
  items: Map<ItemId, Item>;
  /** The name it starts with. */
  initial?: string;
  submitLabel?: string;
  busy: boolean;
  onPicked: (item: Item) => void;
  onUnknown: () => void;
  onCancel: () => void;
}) {
  const list = createUniqueId();
  const [name, setName] = createSignal(props.initial ?? "");

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const item = itemNamed(props.items.values(), name());
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
        {props.submitLabel ?? t("resolve.mapSubmit")}
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

/**
 * A new Item named after the group, or starting as `initial` says; the group's text becomes an alias
 * if the name differs.
 */
function CreateForm(props: {
  text: string;
  initial?: { name: string; section: StoreSection; unitFamily: UnitFamily; allergens: Allergen[] };
  submitLabel?: string;
  busy: boolean;
  onSubmit: (item: NewItemDraft) => void;
  onNoAllergens: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = createSignal(props.initial?.name ?? props.text);
  const [section, setSection] = createSignal<StoreSection>(props.initial?.section ?? "pantry");
  const [unitFamily, setUnitFamily] = createSignal<UnitFamily>(props.initial?.unitFamily ?? "count");
  const [allergens, setAllergens] = createSignal<Allergen[]>(props.initial?.allergens ?? []);
  // Every Recipe using the Item trusts its Allergens, so "none" is ticked, never assumed: not even
  // from a Suggestion of none (ADR 0009).
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
        {props.submitLabel ?? t("resolve.createSubmit")}
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
