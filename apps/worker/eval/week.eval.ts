import { env } from "cloudflare:workers";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ChatReply, type ChatWhere, isPencilled, WEEKDAYS, weekdayOf } from "@mise/domain";
import { afterAll, afterEach, beforeAll, describe, expect, inject, test, vi } from "vitest";
import { useAgentModels } from "../src/agent";
import { connectAs } from "../test/connect";
import { dinnerOn, familyHousehold, weekOf } from "../test/scripted";
import { answeredFirst, realModels } from "./models";

/**
 * Typed turns about a Week on the real agent model: which Week a day name means, and reading a Week's
 * dinners on their right days (#142). Calls Claude with the key in `.dev.vars`, so it runs only by hand:
 *
 *   bun run eval:agent
 */

// Thursday 5 November 2026, in a Week of Monday 2 November; next Week starts on Monday 9 November.
const THURSDAY_NOON = new Date("2026-11-05T12:00:00-07:00");
const THIS_WEDNESDAY = "2026-11-04";
const NEXT_MONDAY = "2026-11-09";
const NEXT_WEDNESDAY = "2026-11-11";
const NEXT_THURSDAY = "2026-11-12";
const ON_THIS_WEEK: ChatWhere = { screen: "week", week: "2026-11-02" };
const ON_NEXT_WEEK: ChatWhere = { screen: "week", week: NEXT_MONDAY };
// How long a turn may take: the agent may read the Week and make several calls first.
const TURN_MS = 90_000;

/** Satay, then Recipes 2 to 9 renamed, so that each dinner is told apart by its title. */
const RECIPE_TITLES = [
  "Satay",
  "Lemon chicken",
  "Black bean burrito bowls",
  "Beef and broccoli stir-fry",
  "Pork chops with apples",
  "Salmon teriyaki",
  "Mushroom risotto",
  "Chickpea curry",
  "Shepherd's pie",
];

beforeAll(() => {
  if (!env.ANTHROPIC_API_KEY) throw new Error("Put ANTHROPIC_API_KEY in apps/worker/.dev.vars to run the eval.");
  useAgentModels(realModels);
  console.log(`Agent model: ${inject("agentModel") || "the agent's own"}`);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(THURSDAY_NOON);
});

afterEach(() => useAgentModels(realModels));

afterAll(() => vi.useRealTimers());

/**
 * The family's Household with its Recipes told apart, this Wednesday's dinner Lemon chicken (chosen by
 * hand), next Monday's Black bean burrito bowls (chosen by hand), and the rest of next Week proposed.
 * `write` sends Robin's typed turn and resolves with the answer.
 */
async function robinWriting() {
  const household = await familyHousehold();
  for (const [index, title] of RECIPE_TITLES.slice(1).entries()) {
    await household.callTool("update_recipe", { id: index + 2, title });
  }
  await household.callTool("set_slot", { date: THIS_WEDNESDAY, meal: "dinner", kind: "recipe", recipeId: 2 });
  await household.callTool("set_slot", { date: NEXT_MONDAY, meal: "dinner", kind: "recipe", recipeId: 3 });
  await household.callTool("propose_week", { date: NEXT_MONDAY });
  const robin = await connectAs(household, "robin@example.com");
  const write = async (text: string, where: ChatWhere): Promise<string> => {
    const reply = (await robin.rpc("chat", [text, where])) as ChatReply;
    if (!reply.ok) throw new Error(reply.error.message);
    console.log(`  Robin: ${text}\n  Mise:  ${reply.value.text}`);
    return reply.value.text;
  };
  return { household, write };
}

/**
 * The weekdays named in the clause of `answer` naming `title`, or in the clause before it when it names
 * none, as in “Tuesday: Risotto”. Clauses end at punctuation, a new line or “and”, not counting an
 * “and” inside one of `titles`.
 */
