import type { ChatMessage, ChatWhere, ToolResult } from "@mise/domain";
import { createEffect, createSignal, createUniqueId, For, on, onCleanup, onMount, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";
import { NeedsConnection } from "./NeedsConnection";
import { Sheet, touch } from "./Sheet";
import type { OpenVoice, VoiceCall } from "./voice";

/**
 * "Ask Mise", in the app header: a chat with the agent from whatever screen is open, which each
 * message names, with the Week it shows (`where`). Kitchen mode covers the header, so it has none.
 * The agent needs the connection. With `voice`, the chat has a mic for a Voice Session.
 */
export function Chat(props: { client: MiseClient; online: boolean; where: () => ChatWhere; voice?: OpenVoice }) {
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
        <ChatSheet client={props.client} where={props.where} voice={props.voice} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

const ERRORS = {
  load: "app.error",
  answer: "chat.unanswered",
  changed: "chat.confirmation.changed",
  answered: "chat.confirmation.answered",
  unconfirmed: "chat.confirmation.failed",
  voice: "chat.voice.failed",
  voiceInUse: "chat.voice.inUse",
  voiceSpent: "chat.voice.spent",
  voiceOff: "chat.voice.off",
} as const;

/** Why a tap on a confirmation was refused: what it describes changed, or someone already tapped it. */
const TAP_ERRORS: Partial<Record<string, "changed" | "answered">> = { expired: "changed", not_found: "answered" };

/**
 * The Household's shared conversation with the agent, and a message to add to it; a sheet over the
 * page. Turns others send show as the conversation changes. A call the agent asked to make that waits
 * for a person shows as a button saying what it will do. A Voice Session's turns show as they are
 * answered; it ends with a tap, when the sheet closes, or when the page is hidden (a locked phone
 * turns the mic off).
 */
function ChatSheet(props: { client: MiseClient; where: () => ChatWhere; voice?: OpenVoice; onClose: () => void }) {
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
  const tap = async (answer: () => Promise<ToolResult<unknown>>) => {
    if (tapping()) return;
    setError(undefined);
    setTapping(true);
    let result: ToolResult<unknown> | undefined;
    try {
      result = await answer();
    } catch {
      // Shown as not gone through below.
    }
    setTapping(false);
    if (!result?.ok) setError(TAP_ERRORS[result?.error.code ?? ""] ?? "unconfirmed");
    void refetch();
  };

  const [voice, setVoice] = createSignal<"off" | "starting" | "on">("off");
  /** When the day's voice minutes come back, after a start refused because they were spent. */
  const [voiceBack, setVoiceBack] = createSignal("");
  // The call running, and which start is current: one ended, or the sheet closed, while a start
  // waits makes that start hang up when it resumes.
  let call: VoiceCall | undefined;
  let attempt = 0;
  // The household closes the session first, so it ends as asked rather than as a dropped call.
  const hangUp = (ending: VoiceCall) =>
    void props.client
      .endVoice()
      .catch(() => {})
      .finally(() => ending.hangUp());

  const startVoice = async () => {
    const dial = props.voice;
    if (!dial || voice() !== "off") return;
    const mine = ++attempt;
    const current = () => mine === attempt;
    setError(undefined);
    setVoice("starting");
    // The call to end if the start goes no further: the household may hold its session by then.
    let opened: VoiceCall | undefined;
    let refusal: "voice" | "voiceInUse" | "voiceSpent" | "voiceOff" = "voice";
    try {
      opened = await dial();
      const reply = current() ? await props.client.startVoice(opened.offer, props.where()) : undefined;
      if (reply && !reply.ok) {
        // Refused, so there is no session to end: only the mic to let go of.
        opened.hangUp();
        opened = undefined;
        if (reply.error.code === "in_use") refusal = "voiceInUse";
        if (reply.error.code === "off") refusal = "voiceOff";
        if (reply.error.code === "spent") {
          refusal = "voiceSpent";
          setVoiceBack(new Date(reply.error.until).toLocaleTimeString(undefined, { timeStyle: "short" }));
        }
        throw new Error(reply.error.message);
      }
      if (reply && current()) await opened.connect(reply.value.sdp);
    } catch {
      // The mic was refused, the browser has no WebRTC, or the household refused or didn't answer.
      if (opened) hangUp(opened);
      if (current()) {
        setVoice("off");
        setError(refusal);
      }
      return;
    }
    if (!current()) return hangUp(opened);
    call = opened;
    opened.onEnd(() => {
      if (call !== opened) return;
      call = undefined;
      setVoice("off");
    });
    setVoice("on");
  };

  const endVoice = () => {
    attempt++;
    const ending = call;
    call = undefined;
    setVoice("off");
    if (ending) hangUp(ending);
  };

  // Each turn is heard from where the person is when they say it, so a session follows them.
  createEffect(
    on(
      props.where,
      (where) => {
        if (voice() !== "off") void props.client.moveVoice(where).catch(() => {});
      },
      { defer: true },
    ),
  );

  const onHidden = () => {
    if (document.visibilityState === "hidden") endVoice();
  };
  onMount(() => document.addEventListener("visibilitychange", onHidden));
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onHidden);
    endVoice();
  });

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
                      <li class={`chat-turn chat-turn-confirmation chat-confirmation-${turn.status}`}>
                        <span class="chat-speaker">
                          {t(`chat.confirmation.${turn.status}`)}
                          <span class="visually-hidden">: </span>
                        </span>
                        <Show when={turn.status === "pending"} fallback={<span>{turn.summary}</span>}>
                          <div class="chat-confirmation-actions">
                            <button
                              type="button"
                              disabled={tapping()}
                              onClick={() => void tap(() => props.client.confirm(turn.id))}
                            >
                              {turn.summary}
                            </button>
                            <button
                              type="button"
                              class="button-quiet"
                              disabled={tapping()}
                              aria-label={t("chat.confirmation.cancelLabel", { summary: turn.summary })}
                              onClick={() => void tap(() => props.client.call("cancel_confirmation", { id: turn.id }))}
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
              {t(ERRORS[failed()], { time: voiceBack() })}
            </p>
          )}
        </Show>
      </div>
      <div class="chat-composer">
        <Show when={voice() !== "off"}>
          <div class="chat-voice">
            <p class="meta" role="status">
              {t(voice() === "on" ? "chat.voice.listening" : "chat.voice.starting")}
            </p>
            <button type="button" class="button-quiet" onClick={endVoice}>
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
          <Show when={props.voice && voice() === "off"}>
            <button
              type="button"
              class="icon-button chat-mic"
              aria-label={t("chat.voice.start")}
              onClick={() => void startVoice()}
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
        <small>{t("chat.disclaimer")}</small>
      </div>
    </Sheet>
  );
}
