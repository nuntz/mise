import {
  addDays,
  type ConflictWho,
  type EffortBudgets,
  type Household,
  type Item,
  type ItemId,
  isPencilled,
  isRerollable,
  type Locale,
  type ProposalReason,
  type ProposedWeek,
  type ReasonFactor,
  type Slot,
  type ToolResult,
  WEEKDAYS,
  type Week,
  type Weekday,
  weekdayOf,
} from "@mise/domain";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import { dayInitial, formatDate } from "./dates";
import { errorText } from "./errors";
import { Icon } from "./icons";
import { itemNamed } from "./items";
import { t } from "./messages";
import { NeedsConnection } from "./NeedsConnection";
import { Sheet } from "./Sheet";

/** What the Week, and proposing it, need to know of the Household. */
export type WeekHousehold = Pick<Household, "members" | "locale" | "effortBudgets" | "timezone">;

/**
 * Proposing the Week and re-rolling it. A Week with nothing planned yet shows as empty, with proposing it the one thing to do.
 * The Week keeps its Use it up (ADR 0030): proposing first offers it, and beside Re-roll it can be changed.
 */
export function ProposalControls(props: {
  client: MiseClient;
  week: Week;
  items: Map<ItemId, Item>;
  locale: Locale;
  online: boolean;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  // What the Use it up sheet has picked so far: stored only on saving or proposing, not on Cancel.
  const [draft, setDraft] = createSignal<ItemId[]>();
  const proposed = () => props.week.proposalSeed !== null;
  const empty = () => nothingPlanned(props.week);

  // What a Re-roll or a Use it up change that left every dinner as it was says about it.
  const [unchanged, setUnchanged] = createSignal<string>();

  const run = async <T,>(call: () => Promise<ToolResult<T>>, ifUnchanged?: (value: T) => string | undefined) => {
    setBusy(true);
    setUnchanged(undefined);
    try {
      const result = await call();
      setError(result.ok ? undefined : errorText(result.error, "slot"));
      if (result.ok) setUnchanged(ifUnchanged?.(result.value));
    } catch {
      setError(t("app.error"));
    }
    setBusy(false);
  };
  const date = () => props.week.startDate;
  const reroll = () =>
    run(
      () => props.client.call("propose_week", { date: date(), reroll: true }),
      ({ week, changed }) =>
        changed
          ? undefined
          : // A Recurring Recipe's night stays as its rule has it, as "Let Mise choose" says too.
            [
              t("week.nothingToReroll"),
              ...week.slots.flatMap((slot) => recurringNightText(slot, props.locale) ?? []),
            ].join(" "),
    );
  const setUseUp = (items: ItemId[]) => props.client.call("set_use_up", { date: date(), items });
  const changeUseUp = (items: ItemId[]) =>
    run(
      () => setUseUp(items),
      ({ changed }: ProposedWeek) =>
        changed || items.length === 0
          ? undefined
          : t("useUp.unchanged", {
              items: new Intl.ListFormat(props.locale, { type: "conjunction" }).format(items.map(nameOf)),
            }),
    );
  // Proposing stores the Items first, so that the Proposal favours them.
  const proposeWith = (items: ItemId[]) =>
    run(async () => {
      const stored = await setUseUp(items);
      return stored.ok ? props.client.call("propose_week", { date: date() }) : stored;
    });
  const offerUseUp = () => setDraft(props.week.useUp);
  const nameOf = (id: ItemId) => props.items.get(id)?.name ?? id;
  const disabled = () => busy() || !props.online;
  // Re-roll is offered only when it can change a dinner, and says so under it when it can't.
  const canReroll = () => props.week.slots.some((slot) => slot.meal === "dinner" && isRerollable(slot));
  const titleId = createUniqueId();
  // Proposing needs the connection, and offline says so under the control.
  const reasonId = createUniqueId();
  const describedBy = () => (props.online ? undefined : reasonId);
  const allYoursId = createUniqueId();
  const rerollDescribedBy = () => describedBy() ?? (canReroll() ? undefined : allYoursId);
  const proposeButton = () => (
    <button
      type="button"
      class="button-primary"
      disabled={disabled()}
      aria-describedby={describedBy()}
      onClick={offerUseUp}
    >
      {t("week.propose")}
    </button>
  );

  return (
    <>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Show
        when={!empty()}
        fallback={
          <div class="empty">
            <Icon name="calendarPlus" />
            <p class="empty-title">{t("week.emptyTitle")}</p>
            <p>{t("week.emptyBody")}</p>
            <div class="control">
              {proposeButton()}
              <NeedsConnection id={reasonId} online={props.online} />
            </div>
          </div>
        }
      >
        <Show when={proposed()} fallback={proposeButton()}>
          {/* Re-roll and Use it up, the same size side by side: neither outranks the Week under them. */}
          <div class="proposal-tools">
            <button
              type="button"
              class="button-row"
              disabled={disabled() || !canReroll()}
              aria-describedby={rerollDescribedBy()}
              onClick={reroll}
            >
              <Icon name="refresh" />
              {t("week.reroll")}
            </button>
            <button
              type="button"
              class="button-row proposal-use-up"
              disabled={disabled()}
              aria-describedby={describedBy()}
              onClick={offerUseUp}
            >
              <Icon name="sprout" />
              <span>
                {props.week.useUp.length > 0
                  ? t("useUp.change", { items: props.week.useUp.map(nameOf).join(", ") })
                  : t("useUp.none")}
              </span>
            </button>
          </div>
        </Show>
        <Show when={!props.online || proposed()}>
          <div class="proposal-notes">
            <NeedsConnection id={reasonId} online={props.online} />
            <Show when={props.online && proposed()}>
              <Show
                when={canReroll()}
                fallback={
                  <p id={allYoursId} class="control-reason">
                    {t("week.rerollAllYours")}
                  </p>
                }
              >
                {/* The chip each pencilled dinner carries, as the key to what Re-roll changes. */}
                <p class="control-reason proposal-hint">
                  <PencilledChip />
                  {t("week.proposeHint")}
                </p>
              </Show>
            </Show>
          </div>
        </Show>
        {/* The answer to what was just tapped, not standing copy. */}
        <Show when={unchanged()}>
          <p class="banner banner-plum" role="status">
            {unchanged()}
          </p>
        </Show>
      </Show>
      <Show when={props.online && draft()}>
        {(picked) => (
          <Sheet labelledBy={titleId} onEscape={() => setDraft(undefined)} focusField={false}>
            <div class="sheet-header">
              <div class="page-heading">
                <h2 id={titleId} class="dish-title">
                  {t("useUp.title")}
                </h2>
              </div>
            </div>
            <div class="sheet-body">
              <UseUpPicker items={props.items} picked={picked()} onChange={setDraft} />
              <button
                type="button"
                class="button-primary"
                disabled={disabled()}
                onClick={() => {
                  const items = picked();
                  setDraft(undefined);
                  void (proposed() ? changeUseUp(items) : proposeWith(items));
                }}
              >
                {proposed() ? t("useUp.save") : t("week.propose")}
              </button>
              <button type="button" class="button-quiet" onClick={() => setDraft(undefined)}>
                {t("slot.cancel")}
              </button>
            </div>
          </Sheet>
        )}
      </Show>
    </>
  );
}

/**
 * Whether the Week marks the Slot as pencilled: Mise chose it and a Re-roll could still change it (ADR 0032),
 * so the chip keeps the promise of the line under Re-roll. A dinner nobody is eating, left unplanned, or one
 * already cooked has a reason but nothing for a Re-roll to change.
 */
export function marksPencilled(slot: Slot): boolean {
  return isPencilled(slot) && isRerollable(slot);
}

/** Whether the Week is yet to be planned: never proposed, and no dinner chosen by hand. */
export function nothingPlanned(week: Week): boolean {
  return week.proposalSeed === null && week.slots.every((slot) => slot.meal !== "dinner" || slot.kind === "unplanned");
}

/** What marks a pencilled dinner on the Week: Mise chose it, and a Re-roll may change it (ADR 0032). */
export function PencilledChip() {
  return (
    <span class="chip chip-plum">
      <Icon name="pencil" size={14} />
      {t("slot.pencilled")}
    </span>
  );
}

/**
 * What to say of a dinner Mise gave a Recurring Recipe, when a Proposal couldn't change it: its rule, not
 * Mise, decides it. Nothing for any other dinner.
 */
export function recurringNightText(slot: Slot, locale: Locale): string | undefined {
  const { reason, recipe } = slot;
  if (slot.meal !== "dinner" || reason?.kind !== "recurring" || !recipe) return undefined;
  return reason.recurrence === "weekly"
    ? t("slot.recurringWeekly", { title: recipe.title })
    : t("slot.recurringNight", { day: formatDate(slot.date, locale, { weekday: "long" }), title: recipe.title });
}

/** Items on hand to use up, picked by name or alias from the Item catalogue. */
function UseUpPicker(props: { items: Map<ItemId, Item>; picked: ItemId[]; onChange: (picked: ItemId[]) => void }) {
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string>();
  const list = createUniqueId();

  const add = (event: SubmitEvent) => {
    event.preventDefault();
    const item = itemNamed(props.items.values(), name());
    if (!item) {
      setError(t("useUp.noSuchItem", { name: name().trim() }));
      return;
    }
    setError(undefined);
    setName("");
    if (!props.picked.includes(item.id)) props.onChange([...props.picked, item.id]);
  };
  const nameOf = (id: ItemId) => props.items.get(id)?.name ?? id;

  return (
    <form aria-label={t("useUp.title")} onSubmit={add}>
      <p class="meta">{t("useUp.hint")}</p>
      <Show when={props.picked.length > 0}>
        <ul class="rows">
          <For each={props.picked}>
            {(id) => (
              <li>
                <span class="row-body">{nameOf(id)}</span>
                <button
                  type="button"
                  class="button-row"
                  aria-label={t("useUp.removeItem", { name: nameOf(id) })}
                  onClick={() => props.onChange(props.picked.filter((other) => other !== id))}
                >
                  {t("useUp.remove")}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <label>
        {t("useUp.item")}
        <input list={list} required value={name()} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <datalist id={list}>
        <For each={[...props.items.values()]}>{(item) => <option value={item.name} />}</For>
      </datalist>
      <button type="submit" class="button-secondary">
        {t("useUp.add")}
      </button>
    </form>
  );
}

/**
 * The Effort Budgets, folded to one line that says them. Open, a grid of the week's days: a row for this
 * Week, whose differences from the Household's override them, and a row for every Week, with one Save.
 */
export function EffortBudgetsEditor(props: { client: MiseClient; household: WeekHousehold; week: Week }) {
  const [typed, setTyped] = createSignal<{
    week: Partial<Record<Weekday, string>>;
    every: Partial<Record<Weekday, string>>;
  }>({ week: {}, every: {} });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const value = (row: "week" | "every", weekday: Weekday) =>
    typed()[row][weekday] ??
    String(row === "week" ? props.week.effortBudgets[weekday] : props.household.effortBudgets[weekday]);
  const type = (row: "week" | "every", weekday: Weekday, text: string) =>
    setTyped({ ...typed(), [row]: { ...typed()[row], [weekday]: text } });
  const changed = (row: "week" | "every", budgets: EffortBudgets) =>
    Object.fromEntries(
      WEEKDAYS.flatMap((weekday) =>
        Number(value(row, weekday)) === budgets[weekday] ? [] : [[weekday, Number(value(row, weekday))]],
      ),
    ) as Partial<EffortBudgets>;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const week = changed("week", props.week.effortBudgets);
    const every = changed("every", props.household.effortBudgets);
    const writes: (() => Promise<ToolResult<unknown>>)[] = [];
    // Every Week's first, so that this Week's are compared with the Household's budgets as saved.
    if (Object.keys(every).length > 0) writes.push(() => props.client.call("set_effort_budgets", { budgets: every }));
    if (Object.keys(week).length > 0)
      writes.push(() =>
        props.client.call("set_week_effort_budgets", {
          date: props.week.startDate,
          // The Household's own budget, as the Every Week row now has it, is no override.
          budgets: Object.fromEntries(
            Object.entries(week).map(([weekday, minutes]) => [
              weekday,
              minutes === Number(value("every", weekday as Weekday)) ? null : minutes,
            ]),
          ),
        }),
      );
    if (writes.length === 0) return;
    setBusy(true);
    try {
      for (const write of writes) {
        const result = await write();
        if (!result.ok) {
          setError(errorText(result.error, "slot"));
          setBusy(false);
          return;
        }
      }
      setError(undefined);
      setTyped({ week: {}, every: {} });
    } catch {
      setError(t("app.error"));
    }
    setBusy(false);
  };

  // The Week's own days, in its order, as its cards above have them.
  const days = () => Array.from({ length: 7 }, (_, offset) => addDays(props.week.startDate, offset));
  // This Week's budget where it differs from every Week's.
  const overridden = (weekday: Weekday) => props.week.effortBudgets[weekday] !== props.household.effortBudgets[weekday];
  const row = (which: "week" | "every") => (
    <fieldset class="field budget-row">
      <legend>{t(which === "week" ? "effort.thisWeek" : "effort.everyWeek")}</legend>
      <div class="budget-cells">
        <For each={days().map(weekdayOf)}>
          {(weekday) => (
            <input
              type="number"
              inputMode="numeric"
              class={which === "week" && overridden(weekday) ? "budget-overridden" : undefined}
              aria-label={t(`weekday.${weekday}`)}
              required
              min={0}
              max={24 * 60}
              value={value(which, weekday)}
              onInput={(e) => type(which, weekday, e.currentTarget.value)}
            />
          )}
        </For>
      </div>
    </fieldset>
  );

  return (
    <details class="effort-budgets">
      <summary class="section-head">
        <h2>{t("effort.title")}</h2>
        <span class="meta">{effortSummary(props.week.effortBudgets)}</span>
      </summary>
      <form class="stack" aria-label={t("effort.title")} onSubmit={submit}>
        <p class="meta">{t("effort.hint")}</p>
        <Show when={error()}>
          <p class="banner banner-warn" role="alert">
            {error()}
          </p>
        </Show>
        <div class="budget-cells budget-days" aria-hidden="true">
          <For each={days()}>{(date) => <span>{dayInitial(date, props.household.locale)}</span>}</For>
        </div>
        {row("week")}
        {row("every")}
        <div class="budget-foot">
          <p class="meta">
            <span class="budget-key" aria-hidden="true" />
            {t("effort.overriddenKey")}
          </p>
          <button type="submit" class="button-secondary" disabled={busy()}>
            {busy() ? t("slot.saving") : t("slot.save")}
          </button>
        </div>
      </form>
    </details>
  );
}

/** The Week's Effort Budgets in a few words: one for every day, weekdays and weekends, or each day's. */
function effortSummary(budgets: EffortBudgets): string {
  const minutes = WEEKDAYS.map((weekday) => budgets[weekday]);
  const [first = 0] = minutes;
  if (minutes.every((each) => each === first)) return t("effort.summaryEvery", { minutes: String(first) });
  const weekdays = minutes.slice(0, 5);
  const weekend = minutes.slice(5);
  if (weekdays.every((each) => each === first) && weekend.every((each) => each === weekend[0]))
    return t("effort.summaryWeekend", { weekdays: String(first), weekend: String(weekend[0]) });
  return t("effort.summaryEach", { minutes: minutes.join(" · ") });
}

/** A Member by name, or the Guests. */
export function whoName(who: ConflictWho, household: Pick<Household, "members">): string {
  if (who === "guests") return t("conflict.guests");
  return household.members.find((member) => member.id === who)?.name ?? String(who);
}

/** Why Mise chose a pencilled dinner as it did, as a sentence. */
export function reasonText(
  reason: ProposalReason,
  household: Pick<Household, "members" | "locale">,
  items: Map<ItemId, Item>,
): string {
  const list = (parts: string[]) => new Intl.ListFormat(household.locale, { type: "conjunction" }).format(parts);
  switch (reason.kind) {
    case "nobody_eating":
      return t("reason.nobodyEating");
    case "leftovers":
      return t("reason.leftovers", { day: t(`weekday.${weekdayOf(reason.of)}`) });
    case "recurring":
      return reason.recurrence === "weekly"
        ? t("reason.recurringWeekly")
        : t("reason.recurringWeekday", { weekday: t(`weekday.${reason.recurrence.weekday}`) });
    case "chosen": {
      const factors = reason.factors.map((factor) => factorText(factor, household, items, list)).join("; ");
      return reason.candidates === 1
        ? t("reason.chosenOnly", { factors })
        : t("reason.chosen", { count: String(reason.candidates), factors });
    }
    case "no_candidate": {
      const { excluded } = reason;
      const why = [
        excluded.conflict > 0 && t("reason.excludedConflict", { count: String(excluded.conflict) }),
        excluded.never > 0 && t("reason.excludedNever", { count: String(excluded.never) }),
        excluded.course > 0 && t("reason.excludedCourse", { count: String(excluded.course) }),
        excluded.recent > 0 && t("reason.excludedRecent", { count: String(excluded.recent) }),
        excluded.effort > 0 && t("reason.excludedEffort", { count: String(excluded.effort) }),
      ].filter((part): part is string => typeof part === "string");
      return why.length > 0 ? t("reason.noCandidate", { why: why.join(", ") }) : t("reason.noRecipes");
    }
  }
}

function factorText(
  factor: ReasonFactor,
  household: Pick<Household, "members">,
  items: Map<ItemId, Item>,
  list: (parts: string[]) => string,
): string {
  switch (factor.kind) {
    case "recency":
      return factor.daysApart === null ? t("reason.notRecent") : t("reason.recent", { days: String(factor.daysApart) });
    case "effort":
      return factor.minutes === null
        ? t("reason.effortUnknown")
        : t("reason.effort", { minutes: String(factor.minutes), budget: String(factor.budget) });
    case "rating":
      return t(factor.rating === "again" ? "reason.again" : "reason.meh");
    case "imported_preference":
      return t(factor.preference === "positive" ? "reason.likedBefore" : "reason.dislikedBefore");
    case "uses_up":
      return t("reason.usesUp", { items: list(factor.items.map((id) => items.get(id)?.name ?? id)) });
    case "disliked":
      return t("reason.dislikedBy", { who: list(factor.by.map((who) => whoName(who, household))) });
    case "repeats_protein":
      return t("reason.repeatsProtein", { protein: factor.protein });
    case "repeats_cuisine":
      return t("reason.repeatsCuisine", { cuisine: factor.cuisine });
  }
}
