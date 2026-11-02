import { env } from "cloudflare:workers";
import type { ChatWhere, VoiceStartReply } from "@mise/domain";
import { afterAll, beforeAll, describe, expect, inject, test, vi } from "vitest";
import { useAgentModels } from "../src/agent";
import { useLive } from "../src/live";
import { anthropicModels } from "../src/llm";
import { connectAs } from "../test/connect";
import { pretendLive } from "../test/liveService";
import { dinnerOn, familyHousehold, type HouseholdStub } from "../test/scripted";

/**
 * Spoken turns on the real agent model: what a Voice Session's agent does with a turn, and how it
 * answers for the ear (#103). GPT-Live is pretended, as in the voice tests; the answer checked is the
 * commentary it would speak. Calls Claude with the key in `.dev.vars`, so it runs only by hand:
 *
 *   bun run eval:agent
 *   MISE_EVAL_MODEL=claude-sonnet-5-5 bun run eval:agent   (on another model than the agent's)
 */

// Friday 30 October 2026, in a Week of Monday 26 October: this Tuesday and Wednesday have passed.
const FRIDAY_NOON = new Date("2026-10-30T12:00:00-07:00");
const ON_THE_PANTRY: ChatWhere = { screen: "pantry" };
// How long a turn may take: the agent may read the Week and make several calls first.
const TURN_MS = 90_000;

beforeAll(() => {
  if (!env.ANTHROPIC_API_KEY) throw new Error("Put ANTHROPIC_API_KEY in apps/worker/.dev.vars to run the eval.");
  // The real model, not a scripted one: the agent's, or the one asked for.
  const id = inject("agentModel");
  useAgentModels(
    id
      ? (env) => ({ models: anthropicModels(env.ANTHROPIC_API_KEY), model: { provider: "anthropic", id } })
      : undefined,
  );
  console.log(`Agent model: ${id || "the agent's own"}`);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FRIDAY_NOON);
});

afterAll(() => vi.useRealTimers());

/**
 * The family's Household with this Week's dinners planned (Tuesday Rice bowl 2, Wednesday Rice bowl 3,
 * Sunday Rice bowl 4) and next Week's (Tuesday Rice bowl 6, Wednesday Rice bowl 7, Sunday Rice bowl
 * 5), and Robin talking from `where`. `say` sends one turn and resolves with what Mise would
 * speak back.
 */
async function robinTalking(where: ChatWhere) {
  const household = await familyHousehold();
  const dinners: [string, number][] = [
    ["2026-10-27", 2],
    ["2026-10-28", 3],
    ["2026-11-01", 4],
    ["2026-11-03", 6],
    ["2026-11-04", 7],
    ["2026-11-08", 5],
  ];
  for (const [date, recipeId] of dinners) {
    await household.callTool("set_slot", { date, meal: "dinner", kind: "recipe", recipeId });
  }
  const { live, sessions } = pretendLive();
  useLive(() => live);
  const robin = await connectAs(household, "robin@example.com");
  const reply = (await robin.rpc("startVoice", ["v=0 offer", where])) as VoiceStartReply;
  const session = sessions[0];
  if (!reply.ok || !session) throw new Error("The Voice Session didn't start");
  let turns = 0;
  const say = async (text: string): Promise<string> => {
    const id = `item_${++turns}`;
    session.serverSends({ type: "session.input_transcript.delta", delta: text });
    session.serverSends({ type: "session.delegation.created", delegation: { id } });
    const spoken = await vi.waitFor(
      () => {
        const commentary = session.sent.find(
          (event) => event.type === "session.commentary.append" && event.delegation_id === id,
        );
        if (commentary?.type !== "session.commentary.append") throw new Error("Not answered yet");
        return commentary.content;
      },
      { timeout: TURN_MS, interval: 250 },
    );
    console.log(`  Robin: ${text}\n  Mise:  ${spoken}`);
    return spoken;
  };
  return { household, robin, say };
}

