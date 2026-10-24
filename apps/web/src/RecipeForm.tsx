import { COURSES, type Course, type Recipe, type ToolInput, WEEKDAYS, type Weekday } from "@mise/domain";
import { createSignal, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { t } from "./messages";

/** A Recipe as the form holds it: text as typed, lists one entry per line. */
type RecipeDraft = {
  title: string;
  baseServings: string;
  ingredients: string;
  steps: string;
  tags: string;
  effortMinutes: string;
  cuisine: string;
  mainProtein: string;
  course: "" | Course;
  recurring: "" | "weekly" | Weekday;
  yieldsLeftovers: boolean;
  prepAhead: string;
  notes: string;
};

const emptyRecipe = (): RecipeDraft => ({
  title: "",
  baseServings: "4",
  ingredients: "",
  steps: "",
  tags: "",
  effortMinutes: "",
  cuisine: "",
  mainProtein: "",
  course: "",
  recurring: "",
  yieldsLeftovers: false,
  prepAhead: "",
  notes: "",
});

function draftOf(recipe: Recipe): RecipeDraft {
  return {
    title: recipe.title,
    baseServings: String(recipe.baseServings),
    ingredients: recipe.ingredients.map((ingredient) => ingredient.raw).join("\n"),
    steps: recipe.steps.join("\n"),
    tags: recipe.tags.join(", "),
    effortMinutes: recipe.effortMinutes === null ? "" : String(recipe.effortMinutes),
    cuisine: recipe.cuisine ?? "",
    mainProtein: recipe.mainProtein ?? "",
    course: recipe.course ?? "",
    recurring: recipe.recurring === null ? "" : recipe.recurring === "weekly" ? "weekly" : recipe.recurring.weekday,
    yieldsLeftovers: recipe.yieldsLeftovers,
    prepAhead: recipe.prepAhead ?? "",
    notes: recipe.notes ?? "",
  };
}

/** The draft as tool input; the tools validate it, and drop blank lines. */
function recipeOf(draft: RecipeDraft): Required<ToolInput<"create_recipe">> {
  const text = (value: string) => value.trim() || null;
  return {
    title: draft.title,
    baseServings: Number(draft.baseServings),
    ingredients: draft.ingredients.split("\n"),
    steps: draft.steps.split("\n"),
    tags: draft.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    effortMinutes: draft.effortMinutes.trim() === "" ? null : Number(draft.effortMinutes),
    cuisine: text(draft.cuisine),
    mainProtein: text(draft.mainProtein),
    course: draft.course === "" ? null : draft.course,
    recurring: draft.recurring === "" ? null : draft.recurring === "weekly" ? "weekly" : { weekday: draft.recurring },
    yieldsLeftovers: draft.yieldsLeftovers,
    prepAhead: text(draft.prepAhead),
    notes: text(draft.notes),
  };
}

/** Creates a Recipe, or edits `recipe` when given. Calls `onSaved` with the Recipe as saved. */
export function RecipeForm(props: {
  client: MiseClient;
  recipe?: Recipe;
  onSaved: (recipe: Recipe) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = createSignal(props.recipe ? draftOf(props.recipe) : emptyRecipe());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const update = <K extends keyof RecipeDraft>(key: K, value: RecipeDraft[K]) => setDraft({ ...draft(), [key]: value });

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const input = recipeOf(draft());
      const result = props.recipe
        ? await props.client.call("update_recipe", { id: props.recipe.id, ...input })
        : await props.client.call("create_recipe", input);
      if (result.ok) props.onSaved(result.value);
      else setError(errorText(result.error, "recipe"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save}>
      <label>
        {t("recipeForm.title")}
        <input required maxLength={200} value={draft().title} onInput={(e) => update("title", e.currentTarget.value)} />
      </label>
      <label>
        {t("recipeForm.baseServings")}
        <input
          type="number"
          required
          min={1}
          max={100}
          value={draft().baseServings}
          onInput={(e) => update("baseServings", e.currentTarget.value)}
        />
      </label>
      <label>
        {t("recipeForm.ingredients")}
        <textarea rows={8} value={draft().ingredients} onInput={(e) => update("ingredients", e.currentTarget.value)} />
      </label>
      <small>{t("recipeForm.ingredientsHint")}</small>
      <label>
        {t("recipeForm.steps")}
        <textarea rows={8} value={draft().steps} onInput={(e) => update("steps", e.currentTarget.value)} />
      </label>
      <small>{t("recipeForm.stepsHint")}</small>
      <label>
        {t("recipeForm.tags")}
        <input value={draft().tags} onInput={(e) => update("tags", e.currentTarget.value)} />
      </label>
      <small>{t("recipeForm.tagsHint")}</small>
      <label>
        {t("recipeForm.effortMinutes")}
        <input
          type="number"
          min={0}
          value={draft().effortMinutes}
          onInput={(e) => update("effortMinutes", e.currentTarget.value)}
        />
      </label>
      <small>{t("recipeForm.effortHint")}</small>
      <label>
        {t("recipeForm.cuisine")}
        <input maxLength={100} value={draft().cuisine} onInput={(e) => update("cuisine", e.currentTarget.value)} />
      </label>
      <label>
        {t("recipeForm.mainProtein")}
        <input
          maxLength={100}
          value={draft().mainProtein}
          onInput={(e) => update("mainProtein", e.currentTarget.value)}
        />
      </label>
      <label>
        {t("recipeForm.course")}
        <select
          value={draft().course}
          onChange={(e) => update("course", e.currentTarget.value as RecipeDraft["course"])}
        >
          <option value="">{t("recipeForm.courseUnknown")}</option>
          <For each={COURSES}>{(course) => <option value={course}>{t(`course.${course}`)}</option>}</For>
        </select>
      </label>
      <small>{t("recipeForm.courseHint")}</small>
      <label>
        {t("recipeForm.recurring")}
        <select
          value={draft().recurring}
          onChange={(e) => update("recurring", e.currentTarget.value as RecipeDraft["recurring"])}
        >
          <option value="">{t("recipeForm.notRecurring")}</option>
          <option value="weekly">{t("recipe.recurringWeekly")}</option>
          <For each={WEEKDAYS}>
            {(weekday) => (
              <option value={weekday}>{t("recipe.recurringWeekday", { weekday: t(`weekday.${weekday}`) })}</option>
            )}
          </For>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft().yieldsLeftovers}
          onChange={(e) => update("yieldsLeftovers", e.currentTarget.checked)}
        />
        {t("recipe.yieldsLeftovers")}
      </label>
      <label>
        {t("recipeForm.prepAhead")}
        <input maxLength={500} value={draft().prepAhead} onInput={(e) => update("prepAhead", e.currentTarget.value)} />
      </label>
      <label>
        {t("recipeForm.notes")}
        <textarea
          rows={4}
          maxLength={20_000}
          value={draft().notes}
          onInput={(e) => update("notes", e.currentTarget.value)}
        />
      </label>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <button type="submit" disabled={busy()}>
        {busy() ? t("recipeForm.saving") : t("recipeForm.save")}
      </button>
      <button type="button" onClick={() => props.onCancel()}>
        {t("recipeForm.cancel")}
      </button>
    </form>
  );
}
