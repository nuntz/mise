import {
  type Draft,
  type ImportFlag,
  type Item,
  type ItemId,
  isLinkOnly,
  linkOf,
  type Suggestion,
  type ToolResult,
} from "@mise/domain";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MiseClient } from "./client";
import { Done } from "./Done";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { FillDraft, flagText } from "./Import";
import { createItems } from "./items";
import { t } from "./messages";
import { RecipeForm } from "./RecipeForm";
import { courseText, effortText, resolutionText } from "./Recipes";
import { suggestionSummary } from "./ResolveIngredients";

/** A Draft as the screen keeps it: keyed by its Recipe's id, so a refresh keeps a Draft being edited. */
type ListedDraft = Draft & { id: number };

/**
 * What waits on a person, read from the tools that list each (no stored queue): Draft Recipes to
 * accept, edit or discard; Import Flags; and Suggestions, which `onResolve` goes to resolve.
 */
export function ReviewPage(props: { client: MiseClient; onResolve: () => void }) {
  const [loaded, setLoaded] = createStore<{ drafts?: ListedDraft[]; flags?: ImportFlag[]; suggestions?: Suggestion[] }>(
    {},
  );
  const [failed, setFailed] = createSignal(false);
  const items = createItems(props.client);

  keepFresh(
    props.client,
    ["recipes"],
    () =>
      Promise.all([
        props.client.call("list_drafts", {}),
        props.client.call("list_import_flags", {}),
        props.client.call("list_suggestions", {}),
      ]),
    ([drafts, flags, suggestions]) => {
      if (drafts.ok) setLoaded("drafts", reconcile(drafts.value.map((draft) => ({ id: draft.recipe.id, ...draft }))));
      if (flags.ok) setLoaded("flags", flags.value);
      if (suggestions.ok) setLoaded("suggestions", suggestions.value);
      setFailed(!drafts.ok || !flags.ok || !suggestions.ok);
    },
    () => setFailed(true),
  );

  // A Draft's flags show on the Draft itself.
  const flags = () => {
    const drafts = new Set((loaded.drafts ?? []).map((draft) => draft.id));
    return (loaded.flags ?? []).filter((flag) => !drafts.has(flag.recipe.id));
  };
  const loadedAll = () => loaded.drafts && loaded.flags && loaded.suggestions;
  const nothing = () =>
    loadedAll() && loaded.drafts?.length === 0 && flags().length === 0 && loaded.suggestions?.length === 0;

  return (
    <section>
      <h2>{t("review.title")}</h2>
      <Show when={failed()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      <Show when={nothing()}>
        <Done>{t("review.none")}</Done>
      </Show>
      <Show when={(loaded.drafts ?? []).length > 0}>
        <h3>{t("review.drafts")}</h3>
        <For each={loaded.drafts}>{(draft) => <DraftCard client={props.client} draft={draft} items={items()} />}</For>
      </Show>
      <Show when={flags().length > 0}>
        <h3 id="review-flags">{t("import.flags")}</h3>
        <ul class="rows" aria-labelledby="review-flags">
          <For each={flags()}>
            {(flag) => (
              <li>
                <span class="row-body">{flagText(flag)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={(loaded.suggestions ?? []).length > 0}>
        <h3 id="review-suggestions">{t("review.suggestions")}</h3>
        <p>{t("suggestion.disclosure")}</p>
        <ul class="rows" aria-labelledby="review-suggestions">
          <For each={loaded.suggestions}>
            {(suggestion) => (
              <li>
                <span class="row-body">
                  {suggestion.text}: {suggestionSummary(suggestion.suggested, items())}
                </span>
              </li>
            )}
          </For>
        </ul>
        <button type="button" class="button-secondary" onClick={() => props.onResolve()}>
          {t("review.resolve")}
        </button>
      </Show>
    </section>
  );
}

/**
 * A Draft with what to check before accepting it, edited in place; a link-only Draft with its link
 * and a place to add screenshots or paste its recipe's text instead.
 */
function DraftCard(props: { client: MiseClient; draft: ListedDraft; items: Map<ItemId, Item> }) {
  const heading = createUniqueId();
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const recipe = () => props.draft.recipe;
  /** The link of a link-only Draft; null for any other. */
  const link = () => (isLinkOnly(recipe()) ? linkOf(recipe()) : null);

  const act = async (change: () => Promise<ToolResult<unknown>>) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await change();
      if (!result.ok) setError(errorText(result.error, "recipe"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article aria-labelledby={heading}>
      <h4 id={heading}>{recipe().title}</h4>
      <p class="meta">
        {[
          t("recipe.servings", { count: String(recipe().baseServings) }),
          effortText(recipe().effortMinutes),
          courseText(recipe().course) ?? t("review.courseUnknown"),
        ].join(" · ")}
      </p>
      <Show when={link()} fallback={<p>{t("review.aiRead")}</p>}>
        {(url) => (
          <>
            <p>{t("review.linkOnly")}</p>
            <p>
              <a href={url()} target="_blank" rel="noopener noreferrer">
                {url()}
              </a>
            </p>
          </>
        )}
      </Show>
      <For each={props.draft.duplicateOf}>{(other) => <p>{t("review.duplicate", { title: other.title })}</p>}</For>
      <Show
        when={editing()}
        fallback={
          <>
            <Show when={link()}>
              <FillDraft client={props.client} draft={recipe()} />
            </Show>
            <ul class="ingredients">
              {/* How Mise read each line, so a guessed amount is seen before it can be shopped. */}
              <For each={recipe().ingredients}>
                {(ingredient) => (
                  <li>
                    <span>{ingredient.raw}</span> <span class="meta">— {resolutionText(ingredient, props.items)}</span>
                  </li>
                )}
              </For>
            </ul>
            {/* A link-only Draft has nothing to plan until its recipe's text is added. */}
            <Show when={!link()}>
              <button
                type="button"
                disabled={busy()}
                onClick={() => void act(() => props.client.call("accept_draft", { id: recipe().id }))}
              >
                {t("review.accept")}
              </button>
            </Show>
            <button type="button" class="button-secondary" disabled={busy()} onClick={() => setEditing(true)}>
              {t("review.edit")}
            </button>
            <button
              type="button"
              class="button-danger"
              disabled={busy()}
              onClick={() => {
                // Discarding is deleting, confirmed as any Recipe's deletion is.
                if (!window.confirm(t("recipe.deleteConfirm", { title: recipe().title }))) return;
                void act(() => props.client.call("delete_recipe", { id: recipe().id, confirm: true }));
              }}
            >
              {t("review.discard")}
            </button>
          </>
        }
      >
        <RecipeForm
          client={props.client}
          recipe={recipe()}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </Show>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
    </article>
  );
}
