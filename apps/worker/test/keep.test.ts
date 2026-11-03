import { env } from "cloudflare:workers";
import type { ProposedWeek, Slot, ToolResult, Week } from "@mise/domain";
import { describe, expect, test } from "vitest";

/**
 * A Household of Robin (allergic to peanut) and Alex, Members 1 and 2, whose Weeks start on Monday.
 * Recipe 1 is Satay (peanut); Recipes 2 to 13 are safe for everyone and yield Leftovers when
 * `leftovers` is set.
 */
async function setUpHousehold({ leftovers = false } = {}) {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", {
    name: "The Example Family",
    members: [{ name: "Robin", constraints: [{ kind: "allergy", allergen: "peanut" }] }, { name: "Alex" }],
  });
  await household.callTool("create_recipe", {
    title: "Satay",
    baseServings: 4,
    ingredients: ["2 tbsp peanut butter"],
    effortMinutes: 30,
  });
  for (let index = 2; index <= 13; index++) {
    await household.callTool("create_recipe", {
      title: `Rice bowl ${index}`,
      baseServings: 4,
      ingredients: ["400 g rice"],
      effortMinutes: 30,
      yieldsLeftovers: leftovers,
    });
  }
  return household;
}

type TestHousehold = Awaited<ReturnType<typeof setUpHousehold>>;

// Monday 26 October 2026 and the days after it.
const MONDAY = "2026-10-26";
const TUESDAY = "2026-10-27";
const WEDNESDAY = "2026-10-28";
const dinner = (date: string) => ({ date, meal: "dinner" }) as const;

function succeeded<T>(outcome: unknown): T {
  const result = outcome as ToolResult<T>;
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value;
}

function slotOf(week: Week, date: string): Slot {
  return week.slots.find((slot) => slot.date === date && slot.meal === "dinner") as Slot;
}

async function propose(household: TestHousehold, reroll = false): Promise<Week> {
  return succeeded<ProposedWeek>(await household.callTool("propose_week", { date: MONDAY, reroll })).week;
}

describe("Keeping a Suggestion", () => {
  test("deletes its reason, so the dinner is the Household's own", async () => {
    const household = await setUpHousehold();
    const proposed = slotOf(await propose(household), WEDNESDAY);
    expect(proposed.reason).toMatchObject({ kind: "chosen" });

    const kept = succeeded<Slot>(await household.callTool("keep_slot", dinner(WEDNESDAY)));

    expect(kept).toMatchObject({ kind: "recipe", recipe: { id: proposed.recipe?.id }, reason: null });
    const week = succeeded<Week>(await household.callTool("get_week", { date: MONDAY }));
    expect(slotOf(week, WEDNESDAY).reason).toBeNull();
    expect(slotOf(week, TUESDAY).reason).toMatchObject({ kind: "chosen" });
  });

  test("a kept dinner survives a Re-roll", async () => {
    const household = await setUpHousehold();
    const proposed = slotOf(await propose(household), WEDNESDAY);
    succeeded(await household.callTool("keep_slot", dinner(WEDNESDAY)));

    for (let roll = 0; roll < 3; roll++) {
      const week = await propose(household, true);
      expect(slotOf(week, WEDNESDAY)).toMatchObject({ recipe: { id: proposed.recipe?.id }, reason: null });
    }
  });

  test("keeping Leftovers Mise placed keeps them and the dinner they are of, and a Re-roll moves neither", async () => {
    const household = await setUpHousehold({ leftovers: true });
    const proposed = await propose(household);
    const cooked = slotOf(proposed, MONDAY);
    expect(slotOf(proposed, TUESDAY)).toMatchObject({ kind: "leftovers", reason: { kind: "leftovers", of: MONDAY } });

    const kept = succeeded<Slot>(await household.callTool("keep_slot", dinner(TUESDAY)));

    expect(kept).toMatchObject({ kind: "leftovers", leftoversOf: dinner(MONDAY), reason: null });
    for (let roll = 0; roll < 3; roll++) {
      const week = await propose(household, true);
      expect(slotOf(week, MONDAY)).toMatchObject({
        recipe: { id: cooked.recipe?.id },
        leftovers: [dinner(TUESDAY)],
        reason: null,
      });
      expect(slotOf(week, TUESDAY)).toMatchObject({ kind: "leftovers", leftoversOf: dinner(MONDAY), reason: null });
    }
  });

  test("is refused on a dinner of the Household's own", async () => {
    const household = await setUpHousehold();
    await propose(household);
    succeeded(await household.callTool("set_slot", { ...dinner(WEDNESDAY), kind: "recipe", recipeId: 2 }));

    expect(await household.callTool("keep_slot", dinner(WEDNESDAY))).toMatchObject({
      ok: false,
      error: { code: "nothing_to_keep", message: expect.stringContaining("already the Household's own") },
    });
  });

  test("is refused on an unplanned dinner", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("keep_slot", dinner(WEDNESDAY))).toMatchObject({
      ok: false,
      error: { code: "nothing_to_keep", message: expect.stringContaining("no Recipe or Leftovers") },
    });
  });

  test("is refused on a dinner nobody is eating", async () => {
    const household = await setUpHousehold();
    succeeded(await household.callTool("set_diners", { ...dinner(WEDNESDAY), diners: [] }));
    expect(slotOf(await propose(household), WEDNESDAY).reason).toMatchObject({ kind: "nobody_eating" });

    expect(await household.callTool("keep_slot", dinner(WEDNESDAY))).toMatchObject({
      ok: false,
      error: { code: "nothing_to_keep", message: expect.stringContaining("no Recipe or Leftovers") },
    });
  });

  test("is refused on a Suggestion with a Recipe that nobody is eating any more", async () => {
    const household = await setUpHousehold();
    await propose(household);
    // Saying who eats it leaves it a Suggestion, with its Recipe.
    const nobody = succeeded<Slot[]>(await household.callTool("set_diners", { ...dinner(WEDNESDAY), diners: [] }))[0];
    expect(nobody).toMatchObject({ kind: "recipe", diners: [], guests: 0, reason: { kind: "chosen" } });

    expect(await household.callTool("keep_slot", dinner(WEDNESDAY))).toMatchObject({
      ok: false,
      error: { code: "nothing_to_keep", message: expect.stringContaining("Nobody is eating") },
    });
  });

  test("is refused on a dinner no Recipe fit", async () => {
    const household = await setUpHousehold();
    // Only Satay is a main dish, and Robin can't eat it.
    for (let id = 2; id <= 13; id++) await household.callTool("update_recipe", { id, course: "dessert" });
    expect(slotOf(await propose(household), WEDNESDAY).reason).toMatchObject({ kind: "no_candidate" });

    expect(await household.callTool("keep_slot", dinner(WEDNESDAY))).toMatchObject({
      ok: false,
      error: { code: "nothing_to_keep", message: expect.stringContaining("no Recipe or Leftovers") },
    });
  });
});
