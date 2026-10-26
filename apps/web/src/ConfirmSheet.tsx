import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { t } from "./messages";
import { Sheet } from "./Sheet";

/** What a confirm sheet asks: its title, one sentence saying what's lost, and the action's name. */
export type ConfirmQuestion = { title: string; lost: string; action: string };

/**
 * Mise's own confirmation, in place of the browser's OK/Cancel: `ask` opens the sheet and resolves
 * to whether the action was confirmed. Cancel and Escape resolve to false, as does the asker
 * going away while the sheet is open. The caller renders `ConfirmSheet` where the sheet belongs.
 */
export function createConfirm() {
  const [asking, setAsking] = createSignal<{ question: ConfirmQuestion; answer: (confirmed: boolean) => void }>();

  const ask = (question: ConfirmQuestion) =>
    new Promise<boolean>((resolve) =>
      setAsking({
        question,
        answer: (confirmed) => {
          setAsking(undefined);
          resolve(confirmed);
        },
      }),
    );
  onCleanup(() => asking()?.answer(false));

  const ConfirmSheet = () => {
    const titleId = createUniqueId();
    return (
      <Show when={asking()}>
        {(open) => (
          <Sheet labelledBy={titleId} onEscape={() => open().answer(false)} focusField={false}>
            <div class="sheet-header">
              <div class="page-heading">
                <h2 id={titleId} class="dish-title">
                  {open().question.title}
                </h2>
              </div>
            </div>
            <div class="sheet-body">
              <p>{open().question.lost}</p>
              <button type="button" class="button-danger" onClick={() => open().answer(true)}>
                {open().question.action}
              </button>
              <button type="button" class="button-quiet" onClick={() => open().answer(false)}>
                {t("confirm.cancel")}
              </button>
            </div>
          </Sheet>
        )}
      </Show>
    );
  };

  return { ask, ConfirmSheet };
}
