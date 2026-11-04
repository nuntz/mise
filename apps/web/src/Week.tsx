import {
  addDays,
  type Conflict,
  canHandBack,
  type Item,
  type ItemId,
  isKeepable,
  type LocalDate,
  type Locale,
  localDate,
  MEALS,
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
  type SlotRecipe,
  sameConflict,
  type ToolInput,
  type ToolResult,
  type Week,
  type WeekSpan,
  weekDates,
} from "@mise/domain";
import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, Match, Show, Switch } from "solid-js";
import { createConfirm } from "./ConfirmSheet";
import type { MiseClient } from "./client";
import { dayInitial, formatDate, shortDate } from "./dates";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { Icon, PlateGlyph } from "./icons";
import { createItems } from "./items";
import { type ConstraintDraft, ConstraintFields, constraintDraftsOf, constraintsOf } from "./MemberFields";
import { nameText, t } from "./messages";
import { savedWeeks, saveWeek } from "./offline";
import { RunOut } from "./Pantry";
import {
  EffortBudgetsEditor,
  type WeekHousehold as Household,
  marksPencilled,
  PencilledChip,
  ProposalControls,
  reasonText,
  recurringNightText,
  whoName,
} from "./Proposal";
import { RecipeSheet } from "./RecipeSheet";
import { ReadyMadeChip } from "./Recipes";
import { Sheet } from "./Sheet";

