import { z } from "zod";

/**
 * The canonical Allergens, Canada's priority allergens to start with. Extend by appending: stored
 * Constraints and Items refer to these names, so never rename or remove one.
 */
export const ALLERGENS = [
  "peanut",
  "tree_nut",
  "milk",
  "egg",
  "wheat",
  "soy",
  "fish",
  "shellfish",
  "sesame",
  "mustard",
  "sulphite",
] as const;
export const Allergen = z.enum(ALLERGENS);
export type Allergen = z.infer<typeof Allergen>;

/** Allergy, intolerance and diet are Hard Constraints; dislike is the one Soft Constraint. */
export const CONSTRAINT_KINDS = ["allergy", "intolerance", "diet", "dislike"] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

/** A Hard Constraint excludes a Recipe outright; a Soft one only scores it down. */
export function constraintSeverity(kind: ConstraintKind): "hard" | "soft" {
  return kind === "dislike" ? "soft" : "hard";
}

/** A label for what a Constraint is about, such as "lactose" or "mushrooms". */
const Term = z.string().trim().min(1).max(100);

/**
 * A Hard Constraint names its Allergen, which is what Recipes are checked against (ADR 0008); its
 * term is only a label. A dislike is Soft, so it may name just a term.
 */
const hard = <K extends Exclude<ConstraintKind, "dislike">>(kind: K) =>
  z.object({ kind: z.literal(kind), allergen: Allergen, term: Term.optional() }).strict();

export const Constraint = z.discriminatedUnion("kind", [
  hard("allergy"),
  hard("intolerance"),
  hard("diet"),
  z
    .object({ kind: z.literal("dislike"), allergen: Allergen.optional(), term: Term.optional() })
    .strict()
    .refine((constraint) => constraint.allergen !== undefined || constraint.term !== undefined, {
      message: "Name an Allergen or a term",
    }),
]);
export type Constraint = z.infer<typeof Constraint>;

export function isHardConstraint(constraint: Constraint): boolean {
  return constraintSeverity(constraint.kind) === "hard";
}

export const MemberId = z.number().int().positive();
export type MemberId = z.infer<typeof MemberId>;

const MemberName = z.string().trim().min(1).max(100);

/** The email a Member signs in with, which links them to a Caller. Lower case, as Callers are. */
const MemberEmail = z.string().trim().toLowerCase().pipe(z.email());

const Constraints = z.array(Constraint).max(50);

export const Member = z.object({
  id: MemberId,
  name: MemberName,
  /** Null for a Member who never signs in, such as a young child. */
  email: MemberEmail.nullable(),
  constraints: Constraints,
});
export type Member = z.infer<typeof Member>;

export const NewMember = z
  .object({
    name: MemberName,
    email: MemberEmail.nullable().default(null),
    constraints: Constraints.default([]),
  })
  .strict();
export type NewMember = z.output<typeof NewMember>;

export const UpdateMemberInput = z
  .object({
    id: MemberId,
    name: MemberName.optional(),
    /** Null unlinks the Member from any sign-in. */
    email: MemberEmail.nullable().optional(),
    /** Replaces the Member's Constraints, so one edit saves everything or nothing. */
    constraints: Constraints.optional(),
  })
  .strict();

export const UpdateMemberConstraintsInput = z.object({ id: MemberId, constraints: Constraints }).strict();

export const RemoveMemberInput = z.object({ id: MemberId }).strict();
