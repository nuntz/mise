import { type CalendarToken, calendarFeedPath } from "@mise/domain";
import { createSignal, Match, Show, Switch } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { t } from "./messages";

/** Settings: the calendar feed's subscribe URL, and rotating it when it has gone too far. */
export function CalendarSettings(props: { client: MiseClient }) {
  const [token, setToken] = createSignal<CalendarToken | null>();
  const [failed, setFailed] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
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

  const rotate = async () => {
    setRotating(true);
    try {
      // Loaded again rather than shown, so an older answer still on its way can't replace it.
      if ((await props.client.call("rotate_calendar_token", {})).ok) await refetch();
      else setFailed(true);
    } catch {
      setFailed(true);
    }
    setRotating(false);
    setConfirming(false);
  };

  return (
    <section>
      <h2>{t("calendar.title")}</h2>
      <p>{t("calendar.intro")}</p>
      <Show when={failed()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
      <Switch>
        <Match when={token()}>
          {(current) => (
            <>
              <label>
                {t("calendar.url")}
                <input readOnly value={`${window.location.origin}${calendarFeedPath(current().token)}`} />
              </label>
              <p>
                <a href={`webcal://${window.location.host}${calendarFeedPath(current().token)}`}>
                  {t("calendar.subscribe")}
                </a>
              </p>
              <p>{t("calendar.secret")}</p>
              <Show
                when={confirming()}
                fallback={
                  <button type="button" onClick={() => setConfirming(true)}>
                    {t("calendar.rotate")}
                  </button>
                }
              >
                <p role="alert">{t("calendar.rotateWarning")}</p>
                <button type="button" disabled={rotating()} onClick={rotate}>
                  {t("calendar.rotateConfirm")}
                </button>
                <button type="button" disabled={rotating()} onClick={() => setConfirming(false)}>
                  {t("calendar.cancel")}
                </button>
              </Show>
            </>
          )}
        </Match>
        <Match when={token() === null}>
          <button type="button" disabled={rotating()} onClick={rotate}>
            {t("calendar.create")}
          </button>
        </Match>
      </Switch>
    </section>
  );
}