/** Which Slot of the Week: its day and meal. */
export type SlotKey = Pick<Slot, "date" | "meal">;

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
  onCook: (recipe: RecipeId, servings: number, slot: SlotKey) => void;
  /** Told the start of the Week shown, or undefined while none is. */
  onWeekShown?: (start: LocalDate | undefined) => void;
  /** Opens on next Week, once the current one has said when that starts, as a notification's link asks. */
  openNext?: boolean;
  /** A banner under the Week's title and switch, such as the Pantry check's nudge. */
  banner?: JSX.Element;
}) {
  const [next, setNext] = createSignal(false);
  const readOnly = () => !props.online;
  // The current Week kept on this device shows at once, and for as long as the household can't be
  // reached; not once it has ended, when it no longer is the current Week. One kept as next is the
  // current one once it has begun.
  const keptCurrent = () => {
    const today = localDate(new Date(), props.household.timezone);
    return savedWeeks().find((saved) => saved.endDate >= today);
  };
  const [week, setWeek] = createSignal<Week | undefined>(keptCurrent());
  // The Week after the current one starts the day after it ends: as loaded, or offline as kept.
  const [loadedNextStart, setNextStart] = createSignal<LocalDate>();
  const nextStart = () => {
    const current = readOnly() ? keptCurrent() : undefined;
    return loadedNextStart() ?? (current && nextWeekStart(current));
  };
  // Next Week as kept on this device shows only while the household can't be reached.
  const keptNext = () => savedWeeks().find((saved) => saved.startDate === nextStart());
  createEffect(() => props.onWeekShown?.(week()?.startDate));
  // Whether a link has opened next Week already: it does so only once.
  let openedNext = false;
  const [error, setError] = createSignal<string>();
  // Names the "use it up" Items a Proposal gives as reasons.
  const items = createItems(props.client);
  const [opened, setOpened] = createSignal<OpenRecipe>();
  // The one Slot whose form is open. A Slot closes only its own form, so a save that finishes
  // after another Slot was opened leaves that one open.
  const [editing, setEditing] = createSignal<SlotKey>();
  const edit = (slot: SlotKey, on: boolean) =>
    setEditing((current) => (on ? slot : current && sameSlot(current, slot) ? undefined : current));
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
    // Next Week shown as kept is the one loaded again on reconnecting.
    if (showNext) setNextStart(nextStart());
    setWeek(showNext ? (readOnly() ? keptNext() : undefined) : keptCurrent());
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
    <section class="screen week-screen" aria-labelledby="week-title">
      <header class="page-header">
        {/* The dates are the title: the switch under it says which Week they are. */}
        <h1 id="week-title" class="week-title">
          {week() ? weekRange(week() as Week, props.household.locale) : t("week.title")}
        </h1>
        <div class="segmented">
          <button type="button" aria-pressed={!next()} onClick={() => show(false)}>
            {t("week.this")}
          </button>
          <button type="button" aria-pressed={next()} disabled={!nextStart()} onClick={() => show(true)}>
            {t("week.next")}
          </button>
        </div>
        {props.banner}
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
                      {/* A dot under a day whose dinner is pencilled, so the rail shows what a Re-roll may change. */}
                      <span
                        class={pencilledOn(shown(), date) ? "day-rail-dot day-rail-dot-on" : "day-rail-dot"}
                        aria-hidden="true"
                      />
                    </button>
                  )}
                </For>
              </nav>
              <ProposalControls
                client={props.client}
                week={shown()}
                items={items()}
                locale={props.household.locale}
                online={props.online}
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
      <Show
        when={week()}
        fallback={
          <Show when={!readOnly()} fallback={<p class="control-reason">{t("app.needsConnection")}</p>}>
            <WeekLoading />
          </Show>
        }
      >
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
                    onEdit={edit}
                    week={shown()}
                    slots={shown().slots.filter((slot) => slot.date === date)}
                  />
                )}
              </For>
            </div>
            <Show when={!readOnly()}>
              <EffortBudgetsEditor client={props.client} household={props.household} week={shown()} />
              <Show when={shown().slots.some(clearable)}>
                <button type="button" class="button-danger" onClick={() => clear(shown())}>
                  {t("week.clear")}
                </button>
              </Show>
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
                onCook={
                  slot().recipe
                    ? (recipe, servings) => props.onCook(recipe, servings, { date: slot().date, meal: slot().meal })
                    : undefined
                }
                onClose={() => setOpened(undefined)}
                slotActions={
                  <Show when={slot().recipe}>
                    <Cooking
                      client={props.client}
                      household={props.household}
                      slot={slot()}
                      readOnly={readOnly()}
                      online={props.online}
                      rate={open.rate}
                      onEdit={() => {
                        setOpened(undefined);
                        edit(open.slot, true);
                      }}
                    />
                  </Show>
                }
              >
                <SlotReason
                  client={props.client}
                  household={props.household}
                  items={items()}
                  slot={slot()}
                  readOnly={readOnly()}
                />
                <SlotConflicts household={props.household} slot={slot()} />
              </RecipeSheet>
            )}
          </Show>
        )}
      </Show>
    </section>
  );
}

/** Whether the day's dinner is marked pencilled, as its card's chip says (ADR 0032). */
function pencilledOn(week: Week, date: LocalDate): boolean {
  return week.slots.some((slot) => slot.date === date && slot.meal === "dinner" && marksPencilled(slot));
}

/**
 * Whether clearing its Week changes the Slot, breakfast and lunch as much as dinner: `clear_week` keeps
 * cooked ones and starts the rest afresh, unlinking Leftovers of them, even in the next Week.
 */
function clearable(slot: Slot): boolean {
  if (slot.cookedAt !== null) return false;
  return (
    slot.kind !== "unplanned" ||
    slot.note !== null ||
    !slot.dinersAreDefault ||
    slot.guests > 0 ||
    slot.guestConstraints.length > 0 ||
    slot.reason !== null ||
    slot.leftovers.length > 0
  );
}

