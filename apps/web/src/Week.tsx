import {
  type Conflict,
  type Item,
  type ItemId,
  type LocalDate,
  type Locale,
  localDate,
  type Meal,
  type Member,
  type MemberId,
  nextWeekStart,
  type Override,
  RATINGS,
  type Rating,
  type RecipeId,
  type RecipeSummary,
  type RefusedConflict,
  SLOT_KINDS,
  type Slot,
  type SlotKind,
  sameConflict,
  type ToolInput,
  type ToolResult,
  type Week,
  type WeekSpan,
  weekDates,
} from "@mise/domain";
import { createEffect, createMemo, createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import { createConfirm } from "./ConfirmSheet";
import type { MiseClient } from "./client";
import { formatDate, shortDate } from "./dates";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { Icon, PlateGlyph } from "./icons";
import { createItems } from "./items";
import { type ConstraintDraft, ConstraintFields, constraintDraftsOf, constraintsOf } from "./MemberFields";
import { nameText, t } from "./messages";
import { savedWeek, saveWeek } from "./offline";
import { RunOut } from "./Pantry";
import {
  EffortBudgetsEditor,
  type WeekHousehold as Household,
  ProposalControls,
  reasonText,
  whoName,
} from "./Proposal";
import { RecipeSheet } from "./RecipeSheet";
import { Sheet } from "./Sheet";

/** Which Slot of the Week: its day and meal. */
type SlotKey = Pick<Slot, "date" | "meal">;

/**
 * The Recipe a Slot holds, or that its Leftovers are of, opened over the Week and scaled to the
 * `servings` it is cooked for; at its rating, when `rate` is set.
 */
type OpenRecipe = { id: RecipeId; servings: number; slot: SlotKey; rate: boolean };

/**
 * The current and next Week, each day's dinner first, with every Slot editable by hand. Offline it is
 * read-only: the Week can be looked at and cooked from, not changed.
 */
export function WeekPage(props: {
  client: MiseClient;
  household: Household;
  online: boolean;
  onGrocery: () => void;
  onCook: (recipe: RecipeId, servings: number) => void;
  /** Told the start of the Week shown, or undefined while none is. */
  onWeekShown?: (start: LocalDate | undefined) => void;
  /** Opens on next Week, once the current one has said when that starts, as a notification's link asks. */
  openNext?: boolean;
}) {
  const [next, setNext] = createSignal(false);
  // The current Week kept on this device shows at once, and for as long as the household can't be
  // reached; not once it has ended, when it no longer is the current Week.
  const kept = () => {
    const saved = savedWeek();
    const today = localDate(new Date(), props.household.timezone);
    return saved && saved.endDate >= today ? saved : undefined;
  };
  const [week, setWeek] = createSignal<Week | undefined>(kept());
  createEffect(() => props.onWeekShown?.(week()?.startDate));
  // The Week after the current one starts the day after it ends.
  const [nextStart, setNextStart] = createSignal<LocalDate>();
  // Whether a link has opened next Week already: it does so only once.
  let openedNext = false;
  const [error, setError] = createSignal<string>();
  // Names the "use it up" Items a Proposal gives as reasons.
  const items = createItems(props.client);
  const readOnly = () => !props.online;
  const [opened, setOpened] = createSignal<OpenRecipe>();
  // The one Slot whose form is open.
  const [editing, setEditing] = createSignal<SlotKey>();
  const open = (slot: Slot, rate = false) => {
    const recipe = slot.recipe ?? slot.leftoversOf?.recipe;
    if (!recipe) return;
    // Leftovers are cooked on the Slot they're of; one in another Week isn't here, so as written.
    const of = slot.leftoversOf;
    const cooked = of ? week()?.slots.find((s) => sameSlot(s, of)) : slot;
    setOpened({
      id: recipe.id,
      servings: cooked?.cookFor || recipe.baseServings,
      slot: { date: slot.date, meal: slot.meal },
      rate,
    });
  };
  // The opened Slot as the Week now has it, so that marking it cooked or rating it shows at once.
  const openedSlot = (open: OpenRecipe) => week()?.slots.find((slot) => sameSlot(slot, open.slot));

  // Slots show their Recipes' titles and photos, and follow the default Diners: every Member.
  const refetch = keepFresh(
    props.client,
    ["plan", "recipes", "household"],
    () => {
      const start = nextStart();
      return props.client.call("get_week", next() && start ? { date: start } : {});
    },
    (result) => {
      setError(result.ok ? undefined : t("app.error"));
      if (!result.ok) return;
      if (!next()) {
        setNextStart(nextWeekStart(result.value));
        saveWeek(result.value);
        if (props.openNext && !openedNext) {
          openedNext = true;
          show(true);
          return;
        }
      }
      setWeek(result.value);
    },
    // Offline, the Week shown stands; reconnecting fetches it again.
    () => {
      if (props.online) setError(t("app.error"));
    },
  );

  const show = (showNext: boolean) => {
    setNext(showNext);
    setWeek(showNext ? undefined : kept());
    void refetch();
  };

  const confirm = createConfirm();
  const clear = async (shown: Week) => {
    const lost = t("week.clearLost", { date: dayTitle(shown.startDate, props.household.locale) });
    const confirmed = await confirm.ask({ title: t("week.clearTitle"), lost, action: t("week.clear") });
    if (!confirmed) return;
    setError(
      (await outcomeOf(() => props.client.call("clear_week", { date: shown.startDate, confirm: true }))).failure,
    );
  };

  const today = () => localDate(new Date(), props.household.timezone);
  const jump = (date: LocalDate) => document.getElementById(dayId(date))?.scrollIntoView?.({ block: "start" });

  return (
    <section class="screen" aria-labelledby="week-title">
      <header class="page-header">
        <div class="page-heading">
          <p class="overline">{next() ? t("week.overlineNext") : t("week.overline")}</p>
          <h1 id="week-title">{week() ? weekRange(week() as Week, props.household.locale) : t("week.title")}</h1>
        </div>
        <div class="segmented">
          <button type="button" aria-pressed={!next()} onClick={() => show(false)}>
            {t("week.this")}
          </button>
          <button type="button" aria-pressed={next()} disabled={!nextStart()} onClick={() => show(true)}>
            {t("week.next")}
          </button>
        </div>
        <Show when={week()}>
          {(shown) => (
            <>
              <nav class="day-rail" aria-label={t("week.jump")}>
                <For each={weekDates(shown())}>
                  {(date) => (
                    <button
                      type="button"
                      aria-label={t("week.jumpTo", { day: dayTitle(date, props.household.locale) })}
                      aria-current={date === today() ? "date" : undefined}
                      onClick={() => jump(date)}
                    >
                      <span aria-hidden="true">{dayInitial(date, props.household.locale)}</span>
                      <span class="numeral" aria-hidden="true">
                        {Number(date.slice(8))}
                      </span>
                    </button>
                  )}
                </For>
              </nav>
              <ProposalControls
                client={props.client}
                week={shown()}
                items={items()}
                readOnly={readOnly()}
                onGrocery={() => props.onGrocery()}
              />
            </>
          )}
        </Show>
      </header>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={week()} fallback={<WeekLoading />}>
        {(shown) => (
          <>
            <div class="days">
              <For each={weekDates(shown())}>
                {(date) => (
                  <Day
                    client={props.client}
                    household={props.household}
                    items={items()}
                    date={date}
                    today={date === today()}
                    readOnly={readOnly()}
                    onCook={props.onCook}
                    onOpen={open}
                    editing={editing()}
                    onEdit={setEditing}
                    slots={shown().slots.filter((slot) => slot.date === date)}
                  />
                )}
              </For>
            </div>
            <Show when={!readOnly()}>
              <EffortBudgetsEditor client={props.client} household={props.household} week={shown()} />
              <button type="button" class="button-danger" onClick={() => clear(shown())}>
                {t("week.clear")}
              </button>
            </Show>
          </>
        )}
      </Show>
      <confirm.ConfirmSheet />
      <Show when={opened()} keyed>
        {(open) => (
          <Show when={openedSlot(open)}>
            {(slot) => (
              <RecipeSheet
                client={props.client}
                id={open.id}
                servings={open.servings}
                locale={props.household.locale}
                onCook={slot().recipe ? props.onCook : undefined}
                onClose={() => setOpened(undefined)}
                slotActions={
                  <Show when={slot().recipe}>
                    <Cooking
                      client={props.client}
                      household={props.household}
                      slot={slot()}
                      readOnly={readOnly()}
                      rate={open.rate}
                      onEdit={() => {
                        setOpened(undefined);
                        setEditing(open.slot);
                      }}
                    />
                  </Show>
                }
              >
                <SlotConflicts household={props.household} slot={slot()} />
              </RecipeSheet>
            )}
          </Show>
        )}
      </Show>
    </section>
  );
}

/** The Week's shape in still blocks while it loads: photo cards and compact rows, as they will land. */
function WeekLoading() {
  const full = [true, false, true, true, false, true, true];
  return (
    <div class="days" aria-busy="true">
      <p class="visually-hidden">{t("week.loading")}</p>
      <For each={full}>
        {(isFull) => (
          <div class="day" aria-hidden="true">
            <Show
              when={isFull}
              fallback={
                <div class="compact">
                  <span class="skeleton thumb" />
                  <div class="stack">
                    <span class="skeleton sk-title-sm" />
                    <span class="skeleton sk-meta" />
                  </div>
                </div>
              }
            >
              <span class="skeleton skeleton-photo" />
              <span class="skeleton sk-title" />
              <span class="skeleton sk-meta" />
            </Show>
            <span class="skeleton sk-strip" />
          </div>
        )}
      </For>
    </div>
  );
}

/** The meals a Day's strip folds away under its dinner. */
const OTHER_MEALS = ["breakfast", "lunch"] as const;
type OtherMeal = (typeof OTHER_MEALS)[number];

function Day(props: {
  client: MiseClient;
  household: Household;
  items: Map<ItemId, Item>;
  date: LocalDate;
  today: boolean;
  readOnly: boolean;
  onCook: (recipe: RecipeId, servings: number) => void;
  onOpen: (slot: Slot, rate?: boolean) => void;
  editing: SlotKey | undefined;
  onEdit: (slot: SlotKey | undefined) => void;
  slots: Slot[];
}) {
  const title = () => dayTitle(props.date, props.household.locale);
  const isEditing = (meal: Meal) => !!props.editing && sameSlot(props.editing, { date: props.date, meal });
  const slot = (meal: Meal) => props.slots.find((s) => s.meal === meal) as Slot;
  const [editingDiners, setEditingDiners] = createSignal(false);
  const [unfolded, setUnfolded] = createSignal(false);
  const otherMealsId = createUniqueId();
  // Unfolds when breakfast or lunch comes to need attention or be edited; it can be folded again.
  const needsAttention = createMemo(() => OTHER_MEALS.some((meal) => blocking(slot(meal)) || isEditing(meal)));
  createEffect(() => {
    if (needsAttention()) setUnfolded(true);
  });
  const view = (meal: Meal, prominent = false) => (
    <SlotView
      client={props.client}
      household={props.household}
      items={props.items}
      slot={slot(meal)}
      day={dayLabel(props.date, props.household.locale, props.today)}
      today={props.today}
      readOnly={props.readOnly}
      onCook={props.onCook}
      onOpen={props.onOpen}
      editing={isEditing(meal)}
      onEdit={(edit) => props.onEdit(edit ? { date: props.date, meal } : undefined)}
      prominent={prominent}
    />
  );
  // Breakfast and lunch, folded: what's planned for them, if anything.
  const planned = (meal: OtherMeal) =>
    ["unplanned", "skip"].includes(slot(meal).kind) ? undefined : slotTitle(slot(meal));
  const otherPlans = () => {
    const breakfast = planned("breakfast");
    const lunch = planned("lunch");
    if (breakfast && lunch) return t("week.otherMealsBoth", { breakfast, lunch });
    if (breakfast) return t("week.otherMealsBreakfast", { breakfast });
    if (lunch) return t("week.otherMealsLunch", { lunch });
    return t("week.otherMealsNone");
  };
  // Who's eating the day, as dinner has it: the Day's Diners form starts from there too.
  const eating = () => {
    const count = slot("dinner").diners.length;
    if (count === 0) return t("week.eatingNone");
    return count === 1 ? t("week.eatingOne") : t("week.eating", { count: String(count) });
  };
  const eatingText = () => (
    <>
      <Icon name="people" />
      {eating()}
    </>
  );

  return (
    <section class="day" id={dayId(props.date)} aria-label={title()}>
      <h2 class="visually-hidden">{title()}</h2>
      {view("dinner", true)}
      <div class="strip">
        <Show when={!props.readOnly && !editingDiners()} fallback={<span class="strip-diners">{eatingText()}</span>}>
          <button type="button" class="strip-diners" onClick={() => setEditingDiners(true)}>
            {eatingText()}
          </button>
        </Show>
        <span class="strip-dot" aria-hidden="true">
          ·
        </span>
        <button
          type="button"
          class="strip-plan"
          aria-expanded={unfolded()}
          aria-controls={otherMealsId}
          onClick={() => setUnfolded(!unfolded())}
        >
          <span>{otherPlans()}</span>
          <Icon name="chevronDown" />
        </button>
      </div>
      {/* Hidden rather than unmounted when folded, so a form being filled in keeps what was typed. */}
      <div class="strip-meals" id={otherMealsId} hidden={!unfolded()}>
        {view("breakfast")}
        {view("lunch")}
      </div>
      <Show when={editingDiners()}>
        <DayDinersForm
          client={props.client}
          household={props.household}
          date={props.date}
          slots={props.slots}
          onDone={() => setEditingDiners(false)}
        />
      </Show>
    </section>
  );
}

/**
 * A Slot as the Week shows it, with one action by where it stands: nothing chosen, Choose; a Recipe
 * to cook, Cook; cooked, Rate it; rated, none. The rest is in its Recipe's sheet.
 */
function SlotView(props: {
  client: MiseClient;
  household: Household;
  items: Map<ItemId, Item>;
  slot: Slot;
  /** The day as its pill says it, such as "Tonight · Mon 26". */
  day: string;
  today: boolean;
  readOnly: boolean;
  onCook: (recipe: RecipeId, servings: number) => void;
  onOpen: (slot: Slot, rate?: boolean) => void;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  prominent?: boolean;
}) {
  const meal = () => t(`meal.${props.slot.meal}`);
  const unsafe = () => props.slot.conflicts.find((conflict) => conflict.override === null);
  const flag = (): Flag | undefined => {
    const conflict = unsafe();
    if (conflict) return { kind: "warn", text: conflictChip(conflict, props.household) };
    return props.slot.locked ? { kind: "lock", text: t("slot.locked") } : undefined;
  };
  // Under the title, in its text column: who it feeds, what it's cooked for, and its note.
  const meta = () => (
    <>
      <p class="meta">{servingsText(props.slot, props.household)}</p>
      <Show when={props.slot.recipe && props.slot.leftovers.length > 0}>
        <p class="meta">{cookForText(props.slot, props.household)}</p>
      </Show>
      <Show when={props.slot.note}>{(note) => <p class="meta">{note()}</p>}</Show>
    </>
  );
  const choose = () => (
    <Show when={!props.readOnly}>
      <button type="button" class="button-row" onClick={() => props.onEdit(true)}>
        {t(`slot.choose.${props.slot.meal}`)}
      </button>
    </Show>
  );

  return (
    <section class="slot" aria-label={meal()}>
      <Show
        when={props.prominent}
        fallback={
          <p>
            <strong>{meal()}</strong>: <OpenTitle slot={props.slot} onOpen={props.onOpen} />
          </p>
        }
      >
        <Show
          when={props.slot.kind === "recipe" && props.slot.recipe}
          fallback={
            <Show
              when={props.slot.kind !== "unplanned"}
              fallback={
                <div class="compact compact-end">
                  <SlotThumb client={props.client} slot={props.slot} />
                  <div class="row-body">
                    <p class="row-title">{t("week.nothingPlanned", { day: props.day })}</p>
                    <Show when={props.slot.note}>{(note) => <p class="row-meta">{note()}</p>}</Show>
                  </div>
                  <Show when={!props.editing}>
                    <div class="row-end">{choose()}</div>
                  </Show>
                </div>
              }
            >
              <div class="compact">
                <SlotThumb client={props.client} slot={props.slot} />
                <div class="dish">
                  <p class="overline">{props.day}</p>
                  <DishTitle slot={props.slot} onOpen={props.onOpen} />
                  {meta()}
                  <Show when={flag()}>
                    {(shown) => (
                      <p class="chips">
                        <span class={`chip ${FLAG_CLASS[shown().kind].chip}`}>{shown().text}</span>
                      </p>
                    )}
                  </Show>
                </div>
              </div>
            </Show>
          }
        >
          {(recipe) => (
            <div class="dish-card">
              <div class="photo">
                <Show when={recipe().photoKey} fallback={<PlateGlyph size={64} />}>
                  {(key) => (
                    <img
                      src={props.client.photoUrl(recipe().id, key())}
                      alt={t("recipe.photoAlt", { title: recipe().title })}
                    />
                  )}
                </Show>
                <span class={props.today ? "pill pill-today" : "pill"}>{props.day}</span>
                <Show when={flag()}>
                  {(shown) => <span class={`pill pill-status ${FLAG_CLASS[shown().kind].pill}`}>{shown().text}</span>}
                </Show>
              </div>
              <div class="dish">
                <DishTitle slot={props.slot} onOpen={props.onOpen} />
                {meta()}
              </div>
            </div>
          )}
        </Show>
      </Show>
      <Show when={!props.prominent}>{meta()}</Show>
      <Show when={props.slot.reason}>
        {(reason) => <p class="meta">{reasonText(reason(), props.household, props.items)}</p>}
      </Show>
      <SlotConflicts household={props.household} slot={props.slot} />
      <Show
        when={props.editing}
        fallback={
          <Switch fallback={<Show when={props.slot.kind !== "unplanned" || !props.prominent}>{choose()}</Show>}>
            <Match when={props.slot.cookedAt ? props.slot.ratings.at(-1) : undefined}>
              {(rated) => (
                <p class="chips">
                  <span class="chip">{t(`rating.${rated().rating}`)}</span>
                </p>
              )}
            </Match>
            <Match when={props.slot.cookedAt}>
              <p class="chips">
                <CookedChip />
              </p>
              <Show when={!props.readOnly}>
                <div class="slot-actions">
                  <button type="button" class="button-row" onClick={() => props.onOpen(props.slot, true)}>
                    {t("cooking.rateIt")}
                  </button>
                </div>
              </Show>
            </Match>
            <Match when={props.slot.recipe}>
              {(recipe) => (
                <div class="slot-actions">
                  <button
                    type="button"
                    class="button-primary"
                    onClick={() => props.onCook(recipe().id, props.slot.cookFor || recipe().baseServings)}
                  >
                    <Icon name="pot" />
                    {t("kitchen.cook")}
                  </button>
                </div>
              )}
            </Match>
          </Switch>
        }
      >
        <SlotForm
          client={props.client}
          household={props.household}
          slot={props.slot}
          onDone={() => props.onEdit(false)}
        />
      </Show>
    </section>
  );
}

/** A Slot card's title, opening its Recipe as `OpenTitle` does; on a card, tapping its photo does too. */
function DishTitle(props: { slot: Slot; onOpen: (slot: Slot) => void }) {
  return (
    <h3 class="dish-title">
      <OpenTitle slot={props.slot} onOpen={props.onOpen} />
    </h3>
  );
}

/** A Slot's title: a button opening its Recipe, or the one its Leftovers are of, if it has one. */
function OpenTitle(props: { slot: Slot; onOpen: (slot: Slot) => void }) {
  return (
    <Show when={props.slot.recipe ?? props.slot.leftoversOf?.recipe} fallback={slotTitle(props.slot)}>
      <button type="button" class="dish-open" onClick={() => props.onOpen(props.slot)}>
        {slotTitle(props.slot)}
      </button>
    </Show>
  );
}

/** A Slot's Conflicts: blocking ones as warnings, overridden ones with their reason. */
function SlotConflicts(props: { household: Household; slot: Slot }) {
  return (
    <For each={props.slot.conflicts}>
      {(conflict) => (
        <Show
          when={conflict.override}
          fallback={
            <p class="banner banner-warn" role="alert">
              {conflictText(conflict, props.household, slotTitle(props.slot))}
            </p>
          }
        >
          {(reason) => (
            <p class="chips">
              <span class="chip chip-warn">
                {t("conflict.overridden", { ...conflictParams(conflict, props.household), reason: reason() })}
              </span>
            </p>
          )}
        </Show>
      )}
    </For>
  );
}

/**
 * A compact row's square: the dish's photo with a Leftovers band, a solid fork and knife for eating
 * out, or a dashed box for nothing decided.
 */
function SlotThumb(props: { client: MiseClient; slot: Slot }) {
  return (
    <Switch
      fallback={
        <span class="thumb thumb-dashed" aria-hidden="true">
          <Icon name="calendarPlus" />
        </span>
      }
    >
      <Match when={props.slot.kind === "eat_out"}>
        <span class="thumb thumb-solid" aria-hidden="true">
          <Icon name="eatOut" />
        </span>
      </Match>
      <Match when={props.slot.kind === "leftovers"}>
        <span class="thumb thumb-banded" aria-hidden="true">
          <Show when={props.slot.leftoversOf?.recipe} fallback={<PlateGlyph size={30} />}>
            {(recipe) => (
              <Show when={recipe().photoKey} fallback={<PlateGlyph size={30} />}>
                {(key) => <img src={props.client.photoUrl(recipe().id, key())} alt="" />}
              </Show>
            )}
          </Show>
          <span class="thumb-band">{t("slotKind.leftovers")}</span>
        </span>
      </Match>
    </Switch>
  );
}

function CookedChip() {
  return (
    <span class="chip chip-leaf">
      <Icon name="check" size={16} />
      {t("cooking.cooked")}
    </span>
  );
}

/** What a dinner is flagged with: a Conflict nobody has overridden, or that it is Locked. */
type Flag = { kind: "warn" | "lock"; text: string };
const FLAG_CLASS = {
  warn: { pill: "pill-warn", chip: "chip-warn" },
  lock: { pill: "pill-lock", chip: "chip-plum" },
} satisfies Record<Flag["kind"], { pill: string; chip: string }>;

/**
 * A Slot with a Recipe, in that Recipe's sheet: marking it cooked; once it is, what ran out, its
 * Ratings and a prompt for one more; and editing it.
 */
function Cooking(props: {
  client: MiseClient;
  household: Household;
  slot: Slot;
  readOnly: boolean;
  /** Opened to rate it: the rating has the focus. */
  rate: boolean;
  onEdit: () => void;
}) {
  const [rating, setRating] = createSignal<Rating>();
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const where = () => ({ date: props.slot.date, meal: props.slot.meal });

  const call = async (write: () => Promise<ToolResult<unknown>>): Promise<boolean> => {
    setBusy(true);
    const outcome = await outcomeOf(write);
    setBusy(false);
    setError(outcome.failure);
    return !outcome.failure;
  };

  const rate = async (event: SubmitEvent) => {
    event.preventDefault();
    const chosen = rating();
    if (!chosen) return;
    const typed = note().trim() || null;
    if (await call(() => props.client.call("rate_recipe", { ...where(), rating: chosen, note: typed }))) {
      setRating(undefined);
      setNote("");
    }
  };

  const ratedText = (given: Slot["ratings"][number]) => {
    const params = {
      who: given.memberId === null ? t("cooking.someone") : whoName(given.memberId, props.household),
      rating: t(`rating.${given.rating}`),
    };
    return given.note ? t("cooking.ratedNote", { ...params, note: given.note }) : t("cooking.rated", params);
  };

  return (
    <>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Show
        when={props.slot.cookedAt}
        fallback={
          <Show when={!props.readOnly}>
            <button
              type="button"
              class="button-row"
              disabled={busy()}
              onClick={() => call(() => props.client.call("mark_cooked", where()))}
            >
              <Icon name="check" />
              {t("cooking.mark")}
            </button>
          </Show>
        }
      >
        <p class="chips">
          <CookedChip />
        </p>
        <Show when={props.slot.meal === "dinner" && props.slot.recipe}>
          {(recipe) => <RunOut client={props.client} recipeId={recipe().id} />}
        </Show>
        <For each={props.slot.ratings}>{(given) => <p class="meta">{ratedText(given)}</p>}</For>
        <form class="slot-form" aria-label={t("cooking.prompt")} onSubmit={rate}>
          <fieldset
            class="rating"
            ref={(rating) =>
              props.rate && queueMicrotask(() => rating.querySelector<HTMLInputElement>("input")?.focus())
            }
          >
            <legend>{t("cooking.prompt")}</legend>
            <For each={RATINGS}>
              {(option) => (
                <label>
                  <input
                    type="radio"
                    name={`rating-${props.slot.date}-${props.slot.meal}`}
                    checked={rating() === option}
                    onChange={() => setRating(option)}
                  />
                  {t(`rating.${option}`)}
                </label>
              )}
            </For>
          </fieldset>
          <label>
            {t("cooking.note")}
            <input maxLength={500} value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
          </label>
          <button type="submit" class="button-secondary" disabled={busy() || !rating() || props.readOnly}>
            {t("cooking.rate")}
          </button>
        </form>
        <button
          type="button"
          class="button-quiet"
          disabled={busy() || props.readOnly}
          onClick={() => call(() => props.client.call("mark_cooked", { ...where(), cooked: false }))}
        >
          {t("cooking.unmark")}
        </button>
      </Show>
      <Show when={!props.readOnly}>
        <button type="button" class="button-row" onClick={() => props.onEdit()}>
          {t(`slot.edit.${props.slot.meal}`)}
        </button>
      </Show>
    </>
  );
}

/** Who is eating, as a form holds it: the Household's default, or the Members ticked. */
type DinersDraft = { everyone: boolean; diners: MemberId[] };

function SlotForm(props: { client: MiseClient; household: Household; slot: Slot; onDone: () => void }) {
  const { slot } = props;
  const [kind, setKind] = createSignal<SlotKind>(slot.kind);
  const [recipeId, setRecipeId] = createSignal(slot.recipe ? String(slot.recipe.id) : "");
  const [note, setNote] = createSignal(slot.note ?? "");
  const [diners, setDiners] = createSignal<DinersDraft>({ everyone: slot.dinersAreDefault, diners: slot.diners });
  const [guests, setGuests] = createSignal(String(slot.guests));
  const [guestConstraints, setGuestConstraints] = createSignal<ConstraintDraft[]>(
    constraintDraftsOf(slot.guestConstraints),
  );
  const [locked, setLocked] = createSignal(slot.locked);
  const [recipes, setRecipes] = createSignal<RecipeSummary[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [refused, setRefused] = createSignal<RefusedConflict[]>([]);
  const [reasons, setReasons] = createSignal<Record<string, string>>({});
  // A refusal is for the change as it was; changing it again asks afresh, with no old reasons.
  const changing =
    <T,>(set: (value: T) => unknown) =>
    (value: T) => {
      setRefused([]);
      setReasons({});
      set(value);
    };

  void props.client.call("search_recipes", {}).then(
    (result) => result.ok && setRecipes(result.value),
    () => setError(t("app.error")),
  );

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const overrides = overridesOf(refused(), reasons());
    if (!overrides) return;
    const where = { date: slot.date, meal: slot.meal };
    const writes: (() => Promise<ToolResult<unknown>>)[] = [];
    const typedNote = note().trim() || null;
    const dinersInput = dinersOf(diners(), props.household.members);
    const constraints = constraintsOf(guestConstraints());
    const guestsChanged =
      Number(guests()) !== slot.guests || JSON.stringify(constraints) !== JSON.stringify(slot.guestConstraints);
    const slotChanged =
      kind() !== slot.kind ||
      recipeId() !== String(slot.recipe?.id ?? "") ||
      typedNote !== slot.note ||
      dinersChanged(dinersInput, slot) ||
      guestsChanged;
    if (slotChanged) {
      // One change, so that its Conflicts are checked against the Slot as it ends up.
      const change = {
        ...where,
        note: typedNote,
        ...(dinersChanged(dinersInput, slot) && { diners: dinersInput }),
        ...(guestsChanged && { guests: Number(guests()), guestConstraints: constraints }),
        ...(overrides.length > 0 && { overrides }),
      };
      const chosen = kind();
      // No Recipe chosen sends 0, which the tool refuses by name.
      const input: ToolInput<"set_slot"> =
        chosen === "recipe" ? { ...change, kind: chosen, recipeId: Number(recipeId()) } : { ...change, kind: chosen };
      writes.push(() => props.client.call("set_slot", input));
    }
    if (locked() !== slot.locked) writes.push(() => props.client.call("lock_slot", { ...where, locked: locked() }));

    setBusy(true);
    // In order, stopping at the first refusal; what was saved before it stays saved.
    for (const write of writes) {
      const outcome = await outcomeOf(write);
      if (outcome.conflicts) setRefused(outcome.conflicts);
      setError(outcome.failure);
      if (outcome.conflicts || outcome.failure) {
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    props.onDone();
  };

  const recipeTitle = () =>
    recipes().find((recipe) => String(recipe.id) === recipeId())?.title ?? slot.recipe?.title ?? "";

  return (
    <form class="slot-form" aria-label={t(`meal.${slot.meal}`)} onSubmit={save}>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <label>
        {t("slot.kind")}
        <select value={kind()} onChange={(e) => changing(setKind)(e.currentTarget.value as SlotKind)}>
          <For each={SLOT_KINDS}>{(option) => <option value={option}>{t(`slotKind.${option}`)}</option>}</For>
        </select>
      </label>
      <Show when={kind() === "recipe"}>
        <label>
          {t("slot.recipe")}
          <select value={recipeId()} onChange={(e) => changing(setRecipeId)(e.currentTarget.value)}>
            <option value="">{t("slot.chooseRecipe")}</option>
            <For each={recipes()}>{(recipe) => <option value={String(recipe.id)}>{recipe.title}</option>}</For>
          </select>
        </label>
      </Show>
      <label>
        {t("slot.note")}
        <input maxLength={500} value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
      </label>
      <DinersFields members={props.household.members} draft={diners()} onChange={changing(setDiners)} />
      <label>
        {t("slot.guests")}
        <input
          type="number"
          min={0}
          max={50}
          value={guests()}
          onInput={(e) => changing(setGuests)(e.currentTarget.value)}
        />
      </label>
      <fieldset>
        <legend>{t("slot.guestConstraints")}</legend>
        <ConstraintFields constraints={guestConstraints()} onChange={changing(setGuestConstraints)} />
      </fieldset>
      <label>
        <input type="checkbox" checked={locked()} onChange={(e) => setLocked(e.currentTarget.checked)} />
        {t("slot.locked")}
      </label>
      <small>{t("slot.lockedHint")}</small>
      <ConflictOverrides
        household={props.household}
        conflicts={refused()}
        describe={(conflict) => conflictText(conflict, props.household, recipeTitle())}
        reasons={reasons()}
        busy={busy()}
        onChange={setReasons}
        onChangeIt={() => {
          setRefused([]);
          setReasons({});
        }}
        onCancel={() => props.onDone()}
      />
      <FormButtons busy={busy()} refused={refused().length > 0} onCancel={() => props.onDone()} />
    </form>
  );
}

/** Who is eating every meal of a day; it starts from who is eating dinner. */
function DayDinersForm(props: {
  client: MiseClient;
  household: Household;
  date: LocalDate;
  slots: Slot[];
  onDone: () => void;
}) {
  const dinner = props.slots.find((slot) => slot.meal === "dinner") as Slot;
  const [diners, setDiners] = createSignal<DinersDraft>({ everyone: dinner.dinersAreDefault, diners: dinner.diners });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [refused, setRefused] = createSignal<RefusedConflict[]>([]);
  const [reasons, setReasons] = createSignal<Record<string, string>>({});
  // A refusal is for the change as it was; changing it again asks afresh, with no old reasons.
  const changing =
    <T,>(set: (value: T) => unknown) =>
    (value: T) => {
      setRefused([]);
      setReasons({});
      set(value);
    };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const overrides = overridesOf(refused(), reasons());
    if (!overrides) return;
    setBusy(true);
    const outcome = await outcomeOf(() =>
      props.client.call("set_diners", {
        date: props.date,
        diners: dinersOf(diners(), props.household.members),
        ...(overrides.length > 0 && { overrides }),
      }),
    );
    setBusy(false);
    if (outcome.conflicts) setRefused(outcome.conflicts);
    setError(outcome.failure);
    if (!outcome.conflicts && !outcome.failure) props.onDone();
  };

  const describe = (conflict: RefusedConflict) => {
    const slot = props.slots.find((other) => other.meal === conflict.meal);
    return t("conflict.inMeal", {
      meal: t(`meal.${conflict.meal}`),
      conflict: conflictText(conflict, props.household, slot ? slotTitle(slot) : ""),
    });
  };

  return (
    <form class="slot-form" aria-label={t("week.dayDiners")} onSubmit={save}>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <DinersFields members={props.household.members} draft={diners()} onChange={changing(setDiners)} />
      <ConflictOverrides
        household={props.household}
        conflicts={refused()}
        describe={describe}
        reasons={reasons()}
        busy={busy()}
        onChange={setReasons}
        onChangeIt={() => {
          setRefused([]);
          setReasons({});
        }}
        onCancel={() => props.onDone()}
      />
      <FormButtons busy={busy()} refused={refused().length > 0} onCancel={() => props.onDone()} />
    </form>
  );
}

/**
 * What a refused change says, as a sheet that blocks the page: each Conflict, naming the person and
 * the Allergen, and a reason to give for each person and Allergen before saving anyway. Rendered in
 * the form it refuses, so saving anyway submits it.
 */
function ConflictOverrides(props: {
  household: Household;
  conflicts: RefusedConflict[];
  describe: (conflict: RefusedConflict) => string;
  reasons: Record<string, string>;
  busy: boolean;
  onChange: (reasons: Record<string, string>) => void;
  /** Back to the form, to change what was refused. */
  onChangeIt: () => void;
  onCancel: () => void;
}) {
  const titleId = createUniqueId();
  const title = () => {
    const people = overridable(props.conflicts);
    const [only] = people;
    if (people.length !== 1 || !only) return t("conflict.sheetTitleMany");
    const who = whoName(only.who, props.household);
    return t(only.cause === "contains" ? "conflict.sheetTitle" : "conflict.sheetTitleMaybe", { who });
  };
  return (
    <Show when={props.conflicts.length > 0}>
      <Sheet labelledBy={titleId} onEscape={() => props.onChangeIt()}>
        <div class="sheet-header sheet-header-warn">
          <Icon name="warning" />
          <div class="page-heading">
            <p class="overline">{t("conflict.overline")}</p>
            <h2 id={titleId} class="dish-title">
              {title()}
            </h2>
          </div>
        </div>
        <div class="sheet-body">
          <div class="banner banner-warn stack" role="alert">
            <p>{t("conflict.refused")}</p>
            <For each={props.conflicts}>{(conflict) => <p>{props.describe(conflict)}</p>}</For>
          </div>
          <For each={overridable(props.conflicts)}>
            {(conflict) => (
              <label>
                {t("conflict.reason", conflictParams(conflict, props.household))}
                <input
                  required
                  maxLength={500}
                  value={props.reasons[overrideKey(conflict)] ?? ""}
                  onInput={(e) => props.onChange({ ...props.reasons, [overrideKey(conflict)]: e.currentTarget.value })}
                />
              </label>
            )}
          </For>
          <button type="button" class="button-primary" onClick={() => props.onChangeIt()}>
            {t("conflict.changeIt")}
          </button>
          <button type="submit" class="button-secondary" disabled={props.busy}>
            {props.busy ? t("slot.saving") : t("conflict.saveAnyway")}
          </button>
          <button type="button" class="button-quiet" onClick={() => props.onCancel()}>
            {t("slot.cancel")}
          </button>
        </div>
      </Sheet>
    </Show>
  );
}

/** Save and Cancel; while a refusal's sheet is up, it has them instead. */
function FormButtons(props: { busy: boolean; refused: boolean; onCancel: () => void }) {
  return (
    <Show when={!props.refused}>
      <div class="actions">
        <button type="submit" class="button-primary" disabled={props.busy}>
          {props.busy ? t("slot.saving") : t("slot.save")}
        </button>
        <button type="button" class="button-secondary" onClick={() => props.onCancel()}>
          {t("slot.cancel")}
        </button>
      </div>
    </Show>
  );
}

/** One Conflict per person and Allergen: an Override covers it in every Slot the change touches. */
function overridable(conflicts: RefusedConflict[]): RefusedConflict[] {
  return conflicts.filter((conflict, index) => conflicts.findIndex((other) => sameConflict(other, conflict)) === index);
}

function overrideKey(conflict: Pick<Conflict, "who" | "allergen">): string {
  return `${conflict.who}:${conflict.allergen}`;
}

/** The Overrides the reasons given make; null while one is missing. */
function overridesOf(conflicts: RefusedConflict[], reasons: Record<string, string>): Override[] | null {
  const overrides = overridable(conflicts).map((conflict) => ({
    who: conflict.who,
    allergen: conflict.allergen,
    reason: (reasons[overrideKey(conflict)] ?? "").trim(),
  }));
  return overrides.every((override) => override.reason) ? overrides : null;
}

/** "Everyone" follows the Household's default; untick it to choose Members one by one. */
function DinersFields(props: { members: Member[]; draft: DinersDraft; onChange: (draft: DinersDraft) => void }) {
  const toggle = (id: MemberId, eating: boolean) =>
    props.onChange({
      ...props.draft,
      diners: eating ? [...props.draft.diners, id] : props.draft.diners.filter((diner) => diner !== id),
    });

  return (
    <fieldset>
      <legend>{t("slot.diners")}</legend>
      <label>
        <input
          type="checkbox"
          checked={props.draft.everyone}
          onChange={(e) => props.onChange({ ...props.draft, everyone: e.currentTarget.checked })}
        />
        {t("slot.everyone")}
      </label>
      <For each={props.members}>
        {(member) => (
          <label>
            <input
              type="checkbox"
              disabled={props.draft.everyone}
              checked={props.draft.everyone || props.draft.diners.includes(member.id)}
              onChange={(e) => toggle(member.id, e.currentTarget.checked)}
            />
            <span class="name">{nameText(member.name)}</span>
          </label>
        )}
      </For>
    </fieldset>
  );
}

/** The draft as `set_diners` takes it: null for the default, else the Members in Household order. */
function dinersOf(draft: DinersDraft, members: Member[]): MemberId[] | null {
  if (draft.everyone) return null;
  return members.map((member) => member.id).filter((id) => draft.diners.includes(id));
}

function dinersChanged(diners: MemberId[] | null, slot: Slot): boolean {
  if (diners === null) return !slot.dinersAreDefault;
  return slot.dinersAreDefault || diners.join() !== slot.diners.join();
}

function slotTitle(slot: Slot): string {
  const cooked = slot.leftoversOf?.recipe;
  if (cooked) return t("slot.leftoversOf", { title: cooked.title });
  return slot.recipe?.title ?? t(`slotKind.${slot.kind}`);
}

/**
 * How many a Slot's Recipe is cooked for, and which Leftovers that includes: one sentence per meal for
 * one Leftover, else the days. Weekdays come from Intl, so no message is pasted into another.
 */
function cookForText(slot: Slot, household: Household): string {
  const count = String(slot.cookFor);
  const weekday = (date: LocalDate) => formatDate(date, household.locale, { weekday: "long" });
  const [only, ...others] = slot.leftovers;
  if (only && others.length === 0) return t(`slot.cookFor.${only.meal}`, { count, day: weekday(only.date) });
  const days = [...new Set(slot.leftovers.map(({ date }) => weekday(date)))];
  return t("slot.cookForDays", {
    count,
    days: new Intl.ListFormat(household.locale, { type: "conjunction" }).format(days),
  });
}

/** Who a Slot feeds, and how that compares with what its Recipe makes. */
function servingsText(slot: Slot, household: Household): string {
  if (slot.servings === 0) return t("slot.nobody");
  const names = slot.diners.map((id) => household.members.find((member) => member.id === id)?.name ?? String(id));
  if (slot.guests > 0) {
    names.push(slot.guests === 1 ? t("slot.guestCount") : t("slot.guestCountMany", { count: String(slot.guests) }));
  }
  const params = {
    count: String(slot.servings),
    who: new Intl.ListFormat(household.locale, { type: "conjunction" }).format(names),
  };
  return slot.recipe
    ? t("slot.servesRecipe", { ...params, base: String(slot.recipe.baseServings) })
    : t("slot.serves", params);
}

function sameSlot(slot: SlotKey, other: SlotKey): boolean {
  return slot.date === other.date && slot.meal === other.meal;
}

/** Where the day rail jumps to. */
function dayId(date: LocalDate): string {
  return `day-${date}`;
}

/** The day as a pill over its photo says it: "Mon 26", or "Tonight · Mon 26". */
function dayLabel(date: LocalDate, locale: Locale, today: boolean): string {
  const day = formatDate(date, locale, { weekday: "short", day: "numeric" });
  return today ? t("week.tonight", { day }) : day;
}

/** The weekday's initial, as the day rail shows it. */
function dayInitial(date: LocalDate, locale: Locale): string {
  return formatDate(date, locale, { weekday: "narrow" });
}

/** The Week as its title says it, such as "Oct 26 to Nov 1". */
function weekRange(week: WeekSpan, locale: Locale): string {
  return t("week.range", { from: shortDate(week.startDate, locale), to: shortDate(week.endDate, locale) });
}

/** A Conflict nobody has overridden, as the flag on its dinner: "Robin · Peanut". */
function conflictChip(conflict: Conflict, household: Household): string {
  return t("conflict.chip", conflictParams(conflict, household));
}

/** A date as the Household reads it, such as "Tuesday, October 27". */
function dayTitle(date: LocalDate, locale: Locale): string {
  return formatDate(date, locale, { weekday: "long", month: "long", day: "numeric" });
}

/** Whether the Slot has a Conflict nobody has overridden. */
function blocking(slot: Slot): boolean {
  return slot.conflicts.some((conflict) => conflict.override === null);
}

function conflictParams(conflict: Conflict, household: Household): Record<string, string> {
  return {
    who: whoName(conflict.who, household),
    allergen: t(`allergen.${conflict.allergen}`),
    constraint: t(`constraint.${conflict.constraint}`),
  };
}

/** A Conflict of `title` with someone's Hard Constraint, naming them and the Allergen. */
function conflictText(conflict: Conflict, household: Household, title: string): string {
  return t(conflict.cause === "contains" ? "conflict.contains" : "conflict.unknown", {
    ...conflictParams(conflict, household),
    title,
  });
}

/**
 * Makes a tool call. A refusal for Conflicts comes back as those Conflicts; any other refusal, or no
 * answer at all, as what to show. Neither, if it succeeded.
 */
async function outcomeOf(
  call: () => Promise<ToolResult<unknown>>,
): Promise<{ failure?: string; conflicts?: RefusedConflict[] }> {
  try {
    const result = await call();
    if (result.ok) return {};
    if (result.error.code === "constraint_conflict" && result.error.conflicts)
      return { conflicts: result.error.conflicts };
    return { failure: errorText(result.error, "slot") };
  } catch {
    return { failure: t("app.error") };
  }
}
