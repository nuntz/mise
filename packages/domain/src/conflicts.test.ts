import { describe, expect, test } from "bun:test";
import { slotConflicts } from "./conflicts";
import type { Member } from "./members";
import type { RecipeAllergens } from "./recipes";

const robin = { id: 1, constraints: [{ kind: "allergy", allergen: "peanut" }] } satisfies Pick<
  Member,
  "id" | "constraints"
>;
const alex = {
  id: 2,
  constraints: [
    { kind: "intolerance", allergen: "milk", term: "lactose" },
    { kind: "diet", allergen: "milk" },
    { kind: "dislike", allergen: "sesame" },
  ],
} satisfies Pick<Member, "id" | "constraints">;
const sam = { id: 3, constraints: [] } satisfies Pick<Member, "id" | "constraints">;

describe("slotConflicts", () => {
  test("a Diner's Hard Constraint conflicts with a Recipe containing its Allergen, once per person and Allergen", () => {
    const conflicts = slotConflicts({
      allergens: { kind: "known", allergens: ["peanut", "milk", "sesame"] },
      diners: [robin, alex, sam],
      guests: 0,
      guestConstraints: [],
    });

    expect(conflicts).toEqual([
      { who: 1, allergen: "peanut", constraint: "allergy", cause: "contains" },
      { who: 2, allergen: "milk", constraint: "intolerance", cause: "contains" },
    ]);
  });

  test("a Recipe without the Allergen, or no Recipe at all, conflicts with nobody", () => {
    const diners = [robin, alex];
    const known: RecipeAllergens = { kind: "known", allergens: ["wheat"] };

    expect(slotConflicts({ allergens: known, diners, guests: 0, guestConstraints: [] })).toEqual([]);
    expect(slotConflicts({ allergens: null, diners, guests: 0, guestConstraints: [] })).toEqual([]);
  });

  test("unknown Allergens fail closed: every Hard Constraint conflicts, unless an Allergen is known to be there", () => {
    const conflicts = slotConflicts({
      allergens: { kind: "unknown", atLeast: ["peanut"], unresolved: 2 },
      diners: [robin, alex],
      guests: 0,
      guestConstraints: [],
    });

    expect(conflicts).toEqual([
      { who: 1, allergen: "peanut", constraint: "allergy", cause: "contains" },
      { who: 2, allergen: "milk", constraint: "intolerance", cause: "unknown" },
    ]);
  });

  test("Guests' Hard Constraints conflict as the Guests, but only while there are Guests", () => {
    const allergens: RecipeAllergens = { kind: "known", allergens: ["sesame"] };
    const guestConstraints = [{ kind: "allergy", allergen: "sesame" }] as const;

    expect(slotConflicts({ allergens, diners: [sam], guests: 2, guestConstraints: [...guestConstraints] })).toEqual([
      { who: "guests", allergen: "sesame", constraint: "allergy", cause: "contains" },
    ]);
    expect(slotConflicts({ allergens, diners: [sam], guests: 0, guestConstraints: [...guestConstraints] })).toEqual([]);
  });
});
