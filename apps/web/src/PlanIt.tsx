import {
  isPencilled,
  localDate,
  MEALS,
  type Meal,
  nextWeekStart,
  type Override,
  type Recipe,
  type RecipeId,
  type RefusedConflict,
  type Slot,
  type Week,
} from "@mise/domain";
import { type Accessor, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";
import { NeedsConnection } from "./NeedsConnection";
import { type WeekHousehold as Household, marksPencilled, PencilledChip } from "./Proposal";
import { Sheet } from "./Sheet";
import {
  ConflictOverrides,
  CookedChip,
  conflictText,
  dayLabel,
  outcomeOf,
  overridesOf,
  type SlotKey,
  SlotThumb,
  sameSlot,
  slotTitle,
} from "./Week";

/** This Week and Next Week. */
export type PlanWeeks = readonly [Week, Week];

/** This Week and Next Week as the household has them, kept fresh; undefined until both have loaded. */
export function createPlanWeeks(client: MiseClient): Accessor<PlanWeeks | undefined> {
  const [weeks, setWeeks] = createSignal<PlanWeeks>();
  // Slots show their Recipes' titles, and the Household's week start says where Next Week starts.
  keepFresh(
    client,
    ["plan", "recipes", "household"],
    async (): Promise<PlanWeeks | undefined> => {
      const thisWeek = await client.call("get_week", {});
      if (!thisWeek.ok) return undefined;
      const nextWeek = await client.call("get_week", { date: nextWeekStart(thisWeek.value) });
      return nextWeek.ok ? [thisWeek.value, nextWeek.value] : undefined;
    },
    (loaded) => loaded && setWeeks(loaded),
  );
  return weeks;
}

/**
 * Where the Recipe is planned from today to the end of Next Week, any meal, in date order, as a plum
 * banner: "On the plan: dinner on Fri 13 and lunch on Wed 18." Show the Week opens the Week holding the
 * first. Nothing while it's planned nowhere; days before today are history.
 */
export function OnThePlan(props: {
  household: Household;
  weeks: PlanWeeks;
  recipe: RecipeId;
  /** Opens This Week, or Next Week when `next`. */
  onWeek: (next: boolean) => void;
}) {
  const planned = createMemo(() => {
    const today = localDate(new Date(), props.household.timezone);
    return props.weeks
      .flatMap((week) => week.slots)
      .filter((slot) => slot.recipe?.id === props.recipe && slot.date >= today);
  });
  const text = () => {
    const slots = planned().map((slot) =>
      t(`plan.slot.${slot.meal}`, { day: dayLabel(slot.date, props.household.locale, false) }),
    );
    return t("plan.onThePlan", {
      slots: new Intl.ListFormat(props.household.locale, { type: "conjunction" }).format(slots),
    });
  };
  return (
    <Show when={planned()[0]}>
      {(first) => (
        <div class="banner banner-plum" role="status">
          <p>{text()}</p>
          <button type="button" onClick={() => props.onWeek(first().date >= props.weeks[1].startDate)}>
            {t("plan.showWeek")}
          </button>
        </div>
      )}
    </Show>
  );
}

/**
 * Plan it: a secondary that opens the day list for putting the Recipe on This Week or Next Week. Offline it
 * is disabled, with the reason under it: a change to a Slot can be refused for a Conflict, so it isn't queued.
 */
export function PlanIt(props: {
  client: MiseClient;
  household: Household;
  online: boolean;
  recipe: Recipe;
  weeks: PlanWeeks | undefined;
}) {
  const [open, setOpen] = createSignal(false);
  const reasonId = createUniqueId();
  return (
    <>
      <button
        type="button"
        class="button-secondary"
        disabled={!props.online || !props.weeks}
        aria-describedby={props.online ? undefined : reasonId}
        onClick={() => setOpen(true)}
      >
        <Icon name="calendarPlus" />
        {t("plan.planIt")}
      </button>
      <NeedsConnection id={reasonId} online={props.online} />
      <Show when={open() && props.weeks}>
        {(weeks) => (
          <PlanSheet
            client={props.client}
            household={props.household}
            recipe={props.recipe}
            weeks={weeks()}
            onClose={() => setOpen(false)}
          />
        )}
      </Show>
    </>
  );
}

/**
 * Which day? The days of This Week or Next Week from today on, each as a row laid out like the Week's card
 * for the meal chosen. Nothing planned and a pencilled dinner are planned in one tap; one of the
 * Household's own asks first; a cooked one can't be picked. A Conflict asks for its reasons over the list,
 * as the Week's Slot form does (ADR 0012). The Diners and Guests stay as they are.
 */
function PlanSheet(props: {
  client: MiseClient;
  household: Household;
  recipe: Recipe;
  weeks: PlanWeeks;
  onClose: () => void;
}) {
  // The sheet's today is the day it opened on.
  const today = localDate(new Date(), props.household.timezone);
  const [meal, setMeal] = createSignal<Meal>(props.recipe.course === "breakfast" ? "breakfast" : "dinner");
  // A cooked meal is history; one of the Household's own that is this Recipe already has nothing to change.
  const pickable = (slot: Slot) =>
    slot.cookedAt === null && !(slot.recipe?.id === props.recipe.id && !isPencilled(slot));
  const daysOf = (week: Week) => week.slots.filter((slot) => slot.meal === meal() && slot.date >= today);
  // Opens on This Week, or on Next Week once This Week has no day left to plan.
  const [next, setNext] = createSignal(!daysOf(props.weeks[0]).some(pickable));
  const shown = () => props.weeks[next() ? 1 : 0];
  const [replacing, setReplacing] = createSignal<SlotKey>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [refused, setRefused] = createSignal<{ slot: SlotKey; conflicts: RefusedConflict[] }>();
  const [reasons, setReasons] = createSignal<Record<string, string>>({});
  // A save that answers once the sheet has closed leaves whatever is open by then alone.
  let closed = false;
  onCleanup(() => {
    closed = true;
  });

  const plan = async (slot: SlotKey, overrides: Override[] = []) => {
    setBusy(true);
    setError(undefined);
    const outcome = await outcomeOf(() =>
      props.client.call("set_slot", {
        date: slot.date,
        meal: slot.meal,
        kind: "recipe",
        recipeId: props.recipe.id,
        ...(overrides.length > 0 && { overrides }),
      }),
    );
    if (closed) return;
    setBusy(false);
    if (outcome.conflicts) return setRefused({ slot, conflicts: outcome.conflicts });
    if (outcome.failure) return setError(outcome.failure);
    // The plan's change notice refetches the Weeks, so the page's On the plan line shows it.
    props.onClose();
  };
  const pick = (slot: Slot) => {
    if (slot.kind === "unplanned" || isPencilled(slot)) void plan(slot);
    else setReplacing({ date: slot.date, meal: slot.meal });
  };
  const isReplacing = (slot: Slot) => {
    const current = replacing();
    return current !== undefined && sameSlot(current, slot);
  };
  // Another Week or meal shows other days: a Replace asked on one of these, or an error, goes.
  const switchTo = (change: () => void) => {
    setReplacing(undefined);
    setError(undefined);
    change();
  };
  // Who's eating, counted as the Week's day counts them: the Diners.
  const eating = (slot: Slot) => {
    const count = slot.diners.length;
    if (count === 0) return t("week.eatingNone");
    return count === 1 ? t("week.eatingOne") : t("week.eating", { count: String(count) });
  };
  const day = (slot: Slot) => {
    const label = dayLabel(slot.date, props.household.locale, slot.date === today && slot.meal === "dinner");
    if (slot.date !== today || slot.meal === "dinner") return label;
    return t("plan.today", { day: dayLabel(slot.date, props.household.locale, false) });
  };

  const titleId = createUniqueId();
  return (
    <Sheet labelledBy={titleId} onEscape={() => props.onClose()} focusField={false}>
      <div class="sheet-header">
        <div class="page-heading">
          <p class="overline">{props.recipe.title}</p>
          <h2 id={titleId} class="dish-title">
            {t("plan.title")}
          </h2>
        </div>
        <button type="button" class="icon-button" aria-label={t("slot.close")} onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </div>
      <div class="sheet-body">
        <div class="segmented">
          {/* Not while a save is out: its answer is for the days shown when it was asked. */}
          <button type="button" aria-pressed={!next()} disabled={busy()} onClick={() => switchTo(() => setNext(false))}>
            {t("week.this")}
          </button>
          <button type="button" aria-pressed={next()} disabled={busy()} onClick={() => switchTo(() => setNext(true))}>
            {t("week.next")}
          </button>
        </div>
        <div class="segmented">
          <For each={MEALS}>
            {(each) => (
              <button
                type="button"
                aria-pressed={meal() === each}
                disabled={busy()}
                onClick={() => switchTo(() => setMeal(each))}
              >
                {t(`meal.${each}`)}
              </button>
            )}
          </For>
        </div>
        <Show when={error()}>
          <p class="banner banner-warn" role="alert">
            {error()}
          </p>
        </Show>
        <ul class="rows">
          <For each={daysOf(shown())}>
            {(slot) => (
              <li>
                <button
                  type="button"
                  class="row row-open plan-row"
                  disabled={busy() || !pickable(slot)}
                  onClick={() => pick(slot)}
                >
                  <span class="row-lead">
                    <SlotThumb client={props.client} slot={slot} />
                  </span>
                  <span class="row-body">
                    <span class="slot-day">
                      <span class="overline" classList={{ "overline-today": slot.date === today }}>
                        {day(slot)}
                      </span>
                      <Show when={marksPencilled(slot)}>
                        <PencilledChip />
                      </Show>
                      <Show when={slot.cookedAt}>
                        <CookedChip />
                      </Show>
                    </span>
                    <span
                      class="dish-title"
                      classList={{
                        "dish-title-pencilled": marksPencilled(slot),
                        "dish-title-none": slot.kind === "unplanned",
                      }}
                    >
                      {slotTitle(slot)}
                    </span>
                    <span class="row-meta">{eating(slot)}</span>
                  </span>
                </button>
                <Show when={isReplacing(slot)}>
                  <div class="plan-confirm">
                    <p>{t("plan.yours", { title: slotTitle(slot), recipe: props.recipe.title })}</p>
                    <div class="actions">
                      <button type="button" class="button-primary" disabled={busy()} onClick={() => void plan(slot)}>
                        {t("plan.replace", { title: slotTitle(slot) })}
                      </button>
                      <button type="button" class="button-quiet" onClick={() => setReplacing(undefined)}>
                        {t("slot.cancel")}
                      </button>
                    </div>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
        {/* A Proposal fills dinners only (ADR 0030). */}
        <Show when={next() && meal() === "dinner" && shown().proposalSeed === null}>
          <p class="meta">{t("plan.nextNotProposed")}</p>
        </Show>
      </div>
      {/* The refusal's Save anyway submits this form, as it does the Week's Slot form. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const refusal = refused();
          const overrides = refusal && overridesOf(refusal.conflicts, reasons());
          if (refusal && overrides) void plan(refusal.slot, overrides);
        }}
      >
        <ConflictOverrides
          household={props.household}
          conflicts={refused()?.conflicts ?? []}
          describe={(conflict) => conflictText(conflict, props.household, props.recipe.title)}
          reasons={reasons()}
          busy={busy()}
          onChange={setReasons}
          onChangeIt={() => {
            setRefused(undefined);
            setReasons({});
          }}
          onCancel={() => props.onClose()}
        />
      </form>
    </Sheet>
  );
}
