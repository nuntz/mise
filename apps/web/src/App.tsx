import { type Household, type QueuedChange, RecipeId } from "@mise/domain";
import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { CalendarSettings } from "./Calendar";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { GroceryPage } from "./Grocery";
import { HouseholdSettingsForm } from "./HouseholdSettings";
import { ImportPage } from "./Import";
import { Icon, type IconName } from "./icons";
import { KitchenMode } from "./Kitchen";
import { MembersSettings } from "./MembersSettings";
import { t } from "./messages";
import { createGroceryQueue, keepGroceryLists, savedHousehold, saveHousehold } from "./offline";
import { PantryBanner, PantryPage } from "./Pantry";
import { RecipesPage } from "./Recipes";
import { ResolveIngredients } from "./ResolveIngredients";
import { SetupForm } from "./SetupForm";
import { TagRecipes } from "./TagRecipes";
import { createKitchenMode } from "./theme";
import { WeekPage } from "./Week";

/** The pages the bottom nav goes to, in its order. */
type Page = "week" | "recipes" | "grocery" | "pantry" | "household";
const NAV: { page: Page; icon: IconName }[] = [
  { page: "week", icon: "week" },
  { page: "recipes", icon: "recipes" },
  { page: "grocery", icon: "basket" },
  { page: "pantry", icon: "jar" },
];

/** The Household's settings, each a section of the Household page. */
type Setting = "members" | "settings" | "calendar" | "import" | "resolve" | "tag";
const SETTINGS: Setting[] = ["members", "settings", "calendar", "import", "resolve", "tag"];

/** The Recipe open in kitchen mode, scaled to `servings` when given. */
type KitchenRecipe = { id: RecipeId; servings?: number };

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
  const [inKitchen, setInKitchen] = createSignal<KitchenRecipe>();
  const [kitchenMode, setKitchenMode] = createKitchenMode();
  // The last Household loaded. Each refetch is reconciled in place (Members matched by id), so a
  // refresh updates the settings without remounting them and throwing away a form someone is filling in.
  const [loaded, setLoaded] = createStore<{ household: Household | null }>({ household: saved ?? null });
  const [online, setOnline] = createSignal(true);
  onCleanup(props.client.onConnection(setOnline));

  keepFresh(
    props.client,
    ["household"],
    () => props.client.call("get_household", {}),
    (result) => {
      if (result.ok) {
        setLoaded("household", reconcile(result.value));
        if (result.value) saveHousehold(result.value);
      }
      setStatus(result.ok ? "ready" : "error");
    },
    () => setStatus("error"),
  );

  const queue = createGroceryQueue(props.client);
  const [pending, setPending] = createSignal<readonly QueuedChange[]>(queue.pending());
  const [refused, setRefused] = createSignal(queue.refused().length);
  onCleanup(
    queue.subscribe(() => {
      setPending(queue.pending());
      setRefused(queue.refused().length);
    }),
  );

  const go = (to: Page) => {
    setPage(to);
    window.scrollTo?.({ top: 0 });
  };
  const cook = (id: RecipeId, servings?: number) => setInKitchen({ id, servings });

  return (
    <Switch>
      <Match when={status() === "loading"}>
        <main class="app">
          <div class="page">
            <p>{t("app.loading")}</p>
          </div>
        </main>
      </Match>
      <Match when={loaded.household}>
        {(household) => (
          <>
            <OfflineGroceryLists client={props.client} household={household()} />
            {/* Kitchen mode covers the app, which stays as it was underneath for when it's left. */}
            <Show when={inKitchen()}>
              {(recipe) => (
                <KitchenMode
                  client={props.client}
                  id={recipe().id}
                  servings={recipe().servings}
                  locale={household().locale}
                  onClose={() => setInKitchen(undefined)}
                />
              )}
            </Show>
            <div class="app" inert={inKitchen() !== undefined}>
              <Show when={!online()}>
                <div class="banner banner-amber banner-top" role="status">
                  <Icon name="wifiOff" />
                  <p>{t("offline.notice")}</p>
                </div>
              </Show>
              <main class="page">
                {/* A failed refresh keeps the last Household on screen, and any forms with it. Offline, that's expected. */}
                <Show when={status() === "error" && online()}>
                  <p class="banner banner-warn" role="alert">
                    {t("app.error")}
                  </p>
                </Show>
                <Show when={pending().length > 0}>
                  <p class="banner banner-amber" role="status">
                    {pending().length === 1
                      ? t("offline.pendingOne")
                      : t("offline.pending", { count: String(pending().length) })}
                  </p>
                </Show>
                <Show when={refused() > 0}>
                  <div class="banner banner-warn" role="alert">
                    <p>{t("offline.refused")}</p>
                    <button type="button" class="button-small" onClick={() => queue.dismissRefused()}>
                      {t("offline.dismiss")}
                    </button>
                  </div>
                </Show>
                <Show when={page() !== "pantry"}>
                  <PantryBanner client={props.client} onOpen={() => go("pantry")} />
                </Show>
                <Switch>
                  <Match when={page() === "week"}>
                    <WeekPage
                      client={props.client}
                      household={household()}
                      online={online()}
                      onHousehold={() => go("household")}
                      onGrocery={() => go("grocery")}
                      onCook={cook}
                    />
                  </Match>
                  <Match when={page() === "grocery"}>
                    <GroceryPage
                      client={props.client}
                      household={household()}
                      queue={queue}
                      pending={pending()}
                      online={online()}
                      onWeek={() => go("week")}
                    />
                  </Match>
                  <Match when={page() === "pantry"}>
                    <PantryPage client={props.client} locale={household().locale} onWeek={() => go("week")} />
                  </Match>
                  <Match when={page() === "recipes"}>
                    <RecipesPage client={props.client} online={online()} open={openRecipe} onCook={cook} />
                  </Match>
                  <Match when={page() === "household"}>
                    <HouseholdPage
                      client={props.client}
                      household={household()}
                      kitchenMode={kitchenMode()}
                      onKitchenMode={setKitchenMode}
                    />
                  </Match>
                </Switch>
              </main>
              <nav class="nav" aria-label={t("nav.label")}>
                <For each={NAV}>
                  {(item) => (
                    <button
                      type="button"
                      aria-current={page() === item.page ? "page" : undefined}
                      onClick={() => go(item.page)}
                    >
                      <Icon name={item.icon} />
                      {t(`nav.${item.page}`)}
                    </button>
                  )}
                </For>
              </nav>
            </div>
          </>
        )}
      </Match>
      <Match when={status() === "error"}>
        <main class="app">
          <div class="page">
            <p class="banner banner-warn" role="alert">
              {t("app.error")}
            </p>
          </div>
        </main>
      </Match>
      <Match when={status() === "ready"}>
        <main class="app">
          <div class="page">
            <SetupForm client={props.client} />
          </div>
        </main>
      </Match>
    </Switch>
  );
}

