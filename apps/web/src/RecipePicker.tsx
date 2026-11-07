import type { RecipeId, RecipeSummary } from "@mise/domain";
import { createEffect, createSignal, createUniqueId, For, on, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";
import { RecipeRow } from "./Recipes";
import { Sheet } from "./Sheet";

/**
 * Choose a Recipe: a sheet over the Slot form that finds Recipes as Search Recipes is typed in, as the
 * Recipes screen does, with the Recipe `chosen` already marked. Picking one hands it to `onPick`. The
 * search takes the focus on opening, keyboard and all: finding the Recipe is what the sheet is for.
 */
export function RecipePicker(props: {
  client: MiseClient;
  /** What the sheet is for, such as "Tonight · Mon 26 · Dinner". */
  overline: string;
  chosen: RecipeId | undefined;
  onPick: (recipe: RecipeSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [recipes, setRecipes] = createSignal<RecipeSummary[]>();
  const [failed, setFailed] = createSignal(false);

  const refetch = keepFresh(
    props.client,
    ["recipes"],
    () => props.client.call("search_recipes", { query: query() }),
    (result) => {
      setFailed(!result.ok);
      if (result.ok) setRecipes(result.value);
    },
    () => setFailed(true),
  );
  createEffect(on(query, refetch, { defer: true }));

  const titleId = createUniqueId();
  return (
    <Sheet class="recipe-picker" labelledBy={titleId} onEscape={() => props.onClose()}>
      <div class="sheet-header">
        <div class="page-heading">
          <p class="overline">{props.overline}</p>
          <h2 id={titleId} class="dish-title">
            {t("slot.chooseRecipe")}
          </h2>
        </div>
        <button type="button" class="icon-button" aria-label={t("slot.close")} onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </div>
      <div class="sheet-body">
        <label>
          {t("recipes.search")}
          <input
            type="search"
            autofocus
            placeholder={t("recipes.searchPlaceholder")}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
        <Show when={failed()}>
          <p class="banner banner-warn" role="alert">
            {t("app.error")}
          </p>
        </Show>
        <Show when={recipes()}>
          {(found) => (
            <Show
              when={found().length > 0}
              fallback={<p class="empty">{query().trim() ? t("recipes.noMatch") : t("recipes.none")}</p>}
            >
              <ul class="rows">
                <For each={found()}>
                  {(recipe) => (
                    <li>
                      <RecipeRow
                        client={props.client}
                        recipe={recipe}
                        current={recipe.id === props.chosen}
                        onClick={() => props.onPick(recipe)}
                      />
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </div>
    </Sheet>
  );
}
