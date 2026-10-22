import { z } from "zod";
import { Allergen, type Constraint, type Member, MemberId } from "./members";
import type { RecipeAllergens } from "./recipes";

/** Whom a Conflict is about: a Diner, by Member id, or the Slot's Guests, who are known only by number. */
export const ConflictWho = z.union([MemberId, z.literal("guests")]);
export type ConflictWho = z.infer<typeof ConflictWho>;

/**
 * A Hard Constraint of someone eating a Slot that its Recipe violates. "contains": the Recipe contains
 * the Allergen. "unknown": the Recipe has Unresolved Ingredients and might, so it fails closed.
 */
export const Conflict = z.object({
  who: ConflictWho,
  allergen: Allergen,
  /** The kind of the first Hard Constraint naming the Allergen. */
  constraint: z.enum(["allergy", "intolerance", "diet"]),
  cause: z.enum(["contains", "unknown"]),
});
export type Conflict = z.infer<typeof Conflict>;

/** What a Slot's Conflicts depend on. Guests' Constraints count only while there are Guests. */
export type ConflictCheck = {
  /** The Slot's Recipe's Allergens; null when it holds no Recipe. */
  allergens: RecipeAllergens | null;
  diners: Pick<Member, "id" | "constraints">[];
  guests: number;
  guestConstraints: Constraint[];
};

/**
 * Every Conflict in a Slot, once per person and Allergen: the Diners in the order given, then the
 * Guests. Only Hard Constraints conflict; a Recipe with unknown Allergens conflicts with all of them.
 */
export function slotConflicts({ allergens, diners, guests, guestConstraints }: ConflictCheck): Conflict[] {
  if (allergens === null) return [];
  const eating: [ConflictWho, Constraint[]][] = diners.map((diner) => [diner.id, diner.constraints]);
  if (guests > 0) eating.push(["guests", guestConstraints]);

  const conflicts: Conflict[] = [];
  for (const [who, constraints] of eating) {
    for (const constraint of constraints) {
      // Every Hard Constraint names an Allergen (ADR 0008); a dislike is Soft.
      if (constraint.kind === "dislike") continue;
      const { allergen } = constraint;
      if (conflicts.some((conflict) => conflict.who === who && conflict.allergen === allergen)) continue;
      const contained = allergens.kind === "known" ? allergens.allergens : allergens.atLeast;
      const cause = contained.includes(allergen) ? "contains" : allergens.kind === "unknown" ? "unknown" : null;
      if (cause) conflicts.push({ who, allergen, constraint: constraint.kind, cause });
    }
  }
  return conflicts;
}

/** Two Conflicts, or a Conflict and an Override, are about the same person and Allergen. */
export function sameConflict(a: Pick<Conflict, "who" | "allergen">, b: Pick<Conflict, "who" | "allergen">): boolean {
  return a.who === b.who && a.allergen === b.allergen;
}

const OverrideReason = z.string().trim().min(1).max(500);

/**
 * Plans a Slot despite a Conflict, saying why it is safe ("we'll make hers without the nuts"). It is
 * stored on the Slot, and dropped once its Conflict is gone or the Slot's Recipe changes.
 */
export const Override = z.object({ who: ConflictWho, allergen: Allergen, reason: OverrideReason }).strict();
export type Override = z.infer<typeof Override>;

/** Overrides given with a change, at most one per person and Allergen. */
export const Overrides = z
  .array(Override)
  .max(100)
  .refine((all) => all.every((one, index) => all.findIndex((other) => sameConflict(one, other)) === index), {
    message: "Override a person and Allergen only once",
  });

/** A Conflict as a Slot shows it: with the reason it was overridden, or null while it blocks. */
export const SlotConflict = Conflict.extend({ override: OverrideReason.nullable() });
export type SlotConflict = z.infer<typeof SlotConflict>;
