import { env, exports } from "cloudflare:workers";
import { addDays, type CalendarToken, localDate, type Recipe, type ToolResult } from "@mise/domain";
import ICAL from "ical.js";
import { beforeAll, describe, expect, test } from "vitest";

const origin = "https://mise.example.com";
const TIMEZONE = "America/Vancouver";

// The feed serves the deployment's one household, which every test here shares.
const household = env.Household.getByName("household");

function succeeded<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

/** A day from today in the Household's calendar, so it is always inside the feed. */
function inDays(days: number): string {
  return addDays(localDate(new Date(), TIMEZONE), days);
}

async function feedToken(): Promise<string> {
  const current = succeeded<CalendarToken | null>(await household.callTool("get_calendar_token", {}));
  return current?.token ?? succeeded<CalendarToken>(await household.callTool("rotate_calendar_token", {})).token;
}

function fetchFeed(token: string): Promise<Response> {
  return exports.default.fetch(`${origin}/cal/${token}.ics`);
}

/** The feed, parsed by ical.js: it throws on anything that isn't iCalendar. */
async function feed(): Promise<ICAL.Component> {
  const response = await fetchFeed(await feedToken());
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
  return new ICAL.Component(ICAL.parse(await response.text()));
}

/** The feed's events on `date`, by summary. */
async function eventsOn(date: string): Promise<ICAL.Event[]> {
  const calendar = await feed();
  return calendar
    .getAllSubcomponents("vevent")
    .map((component) => new ICAL.Event(component))
    .filter((event) => event.startDate.toString().startsWith(date));
}

async function createRecipe(fields: Record<string, unknown>): Promise<Recipe> {
  return succeeded<Recipe>(await household.callTool("create_recipe", { baseServings: 4, ingredients: [], ...fields }));
}

beforeAll(async () => {
  await household.callTool("setup_household", {
    name: "The Example Family",
    timezone: TIMEZONE,
    dinnerTime: "18:30",
    members: [{ name: "Robin" }, { name: "Alex" }],
  });
});

