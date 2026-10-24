import type { ChatMessage, ChatWhere } from "@mise/domain";
import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";
import { Sheet } from "./Sheet";

/**
 * "Ask Mise", in the app header: a chat with the agent from whatever screen is open, which each
 * message names, with the Week it shows (`where`). Kitchen mode covers the header, so it has none.
 * The agent needs the connection.
 */
export function Chat(props: { client: MiseClient; online: boolean; where: () => ChatWhere }) {
  const [open, setOpen] = createSignal(false);

  return (
    <>
      <button type="button" class="button-small" disabled={!props.online} onClick={() => setOpen(true)}>
        <Icon name="chat" />
        {t("chat.action")}
      </button>
      <Show when={open()}>
        <ChatSheet client={props.client} where={props.where} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

/**
 * The Household's shared conversation with the agent, and a message to add to it; a sheet over the
 * page. Turns others send show as the conversation changes.
 */
function ChatSheet(props: { client: MiseClient; where: () => ChatWhere; onClose: () => void }) {
  const titleId = createUniqueId();
  const [turns, setTurns] = createSignal<ChatMessage[]>();
  const [draft, setDraft] = createSignal("");
  const [waiting, setWaiting] = createSignal(false);
  const [error, setError] = createSignal<"load" | "answer">();
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

  const send = async () => {
    const text = draft().trim();
    const before = turns();
    if (!text || waiting() || !before) return;
    setError(undefined);
    setWaiting(true);
    setDraft("");
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
    setDraft(text);
    setError("answer");
  };

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
            <Show when={shown().length > 0} fallback={<p class="body-muted">{t("chat.empty")}</p>}>
              <ol class="chat-turns">
                <For each={shown()}>
                  {(turn) => (
                    <li class={`chat-turn chat-turn-${turn.role}`}>
                      <span class="chat-speaker">
                        {turn.role === "agent" ? t("chat.speaker.agent") : (turn.speaker ?? t("chat.speaker.someone"))}
                        <span class="visually-hidden">: </span>
                      </span>
                      {turn.text}
                    </li>
                  )}
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
              {t(failed() === "load" ? "app.error" : "chat.unanswered")}
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
          <label>
            {t("chat.message")}
            <textarea
              rows={2}
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
          </label>
          <button type="submit" disabled={waiting() || turns() === undefined || !draft().trim()}>
            {t("chat.send")}
          </button>
        </form>
        <small>{t("chat.disclaimer")}</small>
      </div>
    </Sheet>
  );
}
