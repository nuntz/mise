import { type Recipe, type RecipeId, scaledLine } from "@mise/domain";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
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
            let next: HTMLButtonElement | undefined;
            // Back on the first step, Previous hides with the focus it held; Next takes it, not the page.
            const previous = (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
              const focused = document.activeElement === event.currentTarget;
              setStep(at() - 1);
              if (focused && at() === 0) next?.focus();
            };
            return (
              <>
                <Show
                  when={showIngredients()}
                  fallback={
                    <div class="step" aria-live="polite">
                      <Show when={steps().length > 0} fallback={<p class="step-text">{t("kitchen.noSteps")}</p>}>
                        <div class="step-progress">
                          <p class="overline">
                            {t("kitchen.step", { index: String(at() + 1), count: String(steps().length) })}
                          </p>
                          {/* Where the cook is, at arm's length; the words say it to a screen reader. */}
                          <span class="step-dots" aria-hidden="true">
                            <For each={steps()}>
                              {(_, index) => (
                                <span class={index() === at() ? "step-dot step-dot-current" : "step-dot"} />
                              )}
                            </For>
                          </span>
                        </div>
                        <p class="step-text">{steps()[at()]}</p>
                      </Show>
                    </div>
                  }
                >
                  <div class="step">
                    <h2>{t("recipe.ingredients")}</h2>
                    <p class="meta">{scaledForText(servings(), open().baseServings)}</p>
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
                          {/* The first step has nothing before it, so no Previous that looks disabled. */}
                          <Show when={at() > 0}>
                            <button type="button" class="button-secondary" onClick={previous}>
                              <Icon name="chevronLeft" />
                              {t("kitchen.previous")}
                            </button>
                          </Show>
                          <Show
                            when={!last()}
                            fallback={
                              <button type="button" class="button-primary" onClick={() => props.onClose()}>
                                <Icon name="check" />
                                {t("kitchen.finish")}
                              </button>
                            }
                          >
                            <button ref={next} type="button" class="button-primary" onClick={() => setStep(at() + 1)}>
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

/** Who a Recipe's Ingredients are scaled for: `servings`, against the `base` it is written for. */
export function scaledForText(servings: number, base: number): string {
  return servings === base
    ? t("kitchen.asWritten", { count: String(servings) })
    : t("kitchen.scaled", { count: String(servings), base: String(base) });
}
