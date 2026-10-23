import { type Household, type QueuedChange, RecipeId } from "@mise/domain";
import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { CalendarSettings } from "./Calendar";
import type { MiseClient } from "./client";
import { GroceryPage } from "./Grocery";
import { ImportPage } from "./Import";
import { MembersSettings } from "./MembersSettings";
import { t } from "./messages";
import { createGroceryQueue, keepGroceryLists, savedHousehold, saveHousehold } from "./offline";
import { PantryBanner, PantryPage } from "./Pantry";
import { RecipesPage } from "./Recipes";
import { ResolveIngredients } from "./ResolveIngredients";
import { SetupForm } from "./SetupForm";
import { TagRecipes } from "./TagRecipes";
import { WeekPage } from "./Week";

type Page = "week" | "grocery" | "pantry" | "recipes" | "import" | "resolve" | "tag" | "members" | "calendar";
const PAGES: Page[] = ["week", "grocery", "pantry", "recipes", "import", "resolve", "tag", "members", "calendar"];

/**
 * The Recipe a link asks to open (`/?recipe=<id>`, as calendar events give), if any. The query is
 * dropped once read, so the address doesn't keep reopening it.
 */
function recipeFromLink(): RecipeId | undefined {
  const params = new URLSearchParams(window.location.search);
  const id = RecipeId.safeParse(Number(params.get("recipe")));
  if (!params.has("recipe")) return undefined;
  params.delete("recipe");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  return id.success ? id.data : undefined;
}

export function App(props: { client: MiseClient }) {
  // The Household saved on this device, if any, shows at once: the household may be out of reach.
  const saved = savedHousehold();
  const [status, setStatus] = createSignal<"loading" | "error" | "ready">(saved ? "ready" : "loading");
  const openRecipe = recipeFromLink();
  const [page, setPage] = createSignal<Page>(openRecipe ? "recipes" : "week");
  // The last Household loaded. Each refetch is reconciled in place (Members matched by id), so a
  // refresh updates the settings without remounting them and throwing away a form someone is filling in.
  const [loaded, setLoaded] = createStore<{ household: Household | null }>({ household: saved ?? null });
  const [online, setOnline] = createSignal(true);
  onCleanup(props.client.onConnection(setOnline));

  const refetch = async () => {
    try {
      const result = await props.client.call("get_household", {});
      if (result.ok) {
        setLoaded("household", reconcile(result.value));
        if (result.value) saveHousehold(result.value);
      }
      setStatus(result.ok ? "ready" : "error");
    } catch {
      setStatus("error");
    }
  };
  onCleanup(props.client.subscribe("household", refetch));

  const queue = createGroceryQueue(props.client);
  const [pending, setPending] = createSignal<readonly QueuedChange[]>(queue.pending());
  const [refused, setRefused] = createSignal(queue.refused().length);
  onCleanup(
    queue.subscribe(() => {
      setPending(queue.pending());
      setRefused(queue.refused().length);
    }),
  );

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
              <OfflineGroceryLists client={props.client} household={household()} />
              {/* A failed refresh keeps the last Household on screen, and any forms with it. Offline, that's expected. */}
              <Show when={status() === "error" && online()}>
                <p role="alert">{t("app.error")}</p>
              </Show>
              <Show when={!online()}>
                <p role="status">{t("offline.notice")}</p>
              </Show>
              <Show when={pending().length > 0}>
                <p role="status">
                  {pending().length === 1
                    ? t("offline.pendingOne")
                    : t("offline.pending", { count: String(pending().length) })}
                </p>
              </Show>
              <Show when={refused() > 0}>
                <p role="alert">
                  {t("offline.refused")}{" "}
                  <button type="button" onClick={() => queue.dismissRefused()}>
                    {t("offline.dismiss")}
                  </button>
                </p>
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
                  <GroceryPage
                    client={props.client}
                    household={household()}
                    queue={queue}
                    pending={pending()}
                    online={online()}
                  />
                </Match>
                <Match when={page() === "pantry"}>
                  <PantryPage client={props.client} locale={household().locale} />
                </Match>
                <Match when={page() === "recipes"}>
                  <RecipesPage client={props.client} open={openRecipe} />
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
                <Match when={page() === "calendar"}>
                  <CalendarSettings client={props.client} />
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

/** Keeps both Weeks' Grocery Lists on this device; shows nothing. */
function OfflineGroceryLists(props: { client: MiseClient; household: Household }) {
  keepGroceryLists(props.client, () => props.household);
  return null;
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
