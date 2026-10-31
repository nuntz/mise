import { createEffect, createSignal, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import {
  type Confirmation,
  confirmationTaps,
  pendingConfirmations,
  TAP_REFUSALS,
  type TapRefusal,
} from "./confirmations";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { type MessageKey, t } from "./messages";
import type { createVoiceSession, VoiceRefusal } from "./voiceSession";

/**
 * A screen's own mic and what goes with it, for a screen that is looked at while talking, as the chat
 * sheet would cover it: Kitchen mode's step, the Pantry's check-in cards. Each takes the screen's
 * `voice`, its `createVoiceSession`.
 */
export type ScreenVoice = ReturnType<typeof createVoiceSession>;

const VOICE_ERRORS: Record<VoiceRefusal, MessageKey> = {
  voice: "chat.voice.failed",
  voiceInUse: "chat.voice.inUse",
  voiceSpent: "chat.voice.spent",
  voiceOff: "chat.voice.off",
  voiceEnded: "chat.voice.ended",
};

/** The mic, while no session runs and voice is there to be had; `micId` names why it can't start, if it can't. */
export function MicButton(props: { voice: ScreenVoice; micId: string; onStart?: () => void }) {
  return (
    <Show when={!props.voice.talking() && props.voice.micShown()}>
      <button
        type="button"
        class="icon-button"
        aria-label={t("chat.voice.start")}
        disabled={props.voice.micReason() !== undefined}
        aria-describedby={props.voice.micReason() ? props.micId : undefined}
        onClick={() => {
          props.onStart?.();
          void props.voice.start();
        }}
      >
        <Icon name="mic" />
      </button>
    </Show>
  );
}

/** While a session runs: a small indicator, and its end, out of the way of what the screen shows. */
export function VoiceListening(props: { voice: ScreenVoice }) {
  return (
    <Show when={props.voice.talking()}>
      <div class="voice-listening">
        <p class="meta" role="status">
          <Icon name="mic" />
          {t(props.voice.state() === "on" ? "chat.voice.listening" : "chat.voice.starting")}
        </p>
        <button type="button" class="button-quiet" onClick={props.voice.end}>
          {t("chat.voice.end")}
        </button>
      </div>
    </Show>
  );
}

/** Why the mic can't start, said before a tap (as `micId`), or why a start went no further (`error`). */
export function VoiceProblem(props: { voice: ScreenVoice; micId: string; error: VoiceRefusal | undefined }) {
  return (
    <>
      <Show when={!props.voice.talking() && props.voice.micShown() && !props.error && props.voice.micReason()}>
        {(reason) => (
          <p id={props.micId} class="control-reason">
            {reason()}
          </p>
        )}
      </Show>
      <Show when={props.error}>
        {(failed) => (
          <p class="banner banner-warn" role="alert">
            {failed() === "voiceInUse" && props.voice.speaker()
              ? t("chat.voice.talking", { name: props.voice.speaker() ?? "" })
              : t(VOICE_ERRORS[failed()], { time: props.voice.minutesBackAt() })}
          </p>
        )}
      </Show>
    </>
  );
}

/**
 * The changes the agent held for a tap since this screen first talked, over what the screen shows, so
 * the person needn't open the chat; each stays until tapped, cancelled, or withdrawn by voice, and only
 * a tap runs it (ADR 0024). Those pending before are the chat's to show. Counted from the first start,
 * not by when each is read, so one held as the session ends still shows, though read after. Nothing
 * is read without a mic (`listening` false).
 */
export function HeldDuringVoice(props: { client: MiseClient; voice: ScreenVoice; listening: boolean }) {
  const [pendingHere, setPendingHere] = createSignal<Confirmation[]>([]);
  const [tapping, setTapping] = createSignal(false);
  const [tapError, setTapError] = createSignal<TapRefusal>();
  const pendingBefore = new Set<number>();
  let talked = false;
  createEffect(() => {
    if (props.voice.talking()) talked = true;
  });
  const refetchPending = props.listening
    ? keepFresh(
        props.client,
        ["chat"],
        () => props.client.conversation(),
        (conversation) => {
          const pending = pendingConfirmations(conversation);
          if (!talked) for (const turn of pending) pendingBefore.add(turn.id);
          setPendingHere(pending.filter((turn) => !pendingBefore.has(turn.id)));
        },
      )
    : undefined;
  const taps = confirmationTaps(props.client);
  const tap = async (answer: () => Promise<TapRefusal | undefined>) => {
    if (tapping()) return;
    setTapError(undefined);
    setTapping(true);
    setTapError(await answer());
    setTapping(false);
    void refetchPending?.();
  };

  return (
    <>
      <Show when={pendingHere().length > 0}>
        <fieldset class="voice-held">
          <legend>{t("chat.confirmation.pending")}</legend>
          <For each={pendingHere()}>
            {(turn) => (
              <div class="voice-held-actions">
                <button
                  type="button"
                  class="button-secondary button-block"
                  disabled={tapping()}
                  onClick={() => void tap(() => taps.confirm(turn.id))}
                >
                  {turn.summary}
                </button>
                <button
                  type="button"
                  class="button-quiet"
                  disabled={tapping()}
                  aria-label={t("chat.confirmation.cancelLabel", { summary: turn.summary })}
                  onClick={() => void tap(() => taps.cancel(turn.id))}
                >
                  {t("chat.confirmation.cancel")}
                </button>
              </div>
            )}
          </For>
        </fieldset>
      </Show>
      <Show when={tapError()}>
        {(refused) => (
          <p class="banner banner-warn" role="alert">
            {t(TAP_REFUSALS[refused()])}
          </p>
        )}
      </Show>
    </>
  );
}
