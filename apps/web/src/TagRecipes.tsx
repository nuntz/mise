import type { RecipeSummary } from "@mise/domain";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { t } from "./messages";

/** Recipes missing a cuisine or main protein, each set in place; a Recipe leaves once it has both. */
export function TagRecipes(props: { client: MiseClient }) {
  // Reconciled by id, so a refresh after saving one Recipe keeps what is typed into the others.
  const [loaded, setLoaded] = createStore<{ recipes?: RecipeSummary[] }>({});
  const [failed, setFailed] = createSignal(false);

  const refetch = async () => {
    try {
      const result = await props.client.call("list_untagged_recipes", {});
      setFailed(!result.ok);
      if (result.ok) setLoaded("recipes", reconcile(result.value, { key: "id" }));
    } catch {
      setFailed(true);
    }
  };
  onCleanup(props.client.subscribe("recipes", refetch));

  return (
    <section>
      <h2>{t("tag.title")}</h2>
      <Show when={failed()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
      <Show when={loaded.recipes}>
        {(recipes) => (
          <Show when={recipes().length > 0} fallback={<p>{t("tag.none")}</p>}>
            <ul>
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
    <form aria-label={props.recipe.title} onSubmit={submit}>
      <h3>{props.recipe.title}</h3>
      <label>
        {t("recipeForm.cuisine")}
        <input value={cuisine()} onInput={(e) => setCuisine(e.currentTarget.value)} />
      </label>
      <label>
        {t("recipeForm.mainProtein")}
        <input value={mainProtein()} onInput={(e) => setMainProtein(e.currentTarget.value)} />
      </label>
      <button type="submit" disabled={busy()}>
        {t("tag.save")}
      </button>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </form>
  );
}
