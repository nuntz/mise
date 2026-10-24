import { env } from "cloudflare:workers";
import { exportKey, localDate, nextOccurrence } from "@mise/domain";
import { describe, expect, onTestFinished, test } from "vitest";
import { paprikaExport, SAMPLE_PAPRIKA_RECIPES } from "../../../fixtures/paprika";
import sampleHousehold from "../../../fixtures/sample-household.json";

const householdUrl = "http://mise.example.com/agents/household/household";

const recipe = {
  title: "Dal",
  baseServings: 4,
  ingredients: ["1 ⅓ cups red lentils", "1 tbsp ghee", "1 tsp mystery masala"],
  steps: ["Simmer."],
  tags: ["vegetarian"],
  recurring: { weekday: "monday" },
};

function freshHousehold() {
  return env.Household.getByName(crypto.randomUUID());
}

type HouseholdStub = ReturnType<typeof freshHousehold>;

async function exportOf(household: HouseholdStub): Promise<string> {
  const response = await household.fetch(`${householdUrl}/export`);
  expect(response.status).toBe(200);
  return response.text();
}

function restore(household: HouseholdStub, body: string): Promise<Response> {
  return household.fetch(`${householdUrl}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("export and restore", () => {
  test("export → restore into a fresh deployment → export gives an identical file", async () => {
    const original = freshHousehold();
    await original.callTool("setup_household", sampleHousehold);
    await original.callTool("create_recipe", recipe);
    const planned = [
      await original.callTool("set_slot", {
        date: "2026-10-26",
        meal: "dinner",
        kind: "recipe",
        recipeId: 1,
        overrides: [
          { who: 2, allergen: "milk", reason: "Oil instead of ghee for Alex" },
          { who: 3, allergen: "peanut", reason: "The masala is ours, no peanut" },
        ],
      }),
      await original.callTool("set_diners", { date: "2026-10-26", meal: "dinner", diners: [1, 3] }),
      await original.callTool("set_guests", {
        date: "2026-10-26",
        meal: "dinner",
        guests: 1,
        guestConstraints: [{ kind: "allergy", allergen: "sesame" }],
        overrides: [{ who: "guests", allergen: "sesame", reason: "The masala is ours, no sesame" }],
      }),
      await original.callTool("set_effort_budgets", { budgets: { monday: 30 } }),
      await original.callTool("set_week_effort_budgets", { date: "2026-11-02", budgets: { friday: 15 } }),
      await original.callTool("propose_week", { date: "2026-11-02" }),
      await original.callTool("review_week", { date: "2026-11-02", reviewed: true }),
      // A dinner already eaten, cooked and rated.
      await original.callTool("set_slot", {
        date: "2026-10-05",
        meal: "dinner",
        kind: "recipe",
        recipeId: 1,
        diners: [1],
      }),
      await original.callTool("mark_cooked", { date: "2026-10-05", meal: "dinner" }),
      await original.callTool("rate_recipe", {
        date: "2026-10-05",
        meal: "dinner",
        rating: "again",
        note: "Do it again",
      }),
      await original.callTool("upsert_staple", {
        item: "egg",
        location: "fridge",
        qtyPerShop: { amount: { min: 12, max: 12 }, unit: null },
      }),
      await original.callTool("upsert_staple", { item: "milk", checkEvery: "every_shop", alwaysBuy: true }),
      await original.callTool("record_staple_status", { item: "egg", status: "out" }),
    ];
    expect(planned.every((result) => result.ok)).toBe(true);
    const exported = await exportOf(original);

    const fresh = freshHousehold();
    const restored = await restore(fresh, exported);

    expect(restored.status).toBe(200);
    expect(await exportOf(fresh)).toBe(exported);
    expect(await fresh.callTool("get_household", {})).toMatchObject({
      ok: true,
      value: { name: sampleHousehold.name, members: [{ name: "Robin" }, { name: "Alex" }, { name: "Sam" }] },
    });
    expect(await fresh.callTool("get_recipe", { id: 1 })).toEqual(await original.callTool("get_recipe", { id: 1 }));
    expect(await fresh.callTool("get_week", { date: "2026-10-26" })).toEqual(
      await original.callTool("get_week", { date: "2026-10-26" }),
    );
    expect(await fresh.callTool("get_week", { date: "2026-10-05" })).toEqual(
      await original.callTool("get_week", { date: "2026-10-05" }),
    );
    expect(await fresh.callTool("get_week", { date: "2026-11-02" })).toEqual(
      await original.callTool("get_week", { date: "2026-11-02" }),
    );
    expect(await fresh.callTool("get_household", {})).toEqual(await original.callTool("get_household", {}));
    expect(await fresh.callTool("list_staples", {})).toEqual(await original.callTool("list_staples", {}));
  });

  test("the Household's own Items and aliases survive a restore, and its Recipes still resolve to them", async () => {
    const original = freshHousehold();
    await original.callTool("setup_household", sampleHousehold);
    await original.callTool("create_recipe", recipe);
    await original.callTool("create_item", {
      name: "mystery masala",
      section: "spices",
      allergens: ["mustard"],
      unitFamily: "volume",
    });
    await original.callTool("resolve_ingredient", { text: "ghee butter", item: "ghee" });
    const exported = await exportOf(original);

    const fresh = freshHousehold();
    expect((await restore(fresh, exported)).status).toBe(200);

    expect(await exportOf(fresh)).toBe(exported);
    expect(await fresh.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: true,
      value: { ingredients: [{}, {}, { item: "household:1" }], allergens: { kind: "known" } },
    });
    expect(await fresh.callTool("list_items", {})).toEqual(await original.callTool("list_items", {}));
  });

  test("edits to Items survive a restore: a Household Item's fields, and a shipped one's aliases and section", async () => {
    const original = freshHousehold();
    await original.callTool("setup_household", sampleHousehold);
    await original.callTool("create_recipe", recipe);
    await original.callTool("create_item", {
      name: "mystery masala",
      section: "spices",
      allergens: ["mustard"],
      unitFamily: "volume",
    });
    await original.callTool("update_item", {
      id: "household:1",
      name: "house masala",
      aliases: ["mystery masala"],
      allergens: ["sesame"],
      section: "international",
    });
    await original.callTool("update_item", { id: "ghee", aliases: ["ghee butter"], section: "international" });
    const exported = await exportOf(original);

    const fresh = freshHousehold();
    expect((await restore(fresh, exported)).status).toBe(200);

    expect(await exportOf(fresh)).toBe(exported);
    expect(await fresh.callTool("list_items", {})).toEqual(await original.callTool("list_items", {}));
    expect(await fresh.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: true,
      value: { allergens: { kind: "known", allergens: expect.arrayContaining(["sesame"]) } },
    });
  });

  test("imported Recipes, their import runs and flags survive a restore", async () => {
    const original = freshHousehold();
    await original.callTool("setup_household", sampleHousehold);
    await original.callTool("create_recipe", { ...recipe, title: "Weeknight Dal" });
    const [dal] = SAMPLE_PAPRIKA_RECIPES;
    // No photo: photos stay in R2, outside the export.
    const upload = await original.fetch(`${householdUrl}/imports/paprika`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: await paprikaExport([{ ...dal, photo_data: null }]),
    });
    await original.callTool("run_paprika_import", { upload: ((await upload.json()) as { upload: string }).upload });
    const exported = await exportOf(original);

    const fresh = freshHousehold();
    expect((await restore(fresh, exported)).status).toBe(200);

    expect(await exportOf(fresh)).toBe(exported);
    expect(await fresh.callTool("get_recipe", { id: 2 })).toEqual(await original.callTool("get_recipe", { id: 2 }));
    expect(await fresh.callTool("list_import_runs", {})).toEqual(await original.callTool("list_import_runs", {}));
    expect(await fresh.callTool("list_import_flags", {})).toMatchObject({ ok: true, value: [{ kind: "duplicate" }] });
  });

  test("a removed Member's id is not handed out again after a restore", async () => {
    const original = freshHousehold();
    await original.callTool("setup_household", sampleHousehold);
    const sam = 3;
    await original.callTool("remove_member", { id: sam });
    const exported = await exportOf(original);
    const fresh = freshHousehold();
    await restore(fresh, exported);
    expect(await exportOf(fresh)).toBe(exported);

    const added = await fresh.callTool("add_member", { name: "Jordan" });

    expect(added).toMatchObject({ ok: true, value: { id: 4, name: "Jordan" } });
  });

  test("restore refuses a household that already holds data", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = await exportOf(source);
    const target = freshHousehold();
    await target.callTool("setup_household", { name: "Someone Else" });

    const response = await restore(target, exported);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "not_empty" });
    expect(await target.callTool("get_household", {})).toMatchObject({ ok: true, value: { name: "Someone Else" } });
  });

  test("an export covers the Household's tables and nothing of the SDK's", async () => {
    const household = freshHousehold();
    await household.callTool("setup_household", sampleHousehold);

    const exported = JSON.parse(await exportOf(household));

    expect(exported).toEqual({
      format: "mise.household-export",
      version: 2,
      schemaVersion: 16,
      tables: {
        calendar_token: [],
        household: [
          {
            id: 1,
            name: "The Example Family",
            timezone: "America/Vancouver",
            dinner_time: "18:00",
            week_starts_on: "monday",
            units: "metric",
            locale: "en-CA",
          },
        ],
        member: [
          { id: 1, name: "Robin", email: "cook@example.com" },
          { id: 2, name: "Alex", email: "alex@example.com" },
          { id: 3, name: "Sam", email: null },
        ],
        member_constraint: [
          { member_id: 1, position: 0, kind: "dislike", allergen: null, term: "olives" },
          { member_id: 2, position: 0, kind: "intolerance", allergen: "milk", term: "lactose" },
          { member_id: 3, position: 0, kind: "allergy", allergen: "peanut", term: null },
        ],
        item: [],
        item_alias: [],
        item_allergen: [],
        item_section: [],
        import_error: [],
        import_flag: [],
        import_run: [],
        recipe: [],
        recipe_ingredient: [],
        recipe_step: [],
        recipe_tag: [],
        slot: [],
        slot_diner: [],
        slot_guest_constraint: [],
        slot_override: [],
        slot_rating: [],
        slot_reason: [],
        effort_budget: [],
        week: [],
        week_effort_budget: [],
        week_start_change: [],
        store_section: [],
        grocery_line: [],
        staple: [],
      },
      sequences: { member: 3 },
      photoKeys: [],
    });
  });

  test("an export lists the photos stored in R2", async () => {
    const household = freshHousehold();
    await env.BUCKET.put("photos/recipe-1.jpg", "jpeg");
    await env.BUCKET.put("exports/2026-10-20.json", "{}");
    onTestFinished(() => env.BUCKET.delete(["photos/recipe-1.jpg", "exports/2026-10-20.json"]));

    const exported = JSON.parse(await exportOf(household));

    expect(exported.photoKeys).toEqual(["photos/recipe-1.jpg"]);
  });

  test.each([
    ["not JSON", "{"],
    ["not an export", JSON.stringify({ hello: "world" })],
    ["a future export format", JSON.stringify({ format: "mise.household-export", version: 3 })],
  ])("restore rejects a body that is %s", async (_, body) => {
    const household = freshHousehold();

    const response = await restore(household, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
  });

  test("restore only accepts a JSON body, so a cross-site form cannot post one", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = await exportOf(source);
    const target = freshHousehold();

    const response = await target.fetch(`${householdUrl}/restore`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: exported,
    });

    expect(response.status).toBe(415);
    expect(await target.callTool("get_household", {})).toEqual({ ok: true, value: null });
  });

  test("restore rejects an export with a column the schema does not have, loading nothing", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = JSON.parse(await exportOf(source));
    exported.tables.household[0].favourite_colour = "green";
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await target.callTool("get_household", {})).toEqual({ ok: true, value: null });
  });

  test("restore rejects rows the Household cannot read, leaving it empty for a corrected export", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = JSON.parse(await exportOf(source));
    const valid = JSON.stringify(exported);
    exported.tables.household[0].timezone = "Mars/Olympus_Mons";
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
    expect(await target.callTool("get_household", {})).toEqual({ ok: true, value: null });
    expect((await restore(target, valid)).status).toBe(200);
    expect(await exportOf(target)).toBe(await exportOf(source));
  });

  test("restore rejects a malformed Constraint even when the export has no Household settings", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = JSON.parse(await exportOf(source));
    exported.tables.household = [];
    exported.tables.member_constraint[2].allergen = "unicorn";
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
  });

  test("restore rejects a row that refers to one the export does not have", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    await source.callTool("create_recipe", recipe);
    const exported = JSON.parse(await exportOf(source));
    exported.tables.recipe_step[0].recipe_id = 9;
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
    expect(await target.callTool("get_household", {})).toEqual({ ok: true, value: null });
  });

  test("restore rejects an Ingredient naming an Item the catalogue does not have", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    await source.callTool("create_recipe", recipe);
    const exported = JSON.parse(await exportOf(source));
    exported.tables.recipe_ingredient[0].item_id = "unobtainium";
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
    expect(await target.callTool("search_recipes", {})).toEqual({ ok: true, value: [] });
  });

  test("restore rejects an alias of an Item the catalogue does not have", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    await source.callTool("resolve_ingredient", { text: "beurre", item: "butter" });
    const exported = JSON.parse(await exportOf(source));
    exported.tables.item_alias[0].item_id = "household:9";
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
  });

  /** An export of a Household whose Weeks start on `weekStartsOn` after `changes`, as rows. */
  async function withWeekStartChanges(weekStartsOn: string, changes: { from_date: string; stretches: string }[]) {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = JSON.parse(await exportOf(source));
    exported.tables.household[0].week_starts_on = weekStartsOn;
    exported.tables.week_start_change = changes;
    return JSON.stringify(exported);
  }

  // Monday 2026-10-26's Week runs on to Wednesday 2026-11-04; Weeks start on Thursdays after.
  const toThursday = { from_date: "2026-11-05", stretches: "2026-10-26" };

  test("restore keeps the changes of week start, and so the same Weeks", async () => {
    const target = freshHousehold();

    expect((await restore(target, await withWeekStartChanges("thursday", [toThursday]))).status).toBe(200);

    expect(await target.callTool("get_household", {})).toMatchObject({
      ok: true,
      value: { weekStartsOn: "thursday", weekStartChanges: [{ from: "2026-11-05", stretches: "2026-10-26" }] },
    });
  });

  test.each([
    ["stretches a Week that starts after it", "thursday", [{ from_date: "2026-10-22", stretches: "2026-10-26" }]],
    ["stretches a Week no further than seven days", "thursday", [{ from_date: "2026-10-29", stretches: "2026-10-26" }]],
    ["leaves Weeks starting on another day than the Household's", "friday", [toThursday]],
    [
      "stretches a Week that does not start on the day Weeks start on then",
      "saturday",
      [toThursday, { from_date: "2026-11-21", stretches: "2026-11-09" }],
    ],
    [
      "stretches a Week from before the previous change",
      "saturday",
      [toThursday, { from_date: "2026-11-07", stretches: "2026-10-29" }],
    ],
  ])("restore rejects a change of week start that %s", async (_, weekStartsOn, changes) => {
    const target = freshHousehold();

    const response = await restore(target, await withWeekStartChanges(weekStartsOn, changes));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
  });

  test.each([
    ["an Item the catalogue does not have", { item_id: "unobtainium" }],
    ["a Household Item, which keeps its section itself", { item_id: "household:1" }],
    ["no Store Section", { section: "aisle 9" }],
  ])("restore rejects a Store Section override of %s", async (_, change) => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    await source.callTool("create_item", {
      name: "mystery masala",
      section: "spices",
      allergens: [],
      unitFamily: "volume",
    });
    await source.callTool("update_item", { id: "garam_masala", section: "international" });
    const exported = JSON.parse(await exportOf(source));
    Object.assign(exported.tables.item_section[0], change);
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
  });

  test("restore rejects an export from another schema version", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = JSON.parse(await exportOf(source));
    exported.schemaVersion = 99;

    const response = await restore(freshHousehold(), JSON.stringify(exported));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "schema_mismatch" });
  });
});

describe("nightly export", () => {
  test("setting up the Household schedules the export for 03:00 Household time", async () => {
    const household = freshHousehold();
    await household.callTool("setup_household", { name: "The Example Family", timezone: "Asia/Tokyo" });

    const schedules = await household.listSchedules();

    const expected = nextOccurrence(new Date(), "03:00", "Asia/Tokyo");
    expect(schedules).toEqual([
      expect.objectContaining({ callback: "nightlyExport", time: expected.getTime() / 1000 }),
    ]);
  });

  test("the nightly export writes the export to R2 under the Household's date and schedules the next", async () => {
    const household = freshHousehold();
    await household.callTool("setup_household", sampleHousehold);
    const key = exportKey(localDate(new Date(), sampleHousehold.timezone));
    onTestFinished(() => env.BUCKET.delete(key));

    await household.nightlyExport();

    const stored = await env.BUCKET.get(key);
    expect(await stored?.text()).toBe(await exportOf(household));
    expect(await household.listSchedules()).toEqual([expect.objectContaining({ callback: "nightlyExport" })]);
  });

  test("nothing is scheduled before the Household is set up", async () => {
    expect(await freshHousehold().listSchedules()).toEqual([]);
  });
});
