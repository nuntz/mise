import { type CalendarToken, calendarFeedPath } from "@mise/domain";
import { createSignal, Match, Show, Switch } from "solid-js";
import { createConfirm } from "./ConfirmSheet";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { t } from "./messages";

/** Settings: the calendar feed's subscribe URL, and rotating it when it has gone too far. */
export function CalendarSettings(props: { client: MiseClient }) {
  const [token, setToken] = createSignal<CalendarToken | null>();
  const [failed, setFailed] = createSignal(false);
  const [rotating, setRotating] = createSignal(false);

  // Another device rotating the token announces it as a household change.
  const refetch = keepFresh(
    props.client,
    ["household"],
    () => props.client.call("get_calendar_token", {}),
    (result) => {
      if (result.ok) setToken(result.value);
      setFailed(!result.ok);
    },
    () => setFailed(true),
  );

  const confirm = createConfirm();
  const rotate = async () => {
    const confirmed = await confirm.ask({
      title: t("calendar.rotateTitle"),
      lost: t("calendar.rotateWarning"),
      action: t("calendar.rotateConfirm"),
    });
    if (confirmed) await replaceToken();
  };

  const replaceToken = async () => {
    setRotating(true);
    try {
      // Loaded again rather than shown, so an older answer still on its way can't replace it.
      if ((await props.client.call("rotate_calendar_token", {})).ok) await refetch();
      else setFailed(true);
    } catch {
      setFailed(true);
    }
    setRotating(false);
  };

  return (
    <section>
      <h2>{t("calendar.title")}</h2>
      <p>{t("calendar.intro")}</p>
      <Show when={failed()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      <Switch>
        <Match when={token()}>
          {(current) => (
            <>
              <label>
                {t("calendar.url")}
                <input readOnly value={`${window.location.origin}${calendarFeedPath(current().token)}`} />
              </label>
              <p>{t("calendar.secret")}</p>
              <a
                class="button button-primary"
                href={`webcal://${window.location.host}${calendarFeedPath(current().token)}`}
              >
                {t("calendar.subscribe")}
              </a>
              <button type="button" disabled={rotating()} onClick={rotate}>
                {t("calendar.rotate")}
              </button>
            </>
          )}
        </Match>
        <Match when={token() === null}>
          <button type="button" class="button-primary" disabled={rotating()} onClick={replaceToken}>
            {t("calendar.create")}
          </button>
        </Match>
      </Switch>
      <confirm.ConfirmSheet />
    </section>
  );
}
