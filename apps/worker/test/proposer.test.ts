import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { addDays, type Slot, type ToolResult, type Week } from "@mise/domain";
import { describe, expect, test } from "vitest";
import { migrate } from "../src/migrations";

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
    expect(dinners(week)[2]).toMatchObject({ recipe: { id: 2 }, locked: true, reason: null });
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

  test("proposes only mains or Recipes of unknown Course, and takes a Course corrected by hand", async () => {
    const household = await setUpHousehold();
    for (let id = 3; id <= 13; id++) await household.callTool("update_recipe", { id, course: "dessert" });

    const before = await propose(household);

    expect(new Set(dinners(before).map((dinner) => dinner.recipe?.id ?? null))).toEqual(new Set([2, null]));
    expect(dinners(before)[1]).toMatchObject({
      reason: { kind: "no_candidate", excluded: { conflict: 1, never: 0, course: 11, recent: 1, effort: 0 } },
    });

    await household.callTool("update_recipe", { id: 3, course: "main" });
    const after = await propose(household);

    expect(dinners(after).map((dinner) => dinner.recipe?.id)).toContain(3);
  });

  test("refuses a 'use it up' Item that doesn't exist", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("propose_week", { useUp: ["household:99"] })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  test("changing a proposed Slot's kind by hand drops its reason", async () => {
    const household = await setUpHousehold();
    await propose(household);

    await household.callTool("set_slot", { date: MONDAY, meal: "dinner", kind: "eat_out" });

    const week = weekOf(await household.callTool("get_week", { date: MONDAY }));
    expect(dinners(week)[0]).toMatchObject({ kind: "eat_out", reason: null });
    expect(dinners(week)[1]?.reason).toMatchObject({ kind: "chosen" });
  });
});

describe("the Household's own dinners and Mise's Suggestions", () => {
  const THURSDAY = "2026-10-29";
  const FRIDAY = "2026-10-30";

  test("a Recipe set by hand survives a Re-roll, with no reason", async () => {
    const household = await setUpHousehold();
    await propose(household);
    await household.callTool("set_slot", { date: WEDNESDAY, meal: "dinner", kind: "recipe", recipeId: 2 });

    for (let roll = 0; roll < 3; roll++) {
      const week = await propose(household, { reroll: true });
      expect(dinners(week)[2]).toMatchObject({ recipe: { id: 2 }, reason: null });
      expect(dinners(week).filter((dinner) => dinner.recipe?.id === 2)).toHaveLength(1);
    }
  });

  test("Leftovers, eating out and no meal set by hand survive a Re-roll", async () => {
    const household = await setUpHousehold();
    await propose(household);
    await household.callTool("set_slot", { date: WEDNESDAY, meal: "dinner", kind: "leftovers" });
    await household.callTool("set_slot", { date: THURSDAY, meal: "dinner", kind: "eat_out" });
    await household.callTool("set_slot", { date: FRIDAY, meal: "dinner", kind: "skip" });

    const week = await propose(household, { reroll: true });

    expect(dinners(week).slice(2, 5)).toMatchObject([
      { kind: "leftovers", reason: null },
      { kind: "eat_out", reason: null },
      { kind: "skip", reason: null },
    ]);
  });

  test("changing only a Suggestion's note or Diners keeps it a Suggestion", async () => {
    const household = await setUpHousehold();
    const proposed = dinners(await propose(household))[0] as Slot;

    await household.callTool("set_slot", {
      date: MONDAY,
      meal: "dinner",
      kind: "recipe",
      recipeId: proposed.recipe?.id,
      note: "Make it spicy",
      diners: [1, 2],
    });

    const week = weekOf(await household.callTool("get_week", { date: MONDAY }));
    expect(dinners(week)[0]).toMatchObject({ note: "Make it spicy", diners: [1, 2], reason: proposed.reason });
  });

  test("changing a Suggestion's Recipe makes it the Household's own", async () => {
    const household = await setUpHousehold();
    const proposed = dinners(await propose(household))[0] as Slot;
    const other = proposed.recipe?.id === 2 ? 3 : 2;

    await household.callTool("set_slot", { date: MONDAY, meal: "dinner", kind: "recipe", recipeId: other });

    const week = weekOf(await household.callTool("get_week", { date: MONDAY }));
    expect(dinners(week)[0]).toMatchObject({ recipe: { id: other }, reason: null });
  });
});

