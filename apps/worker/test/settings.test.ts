import { env } from "cloudflare:workers";
import {
  addDays,
  type GroceryList,
  type Household,
  localDate,
  type ToolResult,
  type Week,
  weekdayOf,
} from "@mise/domain";
import { describe, expect, test } from "vitest";

const TIMEZONE = "America/Vancouver";

/** A Household of Robin and Alex, in Vancouver, whose Weeks start on Monday. */
async function setUpHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  succeeded(
    await household.callTool("setup_household", {
      name: "The Example Family",
      timezone: TIMEZONE,
      members: [{ name: "Robin" }, { name: "Alex" }],
    }),
  );
  return household;
}

function succeeded<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

const today = () => localDate(new Date(), TIMEZONE);

describe("changing the Household's settings", () => {
  test("changes the settings given and leaves the rest as they were", async () => {
    const household = await setUpHousehold();

    const updated = succeeded<Household>(
      await household.callTool("update_household_settings", {
        name: "The Examples",
        dinnerTime: "19:15",
        units: "imperial",
        timezone: "europe/paris",
      }),
    );

    expect(updated).toMatchObject({
      name: "The Examples",
      timezone: "Europe/Paris",
      dinnerTime: "19:15",
      weekStartsOn: "monday",
      units: "imperial",
      locale: "en-CA",
      members: [{ name: "Robin" }, { name: "Alex" }],
    });
    expect(succeeded(await household.callTool("get_household", {}))).toEqual(updated);
  });

  test("has 30 minutes of voice a day until changed, and keeps a new daily voice cap", async () => {
    const household = await setUpHousehold();

    const before = succeeded<Household>(await household.callTool("get_household", {}));
    const updated = succeeded<Household>(
      await household.callTool("update_household_settings", { voiceMinutesPerDay: 45 }),
    );

    expect(before.voiceMinutesPerDay).toBe(30);
    expect(updated.voiceMinutesPerDay).toBe(45);
    expect(succeeded(await household.callTool("get_household", {}))).toEqual(updated);
  });

  test("is validated as setup is, and a refused change changes nothing", async () => {
    const household = await setUpHousehold();
    const before = succeeded(await household.callTool("get_household", {}));

    for (const change of [
      { timezone: "Mars/Olympus_Mons" },
      { dinnerTime: "7pm" },
      { weekStartsOn: "someday" },
      { units: "furlongs" },
      { voiceMinutesPerDay: -1 },
      { voiceMinutesPerDay: 2.5 },
      { name: " " },
      { members: [] },
    ]) {
      expect(await household.callTool("update_household_settings", change)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(succeeded(await household.callTool("get_household", {}))).toEqual(before);
  });

  test("needs the Household set up first", async () => {
    const household = env.Household.getByName(crypto.randomUUID());

    expect(await household.callTool("update_household_settings", { units: "imperial" })).toMatchObject({
      ok: false,
      error: { code: "not_set_up" },
    });
  });

  test("a new timezone moves today", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { title: "Dal", baseServings: 4, ingredients: [] });
    succeeded(await household.callTool("update_household_settings", { timezone: "Pacific/Pago_Pago" }));
    // Kiritimati is a day or more ahead of Pago Pago, whatever the time.
    const kiritimatiToday = localDate(new Date(), "Pacific/Kiritimati");
    const slot = { date: kiritimatiToday, meal: "dinner" } as const;
    succeeded(await household.callTool("set_slot", { ...slot, kind: "recipe", recipeId: 1 }));

    expect(await household.callTool("mark_cooked", slot)).toMatchObject({ ok: false, error: { code: "not_yet" } });

    succeeded(await household.callTool("update_household_settings", { timezone: "Pacific/Kiritimati" }));

    expect(await household.callTool("mark_cooked", slot)).toMatchObject({ ok: true });
  });

  test("a Grocery List already built reads in the new units", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { title: "Dal", baseServings: 2, ingredients: ["800 g red lentils"] });
    succeeded(await household.callTool("set_slot", { date: today(), meal: "dinner", kind: "recipe", recipeId: 1 }));
    succeeded(await household.callTool("build_grocery_list", {}));

    succeeded(await household.callTool("update_household_settings", { units: "imperial" }));

    const list = succeeded<GroceryList>(await household.callTool("get_grocery_list", {}));
    const lentils = list.sections.flatMap((section) => section.lines).find((line) => line.name === "lentils");
    expect(lentils?.amounts).toEqual([{ amount: { min: 1.76, max: 1.76 }, unit: "lb" }]);
  });
});

describe("changing the week start", () => {
  /** Thursday, unless the current Week is on its way to it: never the day Weeks start on now. */
  const NEW_START = "thursday";

  test("the current Week keeps its dates and Slots, and the next Week starts on the new day", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { title: "Dal", baseServings: 4, ingredients: [] });
    succeeded(await household.callTool("set_slot", { date: today(), meal: "dinner", kind: "recipe", recipeId: 1 }));
    const before = succeeded<Week>(await household.callTool("get_week", {}));

    const updated = succeeded<Household>(
      await household.callTool("update_household_settings", { weekStartsOn: NEW_START }),
    );

    const current = succeeded<Week>(await household.callTool("get_week", {}));
    expect(updated.weekStartsOn).toBe(NEW_START);
    expect(current.startDate).toBe(before.startDate);
    expect(current.slots.slice(0, 21)).toEqual(before.slots);
    // Monday's Week runs on to the Wednesday after it ends, so the next one starts on a Thursday.
    expect(current.endDate).toBe(addDays(before.startDate, 9));
    expect(current.slots).toHaveLength(30);
    const next = succeeded<Week>(await household.callTool("get_week", { date: addDays(current.endDate, 1) }));
    expect(next.startDate).toBe(addDays(current.endDate, 1));
    expect(weekdayOf(next.startDate)).toBe(NEW_START);
    expect(next.endDate).toBe(addDays(next.startDate, 6));
  });

  test("a Week already planned ahead keeps its dates too", async () => {
    const household = await setUpHousehold();
    const current = succeeded<Week>(await household.callTool("get_week", {}));
    const ahead = addDays(current.startDate, 7);
    succeeded(await household.callTool("set_slot", { date: ahead, meal: "dinner", kind: "eat_out" }));

    succeeded(await household.callTool("update_household_settings", { weekStartsOn: NEW_START }));

    expect(succeeded<Week>(await household.callTool("get_week", {}))).toMatchObject({
      startDate: current.startDate,
      endDate: current.endDate,
    });
    const planned = succeeded<Week>(await household.callTool("get_week", { date: ahead }));
    expect(planned.startDate).toBe(ahead);
    expect(planned.slots.find((slot) => slot.date === ahead && slot.meal === "dinner")?.kind).toBe("eat_out");
    expect(weekdayOf(addDays(planned.endDate, 1))).toBe(NEW_START);
  });

  test("survives an export and restore", async () => {
    const household = await setUpHousehold();
    succeeded(await household.callTool("update_household_settings", { weekStartsOn: NEW_START }));
    const changed = succeeded<Household>(await household.callTool("get_household", {}));
    const exported = await (await household.fetch("http://mise.example.com/agents/household/household/export")).text();

    const restored = env.Household.getByName(crypto.randomUUID());
    const response = await restored.fetch("http://mise.example.com/agents/household/household/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: exported,
    });

    expect(response.status).toBe(200);
    expect(succeeded<Household>(await restored.callTool("get_household", {})).weekStartChanges).toEqual(
      changed.weekStartChanges,
    );
    expect(changed.weekStartChanges).toHaveLength(1);
  });
});
