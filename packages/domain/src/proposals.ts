import { z } from "zod";
import { ConflictWho } from "./conflicts";
import { Minutes } from "./household";
import { ItemId } from "./items";
import { ImportedPreference, Recurrence } from "./recipes";

/** What the Household thought of a Recipe after cooking it in Mise. */
export const RATINGS = ["again", "meh", "never"] as const;
export const Rating = z.enum(RATINGS);
export type Rating = z.infer<typeof Rating>;

/**
 * How a Proposal chooses each dinner's Recipe: "best" among those scoring close to the best, or
 * "any" among every Recipe that passes the rules, which a re-roll falls back on when "best" leaves no
 * other choice.
 */
export const ProposalChoice = z.enum(["best", "any"]);
export type ProposalChoice = z.infer<typeof ProposalChoice>;

/** One thing that weighed for or against the Recipe chosen for a dinner. */
export const ReasonFactor = z.discriminatedUnion("kind", [
  /** How many days from this dinner it is planned nearest, before or after; null if not within 6 weeks. */
  z.object({ kind: z.literal("recency"), daysApart: z.number().int().nonnegative().nullable() }),
  /** Its cooking time (null when unknown) against the day's Effort Budget. */
  z.object({ kind: z.literal("effort"), minutes: Minutes.nullable(), budget: Minutes }),
  z.object({ kind: z.literal("rating"), rating: Rating.exclude(["never"]) }),
  z.object({ kind: z.literal("imported_preference"), preference: ImportedPreference }),
  /** The "use it up" Items it uses. */
  z.object({ kind: z.literal("uses_up"), items: z.array(ItemId) }),
  /** Who dislikes something in it: chosen anyway, scored down. */
  z.object({ kind: z.literal("disliked"), by: z.array(ConflictWho) }),
  /** Its main protein is also within the dinners either side of it. */
  z.object({ kind: z.literal("repeats_protein"), protein: z.string() }),
  /** Its cuisine is also the night before or after. */
  z.object({ kind: z.literal("repeats_cuisine"), cuisine: z.string() }),
]);
export type ReasonFactor = z.infer<typeof ReasonFactor>;

/** How many Recipes were ruled out for a dinner, by the first rule each failed. */
export const Exclusions = z.object({
  /** A Hard Constraint of someone eating, including unknown Allergens. */
  conflict: z.number().int().nonnegative(),
  /** Rated "never". */
  never: z.number().int().nonnegative(),
  /** Not a main dish: its Course is set and is not "main". Reasons stored before Course have none. */
  course: z.number().int().nonnegative().default(0),
  /** Planned within 2 weeks of the dinner. */
  recent: z.number().int().nonnegative(),
  /** Over the day's Effort Budget. */
  effort: z.number().int().nonnegative(),
});
export type Exclusions = z.infer<typeof Exclusions>;

/** Why a Proposal left a dinner as it did, so that it can be explained. */
export const ProposalReason = z.discriminatedUnion("kind", [
  /** A Locked Slot: kept as it was. */
  z.object({ kind: z.literal("locked") }),
  /** Already cooked: kept as it was. */
  z.object({ kind: z.literal("cooked") }),
  /** Leftovers, eating out or no meal, decided by hand: kept as it was. Leftovers a Proposal placed aren't kept. */
  z.object({ kind: z.literal("kept") }),
  /** Nobody is eating it, so nothing was planned. */
  z.object({ kind: z.literal("nobody_eating") }),
  /** A Recurring Recipe, pinned before anything was chosen. */
  z.object({ kind: z.literal("recurring"), recurrence: Recurrence }),
  /** Leftovers of the dinner on `of`, whose Recipe yields them, for the same Diners. */
  z.object({ kind: z.literal("leftovers"), of: z.iso.date() }),
  /** Chosen from `candidates` Recipes that passed every rule. */
  z.object({ kind: z.literal("chosen"), candidates: z.number().int().positive(), factors: z.array(ReasonFactor) }),
  /** No Recipe passed every rule, so it was left unplanned. */
  z.object({ kind: z.literal("no_candidate"), excluded: Exclusions }),
]);
export type ProposalReason = z.infer<typeof ProposalReason>;
