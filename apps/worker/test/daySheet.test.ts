import { env, exports } from "cloudflare:workers";
import {
  addDays,
  type CalendarToken,
  calendarFeedPath,
  DAY_SHEET_MAX_BYTES,
  DAY_SHEET_PATH,
  DaySheet,
  type Household,
  type KitchenDisplay,
  localDate,
  type NewKitchenDisplay,
  type Recipe,
  scaledLine,
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

/** Clears the Weeks holding today and tomorrow, Guests and Leftovers links with them. */
async function clearDays(): Promise<void> {
  for (const date of [today(), addDays(today(), 1)]) {
    succeeded(await household.callTool("clear_week", { date, confirm: true }));
  }
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
      {
        meal: "breakfast",
        kind: "recipe",
        cooked: true,
        needsReview: false,
        title: "Overnight oats",
        servingsText: "For 2. The Recipe makes 4.",
        recipe: { ingredients: [], steps: [] },
      },
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

    expect(sheet.slots.slice(1)).toMatchObject([
      { meal: "lunch", kind: "recipe", cooked: false, needsReview: true, title: "Weeknight Red Lentil Dal & Rice" },
      { meal: "dinner", kind: "recipe", cooked: true, needsReview: true, title: "Peanut noodles" },
    ]);
    // The Recipes come with it, but not what is private about them.
    expect(sheet.slots[2]?.recipe?.ingredients).toEqual(["1½ tbsp peanut butter"]);
    expect(sheet.slots[1]?.recipe?.steps.length).toBeGreaterThan(0);
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

  test("a recipe Slot carries its Recipe, scaled as Kitchen mode scales it, its Leftovers included", async () => {
    const { token } = await pair();
    await clearDays();
    // The Recipe Kitchen mode's tests cook for 6.
    const curry = await createRecipe({
      title: "Curry",
      ingredients: ["2 cloves garlic, minced", "1 cup rice", "400 ml coconut milk", "salt to taste"],
      steps: ["Fry the garlic.", "Add the coconut milk and simmer.", "Serve over the rice."],
    });
    const [date, tomorrow] = [today(), addDays(today(), 1)];
    // Robin, Alex and a Guest tonight; the same three again for tomorrow's lunch.
    succeeded(
      await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId: curry.id, guests: 1 }),
    );
    succeeded(await household.callTool("set_slot", { date: tomorrow, meal: "lunch", kind: "leftovers", guests: 1 }));
    succeeded(
      await household.callTool("link_leftovers", { date: tomorrow, meal: "lunch", of: { date, meal: "dinner" } }),
    );

    const dinner = (await daySheet(token)).slots[2];

    expect(dinner?.servingsText).toBe("For 6. The Recipe makes 4.");
    expect(dinner?.recipe).toEqual({
      ingredients: ["3 cloves garlic, minced", "1½ cup rice", "600 ml coconut milk", "salt to taste"],
      steps: ["Fry the garlic.", "Add the coconut milk and simmer.", "Serve over the rice."],
    });
    // Kitchen mode writes each line with this same function, for the same Slot.
    expect(dinner?.recipe?.ingredients).toEqual(curry.ingredients.map((line) => scaledLine(line, 6 / 4, "en-CA")));
  });

  test("a Ready-made dish is heated whole, never part of its package", async () => {
    const { token } = await pair();
    await clearDays();
    const dumplings = succeeded<Recipe>(
      await household.callTool("create_ready_made_recipe", {
        title: "Dumplings",
        product: "frozen vegetable dumplings",
        baseServings: 4,
        allergens: [],
        section: "frozen",
        steps: [],
        effortMinutes: 5,
      }),
    );
    // Robin, Alex and a Guest: 3 from a pack for 4.
    succeeded(
      await household.callTool("set_slot", {
        date: today(),
        meal: "dinner",
        kind: "recipe",
        recipeId: dumplings.id,
        guests: 1,
      }),
    );

    const dinner = (await daySheet(token)).slots[2];

    expect(dinner?.servingsText).toBe("For 3. The Recipe makes 4.");
    expect(dinner?.recipe?.ingredients).toEqual(["1 package frozen vegetable dumplings"]);
  });

  test("a Recipe cooked for what it makes says so, and one nobody eats is as written", async () => {
    const { token } = await pair();
    await clearDays();
    const soup = await createRecipe({ title: "Soup", baseServings: 2, ingredients: ["1 onion"] });
    const date = today();
    succeeded(await household.callTool("set_slot", { date, meal: "lunch", kind: "recipe", recipeId: soup.id }));
    succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId: soup.id }));
    succeeded(await household.callTool("set_diners", { date, meal: "dinner", diners: [] }));

    const [, lunch, dinner] = (await daySheet(token)).slots;

    for (const slot of [lunch, dinner]) {
      expect(slot?.servingsText).toBe("For 2, as the Recipe is written.");
      expect(slot?.recipe?.ingredients).toEqual(["1 onion"]);
    }
  });

  test("lists the Prep-ahead notes due today, as the Calendar Feed shows them", async () => {
    const { token } = await pair();
    await clearDays();
    const [date, tomorrow] = [today(), addDays(today(), 1)];
    const beans = await createRecipe({ title: "Black bean soup", prepAhead: "Soak the beans overnight." });
    const dough = await createRecipe({ title: "Pizza", prepAhead: "Make the dough." });
    const bread = await createRecipe({ title: "Flatbread", prepAhead: "Start the starter." });
    succeeded(
      await household.callTool("set_slot", { date: tomorrow, meal: "dinner", kind: "recipe", recipeId: beans.id }),
    );
    // Due yesterday, for tonight; and a lunch, which the Calendar Feed gives no Prep-ahead event.
    succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId: dough.id }));
    succeeded(
      await household.callTool("set_slot", { date: tomorrow, meal: "lunch", kind: "recipe", recipeId: bread.id }),
    );

    const sheet = await daySheet(token);

    expect(sheet.prepAhead).toEqual([{ recipeTitle: "Black bean soup", note: "Soak the beans overnight." }]);
    const { token: feedToken } = succeeded<CalendarToken>(await household.callTool("rotate_calendar_token", {}));
    const feed = await (await exports.default.fetch(`${origin}${calendarFeedPath(feedToken)}`)).text();
    const prepEvents = feed
      .split("BEGIN:VEVENT")
      .filter((event) => event.includes(`DTSTART;VALUE=DATE:${date.replaceAll("-", "")}`));
    expect(prepEvents.map((event) => /SUMMARY:(.*)\r\n/.exec(event)?.[1])).toEqual(["Prep ahead: Black bean soup"]);
  });

  test("an unchanged Day Sheet keeps its ETag, and costs a 304 to check", async () => {
    const { token } = await pair();
    const date = today();
    const toast = await createRecipe({ title: "Toast" });
    succeeded(await household.callTool("set_slot", { date, meal: "breakfast", kind: "recipe", recipeId: toast.id }));
    const first = await fetchDaySheet(token);
    const etag = first.headers.get("ETag") as string;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    // A second later, made again: only when it was made has changed.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const again = await fetchDaySheet(token);
    expect(again.headers.get("ETag")).toBe(etag);
    for (const ifNoneMatch of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const unchanged = await exports.default.fetch(DAY_SHEET, {
        headers: { Authorization: `Bearer ${token}`, "If-None-Match": ifNoneMatch },
      });
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("ETag")).toBe(etag);
      expect(unchanged.headers.get("Content-Type")).toBe("application/json");
      expect(await unchanged.text()).toBe("");
    }

    succeeded(await household.callTool("mark_cooked", { date, meal: "breakfast" }));
    const changed = await exports.default.fetch(DAY_SHEET, {
      headers: { Authorization: `Bearer ${token}`, "If-None-Match": etag },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
    expect(DaySheet.parse(await changed.json()).slots[0]?.cooked).toBe(true);
  });

  test("a matching ETag without the token is still refused", async () => {
    const { token } = await pair();
    const etag = (await fetchDaySheet(token)).headers.get("ETag") as string;

    const response = await exports.default.fetch(DAY_SHEET, { headers: { "If-None-Match": etag } });

    expect(response.status).toBe(401);
  });

  test("a Day Sheet past 64 KB cuts the step that breaches it short, and says the rest is in Mise", async () => {
    const { token } = await pair();
    await clearDays();
    const date = today();
    const step = (n: number) => `Étape ${n} : remuez la crème brûlée doucement. `.repeat(80).trim();
    const long = Array.from({ length: 40 }, (_, n) => step(n + 1));
    const feast = await createRecipe({ title: "Grand festin", steps: long });
    const toast = await createRecipe({ title: "Toast", steps: ["Toast the bread."] });
    succeeded(await household.callTool("set_slot", { date, meal: "breakfast", kind: "recipe", recipeId: toast.id }));
    succeeded(await household.callTool("set_slot", { date, meal: "lunch", kind: "skip" }));
    succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId: feast.id }));

    const response = await fetchDaySheet(token);
    const body = await response.text();
    const sheet = DaySheet.parse(JSON.parse(body));

    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(DAY_SHEET_MAX_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(DAY_SHEET_MAX_BYTES - 5000);
    // The small Recipe is whole.
    expect(sheet.slots[0]?.recipe?.steps).toEqual(["Toast the bread."]);
    const steps = sheet.slots[2]?.recipe?.steps ?? [];
    // The steps before the cut are whole; the one that breaches stops at the end of a word.
    expect(steps.slice(0, -1)).toEqual(long.slice(0, steps.length - 1));
    const cut = steps.at(-1) as string;
    expect(cut).toMatch(/\S … continued in Mise$/);
    const kept = cut.replace(/ … continued in Mise$/, "");
    const breached = long[steps.length - 1] as string;
    expect(breached.startsWith(kept)).toBe(true);
    expect(breached[kept.length]).toBe(" ");
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
