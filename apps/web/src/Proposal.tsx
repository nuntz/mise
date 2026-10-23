import {
  type ConflictWho,
  type EffortBudgets,
  type Household,
  type Item,
  type ItemId,
  type ProposalReason,
  type ReasonFactor,
  type ToolResult,
  WEEKDAYS,
  type Week,
  type Weekday,
} from "@mise/domain";
import { createSignal, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { t } from "./messages";

/** What the Week, and proposing it, need to know of the Household. */
export type WeekHousehold = Pick<Household, "members" | "locale" | "effortBudgets">;

/**
 * Proposing the Week and re-rolling it, and, while a proposed Week hasn't been looked over, a banner
 * asking for that.
 */
export function ProposalControls(props: { client: MiseClient; week: Week }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const proposed = () => props.week.proposalSeed !== null;

  const run = async (call: () => Promise<ToolResult<unknown>>) => {
    setBusy(true);
    try {
      const result = await call();
      setError(result.ok ? undefined : errorText(result.error, "slot"));
    } catch {
      setError(t("app.error"));
    }
    setBusy(false);
  };
  const date = () => props.week.startDate;

  return (
    <div>
      <Show when={proposed() && !props.week.reviewed}>
        <div role="status">
          <p>{t("week.unreviewed")}</p>
          <button
            type="button"
            disabled={busy()}
            onClick={() => run(() => props.client.call("review_week", { date: date(), reviewed: true }))}
          >
            {t("week.markReviewed")}
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <button
        type="button"
        disabled={busy()}
        onClick={() => run(() => props.client.call("propose_week", { date: date() }))}
      >
        {t("week.propose")}
      </button>
      <Show when={proposed()}>
        <button
          type="button"
          disabled={busy()}
          onClick={() => run(() => props.client.call("propose_week", { date: date(), reroll: true }))}
        >
          {t("week.reroll")}
        </button>
      </Show>
      <small>{t("week.proposeHint")}</small>
    </div>
  );
}

/** This Week's Effort Budgets, which override the Household's, and the Household's for every Week. */
export function EffortBudgetsEditor(props: { client: MiseClient; household: WeekHousehold; week: Week }) {
  return (
    <details>
      <summary>{t("effort.title")}</summary>
      <p>{t("effort.hint")}</p>
      <BudgetsForm
        label={t("effort.thisWeek")}
        budgets={props.week.effortBudgets}
        save={(changed) =>
          props.client.call("set_week_effort_budgets", {
            date: props.week.startDate,
            // The Household's own budget is no override.
            budgets: Object.fromEntries(
              Object.entries(changed).map(([weekday, minutes]) => [
                weekday,
                minutes === props.household.effortBudgets[weekday as Weekday] ? null : minutes,
              ]),
            ),
          })
        }
      />
      <BudgetsForm
        label={t("effort.everyWeek")}
        budgets={props.household.effortBudgets}
        save={(changed) => props.client.call("set_effort_budgets", { budgets: changed })}
      />
    </details>
  );
}

/** A minutes field per weekday; saving sends only the weekdays changed. */
function BudgetsForm(props: {
  label: string;
  budgets: EffortBudgets;
  save: (changed: Partial<EffortBudgets>) => Promise<ToolResult<unknown>>;
}) {
  const [typed, setTyped] = createSignal<Partial<Record<Weekday, string>>>({});
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const value = (weekday: Weekday) => typed()[weekday] ?? String(props.budgets[weekday]);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const changed = Object.fromEntries(
      WEEKDAYS.flatMap((weekday) =>
        Number(value(weekday)) === props.budgets[weekday] ? [] : [[weekday, Number(value(weekday))]],
      ),
    );
    if (Object.keys(changed).length === 0) return;
    setBusy(true);
    try {
      const result = await props.save(changed);
      setError(result.ok ? undefined : errorText(result.error, "slot"));
      if (result.ok) setTyped({});
    } catch {
      setError(t("app.error"));
    }
    setBusy(false);
  };

  return (
    <form aria-label={props.label} onSubmit={submit}>
      <fieldset>
        <legend>{props.label}</legend>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <For each={WEEKDAYS}>
          {(weekday) => (
            <label>
              {t(`weekday.${weekday}`)}
              <input
                type="number"
                required
                min={0}
                max={24 * 60}
                value={value(weekday)}
                onInput={(e) => setTyped({ ...typed(), [weekday]: e.currentTarget.value })}
              />
            </label>
          )}
        </For>
        <button type="submit" disabled={busy()}>
          {busy() ? t("slot.saving") : t("slot.save")}
        </button>
      </fieldset>
    </form>
  );
}

/** A Member by name, or the Guests. */
export function whoName(who: ConflictWho, household: Pick<Household, "members">): string {
  if (who === "guests") return t("conflict.guests");
  return household.members.find((member) => member.id === who)?.name ?? String(who);
}

/** Why the latest Proposal left a Slot as it did, as a sentence. */
export function reasonText(
  reason: ProposalReason,
  household: Pick<Household, "members" | "locale">,
  items: Map<ItemId, Item>,
): string {
  const list = (parts: string[]) => new Intl.ListFormat(household.locale, { type: "conjunction" }).format(parts);
  switch (reason.kind) {
    case "locked":
      return t("reason.locked");
    case "cooked":
      return t("reason.cooked");
    case "kept":
      return t("reason.kept");
    case "nobody_eating":
      return t("reason.nobodyEating");
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
