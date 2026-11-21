import { describe, expect, test } from "bun:test";
import { type SlotConflict, slotConflicts, wouldFlag } from "./conflicts";
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

describe("wouldFlag", () => {
  const peanutMilkCurry = { id: 7, allergens: { kind: "known", allergens: ["peanut", "milk"] } } satisfies {
    id: number;
    allergens: RecipeAllergens;
  };
  const eating = { diners: [robin, alex], guests: 0, guestConstraints: [] };
  const robinsPeanut: SlotConflict = {
    who: 1,
    allergen: "peanut",
    constraint: "allergy",
    cause: "contains",
    override: "Hers without the peanuts",
  };

  test("another Recipe flags a Conflict the Slot has overridden: changing its Recipe drops its Overrides", () => {
    const slot = { recipe: { id: 3 }, leftoversOf: null, conflicts: [robinsPeanut] };

    expect(wouldFlag({ recipe: peanutMilkCurry, ...eating, slot })).toEqual({
      who: 1,
      allergen: "peanut",
      constraint: "allergy",
      cause: "contains",
    });
  });

  test("the Recipe the Slot holds keeps its Overrides, and flags a Conflict that has none", () => {
    const slot = { recipe: { id: 7 }, leftoversOf: null, conflicts: [robinsPeanut] };

    expect(wouldFlag({ recipe: peanutMilkCurry, ...eating, slot })).toEqual({
      who: 2,
      allergen: "milk",
      constraint: "intolerance",
      cause: "contains",
    });
    expect(
      wouldFlag({ recipe: peanutMilkCurry, diners: [robin], guests: 0, guestConstraints: [], slot }),
    ).toBeUndefined();
  });

  test("Leftovers hold the Recipe they were cooked from, and keep its Overrides", () => {
    const slot = { recipe: null, leftoversOf: { recipe: { id: 7 } }, conflicts: [robinsPeanut] };

    expect(
      wouldFlag({ recipe: peanutMilkCurry, diners: [robin], guests: 0, guestConstraints: [], slot }),
    ).toBeUndefined();
  });

  test("a Slot with no Recipe has no Overrides to keep: every Conflict counts", () => {
    // Even an Override the Slot shows counts for nothing: it holds no Recipe for it to belong to.
    const slot = { recipe: null, leftoversOf: null, conflicts: [robinsPeanut] };

    expect(wouldFlag({ recipe: peanutMilkCurry, ...eating, slot })).toEqual({
      who: 1,
      allergen: "peanut",
      constraint: "allergy",
      cause: "contains",
    });
  });

  test("the Conflict flagged is the first with no Override, Diners in order and then the Guests", () => {
    const slot = { recipe: { id: 7 }, leftoversOf: null, conflicts: [robinsPeanut] };
    const guestConstraints = [{ kind: "allergy", allergen: "peanut" }] as const;

    expect(
      wouldFlag({
        recipe: peanutMilkCurry,
        diners: [robin, sam],
        guests: 2,
        guestConstraints: [...guestConstraints],
        slot,
      }),
    ).toEqual({ who: "guests", allergen: "peanut", constraint: "allergy", cause: "contains" });
    expect(
      wouldFlag({
        recipe: peanutMilkCurry,
        diners: [alex, robin],
        guests: 2,
        guestConstraints: [...guestConstraints],
        slot,
      }),
    ).toEqual({ who: 2, allergen: "milk", constraint: "intolerance", cause: "contains" });
  });

  test("an Override given while the Recipe might contain the Allergen doesn't hold once it's known to", () => {
    const slot = { recipe: { id: 7 }, leftoversOf: null, conflicts: [{ ...robinsPeanut, cause: "unknown" as const }] };

    expect(wouldFlag({ recipe: peanutMilkCurry, diners: [robin], guests: 0, guestConstraints: [], slot })).toEqual({
      who: 1,
      allergen: "peanut",
      constraint: "allergy",
      cause: "contains",
    });
  });
});
