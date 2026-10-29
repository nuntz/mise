import { type Allergen, parseIngredient, type Recipe, STORE_SECTIONS, type StoreSection } from "@mise/domain";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { AllergenPicker, allergenSummary } from "./AllergenPicker";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { createItems, itemNamed } from "./items";
import { t } from "./messages";

/**
 * Adds a Ready-made dish, bought finished and only heated: a Recipe whose one Ingredient is the product,
 * a Household Item carrying the label's Allergens and its Store Section (ADR 0026). A product that
 * already names an Item uses it, Allergens and all. Calls `onSaved` with the Recipe as saved.
 */
export function ReadyMadeForm(props: { client: MiseClient; onSaved: (recipe: Recipe) => void; onCancel: () => void }) {
  const items = createItems(props.client);
  const [title, setTitle] = createSignal("");
  const [product, setProduct] = createSignal("");
  const [servings, setServings] = createSignal("4");
  const [section, setSection] = createSignal<StoreSection>("frozen");
  const [allergens, setAllergens] = createSignal<Allergen[]>([]);
  const [none, setNone] = createSignal(false);
  const [heating, setHeating] = createSignal("");
  const [effortMinutes, setEffortMinutes] = createSignal("");
  const [yieldsLeftovers, setYieldsLeftovers] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  // The Item the server will use, if any: named as the line reads the product, as it names a new one.
  const known = () => {
    const name = parseIngredient(`1 package ${product()}`).name;
    return name.trim() ? itemNamed(items().values(), name) : undefined;
  };
  const productHint = createUniqueId();

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!known() && allergens().length === 0 && !none()) {
      setError(t("item.allergensUnstated"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // One call, so a refusal leaves no Item behind; the server decides which Item the product is.
      const result = await props.client.call("create_ready_made_recipe", {
        title: title(),
        product: product(),
        baseServings: Number(servings()),
        ...(known() ? {} : { allergens: allergens(), section: section() }),
        steps: heating().split("\n"),
        effortMinutes: effortMinutes().trim() === "" ? null : Number(effortMinutes()),
        yieldsLeftovers: yieldsLeftovers(),
      });
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
      <p>{t("readyMade.intro")}</p>
      <label>
        {t("recipeForm.title")}
        <input
          required
          maxLength={200}
          placeholder={t("readyMade.titlePlaceholder")}
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </label>
      <label>
        {t("readyMade.product")}
        <input
          required
          maxLength={100}
          aria-describedby={productHint}
          value={product()}
          onInput={(e) => setProduct(e.currentTarget.value)}
        />
      </label>
      <small id={productHint}>{t("readyMade.productHint")}</small>
      <label>
        {t("readyMade.serves")}
        <input
          type="number"
          required
          min={1}
          max={100}
          value={servings()}
          onInput={(e) => setServings(e.currentTarget.value)}
        />
      </label>
      <Show
        when={known()}
        fallback={
          <>
            <label>
              {t("item.section")}
              <select value={section()} onChange={(e) => setSection(e.currentTarget.value as StoreSection)}>
                <For each={STORE_SECTIONS}>{(value) => <option value={value}>{t(`section.${value}`)}</option>}</For>
              </select>
            </label>
            <AllergenPicker allergens={allergens()} none={none()} onAllergens={setAllergens} onNone={setNone} />
          </>
        }
      >
        {(item) => (
          <Show
            when={item().unitFamily === "count"}
            fallback={
              <p class="banner banner-amber" role="status">
                {t("readyMade.measuredItem")}
              </p>
            }
          >
            <p class="banner banner-plum">
              {t("readyMade.knownItem", { item: item().name, allergens: allergenSummary(item().allergens) })}
            </p>
          </Show>
        )}
      </Show>
      <label>
        {t("readyMade.heating")}
        <textarea rows={3} value={heating()} onInput={(e) => setHeating(e.currentTarget.value)} />
      </label>
      <small>{t("readyMade.heatingHint")}</small>
      <label>
        {t("readyMade.effortMinutes")}
        <input type="number" min={0} value={effortMinutes()} onInput={(e) => setEffortMinutes(e.currentTarget.value)} />
      </label>
      <small>{t("readyMade.effortHint")}</small>
      <label>
        <input
          type="checkbox"
          checked={yieldsLeftovers()}
          onChange={(e) => setYieldsLeftovers(e.currentTarget.checked)}
        />
        {t("recipe.yieldsLeftovers")}
      </label>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <button type="submit" disabled={busy()}>
        {busy() ? t("readyMade.saving") : t("readyMade.save")}
      </button>
      <button type="button" onClick={() => props.onCancel()}>
        {t("recipeForm.cancel")}
      </button>
    </form>
  );
}