describe("letting Mise choose one dinner", () => {
  const FRIDAY = "2026-10-30";

  test("fills the dinner with a reason, marks the Week not reviewed, and changes no other dinner", async () => {
    const household = await setUpHousehold();
    await propose(household);
    await household.callTool("set_slot", { date: WEDNESDAY, meal: "dinner", kind: "recipe", recipeId: 2 });
    const before = weekOf(await household.callTool("review_week", { date: MONDAY, reviewed: true }));

    const week = weekOf(await household.callTool("propose_dinner", { date: WEDNESDAY }));

    expect(dinners(week)[2]?.reason).toMatchObject({ kind: "chosen", candidates: expect.any(Number) });
    expect(dinners(week)[2]?.recipe?.id).not.toBe(2);
    expect(dinners(week)[2]?.recipe?.id).not.toBe(SATAY);
    expect(week.reviewed).toBe(false);
    expect(week.proposalSeed).toBe(before.proposalSeed);
    const others = (of: Week) => of.slots.filter((slot) => !(slot.date === WEDNESDAY && slot.meal === "dinner"));
    expect(others(week)).toEqual(others(before));
    expect(weekOf(await household.callTool("get_week", { date: MONDAY }))).toEqual(week);
  });

  test("fills a dinner of a Week never proposed, and stores no seed for it", async () => {
    const household = await setUpHousehold();

    const week = weekOf(await household.callTool("propose_dinner", { date: WEDNESDAY }));

    expect(dinners(week)[2]).toMatchObject({ kind: "recipe", reason: { kind: "chosen" } });
    expect(dinners(week).filter((dinner) => dinner.kind === "unplanned")).toHaveLength(6);
    expect(week.proposalSeed).toBeNull();
  });

  test("a Recurring Recipe the dinner already had comes back, and the Week stays reviewed", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", {
      title: "Pizza",
      baseServings: 4,
      ingredients: ["500 g flour"],
      effortMinutes: 30,
      recurring: { weekday: "friday" },
    });
    const pizza = dinners(await propose(household))[4]?.recipe?.id;
    await household.callTool("review_week", { date: MONDAY, reviewed: true });

    const week = weekOf(await household.callTool("propose_dinner", { date: FRIDAY }));

    expect(dinners(week)[4]).toMatchObject({ recipe: { id: pizza }, reason: { kind: "recurring" } });
    expect(week.reviewed).toBe(true);
  });

  test("chooses a Recipe safe for whoever eats the dinner's Leftovers linked by hand", async () => {
    const household = await setUpHousehold();
    const TUESDAY = addDays(MONDAY, 1);
    const quick = { baseServings: 4, effortMinutes: 10 };
    // Recipes 14 and 15, after the 13 set up.
    const rice = 14;
    await household.callTool("create_recipe", { title: "Rice", ingredients: ["400 g rice"], ...quick });
    await household.callTool("create_recipe", {
      title: "Peanut noodles",
      ingredients: ["2 tbsp peanut butter"],
      ...quick,
    });
    // Monday allows 20 minutes: Rice and Peanut noodles are all that fit.
    await household.callTool("set_week_effort_budgets", { date: MONDAY, budgets: { monday: 20 } });
    // Only Alex eats Monday's Rice, but Robin, allergic to peanut, eats its Leftovers on Tuesday.
    await household.callTool("set_slot", { date: MONDAY, meal: "dinner", kind: "recipe", recipeId: rice, diners: [2] });
    await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "leftovers" });
    await household.callTool("link_leftovers", { date: TUESDAY, meal: "dinner", of: { date: MONDAY, meal: "dinner" } });

    const week = weekOf(await household.callTool("propose_dinner", { date: MONDAY }));

    expect(dinners(week)[0]).toMatchObject({ recipe: { id: rice }, reason: { kind: "chosen", candidates: 1 } });
    expect(dinners(week)[1]).toMatchObject({ kind: "leftovers", leftoversOf: { date: MONDAY }, conflicts: [] });
  });

  test("refuses a dinner already cooked", async () => {
    const household = await setUpHousehold();
    await propose(household);
    await household.callTool("mark_cooked", { date: MONDAY, meal: "dinner" });

    const result = await household.callTool("propose_dinner", { date: MONDAY });

    expect(result).toMatchObject({ ok: false, error: { code: "already_cooked" } });
  });
});

describe("reasons stored before ADR 0030", () => {
  test("a dinner kept by rule or cooked loses its reason, and a Suggestion keeps its own", async () => {
    const household = await setUpHousehold();
    const proposed = await propose(household);
    // As an earlier Proposer stored them: a reason for dinners it kept, and a cooked Suggestion.
    await runInDurableObject(household, async (_household, state) => {
      const sql = state.storage.sql;
      const reason = (date: string, kind: string) =>
        sql.exec("UPDATE slot_reason SET reason = ? WHERE date = ? AND meal = 'dinner'", `{"kind":"${kind}"}`, date);
      reason(addDays(MONDAY, 1), "kept");
      reason(addDays(MONDAY, 2), "cooked");
      sql.exec("UPDATE slot SET cooked_at = '2026-10-28T19:00:00.000Z' WHERE date = ? AND meal = 'dinner'", WEDNESDAY);
      sql.exec(
        "UPDATE slot SET cooked_at = '2026-10-29T19:00:00.000Z' WHERE date = ? AND meal = 'dinner'",
        addDays(MONDAY, 3),
      );
      sql.exec("DELETE FROM schema_version WHERE version >= 30");
      // Migration 30 again, and only it.
      migrate(state.storage, 30);
    });

    const week = weekOf(await household.callTool("get_week", { date: MONDAY }));

    expect(dinners(week).map((dinner) => dinner.reason)).toEqual([
      dinners(proposed)[0]?.reason,
      null,
      null,
      null,
      dinners(proposed)[4]?.reason,
      dinners(proposed)[5]?.reason,
      dinners(proposed)[6]?.reason,
    ]);
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
