import type { RecipeSummary } from "@mise/domain";
import { createSignal, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MiseClient } from "./client";
import { Done } from "./Done";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { t } from "./messages";

/** Recipes missing a cuisine or main protein, each set in place; a Recipe leaves once it has both. */
export function TagRecipes(props: { client: MiseClient }) {
  // Reconciled by id, so a refresh after saving one Recipe keeps what is typed into the others.
  const [loaded, setLoaded] = createStore<{ recipes?: RecipeSummary[] }>({});
  const [failed, setFailed] = createSignal(false);

  keepFresh(
    props.client,
    ["recipes"],
    () => props.client.call("list_untagged_recipes", {}),
    (result) => {
      setFailed(!result.ok);
      if (result.ok) setLoaded("recipes", reconcile(result.value, { key: "id" }));
    },
    () => setFailed(true),
  );

  return (
    <section>
      <h2>{t("tag.title")}</h2>
      <Show when={failed()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      <Show when={loaded.recipes}>
        {(recipes) => (
          <Show when={recipes().length > 0} fallback={<Done>{t("tag.none")}</Done>}>
            <ul class="rows">
              <For each={recipes()}>
                {(recipe) => (
                  <li>
                    <TagRow client={props.client} recipe={recipe} />
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

function TagRow(props: { client: MiseClient; recipe: RecipeSummary }) {
  const [cuisine, setCuisine] = createSignal(props.recipe.cuisine ?? "");
  const [mainProtein, setMainProtein] = createSignal(props.recipe.mainProtein ?? "");
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await props.client.call("update_recipe", {
        id: props.recipe.id,
        cuisine: cuisine().trim() || null,
        mainProtein: mainProtein().trim() || null,
      });
      setError(result.ok ? undefined : errorText(result.error, "recipe"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="row" aria-label={props.recipe.title} onSubmit={submit}>
      <div class="row-body row-fields">
        <h4 class="row-title">{props.recipe.title}</h4>
        <label>
          {t("recipeForm.cuisine")}
          <input value={cuisine()} onInput={(e) => setCuisine(e.currentTarget.value)} />
        </label>
        <label>
          {t("recipeForm.mainProtein")}
          <input value={mainProtein()} onInput={(e) => setMainProtein(e.currentTarget.value)} />
        </label>
      </div>
      <div class="row-end">
        <button type="submit" disabled={busy()}>
          {t("tag.save")}
        </button>
      </div>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
    </form>
  );
}
