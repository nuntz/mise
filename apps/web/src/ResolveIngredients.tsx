import {
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
import { AllergenPicker } from "./AllergenPicker";
import type { MiseClient } from "./client";
import { Done } from "./Done";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { createItems, itemNamed } from "./items";
import { nameText, t } from "./messages";

/**
 * Unresolved Ingredients grouped by text, most frequent first; each group resolves in one go, by hand
 * or by accepting the model's Suggestion for it. Opens at the group `at` when given: once it has
 * loaded, it's scrolled into view and focused.
 */
export function ResolveIngredients(props: { client: MiseClient; at?: string }) {
  // Reconciled by text, so a refresh after resolving one group keeps what is typed into the others.
  const [loaded, setLoaded] = createStore<{ groups?: UnresolvedGroup[] }>({});
  const [failed, setFailed] = createSignal(false);
  const [suggestions, setSuggestions] = createSignal(new Map<string, Suggestion>());
  const items = createItems(props.client);
  // Only the first load opens at the group; later refreshes leave the page where it is.
  let opened = props.at === undefined;
  const openAt = (group: HTMLElement) => {
    group.scrollIntoView?.({ block: "start" });
    group.focus({ preventScroll: true });
  };

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
      <header class="page-heading">
        <h2>{t("resolve.title")}</h2>
        <Show when={loaded.groups?.length}>
          {(count) => (
            <p class="meta">
              {t(count() === 1 ? "resolve.unresolvedOne" : "resolve.unresolved", { count: String(count()) })}
            </p>
          )}
        </Show>
      </header>
      <Show when={failed()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      <Show when={loaded.groups}>
        {(groups) => (
          <Show when={groups().length > 0} fallback={<Done>{t("resolve.none")}</Done>}>
            <p class="banner banner-amber" role="status">
              {t("resolve.unknown", { recipes: recipeTitles(groups()).join(", ") })}
            </p>
            <SuggestAll client={props.client} />
            <div class="section-head">
              <h3>{t("resolve.section")}</h3>
              <span class="chip">{groups().length}</span>
            </div>
            <ul class="rows">
              <For each={groups()}>
                {(group) => (
                  <li>
                    <GroupRow
                      ref={(row) => {
                        if (opened || group.text !== props.at) return;
                        opened = true;
                        queueMicrotask(() => openAt(row));
                      }}
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

/** Every Recipe with an Unresolved Ingredient, each once, in the order the groups first name them. */
function recipeTitles(groups: UnresolvedGroup[]): string[] {
  return [...new Map(groups.flatMap((group) => group.recipes).map((recipe) => [recipe.id, recipe.title])).values()];
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
    <div class="block">
      <p>{t("suggest.intro")}</p>
      <button type="button" class="button-secondary" disabled={status().state === "asking"} onClick={() => void run()}>
        {t("suggest.all")}
      </button>
      <Switch>
        <Match when={status().state === "asking"}>
          <p class="meta" role="status">
            {status().remaining === undefined
              ? t("suggest.asking")
              : t("suggest.left", { remaining: String(status().remaining) })}
          </p>
        </Match>
        <Match when={status().state === "done"}>
          <p class="meta" role="status">
            {t("suggest.done", { count: String(status().made) })}
          </p>
        </Match>
        <Match when={status().state === "failed"}>
          <p class="banner banner-warn" role="alert">
            {t("suggest.failed", { count: String(status().made) })}
          </p>
        </Match>
      </Switch>
    </div>
  );
}

function GroupRow(props: {
  ref?: (row: HTMLElement) => void;
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

  const title = () => (props.group.text ? nameText(props.group.text) : t("resolve.blank"));

  return (
    <article ref={props.ref} class="row" tabIndex={-1} aria-label={title()}>
      <div class="row-body">
        <h4 class="row-title name">{title()}</h4>
        <p class="row-meta">
          {t(props.group.count === 1 ? "resolve.countOne" : "resolve.count", {
            count: String(props.group.count),
            recipes: props.group.recipes.map((recipe) => recipe.title).join(", "),
            lines: props.group.lines.map((line) => t("resolve.line", { line })).join(" · "),
          })}
        </p>
      </div>
      <Show when={props.group.text !== "" && mode() === "idle"}>
        <div class="row-end">
          <button type="button" onClick={() => setMode("map")}>
            {t("resolve.map")}
          </button>
          <button type="button" onClick={() => setMode("create")}>
            {t("resolve.create")}
          </button>
        </div>
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
      {/* Below the forms and buttons, beside whichever was pressed. */}
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
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
  // "None" must be said by a person (ADR 0009): a new Item without Allergens is accepted from Edit.
  const acceptable = () =>
    props.suggestion.suggested.kind === "existing" || props.suggestion.suggested.allergens.length > 0;
  const suggested = () => suggestedItem(props.suggestion.suggested, props.items);

  return (
    <section class="ai-note" aria-labelledby={heading}>
      <div class="ai-note-head">
        <h4 id={heading}>{t("suggestion.label")}</h4>
        <span class="chip chip-plum">{t("suggestion.aiDrafted")}</span>
      </div>
      <p>{t("suggestion.disclosure")}</p>
      <div class="row-body">
        <p class="row-title name">{nameText(suggested().name)}</p>
        <p class="row-meta">{suggested().meta}</p>
        <div class="chips">
          <Switch>
            <Match when={suggested().allergens === undefined}>
              <span class="chip chip-amber">{t("suggestion.allergensUnknown")}</span>
            </Match>
            {/* The model's "none" for a new Item is a guess; an Item in Mise has its Allergens already. */}
            <Match when={suggested().allergens?.length === 0 && props.suggestion.suggested.kind === "new"}>
              <span class="chip chip-amber">{t("suggestion.noneSuggested")}</span>
            </Match>
            <Match when={suggested().allergens?.length === 0}>
              <span class="chip">{t("item.noAllergens")}</span>
            </Match>
            <Match when={suggested().allergens}>
              {(allergens) => (
                <For each={allergens()}>{(allergen) => <span class="chip">{t(`allergen.${allergen}`)}</span>}</For>
              )}
            </Match>
          </Switch>
        </div>
      </div>
      <Show when={!acceptable()}>
        <p>{t("suggestion.stateNone")}</p>
      </Show>
      <Show when={props.actions}>
        <div class="ai-note-actions">
          <Show when={acceptable()}>
            <button type="button" class="button-primary" onClick={() => props.onAccept()}>
              {t("suggestion.accept")}
            </button>
          </Show>
          <button type="button" onClick={() => props.onEdit()}>
            {t("suggestion.edit")}
          </button>
          <button type="button" class="button-quiet" onClick={() => props.onDismiss()}>
            {t("suggestion.dismiss")}
          </button>
        </div>
      </Show>
    </section>
  );
}

/**
 * The Item a Suggestion names, what it would be, and its Allergens, which are undefined when it names
 * an Item no longer known.
 */
function suggestedItem(
  suggested: SuggestedItem,
  items: Map<ItemId, Item>,
): { name: string; meta: string; allergens?: Allergen[] } {
  if (suggested.kind === "new") {
    return {
      name: suggested.name,
      meta: t("suggestion.newMeta", { section: t(`section.${suggested.section}`) }),
      allergens: suggested.allergens,
    };
  }
  const item = items.get(suggested.item);
  return { name: item?.name ?? suggested.item, meta: t("suggestion.existingMeta"), allergens: item?.allergens };
}

/** What a Suggestion says the text is, with the Allergens that would come with it. */
export function suggestionSummary(suggested: SuggestedItem, items: Map<ItemId, Item>): string {
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
  const item = items.get(suggested.item);
  return t("suggestion.existing", {
    item: item?.name ?? suggested.item,
    allergens: item ? allergenSummary(item.allergens) : "?",
  });
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
      <button type="submit" class="button-primary" disabled={props.busy}>
        {props.submitLabel ?? t("resolve.mapSubmit")}
      </button>
      <button type="button" class="button-quiet" onClick={() => props.onCancel()}>
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

  const hint = createUniqueId();

  return (
    <form onSubmit={submit}>
      <label>
        {t("item.name")}
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} aria-describedby={hint} required />
      </label>
      <small id={hint}>{t("item.aliasHint", { text: props.text })}</small>
      <label>
        {t("item.section")}
        <select value={section()} onChange={(e) => setSection(e.currentTarget.value as StoreSection)}>
          <For each={STORE_SECTIONS}>{(value) => <option value={value}>{t(`section.${value}`)}</option>}</For>
        </select>
      </label>
      <fieldset class="field">
        <legend>{t("item.unitFamily")}</legend>
        <div class="segmented">
          <For each={UNIT_FAMILIES}>
            {(value) => (
              <button type="button" aria-pressed={unitFamily() === value} onClick={() => setUnitFamily(value)}>
                {t(`unitFamily.${value}`)}
              </button>
            )}
          </For>
        </div>
      </fieldset>
      <AllergenPicker allergens={allergens()} none={none()} onAllergens={setAllergens} onNone={setNone} />
      <button type="submit" class="button-primary" disabled={props.busy}>
        {props.submitLabel ?? t("resolve.createSubmit")}
      </button>
      <button type="button" class="button-quiet" onClick={() => props.onCancel()}>
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
