import { z } from "zod";
import type { ConflictWho, Override } from "./conflicts";
import type { Allergen, Constraint, Member } from "./members";
import type { LocalDate, Meal, SlotKind } from "./weeks";

export const ConfirmationId = z.number().int().positive();

/**
 * A call the agent made that only a person's tap runs (ADR 0024): the chat shows it as a button
 * saying what will happen.
 */
export const PendingConfirmation = z.object({ id: ConfirmationId, summary: z.string().min(1) });
export type PendingConfirmation = z.infer<typeof PendingConfirmation>;

/**
 * Pending until tapped, then done; cancelled when the person no longer wants it; expired once the
 * state it describes changes, so a tap never runs a call against something other than what its
 * button said.
 */
export type ConfirmationStatus = "pending" | "done" | "cancelled" | "expired";

/** Withdraws a confirmation still waiting for a tap. Cancelling only ever makes plans safer. */
export const CancelConfirmationInput = z.object({ id: ConfirmationId }).strict();

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

/**
 * A change to a Slot that needs a tap: the Conflicts it overrides, and the Guests' Hard Constraints
 * it drops (only a change of Guests drops any).
 * "Plan “Satay” for dinner on Friday, October 30 although Robin is allergic to peanut"
 * "Have 2 Guests, with no Hard Constraint, at dinner on Friday, October 30, dropping their peanut allergy"
 */
export function describeSlotChange(
  change: SlotChangeSummary,
  overridden: readonly OverriddenFor[],
  dropped: readonly HardConstraint[] = [],
): string {
  const reasons = overridden.map(({ who, name, constraint, allergen }) => {
    const [one, many] = constraint ? OVERRIDDEN[constraint] : ["can't have", "can't have"];
    return `${name} ${who === "guests" ? many : one} ${allergenName(allergen)}`;
  });
  const dropping = dropped.length > 0 ? `, dropping their ${list(dropped.map(constraintName))}` : "";
  const although = reasons.length > 0 ? ` although ${list(reasons)}` : "";
  return `${slotChangeName(change)}${dropping}${although}`;
}

function slotChangeName(change: SlotChangeSummary): string {
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

/**
 * A change to a Member that needs a tap: a new name or sign-in email (null: none), which decide who
 * the agent takes someone for, and the Hard Constraints it loosens.
 */
export type MemberChange = {
  name?: string;
  email?: string | null;
  loosened: readonly HardConstraint[];
  after: readonly Constraint[];
};

/** "Rename Robin to Robyn, change their sign-in email to robyn@example.com and remove their peanut allergy" */
export function describeMemberChange(member: Pick<Member, "name" | "email">, change: MemberChange): string {
  const parts: string[] = [];
  // The first part names the Member; the others say "their" and "them".
  const whose = () => (parts.length === 0 ? `${member.name}'s` : "their");
  const whom = () => (parts.length === 0 ? member.name : "them");
  if (change.name !== undefined) parts.push(`rename ${member.name} to ${change.name}`);
  if (change.email === null) parts.push(`stop ${whom()} signing in as ${member.email}`);
  else if (change.email !== undefined) parts.push(`change ${whose()} sign-in email to ${change.email}`);
  for (const constraint of change.loosened) {
    const disliked = change.after.some((now) => now.kind === "dislike" && now.allergen === constraint.allergen);
    parts.push(
      disliked
        ? `make ${whose()} ${constraintName(constraint)} a dislike`
        : `remove ${whose()} ${constraintName(constraint)}`,
    );
  }
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

/** "a, b and c", without the serial comma, as Mise writes everywhere. */
function list(parts: readonly string[]): string {
  return new Intl.ListFormat("en-GB", { type: "conjunction" }).format(parts);
}
