import type { Household } from "@mise/domain";
import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MiseClient } from "./client";
import { GroceryPage } from "./Grocery";
import { ImportPage } from "./Import";
import { MembersSettings } from "./MembersSettings";
import { t } from "./messages";
import { PantryBanner, PantryPage } from "./Pantry";
import { RecipesPage } from "./Recipes";
import { ResolveIngredients } from "./ResolveIngredients";
import { SetupForm } from "./SetupForm";
import { TagRecipes } from "./TagRecipes";
import { WeekPage } from "./Week";

type Page = "week" | "grocery" | "pantry" | "recipes" | "import" | "resolve" | "tag" | "members";
const PAGES: Page[] = ["week", "grocery", "pantry", "recipes", "import", "resolve", "tag", "members"];

export function App(props: { client: MiseClient }) {
  const [status, setStatus] = createSignal<"loading" | "error" | "ready">("loading");
  const [page, setPage] = createSignal<Page>("week");
  // The last Household loaded. Each refetch is reconciled in place (Members matched by id), so a
  // refresh updates the settings without remounting them and throwing away a form someone is filling in.
  const [loaded, setLoaded] = createStore<{ household: Household | null }>({ household: null });

  const refetch = async () => {
    try {
      const result = await props.client.call("get_household", {});
      if (result.ok) setLoaded("household", reconcile(result.value));
      setStatus(result.ok ? "ready" : "error");
    } catch {
      setStatus("error");
    }
  };
  onCleanup(props.client.subscribe("household", refetch));

  return (
    <main>
      <h1>{t("app.name")}</h1>
      <Switch>
        <Match when={status() === "loading"}>
          <p>{t("app.loading")}</p>
        </Match>
        <Match when={loaded.household}>
          {(household) => (
            <>
              {/* A failed refresh keeps the last Household on screen, and any forms with it. */}
              <Show when={status() === "error"}>
                <p role="alert">{t("app.error")}</p>
              </Show>
              <HouseholdSummary household={household()} />
              <PantryBanner client={props.client} onOpen={() => setPage("pantry")} />
              <nav>
                <For each={PAGES}>
                  {(name) => (
                    <button type="button" aria-pressed={page() === name} onClick={() => setPage(name)}>
                      {t(`nav.${name}`)}
                    </button>
                  )}
                </For>
              </nav>
              <Switch>
                <Match when={page() === "week"}>
                  <WeekPage client={props.client} household={household()} />
                </Match>
                <Match when={page() === "grocery"}>
                  <GroceryPage client={props.client} household={household()} />
                </Match>
                <Match when={page() === "pantry"}>
                  <PantryPage client={props.client} locale={household().locale} />
                </Match>
                <Match when={page() === "recipes"}>
                  <RecipesPage client={props.client} />
                </Match>
                <Match when={page() === "import"}>
                  <ImportPage client={props.client} />
                </Match>
                <Match when={page() === "resolve"}>
                  <ResolveIngredients client={props.client} />
                </Match>
                <Match when={page() === "tag"}>
                  <TagRecipes client={props.client} />
                </Match>
                <Match when={page() === "members"}>
                  <MembersSettings client={props.client} members={household().members} />
                </Match>
              </Switch>
            </>
          )}
        </Match>
        <Match when={status() === "error"}>
          <p role="alert">{t("app.error")}</p>
        </Match>
        <Match when={status() === "ready"}>
          <SetupForm client={props.client} />
        </Match>
      </Switch>
    </main>
  );
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
