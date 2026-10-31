import type { ChatMessage, ChatWhere, Household } from "@mise/domain";
import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import { confirmationTaps, TAP_REFUSALS, type TapRefusal } from "./confirmations";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";
import { NeedsConnection } from "./NeedsConnection";
import { Sheet, touch } from "./Sheet";
import type { OpenVoice } from "./voice";
import { createVoiceSession } from "./voiceSession";

/**
 * "Ask Mise", in the app header: a chat with the agent from whatever screen is open, which each
 * message names, with the Week it shows (`where`). Kitchen mode covers the header, so it has none.
 * The agent needs the connection. With `voice`, the chat has a mic for a Voice Session, whose times
 * are on the `household`'s clock.
 */
export function Chat(props: {
  client: MiseClient;
  online: boolean;
  where: () => ChatWhere;
  voice?: OpenVoice;
  household?: Household | null;
}) {
  const [open, setOpen] = createSignal(false);
  const reasonId = createUniqueId();

  return (
    <>
      <div class="control">
        <button
          type="button"
          class="button-row"
          disabled={!props.online}
          aria-describedby={props.online ? undefined : reasonId}
          onClick={() => setOpen(true)}
        >
          <Icon name="chat" />
          {t("chat.action")}
        </button>
        <NeedsConnection id={reasonId} online={props.online} />
      </div>
      <Show when={open()}>
        <ChatSheet
          client={props.client}
          online={props.online}
          where={props.where}
          voice={props.voice}
          household={props.household}
          onClose={() => setOpen(false)}
        />
      </Show>
    </>
  );
}

const ERRORS = {
  load: "app.error",
  answer: "chat.unanswered",
  ...TAP_REFUSALS,
  voice: "chat.voice.failed",
  voiceInUse: "chat.voice.inUse",
  voiceSpent: "chat.voice.spent",
  voiceOff: "chat.voice.off",
  voiceEnded: "chat.voice.ended",
} as const;

/** The refusals of a start that the mic's reason would repeat. */
const VOICE_REFUSALS: ReadonlySet<keyof typeof ERRORS> = new Set(["voiceInUse", "voiceSpent", "voiceOff"]);

/**
 * The Household's shared conversation with the agent, and a message to add to it; a sheet over the
 * page. Turns others send show as the conversation changes, and a turn Mise couldn't answer says so.
 * A call the agent asked to make that waits for a person shows as a button saying what it will do,
 * large while a Voice Session runs, since only a tap runs it (ADR 0024). A Voice Session's turns show
 * as they are answered; it ends with a tap, when the sheet closes, or when the page is hidden (a
 * locked phone turns the mic off). The mic shows only where voice is available, and says before a
 * tap why it can't start: offline, someone else talking, the day's minutes spent, or voice turned off.
 */
