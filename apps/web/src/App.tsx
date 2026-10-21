import type { Household } from "@mise/domain";
import { createSignal, Match, onCleanup, Switch } from "solid-js";
import type { MiseClient } from "./client";
import { t } from "./messages";
import { SetupForm } from "./SetupForm";

type Loaded = { status: "loading" } | { status: "error" } | { status: "ready"; household: Household | null };

export function App(props: { client: MiseClient }) {
  const [state, setState] = createSignal<Loaded>({ status: "loading" });

  const refetch = async () => {
    try {
      const result = await props.client.call("get_household", {});
      setState(result.ok ? { status: "ready", household: result.value } : { status: "error" });
    } catch {
      setState({ status: "error" });
    }
  };
  onCleanup(props.client.subscribe("household", refetch));

  return (
    <main>
      <h1>{t("app.name")}</h1>
      <Switch>
        <Match when={state().status === "loading"}>
          <p>{t("app.loading")}</p>
        </Match>
        <Match when={state().status === "error"}>
          <p role="alert">{t("app.error")}</p>
        </Match>
        <Match when={readyHousehold(state())} keyed>
          {(household) => <HouseholdSummary household={household} />}
        </Match>
        <Match when={state().status === "ready"}>
          <SetupForm client={props.client} />
        </Match>
      </Switch>
    </main>
  );
}

function readyHousehold(state: Loaded): Household | undefined {
  return state.status === "ready" ? (state.household ?? undefined) : undefined;
}

function HouseholdSummary(props: { household: Household }) {
  return (
    <section>
      <h2>{t("household.title", { name: props.household.name })}</h2>
      <p>
        {t("household.summary", {
          weekday: t(`weekday.${props.household.weekStartsOn}`),
          dinnerTime: props.household.dinnerTime,
          timezone: props.household.timezone,
        })}
      </p>
      <p>
        {t("household.units", {
          units: t(`units.${props.household.units}`),
          locale: t(`locale.${props.household.locale}`),
        })}
      </p>
    </section>
  );
}
