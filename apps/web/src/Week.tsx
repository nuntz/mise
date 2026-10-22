import {
  addDays,
  type Conflict,
  type Household as HouseholdData,
  type LocalDate,
  type Locale,
  type Meal,
  type Member,
  type MemberId,
  type Override,
  type RecipeSummary,
  type RefusedConflict,
  SLOT_KINDS,
  type Slot,
  type SlotKind,
  sameConflict,
  type ToolInput,
  type ToolResult,
  type Week,
  weekDates,
} from "@mise/domain";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { type ConstraintDraft, ConstraintFields, constraintDraftsOf, constraintsOf } from "./MemberFields";
import { t } from "./messages";

/** What the Week needs to know of the Household. */
type Household = Pick<HouseholdData, "members" | "locale">;

/** The current and next Week, each day's dinner first, with every Slot editable by hand. */
export function WeekPage(props: { client: MiseClient; household: Household }) {
  const [next, setNext] = createSignal(false);
  const [week, setWeek] = createSignal<Week>();
  const [currentStart, setCurrentStart] = createSignal<LocalDate>();
  const [error, setError] = createSignal<string>();
  // Only the latest fetch may show its Week, whatever order the answers arrive in.
  let latest = 0;

  const refetch = async () => {
    const fetch = ++latest;
    const start = currentStart();
    try {
      const result = await props.client.call("get_week", next() && start ? { date: addDays(start, 7) } : {});
      if (fetch !== latest) return;
      setError(result.ok ? undefined : t("app.error"));
      if (!result.ok) return;
      if (!next()) setCurrentStart(result.value.startDate);
      setWeek(result.value);
    } catch {
      if (fetch === latest) setError(t("app.error"));
    }
  };
  onCleanup(props.client.subscribe("plan", refetch));
  // Slots show their Recipes' titles and photos, and follow the default Diners: every Member.
  onCleanup(props.client.subscribe("recipes", refetch));
  onCleanup(props.client.subscribe("household", refetch));

  const show = (showNext: boolean) => {
    setNext(showNext);
    void refetch();
  };

  const clear = async (shown: Week) => {
    if (!window.confirm(t("week.clearConfirm", { date: dayTitle(shown.startDate, props.household.locale) }))) return;
    setError(
      (await outcomeOf(() => props.client.call("clear_week", { date: shown.startDate, confirm: true }))).failure,
    );
  };

  return (
    <section>
      <nav>
        <button type="button" aria-pressed={!next()} onClick={() => show(false)}>
          {t("week.this")}
        </button>
        <button type="button" aria-pressed={next()} disabled={!currentStart()} onClick={() => show(true)}>
          {t("week.next")}
        </button>
      </nav>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={week()}>
        {(shown) => (
          <>
            <For each={weekDates(shown().startDate)}>
              {(date) => (
                <Day
                  client={props.client}
                  household={props.household}
                  date={date}
                  slots={shown().slots.filter((slot) => slot.date === date)}
                />
              )}
            </For>
            <button type="button" onClick={() => clear(shown())}>
              {t("week.clear")}
            </button>
          </>
        )}
      </Show>
    </section>
  );
}

