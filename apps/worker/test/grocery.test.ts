import { env } from "cloudflare:workers";
import type { GroceryLine, GroceryList, ToolResult } from "@mise/domain";
import { describe, expect, test } from "vitest";

/**
 * A Household of Robin and Alex, whose Weeks start on Monday, with Recipes 1 (Dal, for 4) and
 * 2 (Tacos, for 2).
 */
async function setUpHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", {
    name: "The Example Family",
    members: [{ name: "Robin" }, { name: "Alex" }],
  });
  await household.callTool("create_recipe", {
    title: "Dal",
    baseServings: 4,
    ingredients: ["400 g red lentils", "2 cloves garlic", "1 tsp salt", "1 bunch gochujang leaves"],
  });
  await household.callTool("create_recipe", {
    title: "Tacos",
    baseServings: 2,
    ingredients: ["1 lb ground beef", "1 clove garlic", "1 lime", "8 corn tortillas"],
  });
  return household;
}

type TestHousehold = Awaited<ReturnType<typeof setUpHousehold>>;

const DAL = 1;
const TACOS = 2;
// Monday 26 October 2026 and the days after it.
const MONDAY = "2026-10-26";
const TUESDAY = "2026-10-27";
const dinner = (date: string) => ({ date, meal: "dinner" }) as const;

function succeeded<T = GroceryList>(outcome: unknown): T {
  const result = outcome as ToolResult<T>;
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value;
}

async function plan(household: TestHousehold, date: string, recipeId: number) {
  succeeded(await household.callTool("set_slot", { ...dinner(date), kind: "recipe", recipeId }));
}

async function build(household: TestHousehold): Promise<GroceryList> {
  return succeeded(await household.callTool("build_grocery_list", { date: MONDAY }));
}

/** Each line as "name: amounts", by section, for reading at a glance. */
function shopping(list: GroceryList): Record<string, string[]> {
  return Object.fromEntries(
    list.sections.map(({ section, lines }) => [
      section,
      lines.map(
        (line) =>
          `${line.name}: ${line.amounts.map(({ amount, unit }) => `${amount.min}${amount.max === amount.min ? "" : `-${amount.max}`} ${unit ?? "each"}`).join(" + ")}`,
      ),
    ]),
  );
}

const lineNamed = (list: GroceryList, name: string): GroceryLine | undefined =>
  list.sections.flatMap((section) => section.lines).find((line) => line.name === name);

describe("building a Grocery List", () => {
  test("scales the Week's Recipes to who's eating, merges by Item, and groups by Store Section", async () => {
    const household = await setUpHousehold();
    // Dal for both Members, so for 2 of its 4; Tacos for both and 2 Guests, so twice over.
    await plan(household, MONDAY, DAL);
    await plan(household, TUESDAY, TACOS);
    succeeded(await household.callTool("set_guests", { ...dinner(TUESDAY), guests: 2 }));

    const list = await build(household);

    expect(list).toMatchObject({ startDate: MONDAY, planChanged: false });
    expect(shopping(list)).toEqual({
      produce: ["garlic: 3 clove", "lime: 2 each"],
      meat: ["ground beef: 907 g"],
      pantry: ["lentils: 200 g"],
      spices: ["salt: 2 ml"],
      // Unresolved, so as written: neither scaled nor merged.
      other: ["1 bunch gochujang leaves: ", "8 corn tortillas: "],
    });
    expect(lineNamed(list, "garlic")).toMatchObject({
      origin: "recipe",
      item: "garlic",
      recipes: [
        { id: DAL, title: "Dal" },
        { id: TACOS, title: "Tacos" },
      ],
      have: false,
      haveAt: null,
    });
    expect(succeeded(await household.callTool("get_grocery_list", { date: TUESDAY }))).toEqual(list);
  });

  test("there is no Grocery List until it is built", async () => {
    const household = await setUpHousehold();
    expect(await household.callTool("get_grocery_list", { date: MONDAY })).toEqual({ ok: true, value: null });
  });
});