async function dinnerTitle(household: HouseholdStub, date: string): Promise<string | null> {
  const slot = await dinnerOn(household, date);
  return slot?.kind === "recipe" ? (slot.recipe?.title ?? null) : (slot?.kind ?? null);
}

/** Satay, then what Recipes 2 to 9 are renamed for the long list. */
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

/** Sentences in an answer, as a listener hears them. */
function sentences(answer: string): number {
  return answer.split(/[.!?](?:\s|$)/).filter((part) => part.trim()).length;
}

describe("a spoken turn", () => {
  test(
    "a day that has passed, named from a screen with no Week, is next Week's; moving onto a dinner asks replace or swap",
    async () => {
      const { household, say } = await robinTalking(ON_THE_PANTRY);

      const asked = await say("Move Tuesday's dinner to Wednesday.");

      expect(asked, "asks, since Wednesday has a dinner").toContain("?");
      expect(asked).toMatch(/replace/i);
      expect(asked).toMatch(/swap/i);
      expect(await dinnerTitle(household, "2026-11-04"), "nothing changes before the answer").toBe("Rice bowl 7");

      await say("Replace it.");

      expect(await dinnerTitle(household, "2026-11-04")).toBe("Rice bowl 6");
      expect(await dinnerTitle(household, "2026-11-03"), "moved, not swapped").toBe("unplanned");
      expect(await dinnerTitle(household, "2026-10-27"), "this Week's Tuesday is untouched").toBe("Rice bowl 2");
      expect(await dinnerTitle(household, "2026-10-28"), "this Week's Wednesday is untouched").toBe("Rice bowl 3");
    },
    4 * TURN_MS,
  );

  test(
    "a day still to come, named from a screen with no Week, is this Week's, said in a sentence or two, with no date read out",
    async () => {
      const { say } = await robinTalking(ON_THE_PANTRY);

      const answer = await say("What's for dinner Sunday?");

      expect(answer).toContain("Rice bowl 4");
      expect(answer).not.toContain("Rice bowl 5");
      expect(sentences(answer)).toBeLessThanOrEqual(2);
      expect(answer, "no Markdown").not.toMatch(/[*#_`]|^\s*[-•]/m);
      expect(answer, "no ISO date").not.toMatch(/\d{4}-\d{2}-\d{2}/);
    },
    2 * TURN_MS,
  );

  test(
    "a long list is offered, not read out",
    async () => {
      const { household, say } = await robinTalking(ON_THE_PANTRY);
      // Nine titles a listener tells apart, so a short answer can't just say "eight rice bowls".
      for (const [index, title] of RECIPE_TITLES.slice(1).entries()) {
        await household.callTool("update_recipe", { id: index + 2, title });
      }

      const answer = await say("What recipes do we have?");

      // Not "Want the rest?": GPT-Live answers a "no" to that itself, and the agent never hears it (#126).
      expect(answer, "says what to say for more").toMatch(/more/i);
      expect(answer.trim(), "ends without a question").not.toMatch(/\?$/);
      const named = RECIPE_TITLES.filter((title) => answer.includes(title));
      expect(named.length, "names at most three of nine").toBeLessThanOrEqual(3);
      expect(sentences(answer)).toBeLessThanOrEqual(3);

      const more = await say("More.");

      const next = RECIPE_TITLES.filter((title) => more.includes(title) && !named.includes(title));
      expect(next.length, "goes on with others").toBeGreaterThan(0);
      expect(next.length, "three more at most").toBeLessThanOrEqual(3);
    },
    3 * TURN_MS,
  );
});

describe("a held change in a spoken turn (ADR 0024)", () => {
  test(
    "a spoken “yes” doesn't run it, and “never mind” withdraws it",
    async () => {
      const { household, say } = await robinTalking(ON_THE_PANTRY);

      expect(await say("Delete the Satay recipe.")).toMatch(/tap/i);
      await say("Yes.");
      expect(await household.callTool("get_recipe", { id: 1 }), "a spoken yes runs nothing").toMatchObject({
        ok: true,
      });

      await say("Never mind, keep it.");

      const shown = (await household.conversation()).filter((message) => message.role === "confirmation");
      expect(shown.length, "held at least once").toBeGreaterThan(0);
      expect(
        shown.map((confirmation) => confirmation.status),
        "every button is withdrawn",
      ).not.toContain("pending");
    },
    4 * TURN_MS,
  );

  // A bare "no" once left the button waiting while the agent said to ignore it (#126).
  test(
    "a bare “no” to the button withdraws it, and a tap then runs nothing",
    async () => {
      const { household, robin, say } = await robinTalking(ON_THE_PANTRY);

      expect(await say("Delete the Satay recipe.")).toMatch(/tap/i);
      await say("No.");

      const shown = (await household.conversation()).filter((message) => message.role === "confirmation");
      expect(shown.length, "held at least once").toBeGreaterThan(0);
      expect(
        shown.map((confirmation) => confirmation.status),
        "every button is withdrawn",
      ).not.toContain("pending");
      for (const { id } of shown) {
        expect(await robin.rpc("confirm", [id]), "a tap runs nothing").toMatchObject({ ok: false });
      }
      expect(await household.callTool("get_recipe", { id: 1 }), "the Recipe is kept").toMatchObject({ ok: true });
    },
    3 * TURN_MS,
  );
});

describe("a spoken turn in Kitchen mode", () => {
  test(
    "“next step” reads the next step aloud and shows it; “how much” gives the amount scaled to the Slot",
    async () => {
      // Next Tuesday's dinner, Rice bowl 6, cooked for the 3 eating it: its 400 g for 4 makes 300 g.
      const where: ChatWhere = { screen: "kitchen", recipe: 6, slot: { date: "2026-11-03", meal: "dinner" }, step: 1 };
      const { household, robin, say } = await robinTalking(where);
      await household.callTool("update_recipe", {
        id: 6,
        steps: ["Rinse the rice until the water runs clear.", "Simmer the rice for 18 minutes.", "Fluff and serve."],
      });

      const read = await say("Next step.");

      expect(read).toMatch(/18 minutes/);
      await vi.waitFor(() => expect(robin.steps).toEqual([2]));

      const amount = await say("How much rice?");

      expect(amount).toMatch(/300/);
      expect(amount).not.toMatch(/400/);
    },
    3 * TURN_MS,
  );
});

describe("the voice Check-in", () => {
  test(
    "on the Pantry screen, leads through the Staples due in card order, taking out, low, fine and skip as said",
    async () => {
      const { household, say } = await robinTalking(ON_THE_PANTRY);
      // Four due, all in the pantry and never checked: the cards ask cumin, oregano, paprika, rice.
      for (const item of ["rice", "paprika", "oregano", "cumin"]) {
        await household.callTool("upsert_staple", { item });
      }

      const asked = await say("Let's check the pantry.");

      expect(asked).toContain("?");
      expect(asked.toLowerCase(), "starts with the first card").toContain("cumin");
      const named = ["cumin", "oregano", "paprika", "rice"].filter((name) => asked.toLowerCase().includes(name));
      expect(named.length, "asks about at most three at once").toBeLessThanOrEqual(3);
      expect(sentences(asked)).toBeLessThanOrEqual(2);

      // Cumin, skipped, is still due, so each turn after lists it first again: only the conversation
      // says it was skipped.
      await say("Skip cumin. Oregano's fine, paprika is low.");
      const done = await say("Rice is out.");

      expect(await household.callTool("list_staples", {}), "cumin skipped, so never checked").toMatchObject({
        ok: true,
        value: [
          { item: "cumin", lastChecked: null },
          { item: "oregano", status: "stocked" },
          { item: "paprika", status: "low" },
          { item: "rice", status: "out" },
        ],
      });
      expect(done, "done, not asking about cumin again").not.toContain("?");
      expect(sentences(done)).toBeLessThanOrEqual(2);
    },
    4 * TURN_MS,
  );
});
