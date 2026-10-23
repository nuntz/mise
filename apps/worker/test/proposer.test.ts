import { env } from "cloudflare:workers";
import { addDays, type Slot, type ToolResult, type Week } from "@mise/domain";
import { describe, expect, test } from "vitest";

/**
 * A Household of Robin (allergic to peanut), Alex and Sam, Members 1, 2 and 3, whose Weeks start on
 * Monday. Recipe 1 is Satay (peanut); Recipes 2 to 13 are safe for everyone, quick, and untagged.
 */
async function setUpHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", {
    name: "The Example Family",
    members: [
      { name: "Robin", constraints: [{ kind: "allergy", allergen: "peanut" }] },
      { name: "Alex" },
      { name: "Sam" },
    ],
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
    });
  }
  return household;
}

type TestHousehold = Awaited<ReturnType<typeof setUpHousehold>>;

const SATAY = 1;
// Monday 26 October 2026 to Sunday 1 November.
const MONDAY = "2026-10-26";
const WEDNESDAY = "2026-10-28";

function weekOf(result: ToolResult<unknown>): Week {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as Week;
}

function dinners(week: Week): Slot[] {
  return week.slots.filter((slot) => slot.meal === "dinner");
}

async function propose(household: TestHousehold, input: Record<string, unknown> = {}): Promise<Week> {
  return weekOf(await household.callTool("propose_week", { date: MONDAY, ...input }));
}

describe("proposing a Week", () => {
  test("fills every dinner with a safe Recipe and a reason, keeping Locked Slots and other meals", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { date: WEDNESDAY, meal: "dinner", kind: "recipe", recipeId: 2 });
    await household.callTool("lock_slot", { date: WEDNESDAY, meal: "dinner", locked: true });
    await household.callTool("set_slot", { date: MONDAY, meal: "lunch", kind: "eat_out" });

    const week = await propose(household);

    expect(week.proposalSeed).toEqual(expect.any(Number));
    expect(week.reviewed).toBe(false);
    for (const dinner of dinners(week)) {
      expect(dinner.kind).toBe("recipe");
      expect(dinner.recipe?.id).not.toBe(SATAY);
      expect(dinner.conflicts).toEqual([]);
    }
    expect(dinners(week)[2]).toMatchObject({ recipe: { id: 2 }, locked: true, reason: { kind: "locked" } });
    expect(dinners(week)[0]?.reason).toMatchObject({ kind: "chosen", candidates: 11 });
    // Recipe 2 is Locked on Wednesday, so it isn't proposed again within 2 weeks of it.
    expect(dinners(week).filter((dinner) => dinner.recipe?.id === 2)).toHaveLength(1);
    expect(week.slots.find((slot) => slot.date === MONDAY && slot.meal === "lunch")).toMatchObject({
      kind: "eat_out",
      reason: null,
    });
    expect(weekOf(await household.callTool("get_week", { date: MONDAY }))).toEqual(week);
  });

  test("gives the same Proposal again for the same Week, and a different one when re-rolled", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { date: WEDNESDAY, meal: "dinner", kind: "recipe", recipeId: 2 });
    await household.callTool("lock_slot", { date: WEDNESDAY, meal: "dinner", locked: true });

    const first = await propose(household);
    const again = await propose(household);
    const rerolled = await propose(household, { reroll: true });

    const recipes = (week: Week) => dinners(week).map((dinner) => dinner.recipe?.id);
    expect(recipes(again)).toEqual(recipes(first));
    expect(again.proposalSeed).toBe(first.proposalSeed);
    expect(rerolled.proposalSeed).not.toBe(first.proposalSeed);
    expect(recipes(rerolled)).not.toEqual(recipes(first));
    expect(dinners(rerolled)[2]).toMatchObject({ recipe: { id: 2 }, locked: true });
  });

  test("doesn't propose what was planned the Week before, and favours the 'use it up' Items", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", {
      title: "Spinach pie",
      baseServings: 4,
      ingredients: ["200 g spinach"],
      effortMinutes: 30,
    });
    for (let day = 0; day < 7; day++) {
      await household.callTool("set_slot", {
        date: addDays(MONDAY, day - 7),
        meal: "dinner",
        kind: "recipe",
        recipeId: day + 2,
      });
    }

    const week = await propose(household, { useUp: ["spinach"] });

    expect(dinners(week)[0]).toMatchObject({
      recipe: { title: "Spinach pie" },
      reason: { kind: "chosen", factors: expect.arrayContaining([{ kind: "uses_up", items: ["spinach"] }]) },
    });
    const planned = dinners(week).map((dinner) => dinner.recipe?.id);
    for (const lastWeek of [2, 3, 4, 5, 6, 7, 8]) expect(planned).not.toContain(lastWeek);
    // Satay is out, and so are last Week's, so one dinner is left without a Recipe.
    expect(dinners(week).filter((dinner) => dinner.reason?.kind === "no_candidate")).toHaveLength(1);
  });

  test("refuses a 'use it up' Item that doesn't exist", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("propose_week", { useUp: ["household:99"] })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  test("editing a proposed Slot by hand drops its reason", async () => {
    const household = await setUpHousehold();
    await propose(household);

    await household.callTool("set_slot", { date: MONDAY, meal: "dinner", kind: "eat_out" });

    const week = weekOf(await household.callTool("get_week", { date: MONDAY }));
    expect(dinners(week)[0]).toMatchObject({ kind: "eat_out", reason: null });
    expect(dinners(week)[1]?.reason).toMatchObject({ kind: "chosen" });
  });
});