function ChatSheet(props: {
  client: MiseClient;
  online: boolean;
  where: () => ChatWhere;
  voice?: OpenVoice;
  household?: Household | null;
  onClose: () => void;
}) {
  const titleId = createUniqueId();
  const [turns, setTurns] = createSignal<ChatMessage[]>();
  const [draft, setDraft] = createSignal("");
  const [waiting, setWaiting] = createSignal(false);
  const [error, setError] = createSignal<keyof typeof ERRORS>();
  const [tapping, setTapping] = createSignal(false);
  let log!: HTMLDivElement;
  let box!: HTMLTextAreaElement;
  let sendButton: HTMLButtonElement | undefined;

  // The newest turn, the note that Mise is thinking, or what went wrong stays in view as the conversation grows.
  createEffect(() => {
    turns();
    waiting();
    error();
    const end =
      log.querySelector('[role="alert"]') ??
      log.querySelector('[role="status"]') ??
      log.querySelector(".chat-turns > li:last-child");
    end?.scrollIntoView?.({ block: "end" });
  });

  // While a message waits for its answer, the turns shown keep it; the conversation is read again after.
  const refetch = keepFresh(
    props.client,
    ["chat"],
    () => props.client.conversation(),
    (conversation) => {
      if (!waiting()) setTurns(conversation);
    },
    () => {
      if (turns()) return;
      setTurns([]);
      setError("load");
    },
  );

  // The example, sent with a tap, leaves what's being typed in the box.
  const send = async (example?: string) => {
    const text = (example ?? draft()).trim();
    const before = turns();
    if (!text || waiting() || !before) return;
    setError(undefined);
    setWaiting(true);
    if (!example) setDraft("");
    // Shown as theirs until the conversation, which names them, is read again.
    const sent: ChatMessage[] = [...before, { role: "member", speaker: t("chat.speaker.you"), text }];
    setTurns(sent);
    let answer: ChatMessage | undefined;
    try {
      const reply = await props.client.chat(text, props.where());
      if (reply.ok) answer = reply.value;
    } catch {
      // Shown as unanswered below.
    }
    setWaiting(false);
    if (answer) {
      setTurns([...sent, answer]);
      void refetch();
      return;
    }
    // Unanswered: the message goes back in the box to send again.
    setTurns(before);
    if (!example) setDraft(text);
    setError("answer");
  };

  // A tap on a confirmation runs the call the agent asked for, which only a person can (ADR 0024), or
  // cancels it.
  const taps = confirmationTaps(props.client);
  const tap = async (answer: () => Promise<TapRefusal | undefined>) => {
    if (tapping()) return;
    setError(undefined);
    setTapping(true);
    const refused = await answer();
    setTapping(false);
    if (refused) setError(refused);
    void refetch();
  };

  const voice = createVoiceSession({
    get client() {
      return props.client;
    },
    get online() {
      return props.online;
    },
    where: () => props.where(),
    get voice() {
      return props.voice;
    },
    get household() {
      return props.household;
    },
    onStarting: () => setError(undefined),
    onRefused: setError,
  });
  const talking = voice.talking;
  const micId = createUniqueId();

  return (
    <Sheet labelledBy={titleId} class="sheet-chat" onEscape={() => props.onClose()}>
      <div class="sheet-header">
        <div class="page-heading">
          <p class="overline">{t("chat.overline")}</p>
          <h2 id={titleId} class="dish-title">
            {t("chat.title")}
          </h2>
        </div>
        <button type="button" class="icon-button" aria-label={t("chat.close")} onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </div>
      {/* Only the conversation scrolls: the close button and the message box stay in reach. */}
      <div class="sheet-body chat-log" ref={log}>
        <Show when={turns()} fallback={<p>{t("app.loading")}</p>}>
          {(shown) => (
            <Show
              when={shown().length > 0}
              fallback={
                <div class="stack">
                  <p class="body-muted">{t("chat.empty")}</p>
                  {/* The example asks itself with a tap. */}
                  <div class="chips">
                    <button
                      type="button"
                      class="chip-button"
                      disabled={waiting()}
                      onClick={() => void send(t("chat.example"))}
                    >
                      <span class="chip">{t("chat.example")}</span>
                    </button>
                  </div>
                </div>
              }
            >
              <ol class="chat-turns">
                <For each={shown()}>
                  {(turn) =>
                    turn.role === "confirmation" ? (
                      <li
                        class={`chat-turn chat-turn-confirmation chat-confirmation-${turn.status}`}
                        classList={{ "chat-confirmation-voice": talking() }}
                      >
                        <span class="chat-speaker">
                          {t(`chat.confirmation.${turn.status}`)}
                          <span class="visually-hidden">: </span>
                        </span>
                        <Show when={turn.status === "pending"} fallback={<span>{turn.summary}</span>}>
                          <div class="chat-confirmation-actions">
                            <button
                              type="button"
                              classList={{ "button-secondary button-block": talking() }}
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
                        </Show>
                      </li>
                    ) : (
                      <li class={`chat-turn chat-turn-${turn.role}`}>
                        <span class="chat-speaker">
                          {turn.role === "agent"
                            ? t("chat.speaker.agent")
                            : (turn.speaker ?? t("chat.speaker.someone"))}
                          <span class="visually-hidden">: </span>
                        </span>
                        {turn.text}
                        <Show when={turn.role === "member" && turn.unanswered}>
                          <small class="chat-unanswered">
                            <span class="visually-hidden"> (</span>
                            {t("chat.notAnswered")}
                            <span class="visually-hidden">)</span>
                          </small>
                        </Show>
                      </li>
                    )
                  }
                </For>
              </ol>
            </Show>
          )}
        </Show>
        <Show when={waiting()}>
          <p class="meta" role="status">
            {t("chat.waiting")}
          </p>
        </Show>
        <Show when={error()}>
          {(failed) => (
            <p class="banner banner-warn" role="alert">
              {failed() === "voiceInUse" && voice.speaker()
                ? t("chat.voice.talking", { name: voice.speaker() ?? "" })
                : t(ERRORS[failed()], { time: voice.minutesBackAt() })}
            </p>
          )}
        </Show>
      </div>
      <div class="chat-composer">
        <Show when={talking()}>
          <div class="chat-voice">
            <p class="meta" role="status">
              {t(voice.state() === "on" ? "chat.voice.listening" : "chat.voice.starting")}
            </p>
            <button type="button" class="button-quiet" onClick={voice.end}>
              {t("chat.voice.end")}
            </button>
          </div>
        </Show>
        <form
          class="chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            // Send hides with the message it sent; the focus it held goes back to the box, not the page,
            // except on a touch screen, where the keyboard would cover the answer.
            if (document.activeElement === sendButton && !touch()) box.focus();
            void send();
          }}
        >
          <textarea
            ref={box}
            rows={2}
            aria-label={t("chat.message")}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter starts a new line.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <Show when={!talking() && voice.micShown()}>
            <button
              type="button"
              class="icon-button chat-mic"
              aria-label={t("chat.voice.start")}
              disabled={voice.micReason() !== undefined}
              aria-describedby={voice.micReason() ? micId : undefined}
              onClick={() => void voice.start()}
            >
              <Icon name="mic" />
            </button>
          </Show>
          {/* Send shows once there's a message to send. */}
          <Show when={draft().trim()}>
            <button
              ref={sendButton}
              type="submit"
              class="icon-button chat-send"
              aria-label={t("chat.send")}
              disabled={waiting() || turns() === undefined}
            >
              <Icon name="arrowUp" />
            </button>
          </Show>
        </form>
        {/* Under the composer, not beside the mic, where it would squeeze the message box; not while
            a refused start's alert says the same. */}
        <Show when={!talking() && voice.micShown() && !VOICE_REFUSALS.has(error() ?? "load") && voice.micReason()}>
          {(reason) => (
            <p id={micId} class="control-reason">
              {reason()}
            </p>
          )}
        </Show>
        <small>{t("chat.disclaimer")}</small>
      </div>
    </Sheet>
  );
}