async function tick(household: TestHousehold, line: GroceryLine | undefined, have: boolean, at: string) {
  return succeeded<GroceryLine>(await household.callTool("set_have_tick", { line: line?.id, have, at }));
}

async function current(household: TestHousehold): Promise<GroceryList> {
  return succeeded<GroceryList | null>(await household.callTool("get_grocery_list", { date: MONDAY })) as GroceryList;
}

describe("a Grocery List when the plan changes", () => {
  test("says so once the plan it was built from changes, whether the Slots or their Recipes", async () => {
    const household = await setUpHousehold();
    await plan(household, MONDAY, DAL);
    const list = await build(household);
    await tick(household, lineNamed(list, "garlic"), true, "2026-10-24T10:00:00Z");
    succeeded(await household.callTool("add_grocery_line", { date: MONDAY, text: "2 lemons" }));
    expect((await current(household)).planChanged).toBe(false);

    await plan(household, TUESDAY, TACOS);
    const changed = await current(household);
    expect(changed.planChanged).toBe(true);
    // The list stays as it was built until someone rebuilds it.
    expect(lineNamed(changed, "lime")).toBeUndefined();

    expect((await build(household)).planChanged).toBe(false);
    succeeded(await household.callTool("set_diners", { ...dinner(MONDAY), diners: [1] }));
    expect((await current(household)).planChanged).toBe(true);

    await build(household);
    succeeded(await household.callTool("update_recipe", { id: TACOS, ingredients: ["1 lb ground beef"] }));
    expect((await current(household)).planChanged).toBe(true);
  });

  test("doesn't say so for a change that leaves the list as it is", async () => {
    const household = await setUpHousehold();
    const wednesday = "2026-10-28";
    await plan(household, MONDAY, DAL);
    await plan(household, TUESDAY, TACOS);
    await build(household);

    // The same dinners on each other's days, a note, and Dal again for nobody.
    await plan(household, MONDAY, TACOS);
    await plan(household, TUESDAY, DAL);
    succeeded(
      await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: TACOS, note: "Early" }),
    );
    succeeded(
      await household.callTool("set_slot", { ...dinner(wednesday), kind: "recipe", recipeId: DAL, diners: [] }),
    );

    expect((await current(household)).planChanged).toBe(false);
  });

  test("rebuilding keeps Have Ticks and lines added by hand, and drops lines no Recipe needs", async () => {
    const household = await setUpHousehold();
    await plan(household, MONDAY, DAL);
    const list = await build(household);
    await tick(household, lineNamed(list, "garlic"), true, "2026-10-24T10:00:00Z");
    await tick(household, lineNamed(list, "lentils"), true, "2026-10-24T10:00:00Z");
    await tick(household, lineNamed(list, "1 bunch gochujang leaves"), true, "2026-10-24T10:00:00Z");
    const lemons = succeeded<GroceryLine>(
      await household.callTool("add_grocery_line", { date: MONDAY, text: "2 lemons" }),
    );
    expect(lemons).toMatchObject({ origin: "manual", item: "lemon", name: "2 lemons", recipes: [], have: false });
    await tick(household, lemons, true, "2026-10-24T10:00:00Z");

    // Tacos need more garlic; Dal is no longer cooked.
    await plan(household, TUESDAY, TACOS);
    succeeded(await household.callTool("set_slot", { ...dinner(MONDAY), kind: "eat_out" }));
    const rebuilt = await build(household);

    expect(shopping(rebuilt)).toEqual({
      produce: ["2 lemons: ", "garlic: 1 clove", "lime: 1 each"],
      meat: ["ground beef: 454 g"],
      other: ["8 corn tortillas: "],
    });
    expect(lineNamed(rebuilt, "garlic")).toMatchObject({ have: true, recipes: [{ id: TACOS, title: "Tacos" }] });
    expect(lineNamed(rebuilt, "2 lemons")).toMatchObject({ have: true, origin: "manual" });
    expect(lineNamed(rebuilt, "lime")).toMatchObject({ have: false });
  });

  test("a Have Tick needs the same Item in the same units to carry over", async () => {
    const household = await setUpHousehold();
    await plan(household, MONDAY, DAL);
    await tick(household, lineNamed(await build(household), "lentils"), true, "2026-10-24T10:00:00Z");

    // More lentils, but still by mass: still had.
    succeeded(await household.callTool("update_recipe", { id: DAL, ingredients: ["2 kg red lentils"] }));
    expect(lineNamed(await build(household), "lentils")).toMatchObject({ have: true, amounts: [{ unit: "kg" }] });
    // Now also by the cup: something new to check.
    succeeded(
      await household.callTool("update_recipe", { id: DAL, ingredients: ["2 kg red lentils", "1 cup red lentils"] }),
    );
    expect(lineNamed(await build(household), "lentils")).toMatchObject({ have: false });
  });
});