/** Keeps both Weeks' Grocery Lists on this device; shows nothing. */
function OfflineGroceryLists(props: { client: MiseClient; household: Household }) {
  keepGroceryLists(props.client, () => props.household);
  return null;
}

/** The Household: what it is, kitchen mode for this device, and its settings one section at a time. */
function HouseholdPage(props: {
  client: MiseClient;
  household: Household;
  kitchenMode: boolean;
  onKitchenMode: (on: boolean) => void;
}) {
  const [setting, setSetting] = createSignal<Setting>("members");

  return (
    <section class="screen">
      <header class="page-heading">
        <p class="overline">{t("household.overline")}</p>
        <h1>{t("household.title", { name: props.household.name })}</h1>
        <p class="meta">
          {t("household.summary", {
            weekday: t(`weekday.${props.household.weekStartsOn}`),
            dinnerTime: props.household.dinnerTime,
            timezone: props.household.timezone,
          })}
        </p>
        <p class="meta">
          {t("household.units", {
            units: t(`units.${props.household.units}`),
            locale: t(`locale.${props.household.locale}`),
          })}
        </p>
      </header>
      <label>
        <input
          type="checkbox"
          role="switch"
          aria-checked={props.kitchenMode}
          checked={props.kitchenMode}
          onChange={(event) => props.onKitchenMode(event.currentTarget.checked)}
        />
        {t("household.kitchenMode")}
      </label>
      <small>{t("household.kitchenModeHint")}</small>
      <nav class="chips" aria-label={t("household.settings")}>
        <For each={SETTINGS}>
          {(name) => (
            <button
              type="button"
              class="button-small"
              aria-current={setting() === name ? "page" : undefined}
              onClick={() => setSetting(name)}
            >
              {t(`nav.${name}`)}
            </button>
          )}
        </For>
      </nav>
      <Switch>
        <Match when={setting() === "members"}>
          <MembersSettings client={props.client} members={props.household.members} />
        </Match>
        <Match when={setting() === "settings"}>
          <HouseholdSettingsForm client={props.client} household={props.household} />
        </Match>
        <Match when={setting() === "calendar"}>
          <CalendarSettings client={props.client} />
        </Match>
        <Match when={setting() === "import"}>
          <ImportPage client={props.client} />
        </Match>
        <Match when={setting() === "resolve"}>
          <ResolveIngredients client={props.client} />
        </Match>
        <Match when={setting() === "tag"}>
          <TagRecipes client={props.client} />
        </Match>
      </Switch>
    </section>
  );
}
