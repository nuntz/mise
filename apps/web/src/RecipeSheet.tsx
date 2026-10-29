import { type Recipe, type RecipeId, scaledLines } from "@mise/domain";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { scaledForText } from "./Kitchen";
import { t } from "./messages";
import { savedRecipe, saveRecipe } from "./offline";
import { RecipeChips, recipeChips } from "./Recipes";
import { Sheet } from "./Sheet";

/**
 * A Slot's Recipe, looked at over the Week: its Ingredients scaled to `servings`, what the Slot is
 * cooked for (its Leftovers included), after the `children` (the Slot's Conflicts) and what can be
 * done with the Slot. The Recipe itself is read-only; Recipes are changed on the Recipes screen.
 */
export function RecipeSheet(props: {
  client: MiseClient;
  id: RecipeId;
  servings: number;
  locale: string;
  /** Without it, nothing to cook: Leftovers are cooked on the Slot they're of. */
  onCook?: (recipe: RecipeId, servings: number) => void;
  onClose: () => void;
  /** What can be done with the Slot: marking it cooked, rating it, editing it. */
  slotActions?: JSX.Element;
  children?: JSX.Element;
}) {
  const titleId = createUniqueId();
  // The Recipe kept on this device shows at once, and while the connection is down.
  const [recipe, setRecipe] = createSignal<Recipe | undefined>(savedRecipe(props.id));

  // Offline, the saved Recipe stands.
  keepFresh(
    props.client,
    ["recipes"],
    () => props.client.call("get_recipe", { id: props.id }),
    (result) => {
      if (!result.ok) return;
      setRecipe(result.value);
      saveRecipe(result.value);
    },
  );

  return (
    <Sheet labelledBy={titleId} focusField={false} onEscape={() => props.onClose()}>
      <div class="sheet-header">
        <div class="page-heading">
          <p class="overline">{t("recipe.overline")}</p>
          <h2 id={titleId} class="dish-title">
            {recipe()?.title ?? t("app.loading")}
          </h2>
          <Show when={recipe()}>
            {(open) => (
              <Show when={recipeChips(open()).length > 0}>
                <div class="chips">
                  <RecipeChips recipe={open()} />
                </div>
              </Show>
            )}
          </Show>
        </div>
        <button type="button" class="icon-button" aria-label={t("recipeSheet.close")} onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </div>
      <div class="sheet-body">
        {props.children}
        <Show when={recipe()}>
          {(open) => (
            <>
              <Show when={open().prepAhead}>
                {(note) => <p class="banner banner-plum">{t("recipe.prepAhead", { note: note() })}</p>}
              </Show>
              <Show when={props.onCook}>
                {(cook) => (
                  <button type="button" class="button-primary" onClick={() => cook()(open().id, props.servings)}>
                    <Icon name="pot" />
                    {t("kitchen.cook")}
                  </button>
                )}
              </Show>
              {props.slotActions}
              <section class="stack" aria-labelledby={`${titleId}-ingredients`}>
                <h3 id={`${titleId}-ingredients`}>{t("recipe.ingredients")}</h3>
                <p class="meta">{scaledForText(props.servings, open().baseServings)}</p>
                <ul class="ingredients" aria-labelledby={`${titleId}-ingredients`}>
                  <For each={scaledLines(open(), props.servings, props.locale)}>{(line) => <li>{line}</li>}</For>
                </ul>
              </section>
              <section class="stack" aria-labelledby={`${titleId}-steps`}>
                <h3 id={`${titleId}-steps`}>{t("recipe.steps")}</h3>
                <ol class="steps" aria-labelledby={`${titleId}-steps`}>
                  <For each={open().steps}>{(step) => <li>{step}</li>}</For>
                </ol>
              </section>
              <Show when={open().notes}>
                {(notes) => (
                  <section class="stack">
                    <h3>{t("recipeForm.notes")}</h3>
                    <p class="pre-line">{notes()}</p>
                  </section>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </Sheet>
  );
}
