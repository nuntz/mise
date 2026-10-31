import { env } from "cloudflare:workers";
import type { ChatWhere, VoiceStartReply } from "@mise/domain";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { useAgentModels } from "../src/agent";
import { useLive } from "../src/live";
import { connectAs } from "../test/connect";
import { pretendLive } from "../test/liveService";
import { dinnerOn, familyHousehold, type HouseholdStub } from "../test/scripted";

/**
 * Spoken turns on the real agent model: what a Voice Session's agent does with a turn, and how it
 * answers for the ear (#103). GPT-Live is pretended, as in the voice tests; the answer checked is the
 * commentary it would speak. Calls Claude with the key in `.dev.vars`, so it runs only by hand:
 *
 *   bun run eval:agent
 */

// Friday 30 October 2026, in a Week of Monday 26 October: Tuesday and Wednesday have passed.
const FRIDAY_NOON = new Date("2026-10-30T12:00:00-07:00");
const ON_THE_PANTRY: ChatWhere = { screen: "pantry" };
// How long a turn may take: the agent may read the Week and make several calls first.
const TURN_MS = 90_000;

beforeAll(() => {
  if (!env.ANTHROPIC_API_KEY) throw new Error("Put ANTHROPIC_API_KEY in apps/worker/.dev.vars to run the eval.");
  // The real model, not a scripted one.
  useAgentModels(undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FRIDAY_NOON);
});

afterAll(() => vi.useRealTimers());

/**
 * The family's Household with this Week's dinners planned (Tuesday Rice bowl 2, Wednesday Rice bowl 3,
 * Thursday Rice bowl 4) and next Thursday's (Rice bowl 5), and Robin talking from `where`. `say` sends
 * one turn and resolves with what Mise would speak back.
 */
async function robinTalking(where: ChatWhere) {
  const household = await familyHousehold();
  const dinners: [string, number][] = [
    ["2026-10-27", 2],
    ["2026-10-28", 3],
    ["2026-10-29", 4],
    ["2026-11-05", 5],
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
  return { household, say };
}

async function dinnerTitle(household: HouseholdStub, date: string): Promise<string | null> {
  const slot = await dinnerOn(household, date);
  return slot?.kind === "recipe" ? (slot.recipe?.title ?? null) : (slot?.kind ?? null);
}

/** Sentences in an answer, as a listener hears them. */
function sentences(answer: string): number {
  return answer.split(/[.!?](?:\s|$)/).filter((part) => part.trim()).length;
}

describe("a spoken turn", () => {
  test(
    "moving a past day's dinner asks first, then moves it within this Week, never next Week",
    async () => {
      const { household, say } = await robinTalking(ON_THE_PANTRY);

      const asked = await say("Move Tuesday's dinner to Wednesday.");

      expect(asked, "asks before changing a past day").toContain("?");
      expect(asked, "says Tuesday has passed").toMatch(/passed|already|gone|earlier this week/i);
      expect(await dinnerTitle(household, "2026-10-27"), "nothing moves before a yes").toBe("Rice bowl 2");

      await say("Yes.");

      expect(await dinnerTitle(household, "2026-10-28")).toBe("Rice bowl 2");
      expect(await dinnerTitle(household, "2026-10-27")).toBe("unplanned");
      expect(await dinnerTitle(household, "2026-11-03"), "next Week's Tuesday is untouched").toBe("unplanned");
      expect(await dinnerTitle(household, "2026-11-04"), "next Week's Wednesday is untouched").toBe("unplanned");
    },
    4 * TURN_MS,
  );

  test(
    "a day named from a screen with no Week is this Week's, said in a sentence or two, with no date read out",
    async () => {
      const { say } = await robinTalking(ON_THE_PANTRY);

      const answer = await say("What's for dinner Thursday?");

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
      const { say } = await robinTalking(ON_THE_PANTRY);

      const answer = await say("What recipes do we have?");

      expect(answer).toContain("?");
      expect((answer.match(/Rice bowl|Satay/g) ?? []).length, "names at most three of nine").toBeLessThanOrEqual(3);
      expect(sentences(answer)).toBeLessThanOrEqual(3);
    },
    2 * TURN_MS,
  );
});
