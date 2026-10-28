import {
  type Allergen,
  type Course,
  type Ingredient,
  type Item,
  type ItemId,
  normaliseItemName,
  type Recipe,
  type RecipeAllergens,
  type RecipeId,
  type RecipeSummary,
  type Recurrence,
} from "@mise/domain";
import { createEffect, createSignal, createUniqueId, For, Match, on, Show, Switch } from "solid-js";
import { createConfirm } from "./ConfirmSheet";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { FilePicker } from "./FilePicker";
import { keepFresh } from "./fresh";
import { Icon, PlateGlyph } from "./icons";
import { nameText, t } from "./messages";
import { lastRecipe, savedRecipe, saveRecipe } from "./offline";
import { ReadyMadeForm } from "./ReadyMadeForm";
import { RecipeForm } from "./RecipeForm";

type View =
  | { kind: "list" }
  | { kind: "recipe"; id: RecipeId }
  | { kind: "new" }
  | { kind: "readyMade" }
  | { kind: "edit"; recipe: Recipe };

/** Recipes: list and search them, view one, create and edit them. Opens on the list, or on the Recipe `open`. */
export function RecipesPage(props: {
  client: MiseClient;
  online: boolean;
  open?: RecipeId;
  onCook: (recipe: RecipeId) => void;
  /** Opens Resolve Ingredients, at the Unresolved group `text` when given. */
  onResolve: (text?: string) => void;
}) {
  const [view, setView] = createSignal<View>(props.open ? { kind: "recipe", id: props.open } : { kind: "list" });
  const list = () => setView({ kind: "list" });
  const show = (recipe: { id: RecipeId }) => setView({ kind: "recipe", id: recipe.id });

  return (
    <section class="screen">
      <Switch>
        <Match when={view().kind === "list"}>
          <RecipeList
            client={props.client}
            online={props.online}
            onOpen={show}
            onNew={() => setView({ kind: "new" })}
            onNewReadyMade={() => setView({ kind: "readyMade" })}
          />
        </Match>
        <Match when={view().kind === "readyMade"}>
          <h1>{t("recipes.newReadyMade")}</h1>
          <ReadyMadeForm client={props.client} onSaved={show} onCancel={list} />
        </Match>
        <Match when={view().kind === "new"}>
          <h1>{t("recipes.new")}</h1>
          <RecipeForm client={props.client} onSaved={show} onCancel={list} />
        </Match>
        <Match when={narrow(view(), "edit")}>
          {(edit) => <RecipeEdit client={props.client} recipe={edit().recipe} onSaved={show} onDeleted={list} />}
        </Match>
        <Match when={narrow(view(), "recipe")}>
          {(open) => (
            <RecipeDetail
              client={props.client}
              id={open().id}
              onBack={list}
              onCook={props.onCook}
              onResolve={props.onResolve}
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

function RecipeList(props: {
  client: MiseClient;
  online: boolean;
  onOpen: (recipe: { id: RecipeId }) => void;
  onNew: () => void;
  onNewReadyMade: () => void;
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

  return (
    <>
      <header class="page-header-row">
        <div class="page-heading">
          <p class="overline">{t("recipes.overline")}</p>
          <h1>{t("recipes.title")}</h1>
        </div>
      </header>
      <label>
        {t("recipes.search")}
        <input
          type="search"
          placeholder={t("recipes.searchPlaceholder")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </label>
      <button type="button" class="button-secondary" onClick={() => props.onNew()}>
        <Icon name="plus" />
        {t("recipes.new")}
      </button>
      <button type="button" class="button-secondary" onClick={() => props.onNewReadyMade()}>
        <Icon name="plus" />
        {t("recipes.newReadyMade")}
      </button>
      <Show when={failed()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      {/* The Recipes can't be listed, but the last one viewed is kept on this device. */}
      <Show when={(failed() || !props.online) && lastRecipe()}>
        {(last) => (
          <button type="button" class="button-secondary" onClick={() => props.onOpen(last())}>
            {t("recipes.lastViewed", { title: last().title })}
          </button>
        )}
      </Show>
      <Show when={recipes()}>
        {(found) => (
          <Show
            when={found().length > 0}
            fallback={<p class="empty">{query().trim() ? t("recipes.noMatch") : t("recipes.none")}</p>}
          >
            <ul class="rows">
              <For each={found()}>
                {(recipe) => {
                  const id = `recipe-${recipe.id}`;
                  return (
                    <li>
                      {/* The whole row opens the Recipe, named by its title and described by its details. */}
                      <button
                        type="button"
                        class="row row-open recipe-row"
                        aria-labelledby={`${id}-title`}
                        aria-describedby={`${id}-meta ${id}-allergens`}
                        onClick={() => props.onOpen(recipe)}
                      >
                        <span class="row-lead thumb" aria-hidden="true">
                          <Show when={recipe.photoKey} fallback={<PlateGlyph size={30} />}>
                            {(key) => <img src={props.client.photoUrl(recipe.id, key())} alt="" />}
                          </Show>
                        </span>
                        <span class="row-body">
                          <span class="dish-title" id={`${id}-title`}>
                            {recipe.title}
                          </span>
                          <span class="row-meta" id={`${id}-meta`}>
                            {[...recipe.tags.map(nameText), effortText(recipe.effortMinutes)].join(" · ")}
                          </span>
                          <Show when={recipe.readyMade}>
                            <span class="chip">{t("recipe.readyMade")}</span>
                          </Show>
                          <Show when={recipe.allergens.kind === "unknown"}>
                            <span class="chip chip-amber">{t("recipe.allergensUnknownChip")}</span>
                          </Show>
                          <span class="row-meta" id={`${id}-allergens`}>
                            {allergensText(recipe.allergens)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </>
  );
}

/** A Recipe's edit view: its form, and Delete Recipe, which asks first in Mise's confirm sheet. */
function RecipeEdit(props: {
  client: MiseClient;
  recipe: Recipe;
  onSaved: (recipe: Recipe) => void;
  onDeleted: () => void;
}) {
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  const confirm = createConfirm();
  const remove = async () => {
    const { id, title } = props.recipe;
    const confirmed = await confirm.ask({
      title: t("recipe.deleteTitle", { title }),
      lost: t("recipe.deleteLost", { title }),
      action: t("recipe.delete"),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await props.client.call("delete_recipe", { id, confirm: true });
      if (result.ok) props.onDeleted();
      else setError(errorText(result.error, "recipe"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{props.recipe.title}</h1>
      <RecipeForm
        client={props.client}
        recipe={props.recipe}
        onSaved={props.onSaved}
        onCancel={() => props.onSaved(props.recipe)}
      />
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <button type="button" class="button-danger" disabled={busy()} onClick={() => void remove()}>
        {t("recipe.delete")}
      </button>
      <confirm.ConfirmSheet />
    </>
  );
}

function RecipeDetail(props: {
  client: MiseClient;
  id: RecipeId;
  onBack: () => void;
  onCook: (recipe: RecipeId) => void;
  onResolve: (text?: string) => void;
  onEdit: (recipe: Recipe) => void;
}) {
  // The last Recipe viewed is kept on this device, so it stays readable if the connection drops mid-cook.
  const [recipe, setRecipe] = createSignal<Recipe | undefined>(savedRecipe(props.id));
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  keepFresh(
    props.client,
    ["recipes"],
    () => props.client.call("get_recipe", { id: props.id }),
    (result) => {
      if (result.ok) {
        setRecipe(result.value);
        saveRecipe(result.value);
      }
      setError(result.ok ? undefined : errorText(result.error, "recipe"));
    },
    () => setError(t("app.error")),
  );

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
      <button type="button" class="button-link back" onClick={() => props.onBack()}>
        <Icon name="chevronLeft" />
        {t("recipe.back")}
      </button>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={recipe()}>
        {(current) => (
          <article class="screen" aria-labelledby="recipe-title">
            <div class="photo hero">
              <Show when={current().photoKey} fallback={<PlateGlyph size={72} />}>
                {(key) => (
                  <img
                    src={props.client.photoUrl(current().id, key())}
                    alt={t("recipe.photoAlt", { title: current().title })}
                  />
                )}
              </Show>
            </div>
            <div class="page-heading">
              <p class="overline">{t("recipe.overline")}</p>
              <h1 id="recipe-title">{current().title}</h1>
              <p class="meta">
                {[
                  t("recipe.servings", { count: String(current().baseServings) }),
                  effortText(current().effortMinutes),
                  ...[current().cuisine, current().mainProtein].map((name) => name && nameText(name)),
                  courseText(current().course),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div class="chips">
              <Show when={current().readyMade}>
                <span class="chip">{t("recipe.readyMade")}</span>
              </Show>
              <Show when={current().recurring}>
                {(recurring) => <span class="chip">{recurrenceText(recurring())}</span>}
              </Show>
              <Show when={current().yieldsLeftovers}>
                <span class="chip">{t("recipe.yieldsLeftovers")}</span>
              </Show>
              <For each={current().tags}>{(tag) => <span class="chip">{nameText(tag)}</span>}</For>
            </div>
            <Show when={current().prepAhead}>
              {(note) => <p class="banner banner-plum">{t("recipe.prepAhead", { note: note() })}</p>}
            </Show>
            <Show
              when={current().allergens.kind === "unknown"}
              fallback={<p class="meta">{allergensText(current().allergens)}</p>}
            >
              <div class="banner banner-amber">
                <p>{allergensText(current().allergens)}</p>
                <button type="button" onClick={() => props.onResolve()}>
                  {t("recipe.resolveThem")}
                </button>
              </div>
            </Show>
            <Show when={current().steps.length > 0}>
              <button type="button" class="button-primary" onClick={() => props.onCook(current().id)}>
                <Icon name="pot" />
                {t("recipe.cook")}
              </button>
            </Show>

            <section class="stack" aria-labelledby="ingredients">
              <h2 id="ingredients">{t("recipe.ingredients")}</h2>
              <ul class="ingredients" aria-labelledby="ingredients">
                <For each={current().ingredients}>
                  {(ingredient) => {
                    const line = createUniqueId();
                    return (
                      <li>
                        <span id={line}>{ingredient.raw}</span>
                        {/* An Unresolved line leads to where it's resolved; its Item shows only in edit. */}
                        <Show when={ingredient.item === null}>
                          <button
                            type="button"
                            class="chip-button"
                            aria-describedby={line}
                            onClick={() => props.onResolve(normaliseItemName(ingredient.name))}
                          >
                            <span class="chip chip-amber">{t("recipe.unresolved")}</span>
                          </button>
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </section>

            <section class="stack" aria-labelledby="steps">
              <h2 id="steps">{t("recipe.steps")}</h2>
              <ol class="steps">
                <For each={current().steps}>{(step) => <li>{step}</li>}</For>
              </ol>
            </section>

            <Show when={current().notes}>
              {(notes) => (
                <section class="stack">
                  <h2>{t("recipeForm.notes")}</h2>
                  <p class="pre-line">{notes()}</p>
                </section>
              )}
            </Show>
            <Show when={sourceText(current())}>{(text) => <p class="meta">{text()}</p>}</Show>

            <div class="slot-actions">
              <button type="button" class="button-row" onClick={() => props.onEdit(current())}>
                {t("recipe.edit")}
              </button>
              <Show when={current().photoKey}>
                <button
                  type="button"
                  class="button-row"
                  disabled={busy()}
                  onClick={() => changePhoto(() => props.client.removePhoto(current().id))}
                >
                  {t("recipe.photoRemove")}
                </button>
              </Show>
            </div>
            <FilePicker
              label={t("recipe.photoUpload")}
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              disabled={busy()}
              onPick={([file]) => {
                if (file) void changePhoto(() => props.client.uploadPhoto(current().id, file));
              }}
            />
          </article>
        )}
      </Show>
    </>
  );
}

/** The Item a line resolved to (its key until the Items load), or that it is Unresolved. */
export function resolutionText(ingredient: Ingredient, items: Map<ItemId, Item>): string {
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

export function courseText(course: Course | null): string | null {
  return course === null ? null : t(`course.${course}`);
}

export function effortText(minutes: number | null): string {
  return minutes === null ? t("recipe.effortUnknown") : t("recipe.effort", { minutes: String(minutes) });
}

/** Where an imported Recipe came from; nothing for one typed into Mise. */
function sourceText(recipe: Recipe): string | null {
  if (recipe.source.kind === "manual") return null;
  if (recipe.source.kind === "text") return t("recipe.importedText");
  if (recipe.source.kind === "screenshot") return t("recipe.importedScreenshots");
  if (recipe.source.kind === "gdrive") return t("recipe.importedDoc", { url: recipe.source.url });
  if (recipe.source.kind === "tiktok") {
    const { url, author } = recipe.source;
    return author ? t("recipe.importedTikTokBy", { url, author }) : t("recipe.importedTikTok", { url });
  }
  if (recipe.source.kind === "url" || recipe.source.kind === "instagram") {
    return t("recipe.importedLink", { url: recipe.source.url });
  }
  const from = recipe.source.author ?? recipe.source.url;
  return from ? t("recipe.importedFrom", { from }) : t("recipe.imported");
}

function recurrenceText(recurring: Recurrence): string {
  return recurring === "weekly"
    ? t("recipe.recurringWeekly")
    : t("recipe.recurringWeekday", { weekday: t(`weekday.${recurring.weekday}`) });
}
