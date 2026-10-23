import { type Ingredient, leadingAmount, type Recipe, type RecipeId, scaleIngredient } from "@mise/domain";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { MiseClient } from "./client";
import { Icon } from "./icons";
import { t } from "./messages";
import { savedRecipe, saveRecipe } from "./offline";

/**
 * Kitchen mode: a Recipe cooked one step at a time, in the high-contrast theme, with the screen kept
 * awake. The Ingredients are a tap away, scaled to `servings`, what the dinner is cooked for (its
 * Leftovers included); without it, as the Recipe is written. No timers.
 */
export function KitchenMode(props: {
  client: MiseClient;
  id: RecipeId;
  servings?: number;
  locale: string;
  onClose: () => void;
}) {
  // The Recipe kept on this device shows at once, and while the connection is down.
  const [recipe, setRecipe] = createSignal<Recipe | undefined>(savedRecipe(props.id));
  const [step, setStep] = createSignal(0);
  const [showIngredients, setShowIngredients] = createSignal(false);
  keepScreenAwake();

  const refetch = async () => {
    try {
      const result = await props.client.call("get_recipe", { id: props.id });
      if (!result.ok) return;
      setRecipe(result.value);
      saveRecipe(result.value);
    } catch {
      // Offline: the saved Recipe stands.
    }
  };
  onCleanup(props.client.subscribe("recipes", refetch));

  return (
    <section class="kitchen" data-theme="kitchen" aria-label={t("kitchen.title")}>
      <div class="kitchen-inner">
        <header class="page-header-row">
          <div class="page-heading">
            <p class="overline">{t("kitchen.title")}</p>
            <h1 class="kitchen-title">{recipe()?.title ?? t("app.loading")}</h1>
          </div>
          <button type="button" class="icon-button" aria-label={t("kitchen.leave")} onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </header>
        <Show when={recipe()}>
          {(open) => {
            const servings = () => props.servings ?? open().baseServings;
            const steps = () => open().steps;
            // A change notice may bring the Recipe back with fewer steps.
            const at = () => Math.min(step(), Math.max(steps().length - 1, 0));
            const last = () => at() >= steps().length - 1;
            return (
              <>
                <Show
                  when={showIngredients()}
                  fallback={
                    <div class="step" aria-live="polite">
                      <Show when={steps().length > 0} fallback={<p class="step-text">{t("kitchen.noSteps")}</p>}>
                        <p class="overline">
                          {t("kitchen.step", { index: String(at() + 1), count: String(steps().length) })}
                        </p>
                        <p class="step-text">{steps()[at()]}</p>
                      </Show>
                    </div>
                  }
                >
                  <div class="step">
                    <h2>{t("recipe.ingredients")}</h2>
                    <p class="meta">
                      {servings() === open().baseServings
                        ? t("kitchen.asWritten", { count: String(servings()) })
                        : t("kitchen.scaled", { count: String(servings()), base: String(open().baseServings) })}
                    </p>
                    <ul class="ingredients kitchen-ingredients" aria-label={t("recipe.ingredients")}>
                      <For each={open().ingredients}>
                        {(ingredient) => (
                          <li>{scaledLine(ingredient, servings() / open().baseServings, props.locale)}</li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>
                <div class="kitchen-controls">
                  <Show
                    when={showIngredients()}
                    fallback={
                      <>
                        <button type="button" class="button-secondary" onClick={() => setShowIngredients(true)}>
                          <Icon name="list" />
                          {t("recipe.ingredients")}
                        </button>
                        <div class="actions">
                          <button
                            type="button"
                            class="button-secondary"
                            disabled={at() === 0}
                            onClick={() => setStep(at() - 1)}
                          >
                            <Icon name="chevronLeft" />
                            {t("kitchen.previous")}
                          </button>
                          <Show
                            when={!last()}
                            fallback={
                              <button type="button" class="button-primary" onClick={() => props.onClose()}>
                                <Icon name="check" />
                                {t("kitchen.finish")}
                              </button>
                            }
                          >
                            <button type="button" class="button-primary" onClick={() => setStep(at() + 1)}>
                              {t("kitchen.next")}
                              <Icon name="chevronRight" />
                            </button>
                          </Show>
                        </div>
                      </>
                    }
                  >
                    <button type="button" class="button-primary" onClick={() => setShowIngredients(false)}>
                      {t("kitchen.backToSteps")}
                    </button>
                  </Show>
                </div>
              </>
            );
          }}
        </Show>
      </div>
    </section>
  );
}

/**
 * Asks the browser to keep the screen on while mounted, and again whenever the page comes back into
 * view (the lock is dropped when it's hidden). Browsers without the Wake Lock API just sleep as usual.
 */
function keepScreenAwake() {
  let lock: WakeLockSentinel | undefined;
  let active = true;
  const request = async () => {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      const granted = await navigator.wakeLock.request("screen");
      if (active) lock = granted;
      else void granted.release();
    } catch {
      // Refused, such as on low battery: the screen may sleep.
    }
  };
  const onVisible = () => void request();
  onMount(() => {
    void request();
    document.addEventListener("visibilitychange", onVisible);
  });
  onCleanup(() => {
    active = false;
    document.removeEventListener("visibilitychange", onVisible);
    void lock?.release();
  });
}

/** An Ingredient line with its amount scaled `by`, the rest as written; unscaled, the line as written. */
function scaledLine(ingredient: Ingredient, by: number, locale: string): string {
  const { amount, unit, name, note } = scaleIngredient(ingredient, by);
  if (by === 1 || !amount) return ingredient.raw;
  const number = (value: number) => kitchenNumber(value, locale);
  const scaled = amount.min === amount.max ? number(amount.min) : `${number(amount.min)}–${number(amount.max)}`;
  const written = leadingAmount(ingredient.raw);
  if (written) return `${scaled} ${written.rest}`;
  return [scaled, unit?.replace("_", " "), name].filter(Boolean).join(" ") + (note ? `, ${note}` : "");
}

const FRACTIONS: [number, string][] = [
  [1 / 8, "⅛"],
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
];

/** 1.5 as "1½", the way a cook reads it; a number that isn't a common fraction, to one decimal. */
function kitchenNumber(value: number, locale: string): string {
  const whole = Math.floor(value);
  const fraction = FRACTIONS.find(([part]) => Math.abs(value - whole - part) < 0.01);
  if (fraction) return `${whole > 0 ? whole : ""}${fraction[1]}`;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}
