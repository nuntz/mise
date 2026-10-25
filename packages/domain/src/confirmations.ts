import type { ConflictWho, Override } from "./conflicts";
import type { Allergen, Constraint, Member } from "./members";
import type { LocalDate, Meal, SlotKind } from "./weeks";

/**
 * A call the agent made that only a person's tap runs (ADR 0024): the chat shows it as a button
 * saying what will happen.
 */
export type PendingConfirmation = { id: number; summary: string };

/**
 * Pending until tapped, then done; expired once the state it describes changes, so a tap never runs
 * a call against something other than what its button said.
 */
export type ConfirmationStatus = "pending" | "done" | "expired";

/** A Hard Constraint, which always names an Allergen. */
type HardConstraint = Extract<Constraint, { kind: "allergy" | "intolerance" | "diet" }>;

function isHard(constraint: Constraint): constraint is HardConstraint {
  return constraint.kind !== "dislike";
}

/**
 * The Hard Constraints in `before` that `after` no longer has: removed, made a dislike or made another
 * kind. A new term on the same kind and Allergen is no loosening; neither is adding a Constraint.
 */
export function loosenedConstraints(before: readonly Constraint[], after: readonly Constraint[]): HardConstraint[] {
  return before
    .filter(isHard)
    .filter((old) => !after.some((now) => now.kind === old.kind && now.allergen === old.allergen));
}

/** The Hard Constraints a Member has. */
export function hardConstraintsOf(member: Pick<Member, "constraints">): HardConstraint[] {
  return member.constraints.filter(isHard);
}

/** "Delete “Lemon chicken”" */
export function describeDeletion(title: string): string {
  return `Delete “${title}”`;
}

/** "Clear the Week of Monday, October 26" */
export function describeClearing(weekStart: LocalDate): string {
  return `Clear the Week of ${dayName(weekStart)}`;
}

/** A change to a Slot, as a button names it before the Conflicts it overrides. */
export type SlotChangeSummary =
  | { kind: "plan"; title: string; date: LocalDate; meal: Meal }
  | { kind: "set"; to: Exclude<SlotKind, "recipe">; date: LocalDate; meal: Meal }
  /** Diners by name; null for everyone, the Household's default. */
  | { kind: "diners"; diners: string[] | null; date: LocalDate; meal: Meal | undefined }
  /** The Guests' Constraints when the change gives them; left as they are otherwise. */
  | { kind: "guests"; guests: number; constraints: Constraint[] | undefined; date: LocalDate; meal: Meal }
  | { kind: "leftovers"; date: LocalDate; meal: Meal; of: { date: LocalDate; meal: Meal } | null };

/** Whom an Override is for, named, and the kind of the Hard Constraint it overrides, if they have it. */
export type OverriddenFor = Pick<Override, "who" | "allergen"> & {
  name: string;
  constraint: HardConstraint["kind"] | null;
};

/** What someone is, by the Hard Constraint overridden, said of one person and of the Guests. */
const OVERRIDDEN: Record<HardConstraint["kind"], [string, string]> = {
  allergy: ["is allergic to", "are allergic to"],
  intolerance: ["is intolerant of", "are intolerant of"],
  diet: ["avoids", "avoid"],
};

/** "Plan “Satay” for dinner on Friday, October 30 although Robin is allergic to peanut" */
export function describeOverride(change: SlotChangeSummary, overridden: readonly OverriddenFor[]): string {
  const reasons = overridden.map(({ who, name, constraint, allergen }) => {
    const [one, many] = constraint ? OVERRIDDEN[constraint] : ["can't have", "can't have"];
    return `${name} ${who === "guests" ? many : one} ${allergenName(allergen)}`;
  });
  return `${describeSlotChange(change)} although ${list(reasons)}`;
}

function describeSlotChange(change: SlotChangeSummary): string {
  switch (change.kind) {
    case "plan":
      return `Plan “${change.title}” for ${slotName(change)}`;
    case "set":
      return `Make ${slotName(change)} ${SLOT_KIND_NAMES[change.to]}`;
    case "diners": {
      const who = change.diners === null ? "everyone" : list(change.diners);
      const when = change.meal ? slotName({ ...change, meal: change.meal }) : `every meal on ${dayName(change.date)}`;
      return `Have ${change.diners?.length === 0 ? "no one" : who} eat ${when}`;
    }
    case "guests":
      return `Have ${guestsName(change.guests, change.constraints)} at ${slotName(change)}`;
    case "leftovers":
      return change.of
        ? `Make ${slotName(change)} Leftovers of ${slotName(change.of)}`
        : `Make ${slotName(change)} Leftovers of nothing in particular`;
  }
}

/** "Remove Robin's peanut allergy and make their milk intolerance a dislike" */
export function describeLoosening(
  name: string,
  loosened: readonly HardConstraint[],
  after: readonly Constraint[],
): string {
  const parts = loosened.map((constraint, index) => {
    const whose = index === 0 ? `${name}'s` : "their";
    const disliked = after.some((now) => now.kind === "dislike" && now.allergen === constraint.allergen);
    return disliked
      ? `make ${whose} ${constraintName(constraint)} a dislike`
      : `remove ${whose} ${constraintName(constraint)}`;
  });
  const sentence = list(parts);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** "Remove Robin and their peanut allergy" */
export function describeRemoval(name: string, hard: readonly HardConstraint[]): string {
  return `Remove ${name} and their ${list(hard.map(constraintName))}`;
}

/** Whom a Conflict is about, as a button names them. */
export function whoName(who: ConflictWho, members: readonly Pick<Member, "id" | "name">[]): string {
  if (who === "guests") return "the Guests";
  return members.find((member) => member.id === who)?.name ?? `Member ${who}`;
}

const SLOT_KIND_NAMES: Record<Exclude<SlotKind, "recipe">, string> = {
  leftovers: "Leftovers",
  eat_out: "eating out",
  unplanned: "unplanned",
  skip: "skipped",
};

function guestsName(guests: number, constraints: Constraint[] | undefined): string {
  const counted = `${guests} ${guests === 1 ? "Guest" : "Guests"}`;
  if (constraints === undefined) return counted;
  const hard = constraints.filter(isHard);
  return hard.length > 0
    ? `${counted}, with ${list(hard.map((c) => `a ${constraintName(c)}`))},`
    : `${counted}, with no Hard Constraint,`;
}

function constraintName(constraint: HardConstraint): string {
  const what = allergenName(constraint.allergen);
  switch (constraint.kind) {
    case "allergy":
      return `${what} allergy`;
    case "intolerance":
      return `${what} intolerance`;
    case "diet":
      return `diet without ${what}`;
  }
}

function allergenName(allergen: Allergen): string {
  return allergen.replaceAll("_", " ");
}

const DAY = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

/** "Friday, October 30" */
function dayName(date: LocalDate): string {
  return DAY.format(new Date(`${date}T00:00:00Z`));
}

function slotName({ date, meal }: { date: LocalDate; meal: Meal }): string {
  return `${meal} on ${dayName(date)}`;
}

function list(parts: readonly string[]): string {
  return new Intl.ListFormat("en", { type: "conjunction" }).format(parts);
}
