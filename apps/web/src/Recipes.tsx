import type {
  Allergen,
  Ingredient,
  Item,
  ItemId,
  Recipe,
  RecipeAllergens,
  RecipeId,
  RecipeSummary,
  Recurrence,
} from "@mise/domain";
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { createItems } from "./items";
import { t } from "./messages";
import { RecipeForm } from "./RecipeForm";

type View = { kind: "list" } | { kind: "recipe"; id: RecipeId } | { kind: "new" } | { kind: "edit"; recipe: Recipe };

/** Recipes: list and search them, view one, create and edit them. */
export function RecipesPage(props: { client: MiseClient }) {
  const [view, setView] = createSignal<View>({ kind: "list" });
  const list = () => setView({ kind: "list" });
  const show = (recipe: { id: RecipeId }) => setView({ kind: "recipe", id: recipe.id });

  return (
    <section>
      <Switch>
        <Match when={view().kind === "list"}>
          <RecipeList client={props.client} onOpen={show} onNew={() => setView({ kind: "new" })} />
        </Match>
        <Match when={view().kind === "new"}>
          <h2>{t("recipes.new")}</h2>
          <RecipeForm client={props.client} onSaved={show} onCancel={list} />
        </Match>
        <Match when={narrow(view(), "edit")}>
          {(edit) => (
            <>
              <h2>{edit().recipe.title}</h2>
              <RecipeForm
                client={props.client}
                recipe={edit().recipe}
                onSaved={show}
                onCancel={() => show(edit().recipe)}
              />
            </>
          )}
        </Match>
        <Match when={narrow(view(), "recipe")}>
          {(open) => (
            <RecipeDetail
              client={props.client}
              id={open().id}
              onBack={list}
              onEdit={(recipe) => setView({ kind: "edit", recipe })}
            />
          )}
        </Match>
      </Switch>
    </section>
  );
}

function narrow<K extends View["kind"]>(view: View, kind: K): Extract<View, { kind: K }> | false {
  return view.kind === kind && (view as Extract<View, { kind: K }>);
}