describe("Have Ticks", () => {
  test("are set to a value, and a tick made earlier never undoes a later one", async () => {
    const household = await setUpHousehold();
    await plan(household, MONDAY, DAL);
    const garlic = lineNamed(await build(household), "garlic");

    expect(await tick(household, garlic, true, "2026-10-24T10:00:00Z")).toMatchObject({ have: true });
    // Set again, it stays set: never a toggle.
    expect(await tick(household, garlic, true, "2026-10-24T10:01:00Z")).toMatchObject({ have: true });
    // Unticked offline before the last tick, and synced after it.
    expect(await tick(household, garlic, false, "2026-10-24T09:00:00.000Z")).toMatchObject({
      have: true,
      haveAt: "2026-10-24T10:01:00.000Z",
    });
    expect(await tick(household, garlic, false, "2026-10-24T10:02:00Z")).toMatchObject({ have: false });
  });

  test("refuse a line that doesn't exist, and a line added to a list not yet built", async () => {
    const household = await setUpHousehold();
    expect(
      await household.callTool("set_have_tick", { line: 99, have: true, at: "2026-10-24T10:00:00Z" }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await household.callTool("add_grocery_line", { date: MONDAY, text: "milk" })).toMatchObject({
      ok: false,
      error: { code: "not_built" },
    });
  });
});

describe("Store Sections", () => {
  test("follow the Household's walking order, with lines without an Item last under 'other'", async () => {
    const household = await setUpHousehold();
    expect(succeeded<{ storeSections: string[] }>(await household.callTool("get_household", {})).storeSections).toEqual(
      [
        "produce",
        "bakery",
        "meat",
        "seafood",
        "dairy",
        "frozen",
        "pantry",
        "baking",
        "spices",
        "condiments",
        "international",
        "beverages",
      ],
    );
    await plan(household, MONDAY, DAL);
    await plan(household, TUESDAY, TACOS);
    expect((await build(household)).sections.map((section) => section.section)).toEqual([
      "produce",
      "meat",
      "pantry",
      "spices",
      "other",
    ]);

    const order = succeeded<string[]>(
      await household.callTool("set_store_section_order", { sections: ["spices", "pantry", "produce"] }),
    );

    expect(order.slice(0, 5)).toEqual(["spices", "pantry", "produce", "bakery", "meat"]);
    expect(succeeded<{ storeSections: string[] }>(await household.callTool("get_household", {})).storeSections).toEqual(
      order,
    );
    expect((await current(household)).sections.map((section) => section.section)).toEqual([
      "spices",
      "pantry",
      "produce",
      "meat",
      "other",
    ]);
  });

  test("are each ordered once", async () => {
    const household = await setUpHousehold();
    expect(await household.callTool("set_store_section_order", { sections: ["spices", "spices"] })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});