function Day(props: { client: MiseClient; household: Household; date: LocalDate; slots: Slot[] }) {
  const title = () => dayTitle(props.date, props.household.locale);
  const slot = (meal: Meal) => props.slots.find((s) => s.meal === meal) as Slot;
  const [editingDiners, setEditingDiners] = createSignal(false);

  return (
    <section aria-label={title()}>
      <h3>{title()}</h3>
      <SlotView client={props.client} household={props.household} slot={slot("dinner")} prominent />
      <details open={["breakfast", "lunch"].some((meal) => blocking(slot(meal as Meal)))}>
        <summary>{t("week.otherMeals")}</summary>
        <SlotView client={props.client} household={props.household} slot={slot("breakfast")} />
        <SlotView client={props.client} household={props.household} slot={slot("lunch")} />
      </details>
      <Show
        when={editingDiners()}
        fallback={
          <button type="button" onClick={() => setEditingDiners(true)}>
            {t("week.dayDiners")}
          </button>
        }
      >
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

function SlotView(props: { client: MiseClient; household: Household; slot: Slot; prominent?: boolean }) {
  const [editing, setEditing] = createSignal(false);
  const meal = () => t(`meal.${props.slot.meal}`);

  return (
    <section aria-label={meal()}>
      <Show
        when={props.prominent}
        fallback={
          <p>
            <strong>{meal()}</strong>: {slotTitle(props.slot)}
          </p>
        }
      >
        <Show when={props.slot.recipe}>
          {(recipe) => (
            <Show when={recipe().photoKey}>
              {(key) => (
                <img
                  src={props.client.photoUrl(recipe().id, key())}
                  alt={t("recipe.photoAlt", { title: recipe().title })}
                />
              )}
            </Show>
          )}
        </Show>
        <h4>{slotTitle(props.slot)}</h4>
      </Show>
      <p>{servingsText(props.slot, props.household)}</p>
      <For each={props.slot.conflicts}>
        {(conflict) => (
          <Show
            when={conflict.override}
            fallback={<p role="alert">{conflictText(conflict, props.household, slotTitle(props.slot))}</p>}
          >
            {(reason) => (
              <p>{t("conflict.overridden", { ...conflictParams(conflict, props.household), reason: reason() })}</p>
            )}
          </Show>
        )}
      </For>
      <Show when={props.slot.note}>{(note) => <p>{note()}</p>}</Show>
      <Show when={props.slot.locked}>
        <p>{t("slot.locked")}</p>
      </Show>
      <Show
        when={editing()}
        fallback={
          <button type="button" onClick={() => setEditing(true)}>
            {t("slot.edit", { meal: meal() })}
          </button>
        }
      >
        <SlotForm
          client={props.client}
          household={props.household}
          slot={props.slot}
          onDone={() => setEditing(false)}
        />
      </Show>
    </section>
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
    <form aria-label={t(`meal.${slot.meal}`)} onSubmit={save}>
      <Show when={error()}>
        <p role="alert">{error()}</p>
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
        onChange={setReasons}
      />
      <SaveButton busy={busy()} refused={refused().length > 0} />
      <button type="button" onClick={() => props.onDone()}>
        {t("slot.cancel")}
      </button>
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
    <form aria-label={t("week.dayDiners")} onSubmit={save}>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <DinersFields members={props.household.members} draft={diners()} onChange={changing(setDiners)} />
      <ConflictOverrides
        household={props.household}
        conflicts={refused()}
        describe={describe}
        reasons={reasons()}
        onChange={setReasons}
      />
      <SaveButton busy={busy()} refused={refused().length > 0} />
      <button type="button" onClick={() => props.onDone()}>
        {t("slot.cancel")}
      </button>
    </form>
  );
}

/**
 * What a refused change says: each Conflict, naming the person and the Allergen, and a
 * reason to give for each person and Allergen before saving anyway.
 */
function ConflictOverrides(props: {
  household: Household;
  conflicts: RefusedConflict[];
  describe: (conflict: RefusedConflict) => string;
  reasons: Record<string, string>;
  onChange: (reasons: Record<string, string>) => void;
}) {
  return (
    <Show when={props.conflicts.length > 0}>
      <div role="alert">
        <p>{t("conflict.refused")}</p>
        <For each={props.conflicts}>{(conflict) => <p>{props.describe(conflict)}</p>}</For>
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
      </div>
    </Show>
  );
}

function SaveButton(props: { busy: boolean; refused: boolean }) {
  return (
    <button type="submit" disabled={props.busy}>
      {props.busy ? t("slot.saving") : props.refused ? t("conflict.saveAnyway") : t("slot.save")}
    </button>
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
            {member.name}
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
  return slot.recipe?.title ?? t(`slotKind.${slot.kind}`);
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

/** A date as the Household reads it, such as "Tuesday, October 27". */
function dayTitle(date: LocalDate, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/** Whether the Slot has a Conflict nobody has overridden. */
function blocking(slot: Slot): boolean {
  return slot.conflicts.some((conflict) => conflict.override === null);
}

function conflictParams(conflict: Conflict, household: Household): Record<string, string> {
  const who =
    conflict.who === "guests"
      ? t("conflict.guests")
      : (household.members.find((member) => member.id === conflict.who)?.name ?? String(conflict.who));
  return { who, allergen: t(`allergen.${conflict.allergen}`), constraint: t(`constraint.${conflict.constraint}`) };
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
