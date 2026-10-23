import { env } from "cloudflare:workers";
import type { DueStaples, GroceryLine, GroceryList, Staple, ToolResult } from "@mise/domain";
import { describe, expect, test } from "vitest";

async function setUpHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family", members: [{ name: "Robin" }] });
  return household;
}

type TestHousehold = Awaited<ReturnType<typeof setUpHousehold>>;

function succeeded<T = Staple>(outcome: unknown): T {
  const result = outcome as ToolResult<T>;
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

async function due(household: TestHousehold): Promise<DueStaples> {
  return succeeded<DueStaples>(await household.callTool("list_due_staples", {}));
}

const items = (staples: Staple[]) => staples.map((staple) => staple.item);

describe("Staples", () => {
  test("an Item becomes a Staple: in the pantry, checked every 14 days and stocked, unless told otherwise", async () => {
    const household = await setUpHousehold();

    const rice = succeeded(await household.callTool("upsert_staple", { item: "rice" }));
    const milk = succeeded(
      await household.callTool("upsert_staple", {
        item: "milk",
        location: "fridge",
        checkEvery: "every_shop",
        qtyPerShop: { amount: { min: 2, max: 2 }, unit: "l" },
      }),
    );

    expect(rice).toEqual({
      item: "rice",
      name: "rice",
      location: "pantry",
      checkEvery: 14,
      alwaysBuy: false,
      qtyPerShop: null,
      status: "stocked",
      lastChecked: null,
      outInARow: 0,
      suggestAlwaysBuy: false,
    });
    expect(milk).toMatchObject({ location: "fridge", checkEvery: "every_shop" });
    expect(succeeded<Staple[]>(await household.callTool("list_staples", {}))).toEqual([rice, milk]);
  });

  test("changing a Staple keeps what the change leaves out", async () => {
    const household = await setUpHousehold();
    succeeded(await household.callTool("upsert_staple", { item: "milk", location: "fridge" }));
    succeeded(await household.callTool("record_staple_status", { item: "milk", status: "low" }));

    const changed = succeeded(await household.callTool("upsert_staple", { item: "milk", alwaysBuy: true }));

    expect(changed).toMatchObject({ location: "fridge", alwaysBuy: true, status: "low", checkEvery: 14 });
  });

  test("only an Item can be a Staple, and only a Staple can be removed or checked", async () => {
    const household = await setUpHousehold();
    const notFound = { ok: false, error: expect.objectContaining({ code: "not_found" }) };

    expect(await household.callTool("upsert_staple", { item: "household:99" })).toEqual(notFound);
    expect(await household.callTool("record_staple_status", { item: "rice", status: "out" })).toEqual(notFound);
    expect(await household.callTool("remove_staple", { item: "rice" })).toEqual(notFound);

    const rice = succeeded(await household.callTool("upsert_staple", { item: "rice" }));
    expect(await household.callTool("remove_staple", { item: "rice" })).toEqual({ ok: true, value: rice });
    expect(succeeded<Staple[]>(await household.callTool("list_staples", {}))).toEqual([]);
  });
});

describe("a pantry check-in", () => {
  test("asks about the Staples that are due, pantry first, and stops asking about one once answered", async () => {
    const household = await setUpHousehold();
    for (const [item, location] of [
      ["butter", "fridge"],
      ["rice", "pantry"],
      ["frozen_peas", "freezer"],
      ["flour", "pantry"],
    ] as const) {
      succeeded(await household.callTool("upsert_staple", { item, location }));
    }
    succeeded(await household.callTool("upsert_staple", { item: "milk", alwaysBuy: true }));

    expect(await due(household)).toEqual({
      due: 4,
      staples: [
        expect.objectContaining({ item: "flour" }),
        expect.objectContaining({ item: "rice" }),
        expect.objectContaining({ item: "butter" }),
        expect.objectContaining({ item: "frozen_peas" }),
      ],
    });

    succeeded(await household.callTool("record_staple_status", { item: "rice", status: "stocked" }));
    succeeded(await household.callTool("record_staple_status", { item: "flour", status: "low" }));
    // Stocked is next asked about in 21 days; low, at the next check after today.
    expect(items((await due(household)).staples)).toEqual(["butter", "frozen_peas"]);
  });

  test("adapts the interval: stocked stretches it, out shrinks it, until it is due again", async () => {
    const household = await setUpHousehold();
    succeeded(await household.callTool("upsert_staple", { item: "rice" }));

    // Out 8 days ago: checked again after 7 days, so due.
    const at = daysAgo(8);
    const out = succeeded(await household.callTool("record_staple_status", { item: "rice", status: "out", at }));
    expect(out).toMatchObject({ status: "out", checkEvery: 7, lastChecked: at });
    expect(items((await due(household)).staples)).toEqual(["rice"]);

    const stocked = succeeded(await household.callTool("record_staple_status", { item: "rice", status: "stocked" }));
    expect(stocked.checkEvery).toBe(11);
    expect((await due(household)).due).toBe(0);
  });

  test("a status recorded before the latest one changes nothing", async () => {
    const household = await setUpHousehold();
    succeeded(await household.callTool("upsert_staple", { item: "rice" }));
    const latest = succeeded(
      await household.callTool("record_staple_status", { item: "rice", status: "low", at: daysAgo(1) }),
    );

    const late = succeeded(
      await household.callTool("record_staple_status", { item: "rice", status: "out", at: daysAgo(2) }),
    );

    expect(late).toEqual(latest);
  });

  test("suggests always buying a Staple out three check-ins in a row; always bought, it is never asked about", async () => {
    const household = await setUpHousehold();
    succeeded(await household.callTool("upsert_staple", { item: "egg", location: "fridge" }));

    const answers: Staple[] = [];
    for (const days of [30, 20, 10]) {
      answers.push(
        succeeded(await household.callTool("record_staple_status", { item: "egg", status: "out", at: daysAgo(days) })),
      );
    }
    expect(answers.map((answer) => answer.suggestAlwaysBuy)).toEqual([false, false, true]);

    const always = succeeded(await household.callTool("upsert_staple", { item: "egg", alwaysBuy: true }));
    expect(always.suggestAlwaysBuy).toBe(false);
    expect((await due(household)).due).toBe(0);
  });
});

describe("Staples on the Grocery List", () => {
  // Monday 26 October 2026.
  const MONDAY = "2026-10-26";
  const dozen = { amount: { min: 12, max: 12 }, unit: null };

  /** Dal on Monday, for both Members of a Household whose Weeks start on Monday. */
  async function planDal(household: TestHousehold) {
    succeeded(await household.callTool("add_member", { name: "Alex" }));
    const { id } = succeeded<{ id: number }>(
      await household.callTool("create_recipe", {
        title: "Dal",
        baseServings: 2,
        ingredients: ["400 g red lentils", "3 eggs", "salt to taste", "1 tbsp olive oil", "olive oil, to fry"],
      }),
    );
    succeeded(await household.callTool("set_slot", { date: MONDAY, meal: "dinner", kind: "recipe", recipeId: id }));
    return id;
  }

  async function build(household: TestHousehold): Promise<GroceryList> {
    return succeeded<GroceryList>(await household.callTool("build_grocery_list", { date: MONDAY }));
  }
  async function current(household: TestHousehold): Promise<GroceryList> {
    return succeeded<GroceryList>(await household.callTool("get_grocery_list", { date: MONDAY }));
  }
  const lines = (list: GroceryList) => list.sections.flatMap((section) => section.lines);
  const lineFor = (list: GroceryList, item: string) => lines(list).find((line) => line.item === item) as GroceryLine;

  test("buys Staples low, out or always bought at their usual quantity, unless the Recipes need an amount", async () => {
    const household = await setUpHousehold();
    await planDal(household);
    for (const [item, status] of [
      ["rice", "low"],
      ["flour", "out"],
      ["salt", "stocked"],
      ["olive_oil", "stocked"],
      ["egg", "out"],
    ] as const) {
      succeeded(await household.callTool("upsert_staple", { item, qtyPerShop: item === "egg" ? dozen : undefined }));
      succeeded(await household.callTool("record_staple_status", { item, status }));
    }
    succeeded(
      await household.callTool("upsert_staple", {
        item: "milk",
        alwaysBuy: true,
        qtyPerShop: { amount: { min: 2, max: 2 }, unit: "l" },
      }),
    );

    const list = await build(household);

    expect(
      lines(list).map((line) => [line.item, line.origin, line.amounts, line.unmeasured, line.recipes.length]),
    ).toEqual(
      expect.arrayContaining([
        ["rice", "staple", [], false, 0],
        ["flour", "staple", [], false, 0],
        ["milk", "staple", [{ amount: { min: 2, max: 2 }, unit: "l" }], false, 0],
        // Dal needs 3 eggs: that replaces the dozen.
        ["egg", "recipe", [{ amount: { min: 3, max: 3 }, unit: null }], false, 1],
        // Some olive oil to fry: kept on hand, so only the tablespoon is bought.
        ["olive_oil", "recipe", [{ amount: { min: 15, max: 15 }, unit: "ml" }], false, 1],
      ]),
    );
    // Salt to taste, and kept on hand: nothing to buy.
    expect(lines(list).map((line) => line.item)).not.toContain("salt");
    expect(lines(list)).toHaveLength(6);
    expect(list.staplesChanged).toBe(false);
  });

  test("Have-ticking a Staple's line sets it to stocked, unless its status was recorded later", async () => {
    const household = await setUpHousehold();
    succeeded(await household.callTool("upsert_staple", { item: "rice" }));
    succeeded(await household.callTool("record_staple_status", { item: "rice", status: "out", at: daysAgo(3) }));
    const rice = lineFor(await build(household), "rice");

    // Ticked yesterday, synced late, after it was found out again this morning: still out.
    succeeded(await household.callTool("record_staple_status", { item: "rice", status: "out", at: daysAgo(0.1) }));
    succeeded(await household.callTool("set_have_tick", { line: rice.id, have: true, at: daysAgo(1) }));
    expect(await staple(household, "rice")).toMatchObject({ status: "out" });

    const at = new Date().toISOString();
    succeeded(await household.callTool("set_have_tick", { line: rice.id, have: true, at }));
    // Not a check-in answer: its interval stays as the check-ins left it.
    expect(await staple(household, "rice")).toMatchObject({ status: "stocked", lastChecked: at, checkEvery: 4 });

    // Unticking says nothing about how it stands.
    succeeded(await household.callTool("set_have_tick", { line: rice.id, have: false, at: new Date().toISOString() }));
    expect(await staple(household, "rice")).toMatchObject({ status: "stocked" });
  });

  test("says when a Staple has become due to be bought since the list was built", async () => {
    const household = await setUpHousehold();
    succeeded(await household.callTool("upsert_staple", { item: "rice" }));
    succeeded(await household.callTool("upsert_staple", { item: "flour" }));
    succeeded(await household.callTool("record_staple_status", { item: "rice", status: "out" }));
    const rice = lineFor(await build(household), "rice");

    // Bought: not a change to the list.
    succeeded(await household.callTool("set_have_tick", { line: rice.id, have: true, at: new Date().toISOString() }));
    expect((await current(household)).staplesChanged).toBe(false);

    succeeded(await household.callTool("record_staple_status", { item: "flour", status: "low" }));
    expect(await current(household)).toMatchObject({ staplesChanged: true, planChanged: false });

    // Rebuilt: flour joins, and rice, stocked now, goes.
    const rebuilt = await build(household);
    expect(rebuilt.staplesChanged).toBe(false);
    expect(lines(rebuilt).map((line) => line.item)).toEqual(["flour"]);
  });

  test("lists the Staples a Recipe uses", async () => {
    const household = await setUpHousehold();
    const dal = await planDal(household);
    for (const item of ["rice", "salt", "egg"]) succeeded(await household.callTool("upsert_staple", { item }));

    const used = succeeded<Staple[]>(await household.callTool("list_staples", { usedBy: dal }));

    expect(items(used)).toEqual(["egg", "salt"]);
  });
});

async function staple(household: TestHousehold, item: string): Promise<Staple | undefined> {
  return succeeded<Staple[]>(await household.callTool("list_staples", {})).find((one) => one.item === item);
}
