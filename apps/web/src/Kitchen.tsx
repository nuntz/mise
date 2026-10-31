import { type ChatWhere, type Household, type Recipe, type RecipeId, scaledLines } from "@mise/domain";
import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { type MessageKey, t } from "./messages";
import { savedRecipe, saveRecipe } from "./offline";
import type { OpenVoice } from "./voice";
import { createVoiceSession, type VoiceRefusal } from "./voiceSession";
import type { SlotKey } from "./Week";

const VOICE_ERRORS: Record<VoiceRefusal, MessageKey> = {
  voice: "chat.voice.failed",
  voiceInUse: "chat.voice.inUse",
  voiceSpent: "chat.voice.spent",
  voiceOff: "chat.voice.off",
};

/**
 * Kitchen mode: a Recipe cooked one step at a time, in the high-contrast theme, with the screen kept
 * awake. The Ingredients are a tap away, scaled to `servings`, what the dinner is cooked for (its
 * Leftovers included); without it, as the Recipe is written. No timers.
 *
 * With `voice`, its own mic starts a Voice Session over the step on screen, for the dinner `slot`
 * when cooked from the Week: open mic, as the phone spike found it works on a speaker, for as long as
 * the page shows (the wake lock keeps it showing; hidden, the session ends). The screen moves to each
 * step the agent reads aloud.
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
      <div class="kitchen-inner">
        <header class="page-header-row">
          <div class="page-heading">
            <p class="overline">{t("kitchen.title")}</p>
            <h1 class="kitchen-title">{recipe()?.title ?? t("app.loading")}</h1>
          </div>
          <div class="kitchen-header-actions">
            <Show when={!voice.talking() && voice.micShown()}>
              <button
                type="button"
                class="icon-button"
                aria-label={t("chat.voice.start")}
                disabled={voice.micReason() !== undefined}
                aria-describedby={voice.micReason() ? micId : undefined}
                onClick={() => void voice.start()}
              >
                <Icon name="mic" />
              </button>
            </Show>
            <button type="button" class="icon-button" aria-label={t("kitchen.leave")} onClick={() => props.onClose()}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        <Show when={voice.talking()}>
          <div class="kitchen-voice">
            <p class="meta" role="status">
              <Icon name="mic" />
              {t(voice.state() === "on" ? "chat.voice.listening" : "chat.voice.starting")}
            </p>
            <button type="button" class="button-quiet" onClick={voice.end}>
              {t("chat.voice.end")}
            </button>
          </div>
        </Show>
        <Show when={!voice.talking() && voice.micShown() && !voiceError() && voice.micReason()}>
          {(reason) => (
            <p id={micId} class="control-reason">
              {reason()}
            </p>
          )}
        </Show>
        <Show when={voiceError()}>
          {(failed) => (
            <p class="banner banner-warn" role="alert">
              {failed() === "voiceInUse" && voice.speaker()
                ? t("chat.voice.talking", { name: voice.speaker() ?? "" })
                : t(VOICE_ERRORS[failed()], { time: voice.minutesBackAt() })}
            </p>
          )}
        </Show>
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
