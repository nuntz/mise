import { env, exports } from "cloudflare:workers";
import {
  addDays,
  DAY_SHEET_PATH,
  DaySheet,
  type Household,
  type KitchenDisplay,
  localDate,
  type NewKitchenDisplay,
  type Recipe,
  type ToolResult,
} from "@mise/domain";
import { beforeAll, describe, expect, test } from "vitest";
import yoastGraph from "../../../fixtures/pages/yoast-graph.html?raw";
import { SAMPLE_JPEG } from "../../../fixtures/paprika";
import { useFetch } from "../src/links";

const origin = "https://mise.example.com";
const DAY_SHEET = `${origin}${DAY_SHEET_PATH}`;
const TIMEZONE = "America/Vancouver";

// The Day Sheet serves the deployment's one household, which every test here shares.
const household = env.Household.getByName("household");

function succeeded<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

function fetchDaySheet(token?: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(DAY_SHEET, {
    ...init,
    ...(token !== undefined && { headers: { Authorization: `Bearer ${token}` } }),
  });
}

async function pair(label = "Kitchen counter"): Promise<NewKitchenDisplay> {
  return succeeded<NewKitchenDisplay>(await household.callTool("add_kitchen_display", { label }));
}

/** The Day Sheet `token` reads, checked against its schema, which allows no other fields. */
async function daySheet(token: string): Promise<DaySheet> {
  const response = await fetchDaySheet(token);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  return DaySheet.parse(await response.json());
}

async function createRecipe(fields: Record<string, unknown>): Promise<Recipe> {
  return succeeded<Recipe>(await household.callTool("create_recipe", { baseServings: 4, ingredients: [], ...fields }));
}

function today(): string {
  return localDate(new Date(), TIMEZONE);
}

let robin: number;

beforeAll(async () => {
  const set = succeeded<Household>(
    await household.callTool("setup_household", {
      name: "The Example Family",
      timezone: TIMEZONE,
      dinnerTime: "18:30",
      members: [{ name: "Robin" }, { name: "Alex" }],
    }),
  );
  robin = set.members.find((member) => member.name === "Robin")?.id as number;
});