function RecipeList(props: { client: MiseClient; onOpen: (recipe: RecipeSummary) => void; onNew: () => void }) {
  const [query, setQuery] = createSignal("");
  const [recipes, setRecipes] = createSignal<RecipeSummary[]>();
  const [failed, setFailed] = createSignal(false);
  // Only the latest search may show its results, whatever order the answers arrive in.
  let latest = 0;

  const refetch = async () => {
    const search = ++latest;
    try {
      const result = await props.client.call("search_recipes", { query: query() });
      if (search !== latest) return;
      setFailed(!result.ok);
      if (result.ok) setRecipes(result.value);
    } catch {
      if (search === latest) setFailed(true);
    }
  };
  onCleanup(props.client.subscribe("recipes", refetch));
  createEffect(on(query, refetch, { defer: true }));

  return (
    <>
      <h2>{t("recipes.title")}</h2>
      <label>
        {t("recipes.search")}
        <input
          type="search"
          placeholder={t("recipes.searchPlaceholder")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </label>
      <button type="button" onClick={() => props.onNew()}>
        {t("recipes.new")}
      </button>
      <Show when={failed()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
      <Show when={recipes()}>
        {(found) => (
          <Show when={found().length > 0} fallback={<p>{query().trim() ? t("recipes.noMatch") : t("recipes.none")}</p>}>
            <ul>
              <For each={found()}>
                {(recipe) => (
                  <li>
                    <button type="button" onClick={() => props.onOpen(recipe)}>
                      {recipe.title}
                    </button>{" "}
                    <span>{[...recipe.tags, effortText(recipe.effortMinutes)].join(" · ")}</span>
                    <p>{allergensText(recipe.allergens)}</p>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </>
  );
}

function RecipeDetail(props: {
  client: MiseClient;
  id: RecipeId;
  onBack: () => void;
  onEdit: (recipe: Recipe) => void;
}) {
  const [recipe, setRecipe] = createSignal<Recipe>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const items = createItems(props.client);

  const refetch = async () => {
    try {
      const result = await props.client.call("get_recipe", { id: props.id });
      if (result.ok) setRecipe(result.value);
      setError(result.ok ? undefined : errorText(result.error, "recipe"));
    } catch {
      setError(t("app.error"));
    }
  };
  onCleanup(props.client.subscribe("recipes", refetch));

  const remove = async (current: Recipe) => {
    if (!window.confirm(t("recipe.deleteConfirm", { title: current.title }))) return;
    setBusy(true);
    try {
      const result = await props.client.call("delete_recipe", { id: current.id, confirm: true });
      if (result.ok) props.onBack();
      else setError(errorText(result.error, "recipe"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  const changePhoto = async (change: () => Promise<boolean>) => {
    setBusy(true);
    try {
      // On success the change notice refetches the Recipe, with its new photo.
      if (!(await change())) setError(t("recipe.photoFailed"));
    } catch {
      setError(t("recipe.photoFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => props.onBack()}>
        {t("recipe.back")}
      </button>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={recipe()}>
        {(current) => (
          <article>
            <h2>{current().title}</h2>
            <Show when={current().photoKey}>
              {(key) => (
                <img
                  src={props.client.photoUrl(current().id, key())}
                  alt={t("recipe.photoAlt", { title: current().title })}
                />
              )}
            </Show>
            <p>
              {[
                t("recipe.servings", { count: String(current().baseServings) }),
                effortText(current().effortMinutes),
                current().cuisine,
                current().mainProtein,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <Show when={current().recurring}>{(recurring) => <p>{recurrenceText(recurring())}</p>}</Show>
            <Show when={current().yieldsLeftovers}>
              <p>{t("recipe.yieldsLeftovers")}</p>
            </Show>
            <Show when={current().prepAhead}>{(note) => <p>{t("recipe.prepAhead", { note: note() })}</p>}</Show>
            <Show when={current().tags.length > 0}>
              <p>{current().tags.join(", ")}</p>
            </Show>

            <p>{allergensText(current().allergens)}</p>

            <h3 id="ingredients">{t("recipe.ingredients")}</h3>
            <ul aria-labelledby="ingredients">
              <For each={current().ingredients}>
                {(ingredient) => (
                  <li>
                    {ingredient.raw} — {resolutionText(ingredient, items())}
                  </li>
                )}
              </For>
            </ul>

            <h3>{t("recipe.steps")}</h3>
            <ol>
              <For each={current().steps}>{(step) => <li>{step}</li>}</For>
            </ol>

            <Show when={current().notes}>
              {(notes) => (
                <>
                  <h3>{t("recipeForm.notes")}</h3>
                  <p style={{ "white-space": "pre-line" }}>{notes()}</p>
                </>
              )}
            </Show>
            <Show when={sourceText(current())}>{(text) => <p>{text()}</p>}</Show>

            <button type="button" onClick={() => props.onEdit(current())}>
              {t("recipe.edit")}
            </button>
            <button type="button" disabled={busy()} onClick={() => remove(current())}>
              {t("recipe.delete")}
            </button>

            <label>
              {t("recipe.photoUpload")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                disabled={busy()}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  if (file) void changePhoto(() => props.client.uploadPhoto(current().id, file));
                }}
              />
            </label>
            <Show when={current().photoKey}>
              <button
                type="button"
                disabled={busy()}
                onClick={() => changePhoto(() => props.client.removePhoto(current().id))}
              >
                {t("recipe.photoRemove")}
              </button>
            </Show>
          </article>
        )}
      </Show>
    </>
  );
}

/** The Item a line resolved to (its key until the Items load), or that it is Unresolved. */
function resolutionText(ingredient: Ingredient, items: Map<ItemId, Item>): string {
  if (ingredient.item === null) return t("recipe.unresolved");
  return items.get(ingredient.item)?.name ?? ingredient.item;
}

function allergensText(allergens: RecipeAllergens): string {
  if (allergens.kind === "unknown") {
    const count = String(allergens.unresolved);
    const unknown = t(allergens.unresolved === 1 ? "recipe.allergensUnknown" : "recipe.allergensUnknownMany", {
      count,
    });
    return allergens.atLeast.length > 0
      ? `${unknown} ${t("recipe.allergensAtLeast", { allergens: allergenNames(allergens.atLeast) })}`
      : unknown;
  }
  return allergens.allergens.length > 0
    ? t("recipe.allergensKnown", { allergens: allergenNames(allergens.allergens) })
    : t("recipe.allergensNone");
}

function allergenNames(allergens: Allergen[]): string {
  return allergens.map((allergen) => t(`allergen.${allergen}`)).join(", ");
}

function effortText(minutes: number | null): string {
  return minutes === null ? t("recipe.effortUnknown") : t("recipe.effort", { minutes: String(minutes) });
}

/** Where an imported Recipe came from; nothing for one typed into Mise. */
function sourceText(recipe: Recipe): string | null {
  if (recipe.source.kind === "manual") return null;
  const from = recipe.source.author ?? recipe.source.url;
  return from ? t("recipe.importedFrom", { from }) : t("recipe.imported");
}

function recurrenceText(recurring: Recurrence): string {
  return recurring === "weekly"
    ? t("recipe.recurringWeekly")
    : t("recipe.recurringWeekday", { weekday: t(`weekday.${recurring.weekday}`) });
}