describe("Effort Budgets", () => {
  test("the Household starts with the defaults, and can change them", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("get_household", {})).toMatchObject({
      value: {
        effortBudgets: {
          monday: 45,
          tuesday: 45,
          wednesday: 45,
          thursday: 45,
          friday: 60,
          saturday: 120,
          sunday: 90,
        },
      },
    });
    const changed = await household.callTool("set_effort_budgets", { budgets: { monday: 20, saturday: 180 } });

    expect(changed).toMatchObject({ ok: true, value: { monday: 20, tuesday: 45, saturday: 180 } });
    expect(await household.callTool("get_household", {})).toMatchObject({
      value: { effortBudgets: { monday: 20, saturday: 180 } },
    });
    expect(weekOf(await household.callTool("get_week", { date: MONDAY })).effortBudgets).toMatchObject({
      monday: 20,
      saturday: 180,
    });
  });

  test("a Week can override them, and the Proposal keeps within them", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", {
      title: "Toast",
      baseServings: 4,
      ingredients: ["400 g rice"],
      effortMinutes: 5,
    });

    const overridden = weekOf(
      await household.callTool("set_week_effort_budgets", { date: MONDAY, budgets: { monday: 10 } }),
    );
    expect(overridden).toMatchObject({ effortBudgetOverrides: { monday: 10 }, effortBudgets: { monday: 10 } });

    const week = await propose(household);
    expect(dinners(week)[0]).toMatchObject({ recipe: { title: "Toast" } });
    // The next Week keeps the Household's.
    expect(weekOf(await household.callTool("get_week", { date: addDays(MONDAY, 7) })).effortBudgets.monday).toBe(45);

    const restored = weekOf(
      await household.callTool("set_week_effort_budgets", { date: MONDAY, budgets: { monday: null } }),
    );
    expect(restored).toMatchObject({ effortBudgetOverrides: {}, effortBudgets: { monday: 45 } });
  });
});

describe("reviewing a Week", () => {
  test("a proposed Week is not reviewed until someone says so, and proposing it again un-reviews it", async () => {
    const household = await setUpHousehold();
    expect(weekOf(await household.callTool("get_week", { date: MONDAY }))).toMatchObject({
      proposalSeed: null,
      reviewed: false,
    });
    await propose(household);

    const reviewed = weekOf(await household.callTool("review_week", { date: MONDAY, reviewed: true }));
    expect(reviewed.reviewed).toBe(true);

    expect((await propose(household, { reroll: true })).reviewed).toBe(false);
  });
});