/** The Week's shape in still blocks while it loads: a compact card per day, as they will land. */
function WeekLoading() {
  return (
    <div class="days" aria-busy="true">
      <p class="visually-hidden">{t("week.loading")}</p>
      <For each={[1, 2, 3, 4, 5, 6, 7]}>
        {() => (
          <div class="day" aria-hidden="true">
            <div class="compact">
              <span class="skeleton thumb" />
              <div class="stack">
                <span class="skeleton sk-title-sm" />
                <span class="skeleton sk-meta" />
              </div>
            </div>
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
  onCook: (recipe: RecipeId, servings: number, slot: SlotKey) => void;
  onOpen: (slot: Slot, rate?: boolean) => void;
  editing: SlotKey | undefined;
  onEdit: (slot: SlotKey, editing: boolean) => void;
  /** The Week the day is in. */
  week: Week;
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
      onEdit={(editing) => props.onEdit({ date: props.date, meal }, editing)}
      week={props.week}
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
      {/* Hidden rather than unmounted when folded, so the button that unfolds it controls something there. */}
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
 * A Slot as the Week shows it. A dinner is a compact card: its thumb; its day, with Pencilled, Ready-made
 * or a Conflict beside it; its name and what it's cooked for. Under them are its actions on one line, or,
 * when Change or Choose is its only one, that action at the card's end. Breakfast and lunch are a line
 * each: the meal, what's planned and its one action. Why Mise pencilled a dinner is in its Recipe's sheet,
 * or on the card when it has no Recipe to open. Editing a Slot opens its form in a sheet.
 */
function SlotView(props: {
  client: MiseClient;
  household: Household;
  items: Map<ItemId, Item>;
  slot: Slot;
  /** The day as the card says it, such as "Tonight · Mon 26". */
  day: string;
  today: boolean;
  readOnly: boolean;
  onCook: (recipe: RecipeId, servings: number, slot: SlotKey) => void;
  onOpen: (slot: Slot, rate?: boolean) => void;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  /** The Week the Slot is in. */
  week: Week;
  prominent?: boolean;
}) {
  const meal = () => t(`meal.${props.slot.meal}`);
  const unsafe = () => props.slot.conflicts.find((conflict) => conflict.override === null);
  // A Conflict nobody has overridden flags the dinner: "Robin · Peanut".
  const flag = () => {
    const conflict = unsafe();
    return conflict && conflictChip(conflict, props.household);
  };
  const pencilled = () => marksPencilled(props.slot);
  const keepable = () => !props.readOnly && isKeepable(props.slot);
  // A Slot whose title opens a Recipe's sheet: why Mise pencilled it is said there.
  const openable = () => !!(props.slot.recipe ?? props.slot.leftoversOf?.recipe);
  const rated = () => (props.slot.cookedAt ? props.slot.ratings.at(-1) : undefined);
  const meta = () => (
    <>
      <Show when={cookedForText(props.slot, props.household)}>{(text) => <p class="meta">{text()}</p>}</Show>
      <Show when={props.slot.note}>{(note) => <p class="meta">{note()}</p>}</Show>
      <Show when={!openable() && props.slot.reason}>
        {(reason) => <p class="meta">{reasonText(reason(), props.household, props.items)}</p>}
      </Show>
    </>
  );
  const choose = () => (
    <button type="button" class="button-row" onClick={() => props.onEdit(true)}>
      {/* Leftovers, a meal out or no meal is decided: its one action changes that. */}
      {t(`slot.${props.slot.kind === "unplanned" ? "choose" : "change"}.${props.slot.meal}`)}
    </button>
  );
  const cook = (recipe: SlotRecipe, primary: boolean) => (
    <button
      type="button"
      class={primary ? "button-primary" : "button-row"}
      onClick={() =>
        props.onCook(recipe.id, props.slot.cookFor || recipe.baseServings, {
          date: props.slot.date,
          meal: props.slot.meal,
        })
      }
    >
      <Icon name="pot" />
      {t("kitchen.cook")}
    </button>
  );
  const rateIt = () => (
    <Show when={!props.readOnly}>
      <button type="button" class="button-row" onClick={() => props.onOpen(props.slot, true)}>
        {t("cooking.rateIt")}
      </button>
    </Show>
  );
  const ratedChip = (rating: Rating) => <span class="chip">{t(`rating.${rating}`)}</span>;
  // A decided dinner's one action at its card's end: Change, when it has nothing to cook or keep.
  const cardEnd = () =>
    !props.readOnly && !props.slot.cookedAt && !props.slot.recipe && !keepable() && props.slot.kind !== "unplanned";
  // Nothing planned has Choose on its own line, so its name and why keep the card's width.
  const choosing = () => !props.readOnly && !props.slot.cookedAt && props.slot.kind === "unplanned";
  const hasActions = () => !!props.slot.cookedAt || !!props.slot.recipe || keepable() || choosing();
  const form = () => (
    <Show when={props.editing}>
      <SlotForm
        client={props.client}
        household={props.household}
        slot={props.slot}
        week={props.week}
        day={props.day}
        onDone={() => props.onEdit(false)}
      />
    </Show>
  );

  return (
    <Show
      when={props.prominent}
      fallback={
        <section class="slot meal-row" aria-label={meal()}>
          <div class="meal-row-line">
            <span class="meal-row-label">{meal()}</span>
            <p class={props.slot.kind === "unplanned" ? "meal-row-title meal-row-none" : "meal-row-title"}>
              <OpenTitle slot={props.slot} onOpen={props.onOpen} />
            </p>
            <div class="row-end">
              <Switch fallback={<Show when={!props.readOnly}>{choose()}</Show>}>
                <Match when={rated()}>{(given) => ratedChip(given().rating)}</Match>
                <Match when={props.slot.cookedAt}>
                  <CookedChip />
                  {rateIt()}
                </Match>
                <Match when={props.slot.recipe}>{(recipe) => cook(recipe(), false)}</Match>
              </Switch>
            </div>
          </div>
          {meta()}
          <SlotConflicts household={props.household} slot={props.slot} />
          {form()}
        </section>
      }
    >
      <section class="slot" aria-label={meal()}>
        <div class={cardEnd() ? "compact compact-end" : "compact"}>
          <SlotThumb client={props.client} slot={props.slot} />
          <div class="dish">
            <p class="slot-day">
              <span class={props.today ? "overline overline-today" : "overline"}>{props.day}</span>
              <Show when={pencilled()}>
                <PencilledChip />
              </Show>
              <Show when={props.slot.recipe?.readyMade}>
                <ReadyMadeChip />
              </Show>
              <Show when={flag()}>{(shown) => <span class="chip chip-warn">{shown()}</span>}</Show>
            </p>
            <DishTitle slot={props.slot} onOpen={props.onOpen} pencilled={pencilled()} />
            {meta()}
          </div>
          <Show when={cardEnd()}>
            <div class="row-end">{choose()}</div>
          </Show>
        </div>
        <SlotConflicts household={props.household} slot={props.slot} />
        <Show when={hasActions()}>
          <div class="slot-actions">
            <Switch>
              <Match when={rated()}>{(given) => ratedChip(given().rating)}</Match>
              <Match when={props.slot.cookedAt}>
                <CookedChip />
                {rateIt()}
              </Match>
              <Match when={props.slot.recipe}>
                {(recipe) => (
                  <>
                    {cook(recipe(), true)}
                    {/* While its form is open, the form's Keep is the one. */}
                    <Show when={keepable() && !props.editing}>
                      <KeepButton client={props.client} slot={props.slot} />
                    </Show>
                  </>
                )}
              </Match>
              <Match when={choosing()}>{choose()}</Match>
              <Match when={keepable()}>
                <Show when={!props.editing}>
                  <KeepButton client={props.client} slot={props.slot} />
                </Show>
                {choose()}
              </Match>
            </Switch>
          </div>
        </Show>
        {form()}
      </section>
    </Show>
  );
}

/**
 * Why Mise pencilled a dinner, in its Recipe's sheet: the Pencilled chip, the reason, and Keep to make
 * it the Household's own.
 */
function SlotReason(props: {
  client: MiseClient;
  household: Household;
  items: Map<ItemId, Item>;
  slot: Slot;
  readOnly: boolean;
}) {
  return (
    <Show when={props.slot.reason}>
      {(reason) => (
        <div class="slot-reason">
          <p class="chips">
            <PencilledChip />
          </p>
          <p class="meta">{reasonText(reason(), props.household, props.items)}</p>
          <Show when={!props.readOnly && isKeepable(props.slot)}>
            <KeepButton client={props.client} slot={props.slot} />
          </Show>
        </div>
      )}
    </Show>
  );
}

/**
 * Keeps a pencilled dinner at once, making it the Household's own; the Week refetches without its reason. On
 * the card beside Cook, in the Recipe's sheet under the reason, and in the Slot form beside "Let Mise choose".
 */
function KeepButton(props: { client: MiseClient; slot: Slot }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const keep = async () => {
    setBusy(true);
    const where = { date: props.slot.date, meal: props.slot.meal };
    setError((await outcomeOf(() => props.client.call("keep_slot", where))).failure);
    setBusy(false);
  };
  return (
    <>
      <button type="button" class="button-row" disabled={busy()} onClick={keep}>
        <Icon name="check" />
        {t("slot.keep")}
      </button>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
    </>
  );
}

/**
 * A Slot card's title, opening its Recipe as `OpenTitle` does; tapping the card's thumb does too. A
 * pencilled dinner's is set in italic, as if in pencil.
 */
function DishTitle(props: { slot: Slot; onOpen: (slot: Slot) => void; pencilled: boolean }) {
  return (
    <h3 class={props.pencilled ? "dish-title dish-title-pencilled" : "dish-title"}>
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
 * A card's square: the dish's photo, or with a Leftovers band; a solid fork and knife for eating out;
 * or a dashed box for nothing decided.
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
      <Match when={props.slot.kind === "recipe" && props.slot.recipe}>
        {(recipe) => (
          <span class="thumb" aria-hidden="true">
            <Show when={recipe().photoKey} fallback={<PlateGlyph size={30} />}>
              {(key) => <img src={props.client.photoUrl(recipe().id, key())} alt="" />}
            </Show>
          </span>
        )}
      </Match>
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

/**
 * A Slot with a Recipe, in that Recipe's sheet: marking it cooked; once it is, what ran out, its
 * Ratings and a prompt for one more; and editing it.
 */
function Cooking(props: {
  client: MiseClient;
  household: Household;
  slot: Slot;
  readOnly: boolean;
  online: boolean;
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
          {(recipe) => <RunOut client={props.client} recipeId={recipe().id} online={props.online} />}
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

/** A Slot that Leftovers can be of: its day and meal, and the Recipe it holds. */
type LeftoversChoice = SlotKey & { recipe: Slot["recipe"] };

/**
 * A Slot's form, in a sheet over the Week so it fits the screen: what acts at once at its top, the fields
 * with their labels beside them, and Save and Cancel held at its foot.
 */
function SlotForm(props: {
  client: MiseClient;
  household: Household;
  slot: Slot;
  week: Week;
  /** The day as the card says it, such as "Tonight · Mon 26". */
  day: string;
  onDone: () => void;
}) {
  const { slot } = props;
  const [kind, setKind] = createSignal<SlotKind>(slot.kind);
  const [recipeId, setRecipeId] = createSignal(slot.recipe ? String(slot.recipe.id) : "");
  // Which Slot its Leftovers are of, as `choiceValue` names it; "" for nothing planned in Mise.
  const linkedAtOpen = slot.leftoversOf ? choiceValue(slot.leftoversOf) : "";
  const [leftoversOf, setLeftoversOf] = createSignal(linkedAtOpen);
  // The Week before, once Leftovers are chosen, when the seven days before this meal reach into it.
  const [weekBefore, setWeekBefore] = createSignal<Slot[]>([]);
  const [note, setNote] = createSignal(slot.note ?? "");
  const [diners, setDiners] = createSignal<DinersDraft>({ everyone: slot.dinersAreDefault, diners: slot.diners });
  const [guests, setGuests] = createSignal(String(slot.guests));
  const [guestConstraints, setGuestConstraints] = createSignal<ConstraintDraft[]>(
    constraintDraftsOf(slot.guestConstraints),
  );
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
  // The same meal a week back: the seven days before this meal are the meals after it. A dinner's
  // start the day after; any other meal's, on that day.
  const weekAgo = { date: addDays(slot.date, -7), meal: slot.meal };
  const firstDay = slot.meal === "dinner" ? addDays(slot.date, -6) : weekAgo.date;
  let askedWeekBefore = false;
  createEffect(() => {
    if (kind() !== "leftovers" || askedWeekBefore || firstDay >= props.week.startDate) return;
    askedWeekBefore = true;
    void props.client.call("get_week", { date: firstDay }).then(
      (result) => result.ok && setWeekBefore(result.value.slots),
      () => setError(t("app.error")),
    );
  });

  // Every Slot with a Recipe in the seven days before this meal, cooked or not, newest first: Drafts,
  // which no search finds, can't be linked. The Slot linked already is offered however far back.
  const choices = createMemo((): LeftoversChoice[] => {
    const planned = new Set(recipes().map((recipe) => recipe.id));
    const offered: LeftoversChoice[] = [...weekBefore(), ...props.week.slots].filter(
      (other) => other.recipe && planned.has(other.recipe.id) && isBefore(weekAgo, other) && isBefore(other, slot),
    );
    const current = slot.leftoversOf;
    if (current && !offered.some((other) => sameSlot(other, current))) offered.push(current);
    return offered.sort((a, b) => (isBefore(a, b) ? 1 : -1));
  });
  const chosenLink = () => choices().find((choice) => choiceValue(choice) === leftoversOf());

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
    // After the rest of the change, so that its Conflicts are checked against the Slot as it ends up.
    if (kind() === "leftovers" && leftoversOf() !== linkedAtOpen) {
      const link = chosenLink();
      const of = link ? { date: link.date, meal: link.meal } : null;
      writes.push(() =>
        props.client.call("link_leftovers", { ...where, of, ...(overrides.length > 0 && { overrides }) }),
      );
    }

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

  const [unchanged, setUnchanged] = createSignal<string>();
  const handBack = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await props.client.call("propose_dinner", { date: slot.date });
      setBusy(false);
      if (!result.ok) return setError(errorText(result.error, "slot"));
      const dinner = result.value.week.slots.find((other) => other.date === slot.date && other.meal === "dinner");
      // A Recurring Recipe's night comes back as it was: its rule, not Mise, decides it.
      const recurring = !result.value.changed && dinner && recurringNightText(dinner, props.household.locale);
      if (recurring) return setUnchanged(recurring);
      props.onDone();
    } catch {
      setBusy(false);
      setError(t("app.error"));
    }
  };

  const recipeTitle = () =>
    kind() === "leftovers"
      ? (chosenLink()?.recipe?.title ?? "")
      : (recipes().find((recipe) => String(recipe.id) === recipeId())?.title ?? slot.recipe?.title ?? "");
  const choiceText = (choice: LeftoversChoice) =>
    t(`slot.leftoversOfOption.${choice.meal}`, {
      day: formatDate(choice.date, props.household.locale, { weekday: "long" }),
      title: choice.recipe?.title ?? t("slotKind.unplanned"),
    });

  const titleId = createUniqueId();
  const guestsId = createUniqueId();
  const guestCount = () => Number(guests()) || 0;
  const stepGuests = (by: number) => changing(setGuests)(String(Math.min(50, Math.max(0, guestCount() + by))));

  return (
    <Sheet labelledBy={titleId} onEscape={() => props.onDone()}>
      <div class="sheet-header">
        <div class="page-heading">
          <p class="overline">{t("slot.formOverline", { day: props.day, meal: t(`meal.${slot.meal}`) })}</p>
          <h2 id={titleId} class="dish-title">
            {t(`slot.edit.${slot.meal}`)}
          </h2>
        </div>
        <button type="button" class="icon-button" aria-label={t("slot.close")} onClick={() => props.onDone()}>
          <Icon name="close" />
        </button>
      </div>
      <form class="slot-form sheet-body" aria-label={t(`meal.${slot.meal}`)} onSubmit={save}>
        <Show when={error()}>
          <p class="banner banner-warn" role="alert">
            {error()}
          </p>
        </Show>
        {/* What acts at once, Keep or "Let Mise choose", set apart from the fields that wait for Save. Both go
            by the Slot as the Week now has it: once kept, it has nothing left to keep and can be handed back.
            What's typed stays. */}
        <Show when={isKeepable(props.slot) || canHandBack(props.slot)}>
          <div class="slot-form-now">
            <Show when={isKeepable(props.slot)}>
              <KeepButton client={props.client} slot={props.slot} />
            </Show>
            <Show when={canHandBack(props.slot)}>
              <button
                type="button"
                class="button-row"
                disabled={busy() || unchanged() !== undefined}
                onClick={handBack}
              >
                <Icon name="refresh" />
                {t("slot.letMiseChoose")}
              </button>
            </Show>
          </div>
          <Show when={unchanged()}>
            <p class="banner banner-plum" role="status">
              {unchanged()}
            </p>
          </Show>
        </Show>
        <div class="field-grid">
          <label>
            <span>{t("slot.kind")}</span>
            <select value={kind()} onChange={(e) => changing(setKind)(e.currentTarget.value as SlotKind)}>
              <For each={SLOT_KINDS}>{(option) => <option value={option}>{t(`slotKind.${option}`)}</option>}</For>
            </select>
          </label>
          <Show when={kind() === "recipe"}>
            <label>
              <span>{t("slot.recipe")}</span>
              <select onChange={(e) => changing(setRecipeId)(e.currentTarget.value)}>
                <option value="" selected={recipeId() === ""}>
                  {t("slot.chooseRecipe")}
                </option>
                {/* Selected option by option: the Recipes arrive after the list is drawn. */}
                <For each={recipes()}>
                  {(recipe) => (
                    <option value={String(recipe.id)} selected={recipeId() === String(recipe.id)}>
                      {recipe.title}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <Show when={kind() === "leftovers"}>
            <label>
              <span>{t("slot.leftoversOfMeal")}</span>
              <select onChange={(e) => changing(setLeftoversOf)(e.currentTarget.value)}>
                <option value="" selected={leftoversOf() === ""}>
                  {t("slot.leftoversOfNothing")}
                </option>
                {/* Selected option by option: the Week before may arrive after the list is drawn. */}
                <For each={choices()}>
                  {(choice) => (
                    <option value={choiceValue(choice)} selected={leftoversOf() === choiceValue(choice)}>
                      {choiceText(choice)}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <label>
            <span>{t("slot.note")}</span>
            <input maxLength={500} value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
          </label>
        </div>
        <DinersFields members={props.household.members} draft={diners()} onChange={changing(setDiners)} />
        {/* Guests by a step either side, and their Constraints only once there are Guests to have them. */}
        <div class="field-grid">
          <div class="field-row">
            <label for={guestsId}>{t("slot.guests")}</label>
            <span class="stepper">
              <button
                type="button"
                class="icon-button"
                aria-label={t("slot.guestsFewer")}
                disabled={guestCount() <= 0}
                onClick={() => stepGuests(-1)}
              >
                <Icon name="minus" />
              </button>
              <input
                id={guestsId}
                type="number"
                min={0}
                max={50}
                value={guests()}
                onInput={(e) => changing(setGuests)(e.currentTarget.value)}
              />
              <button
                type="button"
                class="icon-button"
                aria-label={t("slot.guestsMore")}
                disabled={guestCount() >= 50}
                onClick={() => stepGuests(1)}
              >
                <Icon name="plus" />
              </button>
            </span>
          </div>
        </div>
        <Show when={guestCount() > 0 || guestConstraints().length > 0}>
          <fieldset>
            <legend>{t("slot.guestConstraints")}</legend>
            <ConstraintFields constraints={guestConstraints()} onChange={changing(setGuestConstraints)} />
          </fieldset>
        </Show>
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
    </Sheet>
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

/**
 * Who's eating, as chips that toggle. "Everyone" follows the Household's default; untick a Member from it
 * to choose them one by one, starting from everyone else.
 */
function DinersFields(props: { members: Member[]; draft: DinersDraft; onChange: (draft: DinersDraft) => void }) {
  const eating = (id: MemberId) => props.draft.everyone || props.draft.diners.includes(id);
  const toggle = (id: MemberId, on: boolean) => {
    const before = props.draft.everyone ? props.members.map((member) => member.id) : props.draft.diners;
    props.onChange({ everyone: false, diners: on ? [...before, id] : before.filter((diner) => diner !== id) });
  };

  return (
    <fieldset class="field">
      <legend>{t("slot.diners")}</legend>
      <div class="chips">
        <label class="toggle-chip">
          <input
            type="checkbox"
            checked={props.draft.everyone}
            onChange={(e) => props.onChange({ ...props.draft, everyone: e.currentTarget.checked })}
          />
          {t("slot.everyone")}
        </label>
        <For each={props.members}>
          {(member) => (
            <label class="toggle-chip">
              <input
                type="checkbox"
                checked={eating(member.id)}
                onChange={(e) => toggle(member.id, e.currentTarget.checked)}
              />
              <span class="name">{nameText(member.name)}</span>
            </label>
          )}
        </For>
      </div>
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

/**
 * What a Slot's Recipe is cooked for, when that isn't plain: with its Leftovers, for more or fewer than the
 * Recipe makes, and with how many Guests, whom the day's strip doesn't count.
 */
function cookedForText(slot: Slot, household: Household): string | undefined {
  if (!slot.recipe) return undefined;
  if (slot.leftovers.length > 0) return cookForText(slot, household);
  if (slot.servings === 0) return undefined;
  const parts = [
    slot.servings !== slot.recipe.baseServings &&
      t("slot.forRecipe", { count: String(slot.servings), base: String(slot.recipe.baseServings) }),
    slot.guests > 0 && (slot.guests === 1 ? t("slot.withGuest") : t("slot.withGuests", { count: String(slot.guests) })),
  ].filter((part) => part !== false);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function sameSlot(slot: SlotKey, other: SlotKey): boolean {
  return slot.date === other.date && slot.meal === other.meal;
}

/** Whether `slot` is an earlier meal than `other`. */
function isBefore(slot: SlotKey, other: SlotKey): boolean {
  return slot.date < other.date || (slot.date === other.date && MEALS.indexOf(slot.meal) < MEALS.indexOf(other.meal));
}

/** A Slot as a "Leftovers of" option's value names it. */
function choiceValue(slot: SlotKey): string {
  return `${slot.date}/${slot.meal}`;
}

/** Where the day rail jumps to. */
function dayId(date: LocalDate): string {
  return `day-${date}`;
}

/** The day as its card says it: "Mon 26", or "Tonight · Mon 26". */
function dayLabel(date: LocalDate, locale: Locale, today: boolean): string {
  const day = formatDate(date, locale, { weekday: "short", day: "numeric" });
  return today ? t("week.tonight", { day }) : day;
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