describe("the Day Sheet", () => {
  test("refuses a request without a token, in JSON", async () => {
    const response = await fetchDaySheet();

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("refuses a token no Kitchen Display holds, and a malformed one", async () => {
    await pair();

    for (const token of ["not-a-token", "has spaces", ""]) {
      const response = await fetchDaySheet(token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("gives a paired Kitchen Display today's date and when it turns over", async () => {
    const { token } = await pair();
    const before = Date.now();

    const sheet = await daySheet(token);

    expect(sheet).toMatchObject({
      schemaVersion: 1,
      date: today(),
      timezone: TIMEZONE,
      locale: "en-CA",
      refreshAfterSeconds: 3600,
    });
    // The Household's own offset: Vancouver is UTC-7 or UTC-8.
    expect(sheet.generatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-0[78]:00$/);
    expect(Date.parse(sheet.generatedAt)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    // Midnight at the start of tomorrow, Vancouver time.
    const nextDayAt = new Date(sheet.nextDayAt);
    expect(sheet.nextDayAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/);
    expect(localDate(nextDayAt, TIMEZONE)).toBe(addDays(today(), 1));
    expect(localDate(new Date(nextDayAt.getTime() - 1000), TIMEZONE)).toBe(today());
  });

  test("an unplanned day still has its three Slots, in order", async () => {
    const { token } = await pair();
    await household.callTool("clear_week", { date: today(), confirm: true });

    const sheet = await daySheet(token);

    expect(sheet.slots).toEqual([
      { meal: "breakfast", kind: "unplanned", cooked: false, needsReview: false },
      { meal: "lunch", kind: "unplanned", cooked: false, needsReview: false },
      { meal: "dinner", kind: "unplanned", cooked: false, needsReview: false },
    ]);
  });

  test("shows a recipe Slot's title, and whether it was cooked", async () => {
    const { token } = await pair();
    const oats = await createRecipe({ title: "Overnight oats" });
    const date = today();
    succeeded(await household.callTool("set_slot", { date, meal: "breakfast", kind: "recipe", recipeId: oats.id }));
    succeeded(await household.callTool("set_slot", { date, meal: "lunch", kind: "eat_out" }));
    succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "skip" }));
    succeeded(await household.callTool("mark_cooked", { date, meal: "breakfast" }));

    const sheet = await daySheet(token);

    expect(sheet.slots).toEqual([
      { meal: "breakfast", kind: "recipe", cooked: true, needsReview: false, title: "Overnight oats" },
      { meal: "lunch", kind: "eat_out", cooked: false, needsReview: false },
      { meal: "dinner", kind: "skip", cooked: false, needsReview: false },
    ]);
  });

  test("Leftovers name the earlier Slot they eat, or nothing when they eat nothing in particular", async () => {
    const { token } = await pair();
    const chili = await createRecipe({ title: "Chili" });
    const [yesterday, date] = [addDays(today(), -1), today()];
    succeeded(
      await household.callTool("set_slot", { date: yesterday, meal: "dinner", kind: "recipe", recipeId: chili.id }),
    );
    succeeded(await household.callTool("set_slot", { date, meal: "lunch", kind: "leftovers" }));
    succeeded(
      await household.callTool("link_leftovers", {
        date,
        meal: "lunch",
        of: { date: yesterday, meal: "dinner" },
      }),
    );
    succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "leftovers" }));

    const sheet = await daySheet(token);

    expect(sheet.slots[1]).toEqual({
      meal: "lunch",
      kind: "leftovers",
      cooked: false,
      needsReview: false,
      leftoversOf: { title: "Chili", date: yesterday, meal: "dinner" },
    });
    expect(sheet.slots[2]).toEqual({
      meal: "dinner",
      kind: "leftovers",
      cooked: false,
      needsReview: false,
      leftoversOf: null,
    });
  });

  test("a Slot with a Conflict is marked for review, and nothing private is in the Day Sheet", async () => {
    const { token } = await pair();
    const date = today();
    succeeded(
      await household.callTool("update_member_constraints", {
        id: robin,
        constraints: [{ kind: "allergy", allergen: "peanut" }],
      }),
    );
    const noodles = await createRecipe({
      title: "Peanut noodles",
      ingredients: ["2 tbsp peanut butter"],
      notes: "Grandma's secret sauce",
    });
    succeeded(
      await household.callTool("set_slot", {
        date,
        meal: "dinner",
        kind: "recipe",
        recipeId: noodles.id,
        note: "Make extra for the neighbours",
        guests: 1,
        guestConstraints: [
          { kind: "allergy", allergen: "sesame" },
          { kind: "dislike", term: "cilantro" },
        ],
        overrides: [{ who: robin, allergen: "peanut", reason: "Robin's bowl without the sauce" }],
      }),
    );
    succeeded(await household.callTool("mark_cooked", { date, meal: "dinner" }));
    // A Recipe imported from a link has a source URL, an author and a photo.
    const page = "https://kitchen.example.com/recipes/red-lentil-dal/";
    useFetch(async (input, init) => {
      const { url } = new Request(input, init);
      if (url === page) return new Response(yoastGraph, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (url.endsWith(".jpg")) return new Response(SAMPLE_JPEG, { headers: { "Content-Type": "image/jpeg" } });
      return new Response("Not found", { status: 404 });
    });
    const dal = succeeded<{ recipe: { id: number } }>(await household.callTool("import_url", { url: page })).recipe;
    const imported = succeeded<Recipe>(await household.callTool("get_recipe", { id: dal.id }));
    expect(imported.photoKey).not.toBeNull();
    expect(imported.source).toMatchObject({ kind: "url", author: "Alex Example" });
    succeeded(
      await household.callTool("set_slot", {
        date,
        meal: "lunch",
        kind: "recipe",
        recipeId: dal.id,
        overrides: [{ who: robin, allergen: "peanut", reason: "Checked the label myself" }],
      }),
    );
    succeeded(
      await household.callTool("rate_recipe", { date, meal: "dinner", rating: "again", note: "Loved the crunch" }),
    );

    const response = await fetchDaySheet(token);
    const body = await response.text();
    const sheet = DaySheet.parse(JSON.parse(body));

    expect(sheet.slots.slice(1)).toEqual([
      { meal: "lunch", kind: "recipe", cooked: false, needsReview: true, title: "Weeknight Red Lentil Dal & Rice" },
      { meal: "dinner", kind: "recipe", cooked: true, needsReview: true, title: "Peanut noodles" },
    ]);
    for (const secret of [
      "Robin",
      "Alex",
      "Example Family",
      '"peanut"',
      "sesame",
      "cilantro",
      "allerg",
      "Grandma",
      "neighbours",
      "without the sauce",
      "the label",
      "again",
      "crunch",
      "photo",
      "http",
      "example.com",
      "Alex Example",
      "guest",
    ]) {
      expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  test("records when each Kitchen Display last read it", async () => {
    const display = await pair("Pantry door");
    const listed = () =>
      household
        .callTool("list_kitchen_displays", {})
        .then((result) => succeeded<KitchenDisplay[]>(result).find((shown) => shown.id === display.id));
    expect(await listed()).toEqual({
      id: display.id,
      label: "Pantry door",
      addedAt: display.addedAt,
      lastUsedAt: null,
    });
    expect(JSON.stringify(await listed())).not.toContain(display.token);

    const before = new Date().toISOString();
    await daySheet(display.token);

    expect((await listed())?.lastUsedAt?.localeCompare(before)).toBeGreaterThanOrEqual(0);
  });

  test("a revoked token is refused on the very next request; other Kitchen Displays carry on", async () => {
    const [revoked, kept] = [await pair("Old one"), await pair("New one")];
    await daySheet(revoked.token);

    expect(
      succeeded<KitchenDisplay>(await household.callTool("revoke_kitchen_display", { id: revoked.id })).label,
    ).toBe("Old one");

    const response = await fetchDaySheet(revoked.token);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    await daySheet(kept.token);
    const listed = succeeded<KitchenDisplay[]>(await household.callTool("list_kitchen_displays", {}));
    expect(listed.map((display) => display.id)).not.toContain(revoked.id);
    expect((await household.callTool("revoke_kitchen_display", { id: revoked.id })).ok).toBe(false);
  });

  test("anything else under the Kitchen Display's path is not found, in JSON, rather than the app", async () => {
    const { token } = await pair();

    const response = await exports.default.fetch(`${DAY_SHEET}/extra`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("answers only GET, in JSON", async () => {
    const { token } = await pair();

    const response = await fetchDaySheet(token, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});