describe("the calendar feed", () => {
  test("serves the planned dinners to whoever has the token", async () => {
    const recipe = await createRecipe({ title: "Dal makhani" });
    const date = inDays(3);
    succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId: recipe.id }));

    const [event, ...others] = await eventsOn(date);

    expect(others).toEqual([]);
    expect(event?.summary).toBe("Dal makhani");
  });

  test("a dinner is at the Household's dinner time, in its timezone, which the feed defines", async () => {
    const recipe = await createRecipe({ title: "Tourtière" });
    const date = inDays(4);
    succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId: recipe.id }));

    const calendar = await feed();
    const [event] = await eventsOn(date);
    const start = event?.component.getFirstProperty("dtstart");

    expect(start?.getParameter("tzid")).toBe(TIMEZONE);
    expect(event?.startDate.toString()).toBe(`${date}T18:30:00`);
    expect(event?.duration.toSeconds()).toBe(3600);
    const zone = calendar.getAllSubcomponents("vtimezone").map((component) => new ICAL.Timezone(component));
    expect(zone.map((timezone) => timezone.tzid)).toEqual([TIMEZONE]);
    // ical.js works out the instant from the VTIMEZONE alone: it agrees with the runtime's own zone data.
    const instant = event?.startDate.convertToZone(ICAL.Timezone.utcTimezone).toJSDate() as Date;
    expect(instant.toLocaleString("en-CA", { timeZone: TIMEZONE, hourCycle: "h23" })).toContain("18:30:00");
    expect(calendar.getFirstPropertyValue("refresh-interval")?.toString()).toBe("PT1H");
  });

  test("the description gives the Servings, how many Diners, how many Conflicts and the Recipe's link, but no names or Allergens", async () => {
    const recipe = await createRecipe({ title: "Peanut noodles", ingredients: ["2 tbsp peanut butter"] });
    const robin = (
      await succeeded<{ members: { id: number; name: string }[] }>(await household.callTool("get_household", {}))
    ).members.find((member) => member.name === "Robin");
    succeeded(
      await household.callTool("update_member_constraints", {
        id: robin?.id,
        constraints: [{ kind: "allergy", allergen: "peanut" }],
      }),
    );
    const date = inDays(5);
    succeeded(
      await household.callTool("set_slot", {
        date,
        meal: "dinner",
        kind: "recipe",
        recipeId: recipe.id,
        guests: 2,
        overrides: [{ who: robin?.id, allergen: "peanut", reason: "Robin's bowl without the sauce" }],
      }),
    );

    const [event] = await eventsOn(date);

    expect(event?.description).toBe(
      ["Servings: 4", "Diners: 2", "Conflicts: 1, see Mise for details", `Recipe: ${origin}/?recipe=${recipe.id}`].join(
        "\n",
      ),
    );
    expect(event?.component.getFirstPropertyValue("url")).toBe(`${origin}/?recipe=${recipe.id}`);
  });

  test("Leftovers and eating out are titled so; nothing is shown for a skipped dinner", async () => {
    const [cooked, leftovers, out, skipped] = [inDays(6), inDays(7), inDays(8), inDays(9)];
    const recipe = await createRecipe({ title: "Chili" });
    succeeded(
      await household.callTool("set_slot", { date: cooked, meal: "dinner", kind: "recipe", recipeId: recipe.id }),
    );
    succeeded(await household.callTool("set_slot", { date: leftovers, meal: "dinner", kind: "leftovers" }));
    succeeded(
      await household.callTool("link_leftovers", {
        date: leftovers,
        meal: "dinner",
        of: { date: cooked, meal: "dinner" },
      }),
    );
    succeeded(await household.callTool("set_slot", { date: out, meal: "dinner", kind: "eat_out" }));
    succeeded(await household.callTool("set_slot", { date: skipped, meal: "dinner", kind: "skip" }));

    expect((await eventsOn(leftovers)).map((event) => event.summary)).toEqual(["Leftovers"]);
    // Leftovers link to the Recipe they were cooked from.
    expect((await eventsOn(leftovers))[0]?.component.getFirstPropertyValue("url")).toBe(
      `${origin}/?recipe=${recipe.id}`,
    );
    expect((await eventsOn(out)).map((event) => event.summary)).toEqual(["Eating out"]);
    expect(await eventsOn(skipped)).toEqual([]);
  });

  test("a Recipe's prep-ahead note is its own all-day event the day before", async () => {
    const recipe = await createRecipe({ title: "Chana masala", prepAhead: "Soak the chickpeas overnight" });
    const date = inDays(10);
    succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId: recipe.id }));

    const [prep, ...others] = await eventsOn(addDays(date, -1));

    expect(others).toEqual([]);
    expect(prep?.summary).toBe("Prep ahead: Chana masala");
    expect(prep?.startDate.isDate).toBe(true);
    expect(prep?.endDate.toString()).toBe(date);
    expect(prep?.description).toContain("Soak the chickpeas overnight");
    expect((await eventsOn(date)).map((event) => event.summary)).toEqual(["Chana masala"]);
  });

  test("rotating the token gives a new feed URL and the old one stops working", async () => {
    const old = await feedToken();

    const rotated = succeeded<CalendarToken>(await household.callTool("rotate_calendar_token", {}));

    expect(rotated.token).not.toBe(old);
    expect(succeeded(await household.callTool("get_calendar_token", {}))).toEqual(rotated);
    expect((await fetchFeed(old)).status).toBe(404);
    expect((await fetchFeed(rotated.token)).status).toBe(200);
  });

  test("a new dinner time and timezone move every dinner in the feed", async () => {
    const recipe = await createRecipe({ title: "Ramen" });
    const date = inDays(6);
    succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId: recipe.id }));

    succeeded(
      await household.callTool("update_household_settings", { dinnerTime: "19:45", timezone: "America/Toronto" }),
    );
    try {
      const [event] = await eventsOn(date);

      expect(event?.component.getFirstProperty("dtstart")?.getParameter("tzid")).toBe("America/Toronto");
      expect(event?.startDate.toString()).toBe(`${date}T19:45:00`);
    } finally {
      // The other tests share this Household.
      await household.callTool("update_household_settings", { dinnerTime: "18:30", timezone: TIMEZONE });
    }
  });

  test("refuses a request without a valid token", async () => {
    await feedToken();

    for (const path of ["/cal/not-the-token.ics", "/cal/.ics", "/cal/"]) {
      const response = await exports.default.fetch(`${origin}${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("BEGIN:VCALENDAR");
    }
  });
});
