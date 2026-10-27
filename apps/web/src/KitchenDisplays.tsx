import type { KitchenDisplay, NewKitchenDisplay } from "@mise/domain";
import { createSignal, For, Show } from "solid-js";
import { createConfirm } from "./ConfirmSheet";
import type { MiseClient } from "./client";
import { whenText } from "./dates";
import { keepFresh } from "./fresh";
import { t } from "./messages";

/**
 * Settings: the Kitchen Displays paired to the Household (ADR 0027). Pairing one shows its token
 * once, to copy into the display; revoking one refuses its next request.
 */
export function KitchenDisplaySettings(props: { client: MiseClient }) {
  const [displays, setDisplays] = createSignal<KitchenDisplay[]>();
  const [failed, setFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [label, setLabel] = createSignal("");
  // Only the answer to this screen's own pairing: the token is never read back.
  const [added, setAdded] = createSignal<NewKitchenDisplay>();

  // Another device pairing or revoking one announces it as a household change.
  const refetch = keepFresh(
    props.client,
    ["household"],
    () => props.client.call("list_kitchen_displays", {}),
    (result) => {
      if (result.ok) setDisplays(result.value);
      setFailed(!result.ok);
    },
    () => setFailed(true),
  );

  /** Runs a change, then loads the list again rather than patching it, as the Calendar link does. */
  const change = async (run: () => Promise<boolean>) => {
    setBusy(true);
    try {
      if (await run()) await refetch();
      else setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };

  const pair = (event: SubmitEvent) => {
    event.preventDefault();
    const submitted = label();
    void change(async () => {
      const result = await props.client.call("add_kitchen_display", { label: submitted });
      if (!result.ok) return false;
      setAdded(result.value);
      // Only the name it was paired with: one typed since is the next display's.
      if (label() === submitted) setLabel("");
      return true;
    });
  };

  const confirm = createConfirm();
  const revoke = async (display: KitchenDisplay) => {
    const confirmed = await confirm.ask({
      title: t("kitchenDisplays.revokeTitle", { label: display.label }),
      lost: t("kitchenDisplays.revokeWarning"),
      action: t("kitchenDisplays.revokeConfirm"),
    });
    if (!confirmed) return;
    await change(async () => (await props.client.call("revoke_kitchen_display", { id: display.id })).ok);
  };

  return (
    <section>
      <h2>{t("kitchenDisplays.title")}</h2>
      <p>{t("kitchenDisplays.intro")}</p>
      <Show when={failed()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      <Show when={added()}>
        {(display) => (
          <div class="stack">
            <label>
              {t("kitchenDisplays.token")}
              <input readOnly value={display().token} />
            </label>
            <p>{t("kitchenDisplays.tokenOnce")}</p>
            <button type="button" onClick={() => setAdded(undefined)}>
              {t("kitchenDisplays.done")}
            </button>
          </div>
        )}
      </Show>
      <Show when={displays()}>
        {(shown) => (
          <Show when={shown().length > 0} fallback={<p>{t("kitchenDisplays.none")}</p>}>
            <ul class="rows">
              <For each={shown()}>
                {(display) => (
                  <li class="row">
                    <div class="row-body">
                      <span class="row-title">{display.label}</span>
                      <span class="row-meta">
                        {display.lastUsedAt
                          ? t("kitchenDisplays.lastUsed", { when: whenText(display.lastUsedAt) })
                          : t("kitchenDisplays.unused")}
                      </span>
                    </div>
                    <div class="row-end">
                      <button
                        type="button"
                        class="button-row"
                        aria-label={t("kitchenDisplays.revokeLabel", { label: display.label })}
                        disabled={busy()}
                        onClick={() => revoke(display)}
                      >
                        {t("kitchenDisplays.revoke")}
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
      <form class="stack" onSubmit={pair}>
        <label>
          {t("kitchenDisplays.label")}
          <input
            required
            maxLength={60}
            value={label()}
            placeholder={t("kitchenDisplays.labelPlaceholder")}
            onInput={(event) => setLabel(event.currentTarget.value)}
          />
        </label>
        <button type="submit" class="button-primary" disabled={busy()}>
          {t("kitchenDisplays.pair")}
        </button>
      </form>
      <confirm.ConfirmSheet />
    </section>
  );
}
