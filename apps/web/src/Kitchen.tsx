import { type ChatWhere, type Household, type Recipe, type RecipeId, scaledLines } from "@mise/domain";
import { createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";
import { savedRecipe, saveRecipe } from "./offline";
import { UpdateBanner } from "./Update";
import { HeldDuringVoice, MicButton, VoiceListening, VoiceProblem } from "./VoiceControls";
import type { OpenVoice } from "./voice";
import { createVoiceSession, type VoiceRefusal } from "./voiceSession";
import type { SlotKey } from "./Week";
import { keepScreenAwake } from "./wakeLock";

/**
 * Kitchen mode: a Recipe cooked one step at a time, in the high-contrast theme, with the screen kept
 * awake. The Ingredients are a tap away, scaled to `servings`, what the dinner is cooked for (its
 * Leftovers included); without it, as the Recipe is written. No timers.
 *
 * With `voice`, its own mic starts a Voice Session over the step on screen, for the dinner `slot`
 * when cooked from the Week: open mic, as the phone spike found it works on a speaker, for as long as
 * the page shows (the wake lock keeps it showing; hidden, the session ends). The screen moves to each
 * step the agent reads aloud. A change the agent holds for a tap during the session shows over the
 * step, so the cook needn't open the chat; it stays until tapped, cancelled, or withdrawn by voice, and
 * only a tap runs it (ADR 0024).
 */
export function KitchenMode(props: {
  client: MiseClient;
  id: RecipeId;
  servings?: number;
  slot?: SlotKey;
  locale: string;
  voice?: OpenVoice;
  online?: boolean;
  household?: Household | null;
  /** A newer build of Mise has taken over the page: Kitchen mode covers the app's own offer. */
  newBuild: boolean;
  onReload: () => void;
  onClose: () => void;
}) {
  // The Recipe kept on this device shows at once, and while the connection is down.
  const [recipe, setRecipe] = createSignal<Recipe | undefined>(savedRecipe(props.id));
  const [step, setStep] = createSignal(0);
  const [showIngredients, setShowIngredients] = createSignal(false);
  keepScreenAwake();

  /** The step on screen, counted from 1, as a Voice Session hears it; none without steps. */
  const stepShown = () => {
    const count = recipe()?.steps.length ?? 0;
    return count > 0 ? Math.min(step(), count - 1) + 1 : undefined;
  };
  const where = (): ChatWhere => {
    const shown = stepShown();
    return {
      screen: "kitchen",
      recipe: props.id,
      ...(props.slot && { slot: props.slot }),
      ...(shown && { step: shown }),
    };
  };
  const [voiceError, setVoiceError] = createSignal<VoiceRefusal>();
  const voice = createVoiceSession({
    get client() {
      return props.client;
    },
    get online() {
      return props.online ?? true;
    },
    where,
    get voice() {
      return props.voice;
    },
    get household() {
      return props.household;
    },
    onStarting: () => setVoiceError(undefined),
    onRefused: setVoiceError,
  });
  const micId = createUniqueId();
  // The household sends a step only to the device talking, once the agent has read it aloud.
  onCleanup(
    props.client.onShowStep((shown) => {
      if (!voice.talking()) return;
      setStep(shown - 1);
      setShowIngredients(false);
    }),
  );

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
      <UpdateBanner ready={props.newBuild} reload={() => props.onReload()} />
      <div class="kitchen-inner">
        <header class="page-header-row">
          <div class="page-heading">
            <p class="overline">{t("kitchen.title")}</p>
            <h1 class="kitchen-title">{recipe()?.title ?? t("app.loading")}</h1>
          </div>
          <div class="kitchen-header-actions">
            <MicButton voice={voice} micId={micId} />
            <button type="button" class="icon-button" aria-label={t("kitchen.leave")} onClick={() => props.onClose()}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        <VoiceListening voice={voice} />
        <HeldDuringVoice client={props.client} voice={voice} listening={props.voice !== undefined} />
        <VoiceProblem voice={voice} micId={micId} error={voiceError()} />
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
                      <For each={scaledLines(open(), servings(), props.locale)}>{(line) => <li>{line}</li>}</For>
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

/** Who a Recipe's Ingredients are scaled for: `servings`, against the `base` it is written for. */
export function scaledForText(servings: number, base: number): string {
  return servings === base
    ? t("kitchen.asWritten", { count: String(servings) })
    : t("kitchen.scaled", { count: String(servings), base: String(base) });
}
