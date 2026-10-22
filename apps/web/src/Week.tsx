import {
  addDays,
  type Household as HouseholdData,
  type LocalDate,
  type Locale,
  type Meal,
  type Member,
  type MemberId,
  type RecipeSummary,
  SLOT_KINDS,
  type Slot,
  type SlotKind,
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
    setError(await failureOf(() => props.client.call("clear_week", { date: shown.startDate, confirm: true })));
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
      <details>
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
          members={props.household.members}
          date={props.date}
          dinner={slot("dinner")}
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
          members={props.household.members}
          slot={props.slot}
          onDone={() => setEditing(false)}
        />
      </Show>
    </section>
  );
}

/** Who is eating, as a form holds it: the Household's default, or the Members ticked. */
type DinersDraft = { everyone: boolean; diners: MemberId[] };

function SlotForm(props: { client: MiseClient; members: Member[]; slot: Slot; onDone: () => void }) {
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

  void props.client.call("search_recipes", {}).then(
    (result) => result.ok && setRecipes(result.value),
    () => setError(t("app.error")),
  );

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const where = { date: slot.date, meal: slot.meal };
    const writes: (() => Promise<ToolResult<unknown>>)[] = [];
    const typedNote = note().trim() || null;
    if (kind() !== slot.kind || recipeId() !== String(slot.recipe?.id ?? "") || typedNote !== slot.note) {
      const chosen = kind();
      // No Recipe chosen sends 0, which the tool refuses by name.
      const input: ToolInput<"set_slot"> =
        chosen === "recipe"
          ? { ...where, kind: chosen, recipeId: Number(recipeId()), note: typedNote }
          : { ...where, kind: chosen, note: typedNote };
      writes.push(() => props.client.call("set_slot", input));
    }
    const dinersInput = dinersOf(diners(), props.members);
    if (dinersChanged(dinersInput, slot)) {
      writes.push(() => props.client.call("set_diners", { ...where, diners: dinersInput }));
    }
    const constraints = constraintsOf(guestConstraints());
    if (Number(guests()) !== slot.guests || JSON.stringify(constraints) !== JSON.stringify(slot.guestConstraints)) {
      writes.push(() =>
        props.client.call("set_guests", { ...where, guests: Number(guests()), guestConstraints: constraints }),
      );
    }
    if (locked() !== slot.locked) writes.push(() => props.client.call("lock_slot", { ...where, locked: locked() }));

    setBusy(true);
    // In order, stopping at the first refusal; what was saved before it stays saved.
    for (const write of writes) {
      const failure = await failureOf(write);
      if (failure) {
        setError(failure);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    props.onDone();
  };

  return (
    <form aria-label={t(`meal.${slot.meal}`)} onSubmit={save}>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <label>
        {t("slot.kind")}
        <select value={kind()} onChange={(e) => setKind(e.currentTarget.value as SlotKind)}>
          <For each={SLOT_KINDS}>{(option) => <option value={option}>{t(`slotKind.${option}`)}</option>}</For>
        </select>
      </label>
      <Show when={kind() === "recipe"}>
        <label>
          {t("slot.recipe")}
          <select value={recipeId()} onChange={(e) => setRecipeId(e.currentTarget.value)}>
            <option value="">{t("slot.chooseRecipe")}</option>
            <For each={recipes()}>{(recipe) => <option value={String(recipe.id)}>{recipe.title}</option>}</For>
          </select>
        </label>
      </Show>
      <label>
        {t("slot.note")}
        <input maxLength={500} value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
      </label>
      <DinersFields members={props.members} draft={diners()} onChange={setDiners} />
      <label>
        {t("slot.guests")}
        <input type="number" min={0} max={50} value={guests()} onInput={(e) => setGuests(e.currentTarget.value)} />
      </label>
      <fieldset>
        <legend>{t("slot.guestConstraints")}</legend>
        <ConstraintFields constraints={guestConstraints()} onChange={setGuestConstraints} />
      </fieldset>
      <label>
        <input type="checkbox" checked={locked()} onChange={(e) => setLocked(e.currentTarget.checked)} />
        {t("slot.locked")}
      </label>
      <small>{t("slot.lockedHint")}</small>
      <button type="submit" disabled={busy()}>
        {busy() ? t("slot.saving") : t("slot.save")}
      </button>
      <button type="button" onClick={() => props.onDone()}>
        {t("slot.cancel")}
      </button>
    </form>
  );
}

/** Who is eating every meal of a day; it starts from who is eating dinner. */
function DayDinersForm(props: {
  client: MiseClient;
  members: Member[];
  date: LocalDate;
  dinner: Slot;
  onDone: () => void;
}) {
  const [diners, setDiners] = createSignal<DinersDraft>({
    everyone: props.dinner.dinersAreDefault,
    diners: props.dinner.diners,
  });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    const failure = await failureOf(() =>
      props.client.call("set_diners", { date: props.date, diners: dinersOf(diners(), props.members) }),
    );
    setBusy(false);
    if (failure) setError(failure);
    else props.onDone();
  };

  return (
    <form aria-label={t("week.dayDiners")} onSubmit={save}>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <DinersFields members={props.members} draft={diners()} onChange={setDiners} />
      <button type="submit" disabled={busy()}>
        {busy() ? t("slot.saving") : t("slot.save")}
      </button>
      <button type="button" onClick={() => props.onDone()}>
        {t("slot.cancel")}
      </button>
    </form>
  );
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

/** Makes a tool call; what to show if it was refused or never answered, or undefined if it succeeded. */
async function failureOf(call: () => Promise<ToolResult<unknown>>): Promise<string | undefined> {
  try {
    const result = await call();
    return result.ok ? undefined : errorText(result.error, "slot");
  } catch {
    return t("app.error");
  }
}