function weekdaysBeside(answer: string, title: string, titles: string[]): string[] | undefined {
  let masked = answer.toLowerCase();
  titles.forEach((one, index) => {
    masked = masked.replaceAll(one.toLowerCase(), `#${index}#`);
  });
  const clauses = masked.split(/[,:;.\n]|\band\b/);
  const at = clauses.findIndex((clause) => clause.includes(`#${titles.indexOf(title)}#`));
  if (at < 0) return undefined;
  const named = (clause = "") => WEEKDAYS.filter((weekday) => new RegExp(`\\b${weekday}\\b`).test(clause));
  return named(clauses[at]).length > 0 ? named(clauses[at]) : named(clauses[at - 1]);
}

describe("a typed turn about a Week", () => {
  // The agent once answered from earlier turns about this Week: "Wednesday's dinner is already one of
  // your own, so there's nothing to keep", while next Week's Wednesday was pencilled.
  test(
    "with next Week shown, “keep Wednesday” keeps next Week's Wednesday, even after turns about this Week's",
    async () => {
      answeredFirst([
        fauxAssistantMessage(fauxToolCall("get_week", { date: THIS_WEDNESDAY }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Wednesday's dinner is Lemon chicken. It's one of your own, so no Re-roll changes it."),
      ]);
      const { household, write } = await robinWriting();
      await write("What's for dinner Wednesday?", ON_THIS_WEEK);
      const pencilled = await dinnerOn(household, NEXT_WEDNESDAY);
      expect(pencilled?.reason, "next Wednesday starts pencilled").not.toBeNull();

      await write("keep Wednesday", ON_NEXT_WEEK);

      const kept = await dinnerOn(household, NEXT_WEDNESDAY);
      expect(kept?.reason, "next Wednesday is kept").toBeNull();
      expect(kept?.recipe?.title, "as the Recipe it had").toBe(pencilled?.recipe?.title);
      expect((await dinnerOn(household, THIS_WEDNESDAY))?.recipe?.title).toBe("Lemon chicken");
    },
    3 * TURN_MS,
  );

  // Given the Week's 21 meals by ISO date alone, the agent once called every dinner pencilled, left
  // Friday's out and moved Saturday's and Sunday's a day earlier. And from a read before a Keep, it once
  // called a Kept dinner Mise's (#138).
  test(
    "asked what is pencilled, names exactly the pencilled dinners, each on its right day, and not one Kept since",
    async () => {
      answeredFirst([
        fauxAssistantMessage(fauxToolCall("get_week", { date: NEXT_MONDAY }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Every dinner next week is pencilled but Monday's, Thursday's included."),
      ]);
      const { household, write } = await robinWriting();
      await write("What's pencilled next week?", ON_NEXT_WEEK);
      await household.callTool("keep_slot", { date: NEXT_THURSDAY, meal: "dinner" });
      const dinners = (await weekOf(household, NEXT_MONDAY)).slots.filter((slot) => slot.meal === "dinner");
      const pencilled = dinners.filter(isPencilled);
      expect(pencilled.map((dinner) => weekdayOf(dinner.date))).toEqual([
        "tuesday",
        "wednesday",
        "friday",
        "saturday",
        "sunday",
      ]);

      const answer = await write("What's pencilled this week, day by day?", ON_NEXT_WEEK);

      for (const dinner of pencilled) {
        const title = dinner.recipe?.title;
        if (!title) throw new Error(`The Proposal left ${dinner.date} without a Recipe`);
        expect(weekdaysBeside(answer, title, RECIPE_TITLES), `${title}, on its day alone`).toEqual([
          weekdayOf(dinner.date),
        ]);
      }
      // Monday's and Thursday's may be named, as long as their sentence says they aren't pencilled.
      for (const own of dinners.filter((dinner) => !isPencilled(dinner))) {
        const title = own.recipe?.title ?? "";
        const sentence = answer.split(/[.!?\n]/).find((one) => one.toLowerCase().includes(title.toLowerCase()));
        if (sentence) expect(sentence, `${title} is not pencilled`).toMatch(/\bnot\b|n't|no longer|own|yours|kept/i);
      }
    },
    3 * TURN_MS,
  );
});
