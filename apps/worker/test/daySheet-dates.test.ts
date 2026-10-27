import { env, exports } from "cloudflare:workers";
import {
  DAY_SHEET_PATH,
  DaySheet,
  type NewKitchenDisplay,
  type Recipe,
  type ToolResult,
  type Week,
} from "@mise/domain";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

// Its own file, so the clock can be set without moving the dates other tests plan on. Toronto, as
// the runtime's timezone data keeps Vancouver on UTC-7 all year from November 2026.
const household = env.Household.getByName("household");

function succeeded<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

/** Sets the clock to `instant`, for the household as for the test. */
function at(instant: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

async function daySheetAt(instant: string): Promise<DaySheet> {
  at(instant);
  const response = await exports.default.fetch(`https://mise.example.com${DAY_SHEET_PATH}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return DaySheet.parse(await response.json());
}

/** Plans `title` for dinner on `date`, with a Prep-ahead note naming it. */
async function planDinner(date: string, title: string): Promise<void> {
  const recipe = succeeded<Recipe>(
    await household.callTool("create_recipe", {
      title,
      baseServings: 2,
      ingredients: [],
      prepAhead: `Get ready for ${title}.`,
    }),
  );
  succeeded(await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId: recipe.id }));
}

/** What the Day Sheet says the day is: its date, when it turns over, its dinner and its Prep-ahead notes. */
function dayOf(sheet: DaySheet) {
  return {
    date: sheet.date,
    nextDayAt: sheet.nextDayAt,
    dinner: sheet.slots[2]?.title,
    prepAhead: sheet.prepAhead.map((prep) => prep.recipeTitle),
  };
}

let token: string;

beforeAll(async () => {
  succeeded(
    await household.callTool("setup_household", {
      name: "The Example Family",
      timezone: "America/Toronto",
      dinnerTime: "18:30",
      members: [{ name: "Robin" }],
    }),
  );
  ({ token } = succeeded<NewKitchenDisplay>(await household.callTool("add_kitchen_display", { label: "Counter" })));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Day Sheet's date", () => {
  test("turns over at local midnight", async () => {
    for (const [date, title] of [
      ["2027-06-15", "Tuesday stew"],
      ["2027-06-16", "Wednesday tacos"],
      ["2027-06-17", "Thursday curry"],
    ] as const) {
      await planDinner(date, title);
    }

    // Toronto is on EDT (UTC-4) in June.
    expect(dayOf(await daySheetAt("2027-06-15T23:59:59-04:00"))).toEqual({
      date: "2027-06-15",
      nextDayAt: "2027-06-16T04:00:00Z",
      dinner: "Tuesday stew",
      prepAhead: ["Wednesday tacos"],
    });
    expect(dayOf(await daySheetAt("2027-06-16T00:00:01-04:00"))).toEqual({
      date: "2027-06-16",
      nextDayAt: "2027-06-17T04:00:00Z",
      dinner: "Wednesday tacos",
      prepAhead: ["Thursday curry"],
    });
  });

  test("follows the clocks going back, on a 25-hour day", async () => {
    // Toronto goes from EDT (UTC-4) to EST (UTC-5) at 02:00 on Sunday 7 November 2027.
    await planDinner("2027-11-07", "Sunday roast");
    await planDinner("2027-11-08", "Monday soup");

    const saturday = await daySheetAt("2027-11-06T23:30:00-04:00");
    expect(dayOf(saturday)).toEqual({
      date: "2027-11-06",
      nextDayAt: "2027-11-07T04:00:00Z",
      dinner: undefined,
      prepAhead: ["Sunday roast"],
    });
    expect(saturday.generatedAt).toBe("2027-11-06T23:30:00-04:00");

    // Just after midnight, still on EDT; the next midnight is on EST.
    const sunday = await daySheetAt("2027-11-07T00:30:00-04:00");
    expect(dayOf(sunday)).toEqual({
      date: "2027-11-07",
      nextDayAt: "2027-11-08T05:00:00Z",
      dinner: "Sunday roast",
      prepAhead: ["Monday soup"],
    });
    expect(sunday.generatedAt).toBe("2027-11-07T00:30:00-04:00");
    expect((await daySheetAt("2027-11-07T18:00:00-05:00")).generatedAt).toBe("2027-11-07T18:00:00-05:00");
  });

  test("follows the clocks going forward, on a 23-hour day", async () => {
    // Toronto goes from EST (UTC-5) to EDT (UTC-4) at 02:00 on Sunday 14 March 2027.
    await planDinner("2027-03-14", "Spring pasta");

    expect(dayOf(await daySheetAt("2027-03-13T23:59:00-05:00"))).toMatchObject({
      date: "2027-03-13",
      nextDayAt: "2027-03-14T05:00:00Z",
      prepAhead: ["Spring pasta"],
    });
    const sunday = await daySheetAt("2027-03-14T12:00:00-04:00");
    expect(dayOf(sunday)).toMatchObject({
      date: "2027-03-14",
      nextDayAt: "2027-03-15T04:00:00Z",
      dinner: "Spring pasta",
    });
    expect(sunday.generatedAt).toBe("2027-03-14T12:00:00-04:00");
  });

  test("goes by date across a Week a new week start stretches (ADR 0021)", async () => {
    // After every date the tests above plan on, since Weeks planned past the current one keep their dates.
    // On Thursday 2 December 2027 the Weeks move from Monday to Sunday: the Week from Monday 29 November
    // runs on to Saturday 11 December, and the next starts on Sunday 12 December.
    at("2027-12-02T12:00:00-05:00");
    succeeded(await household.callTool("update_household_settings", { weekStartsOn: "sunday" }));
    await planDinner("2027-12-06", "Stretched Monday");
    await planDinner("2027-12-11", "Last day of the long Week");
    await planDinner("2027-12-12", "First Sunday Week");
    const stretched = succeeded<Week>(await household.callTool("get_week", { date: "2027-12-06" }));
    expect([stretched.startDate, stretched.endDate]).toEqual(["2027-11-29", "2027-12-11"]);

    expect(dayOf(await daySheetAt("2027-12-06T08:00:00-05:00"))).toMatchObject({
      date: "2027-12-06",
      nextDayAt: "2027-12-07T05:00:00Z",
      dinner: "Stretched Monday",
      prepAhead: [],
    });
    // Its last day holds the next Week's first day's Prep-ahead note.
    expect(dayOf(await daySheetAt("2027-12-11T23:59:59-05:00"))).toEqual({
      date: "2027-12-11",
      nextDayAt: "2027-12-12T05:00:00Z",
      dinner: "Last day of the long Week",
      prepAhead: ["First Sunday Week"],
    });
    expect(dayOf(await daySheetAt("2027-12-12T00:00:00-05:00"))).toMatchObject({
      date: "2027-12-12",
      nextDayAt: "2027-12-13T05:00:00Z",
      dinner: "First Sunday Week",
    });
  });
});
