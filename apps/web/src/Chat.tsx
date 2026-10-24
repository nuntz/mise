import type { ChatMessage } from "@mise/domain";
import { createEffect, createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import type { MiseClient } from "./client";
import { Icon } from "./icons";
import { t } from "./messages";
import { Sheet } from "./Sheet";

/**
 * "Ask Mise", in the app header: a chat with the agent from whatever screen is open. Kitchen mode
 * covers the header, so it has none. The agent needs the connection.
 */
export function Chat(props: { client: MiseClient; online: boolean }) {
  const [open, setOpen] = createSignal(false);

  return (
    <>
      <button type="button" class="button-small" disabled={!props.online} onClick={() => setOpen(true)}>
        <Icon name="chat" />
        {t("chat.action")}
      </button>
      <Show when={open()}>
        <ChatSheet client={props.client} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

/** The Household's conversation with the agent, and a message to add to it; a sheet over the page. */
function ChatSheet(props: { client: MiseClient; onClose: () => void }) {
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

  onMount(async () => {
    try {
      setTurns(await props.client.conversation());
    } catch {
      setTurns([]);
      setError("load");
    }
  });

  const send = async () => {
    const text = draft().trim();
    const before = turns();
    if (!text || waiting() || !before) return;
    setError(undefined);
    setWaiting(true);
    setDraft("");
    const sent: ChatMessage[] = [...before, { role: "member", text }];
    setTurns(sent);
    let answer: ChatMessage | undefined;
    try {
      const reply = await props.client.chat(text);
      if (reply.ok) answer = reply.value;
    } catch {
      // Shown as unanswered below.
    }
    setWaiting(false);
    if (answer) {
      setTurns([...sent, answer]);
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
                        {t(`chat.speaker.${turn.role}`)}
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
