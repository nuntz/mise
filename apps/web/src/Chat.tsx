import type { ChatMessage, ChatWhere, ToolResult } from "@mise/domain";
import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";
import { NeedsConnection } from "./NeedsConnection";
import { Sheet } from "./Sheet";

/**
 * "Ask Mise", in the app header: a chat with the agent from whatever screen is open, which each
 * message names, with the Week it shows (`where`). Kitchen mode covers the header, so it has none.
 * The agent needs the connection.
 */
export function Chat(props: { client: MiseClient; online: boolean; where: () => ChatWhere }) {
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
        <ChatSheet client={props.client} where={props.where} onClose={() => setOpen(false)} />
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
} as const;

/** Why a tap on a confirmation was refused: what it describes changed, or someone already tapped it. */
const TAP_ERRORS: Partial<Record<string, "changed" | "answered">> = { expired: "changed", not_found: "answered" };

/**
 * The Household's shared conversation with the agent, and a message to add to it; a sheet over the
 * page. Turns others send show as the conversation changes. A call the agent asked to make that waits
 * for a person shows as a button saying what it will do.
 */
function ChatSheet(props: { client: MiseClient; where: () => ChatWhere; onClose: () => void }) {
  const titleId = createUniqueId();
  const [turns, setTurns] = createSignal<ChatMessage[]>();
  const [draft, setDraft] = createSignal("");
  const [waiting, setWaiting] = createSignal(false);
  const [error, setError] = createSignal<"load" | "answer" | "changed" | "answered" | "unconfirmed">();
  const [tapping, setTapping] = createSignal(false);
  let log!: HTMLDivElement;

  // The newest turn, or the note that Mise is thinking, stays in view as the conversation grows.
  createEffect(() => {
    turns();
    waiting();
    const end = log.querySelector('[role="status"]') ?? log.querySelector(".chat-turns > li:last-child");
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

  return (
    // On a touch screen a focused field brings up the keyboard, which covers the conversation it
    // opened to read: the field waits for a tap there.
    <Sheet
      labelledBy={titleId}
      class="sheet-chat"
      focusField={!window.matchMedia?.("(pointer: coarse)").matches}
      onEscape={() => props.onClose()}
    >
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
              {t(ERRORS[failed()])}
            </p>
          )}
        </Show>
      </div>
      <div class="chat-composer">
        <form
          class="chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
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
          {/* Send shows once there's a message to send. */}
          <Show when={draft().trim()}>
            <button
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
