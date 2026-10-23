import { type CalendarToken, calendarFeedPath } from "@mise/domain";
import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import type { MiseClient } from "./client";
import { t } from "./messages";

/** Settings: the calendar feed's subscribe URL, and rotating it when it has gone too far. */
export function CalendarSettings(props: { client: MiseClient }) {
  const [token, setToken] = createSignal<CalendarToken | null>();
  const [failed, setFailed] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [rotating, setRotating] = createSignal(false);

  /** Shows the token a call returns, or that it failed. */
  const load = async (tool: "get_calendar_token" | "rotate_calendar_token") => {
    try {
      const result = await props.client.call(tool, {});
      if (result.ok) setToken(result.value);
      setFailed(!result.ok);
    } catch {
      setFailed(true);
    }
  };
  const refetch = () => load("get_calendar_token");
  // Another device rotating the token announces it as a household change.
  onCleanup(props.client.subscribe("household", refetch));
  void refetch();

  const rotate = async () => {
    setRotating(true);
    await load("rotate_calendar_token");
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
