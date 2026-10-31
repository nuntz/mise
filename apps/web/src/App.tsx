import { type ChatWhere, type Household, type LocalDate, type QueuedChange, RecipeId } from "@mise/domain";
import {
  createComputed,
  createEffect,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  type Signal,
  Switch,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { CalendarSettings } from "./Calendar";
import { Chat } from "./Chat";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { GroceryPage } from "./Grocery";
import { HouseholdSettingsForm } from "./HouseholdSettings";
import { createHouseholdStatus, type StatusChip, type StatusChips } from "./householdStatus";
import { IMPORT_METHODS, type ImportMethod, ImportPage } from "./Import";
import { ItemsSettings } from "./Items";
import { Icon, type IconName } from "./icons";
import { KitchenMode } from "./Kitchen";
import { KitchenDisplaySettings } from "./KitchenDisplays";
import { MembersSettings } from "./MembersSettings";
import { setLocale, t } from "./messages";
import { NotificationSettings } from "./Notifications";
import { createGroceryQueue, keepGroceryLists, keepPlannedRecipes, savedHousehold, saveHousehold } from "./offline";
import { PantryBanner, PantryPage } from "./Pantry";
import { createPushedPages } from "./pushed";
import { RanOut } from "./RanOut";
import { RecipesPage } from "./Recipes";
import { ResolveIngredients } from "./ResolveIngredients";
import { ReviewPage } from "./Review";
import { SetupForm } from "./SetupForm";
import { SwitchRow } from "./SwitchRow";
import { TagRecipes } from "./TagRecipes";
import { createKitchenMode } from "./theme";
import { UpdateBanner } from "./Update";
import type { OpenVoice } from "./voice";
import { WeekPage } from "./Week";

/** The pages the bottom nav goes to, in its order. */
type Page = "week" | "recipes" | "grocery" | "pantry" | "household";
const NAV: { page: Page; icon: IconName }[] = [
  { page: "week", icon: "week" },
  { page: "recipes", icon: "recipes" },
  { page: "grocery", icon: "basket" },
  { page: "pantry", icon: "jar" },
  { page: "household", icon: "people" },
];

/** The Household's settings, each a section the Household page opens. */
type Setting =
  | "members"
  | "settings"
  | "calendar"
  | "displays"
  | "notifications"
  | "review"
  | "import"
  | "resolve"
  | "items"
  | "tag";
/** A page the Household page pushes: a setting, or a way to import pushed over Import. */
type HouseholdPushed = Setting | `import-${ImportMethod}`;
/** The way to import a pushed page opens, if it's one. */
const importMethod = (page: HouseholdPushed) => IMPORT_METHODS.find((method) => page === `import-${method}`);
/** The setting a pushed page belongs to. */
const settingOf = (page: HouseholdPushed): Setting => (importMethod(page) ? "import" : (page as Setting));
/** The Household page's rows, in their groups. */
const SETTING_GROUPS: { group: "people" | "planning" | "recipes"; settings: Setting[] }[] = [
  { group: "people", settings: ["members"] },
  { group: "planning", settings: ["settings", "calendar", "displays", "notifications"] },
  { group: "recipes", settings: ["review", "import", "resolve", "items", "tag"] },
];

/** A Household row's chip, drawn in its status colour. */
const CHIP_CLASS = {
  plain: "chip",
  leaf: "chip chip-leaf",
  amber: "chip chip-amber",
} satisfies Record<NonNullable<StatusChip["tone"]> | "plain", string>;

/** The Recipe open in kitchen mode, scaled to `servings` when given. */
type KitchenRecipe = { id: RecipeId; servings?: number };

/**
 * What a link opens: a Recipe, next Week, the pantry check, or one of the Household's settings.
 * Calendar events and notifications link here, and a Recipe's Unresolved lines link to Resolve
 * Ingredients at their group (`at`).
 */
type Opening =
  | { page: "recipes"; recipe: RecipeId }
  | { page: "week"; next: true }
  | { page: "pantry" }
  | { page: "household"; setting: Setting; at?: string };

/** The query each link is made of. */
const LINK_PARAMS = ["recipe", "review", "week", "pantry"];

/**
 * What a link asks to open, if anything: a Recipe (`/?recipe=<id>`, as calendar events give), the
 * Review screen (`/?review`, as the share page gives), next Week (`/?week=next`) or the pantry check
 * (`/?pantry`), as notifications give. The query is dropped once read, so the address doesn't keep
 * reopening it.
 */
function openFromLink(): Opening | undefined {
  const params = new URLSearchParams(window.location.search);
  if (!LINK_PARAMS.some((param) => params.has(param))) return undefined;
  const id = RecipeId.safeParse(Number(params.get("recipe")));
  const opening: Opening | undefined = params.has("recipe")
    ? id.success
      ? { page: "recipes", recipe: id.data }
      : undefined
    : params.has("review")
      ? { page: "household", setting: "review" }
      : params.has("pantry")
        ? { page: "pantry" }
        : params.get("week") === "next"
          ? { page: "week", next: true }
          : undefined;
  for (const param of LINK_PARAMS) params.delete(param);
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  return opening;
}

/** `voice` is the browser's WebRTC for Voice Sessions; without it, the chat has no mic. */
export function App(props: { client: MiseClient; voice?: OpenVoice }) {
  // The Household saved on this device, if any, shows at once: the household may be out of reach.
  const saved = savedHousehold();
  const [status, setStatus] = createSignal<"loading" | "error" | "ready">(saved ? "ready" : "loading");
  // What a link opened, until the bottom nav or a button goes anywhere: then pages open as usual.
  const [opening, setOpening] = createSignal(openFromLink());
  const [page, setPage] = createSignal<Page>(opening()?.page ?? "week");
  const openedRecipe = () => {
    const opened = opening();
    return opened?.page === "recipes" ? opened.recipe : undefined;
  };
  const openedNextWeek = () => {
    const opened = opening();
    return opened?.page === "week" && opened.next;
  };
  const openedHousehold = () => {
    const opened = opening();
    return opened?.page === "household" ? opened : undefined;
  };
  // The Week the Week or Grocery page last showed, for the chat to say where it was opened.
  const [weekShown, setWeekShown] = createSignal<LocalDate>();
  const where = (): ChatWhere => {
    const week = page() === "week" || page() === "grocery" ? weekShown() : undefined;
    return { screen: page(), ...(week && { week }) };
  };
  const [inKitchen, setInKitchen] = createSignal<KitchenRecipe>();
  const [kitchenMode, setKitchenMode] = createKitchenMode();
  // The last Household loaded. Each refetch is reconciled in place (Members matched by id), so a
  // refresh updates the settings without remounting them and throwing away a form someone is filling in.
  const [loaded, setLoaded] = createStore<{ household: Household | null }>({ household: saved ?? null });
  // Set before the pages render, so names are cased for the Household's locale.
  createComputed(() => loaded.household && setLocale(loaded.household.locale));
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

  // Counts taps on the Household tab while it shows, each taking the Household back to its index.
  const [householdAgain, setHouseholdAgain] = createSignal(0);
  const go = (to: Page) => {
    if (to === "household" && page() === "household") setHouseholdAgain((count) => count + 1);
    setOpening(undefined);
    setPage(to);
    window.scrollTo?.({ top: 0 });
  };
  const cook = (id: RecipeId, servings?: number) => setInKitchen({ id, servings });
  const resolve = (at?: string) => {
    setOpening({ page: "household", setting: "resolve", at });
    setPage("household");
    window.scrollTo?.({ top: 0 });
  };

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
            <KeepForOffline client={props.client} household={household()} />
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
              <UpdateBanner
                container={"serviceWorker" in navigator ? navigator.serviceWorker : undefined}
                reload={() => window.location.reload()}
              />
              <Show when={!online()}>
                <div class="banner banner-amber banner-top" role="status">
                  <Icon name="wifiOff" />
                  <p>{t("offline.notice")}</p>
                </div>
              </Show>
              <header class="app-header">
                <RanOut client={props.client} online={online()} />
                <Chat client={props.client} online={online()} where={where} voice={props.voice} />
              </header>
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
                    <button type="button" class="button-row" onClick={() => queue.dismissRefused()}>
                      {t("offline.dismiss")}
                    </button>
                  </div>
                </Show>
                {/* The nudge shows on the Week, which leads to the check; Pantry says it in its heading. */}
                <Show when={page() === "week"}>
                  <PantryBanner client={props.client} online={online()} onOpen={() => go("pantry")} />
                </Show>
                <Switch>
                  <Match when={page() === "week"}>
                    <WeekPage
                      client={props.client}
                      household={household()}
                      online={online()}
                      onGrocery={() => go("grocery")}
                      onCook={cook}
                      onWeekShown={setWeekShown}
                      openNext={openedNextWeek()}
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
                      onWeekShown={setWeekShown}
                    />
                  </Match>
                  <Match when={page() === "pantry"}>
                    <PantryPage
                      client={props.client}
                      locale={household().locale}
                      online={online()}
                      onWeek={() => go("week")}
                    />
                  </Match>
                  <Match when={page() === "recipes"}>
                    <RecipesPage
                      client={props.client}
                      online={online()}
                      open={openedRecipe()}
                      onCook={cook}
                      onResolve={resolve}
                    />
                  </Match>
                  <Match when={page() === "household"}>
                    <HouseholdPage
                      client={props.client}
                      open={openedHousehold()?.setting}
                      resolveAt={openedHousehold()?.at}
                      home={householdAgain()}
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

/** Keeps both Weeks' Grocery Lists and planned Recipes on this device; shows nothing. */
function KeepForOffline(props: { client: MiseClient; household: Household }) {
  keepGroceryLists(props.client, () => props.household);
  keepPlannedRecipes(props.client, () => props.household);
  return null;
}

/**
 * The Household: its index (see `HouseholdIndex`), and each setting as its own page over it, `open` at
 * once when given (Resolve Ingredients at the group `resolveAt`, the first time only). Back returns to
 * the index, as does each change of `home` (the Household tab tapped again).
 */
/** The commit this bundle was built from, shown at the foot of Settings; `dev` where none was built in. */
const BUILD = import.meta.env.MISE_BUILD ?? "dev";

function HouseholdPage(props: {
  client: MiseClient;
  open?: Setting;
  resolveAt?: string;
  home: number;
  household: Household;
  kitchenMode: boolean;
  onKitchenMode: (on: boolean) => void;
}) {
  const setting = createPushedPages<HouseholdPushed>("household", props.open);
  // Resolve Ingredients opened any other way, even back here later, opens at the top. `setting` has
  // opened `props.open` already, so the first page change is leaving it.
  const [resolveAt, setResolveAt] = createSignal(props.open === "resolve" ? props.resolveAt : undefined);
  createEffect(on(setting.page, () => setResolveAt(undefined), { defer: true }));
  const status = createSignal<StatusChips>({ review: [], resolve: [], tag: [] });
  createEffect(on(() => props.home, setting.home, { defer: true }));

  return (
    <Show
      when={setting.page()}
      fallback={
        <HouseholdIndex
          client={props.client}
          household={props.household}
          kitchenMode={props.kitchenMode}
          onKitchenMode={props.onKitchenMode}
          onOpen={setting.open}
          status={status}
        />
      }
    >
      {(open) => (
        <section class="screen">
          <header class="page-heading">
            <button type="button" class="button-link back" onClick={() => setting.back()}>
              <Icon name="chevronLeft" />
              {importMethod(open()) ? t("nav.import") : t("household.back")}
            </button>
            <p class="overline">{t("household.sectionOverline", { section: t(`nav.${settingOf(open())}`) })}</p>
          </header>
          <Switch>
            <Match when={open() === "members"}>
              <MembersSettings client={props.client} members={props.household.members} />
            </Match>
            <Match when={open() === "settings"}>
              <HouseholdSettingsForm client={props.client} household={props.household} />
              <p class="meta">{t("settings.build", { build: BUILD })}</p>
            </Match>
            <Match when={open() === "calendar"}>
              <CalendarSettings client={props.client} />
            </Match>
            <Match when={open() === "displays"}>
              <KitchenDisplaySettings client={props.client} />
            </Match>
            <Match when={open() === "notifications"}>
              <NotificationSettings client={props.client} />
            </Match>
            <Match when={open() === "review"}>
              <ReviewPage client={props.client} onResolve={() => setting.open("resolve")} />
            </Match>
            <Match when={settingOf(open()) === "import"}>
              <ImportPage
                client={props.client}
                method={importMethod(open())}
                onMethod={(method) => setting.open(`import-${method}`)}
                onReview={() => setting.open("review")}
              />
            </Match>
            <Match when={open() === "resolve"}>
              <ResolveIngredients client={props.client} at={resolveAt()} />
            </Match>
            <Match when={open() === "items"}>
              <ItemsSettings client={props.client} sections={props.household.storeSections} />
            </Match>
            <Match when={open() === "tag"}>
              <TagRecipes client={props.client} />
            </Match>
          </Switch>
        </section>
      )}
    </Show>
  );
}

/**
 * The Household's index: what it is, kitchen mode for this device, and a row for each of its settings,
 * with a chip where something waits. The chips keep fresh only while the index shows, from what
 * `status` last held.
 */
function HouseholdIndex(props: {
  client: MiseClient;
  household: Household;
  kitchenMode: boolean;
  onKitchenMode: (on: boolean) => void;
  onOpen: (setting: Setting) => void;
  status: Signal<StatusChips>;
}) {
  const status = createHouseholdStatus(props.client, props.status);
  const chips = (name: Setting) => {
    const shown: Partial<Record<Setting, StatusChip[]>> = status();
    return shown[name] ?? [];
  };

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
            units: t(`units.${props.household.units}`),
            locale: t(`locale.${props.household.locale}`),
          })}
        </p>
      </header>
      <SwitchRow
        label={t("household.kitchenMode")}
        hint={t("household.kitchenModeHint")}
        checked={props.kitchenMode}
        onChange={props.onKitchenMode}
      />
      <For each={SETTING_GROUPS}>
        {(group) => (
          <section>
            <h3 id={`household-${group.group}`}>{t(`household.${group.group}`)}</h3>
            <ul class="rows" aria-labelledby={`household-${group.group}`}>
              <For each={group.settings}>
                {(name) => (
                  <li>
                    <button type="button" class="row row-open" onClick={() => props.onOpen(name)}>
                      <span class="row-body">
                        <span class="row-title">{t(`nav.${name}`)}</span>
                        <Show when={chips(name).length > 0}>
                          <span class="chips">
                            <For each={chips(name)}>
                              {(chip) => <span class={CHIP_CLASS[chip.tone ?? "plain"]}>{chip.text}</span>}
                            </For>
                          </span>
                        </Show>
                      </span>
                      <span class="row-end">
                        <Icon name="chevronRight" />
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </For>
    </section>
  );
}
