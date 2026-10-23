import { env } from "cloudflare:workers";
import type { Recipe, Slot, ToolResult, Week } from "@mise/domain";
import { describe, expect, test } from "vitest";
import { CALLER_HEADER } from "../src/identity";

/**
 * A Household of Robin (who signs in as robin@example.com) and Alex, Members 1 and 2, whose Weeks
 * start on Monday, with Recipes 1 (Dal) and 2 (Tacos).
 */
async function setUpHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", {
    name: "The Example Family",
    members: [{ name: "Robin", email: "robin@example.com" }, { name: "Alex" }],
  });
  for (const title of ["Dal", "Tacos"]) {
    await household.callTool("create_recipe", { title, baseServings: 4, ingredients: ["400 g rice"] });
  }
  return household;
}

type TestHousehold = Awaited<ReturnType<typeof setUpHousehold>>;

const DAL = 1;
const TACOS = 2;
// Monday 12 October 2026 and the Monday after: dinners already eaten.
const MONDAY = "2026-10-12";
const NEXT_MONDAY = "2026-10-19";
const dinner = (date: string) => ({ date, meal: "dinner" }) as const;

/** What a tool call that is expected to succeed returned: a Slot unless said otherwise. */
function succeeded<T = Slot>(outcome: unknown): T {
  const result = outcome as ToolResult<T>;
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value;
}

async function recipe(household: TestHousehold, id: number): Promise<Recipe> {
  return succeeded<Recipe>(await household.callTool("get_recipe", { id }));
}

async function planAndCook(household: TestHousehold, date: string, recipeId: number): Promise<Slot> {
  succeeded(await household.callTool("set_slot", { ...dinner(date), kind: "recipe", recipeId }));
  return succeeded(await household.callTool("mark_cooked", dinner(date)));
}

describe("marking a Slot cooked", () => {
  test("records when it was cooked, and its Recipe's last-cooked date and cook count", async () => {
    const household = await setUpHousehold();
    expect(await recipe(household, DAL)).toMatchObject({ lastCookedAt: null, cookCount: 0 });

    const before = Date.now();
    const slot = await planAndCook(household, MONDAY, DAL);

    expect(Date.parse(slot.cookedAt ?? "")).toBeGreaterThanOrEqual(before);
    expect(slot).toMatchObject({ recipe: { id: DAL }, ratings: [] });
    expect(await recipe(household, DAL)).toMatchObject({ lastCookedAt: MONDAY, cookCount: 1 });

    await planAndCook(household, NEXT_MONDAY, DAL);

    expect(await recipe(household, DAL)).toMatchObject({ lastCookedAt: NEXT_MONDAY, cookCount: 2 });
    expect(await recipe(household, TACOS)).toMatchObject({ lastCookedAt: null, cookCount: 0 });
  });
});

describe("marking cooked, refused and undone", () => {
  test("only a Slot with a Recipe can be cooked, and only a cooked one rated", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { ...dinner(MONDAY), kind: "eat_out" });

    expect(await household.callTool("mark_cooked", dinner(MONDAY))).toMatchObject({
      ok: false,
      error: { code: "no_recipe" },
    });
    await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: DAL });
    expect(await household.callTool("rate_recipe", { ...dinner(MONDAY), rating: "again" })).toMatchObject({
      ok: false,
      error: { code: "not_cooked" },
    });
  });

  test("a dinner after today can't be cooked yet", async () => {
    const household = await setUpHousehold();
    const later = "2099-01-05";
    await household.callTool("set_slot", { ...dinner(later), kind: "recipe", recipeId: DAL });

    expect(await household.callTool("mark_cooked", dinner(later))).toMatchObject({
      ok: false,
      error: { code: "not_yet" },
    });
  });

  test("clearing the Week leaves its cooked Slots, and their Ratings, as they were", async () => {
    const household = await setUpHousehold();
    await planAndCook(household, MONDAY, DAL);
    await household.callTool("rate_recipe", { ...dinner(MONDAY), rating: "never" });
    await household.callTool("set_slot", { date: MONDAY, meal: "lunch", kind: "eat_out" });

    const week = succeeded<Week>(await household.callTool("clear_week", { date: MONDAY, confirm: true }));

    expect(week.slots).toContainEqual(
      expect.objectContaining({
        ...dinner(MONDAY),
        recipe: expect.objectContaining({ id: DAL }),
        ratings: [expect.anything()],
      }),
    );
    expect(week.slots).toContainEqual(expect.objectContaining({ date: MONDAY, meal: "lunch", kind: "unplanned" }));
    expect(await recipe(household, DAL)).toMatchObject({ cookCount: 1 });
  });

  test("marking it cooked again keeps when it was first marked", async () => {
    const household = await setUpHousehold();
    const first = await planAndCook(household, MONDAY, DAL);

    const again = succeeded(await household.callTool("mark_cooked", dinner(MONDAY)));

    expect(again.cookedAt).toBe(first.cookedAt);
    expect(await recipe(household, DAL)).toMatchObject({ cookCount: 1 });
  });

  test("unmarking it, or changing its Recipe, forgets the cooking and its Ratings", async () => {
    const household = await setUpHousehold();
    await planAndCook(household, MONDAY, DAL);
    await household.callTool("rate_recipe", { ...dinner(MONDAY), rating: "never" });

    const unmarked = succeeded(await household.callTool("mark_cooked", { ...dinner(MONDAY), cooked: false }));

    expect(unmarked).toMatchObject({ cookedAt: null, ratings: [] });
    expect(await recipe(household, DAL)).toMatchObject({ lastCookedAt: null, cookCount: 0 });

    await household.callTool("mark_cooked", dinner(MONDAY));
    await household.callTool("rate_recipe", { ...dinner(MONDAY), rating: "never" });
    // A note is not a new Recipe: the cooking stays.
    await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: DAL, note: "Extra lime" });
    expect(succeeded<Week>(await household.callTool("get_week", { date: MONDAY })).slots).toContainEqual(
      expect.objectContaining({ ...dinner(MONDAY), ratings: [expect.objectContaining({ rating: "never" })] }),
    );

    const changed = succeeded(
      await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: TACOS }),
    );

    expect(changed).toMatchObject({ cookedAt: null, ratings: [] });
    expect(await recipe(household, DAL)).toMatchObject({ cookCount: 0 });
  });
});

describe("rating a cooked Slot", () => {
  test("records again, meh or never and a note, with when; a call from inside the deployment has no Member", async () => {
    const household = await setUpHousehold();
    await planAndCook(household, MONDAY, DAL);

    const rated = succeeded(
      await household.callTool("rate_recipe", { ...dinner(MONDAY), rating: "meh", note: "  Too salty  " }),
    );

    expect(rated.ratings).toEqual([{ memberId: null, rating: "meh", note: "Too salty", at: expect.any(String) }]);
    expect(succeeded<Week>(await household.callTool("get_week", { date: MONDAY })).slots).toContainEqual(rated);
  });

  test("is attributed to the Member the Caller signs in as, whose new Rating replaces their old one", async () => {
    const household = await setUpHousehold();
    await planAndCook(household, MONDAY, DAL);
    const robin = await connectAs(household, "robin@example.com");
    const visitor = await connectAs(household, "visitor@example.com");

    await robin.call("rate_recipe", { ...dinner(MONDAY), rating: "meh" });
    await visitor.call("rate_recipe", { ...dinner(MONDAY), rating: "again" });
    const rated = succeeded(await robin.call("rate_recipe", { ...dinner(MONDAY), rating: "again", note: "Better" }));

    expect(rated.ratings).toEqual([
      { memberId: null, rating: "again", note: null, at: expect.any(String) },
      { memberId: 1, rating: "again", note: "Better", at: expect.any(String) },
    ]);
  });

  test("a removed Member's Ratings stay, without their name", async () => {
    const household = await setUpHousehold();
    await planAndCook(household, MONDAY, DAL);
    await (await connectAs(household, "robin@example.com")).call("rate_recipe", { ...dinner(MONDAY), rating: "never" });

    await household.callTool("remove_member", { id: 1 });

    const week = succeeded<Week>(await household.callTool("get_week", { date: MONDAY }));
    expect(week.slots).toContainEqual(
      expect.objectContaining({
        ...dinner(MONDAY),
        ratings: [expect.objectContaining({ memberId: null, rating: "never" })],
      }),
    );
  });
});

describe("cooking and Ratings feed the Proposer", () => {
  test("a cooked dinner is kept; a Recipe rated never is not proposed again", async () => {
    const household = await setUpHousehold();
    // A third Recipe, so that the Week can be filled without Tacos.
    await household.callTool("create_recipe", { title: "Soup", baseServings: 4, ingredients: ["400 g rice"] });
    await planAndCook(household, MONDAY, TACOS);
    await household.callTool("rate_recipe", { ...dinner(MONDAY), rating: "never" });

    const week = succeeded<Week>(await household.callTool("propose_week", { date: MONDAY }));
    const next = succeeded<Week>(await household.callTool("propose_week", { date: "2026-12-07" }));

    const dinners = (of: Week) => of.slots.filter((slot) => slot.meal === "dinner");
    expect(dinners(week)[0]).toMatchObject({ recipe: { id: TACOS }, reason: { kind: "cooked" } });
    expect(dinners(week)[0]?.cookedAt).not.toBeNull();
    expect(dinners(next).map((slot) => slot.recipe?.id)).not.toContain(TACOS);
  });
});

async function connectAs(household: TestHousehold, email: string) {
  const response = await household.fetch("http://mise.example.com/agents/household/household", {
    headers: { Upgrade: "websocket", [CALLER_HEADER]: JSON.stringify({ email }) },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error(`Expected a WebSocket upgrade, got ${response.status}`);
  socket.accept();

  const replies = new Map<string, (reply: { success: boolean; result?: unknown; error?: string }) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "rpc") replies.get(message.id)?.(message);
  });

  return {
    call: (name: string, input: unknown) =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        replies.set(id, (reply) => (reply.success ? resolve(reply.result) : reject(new Error(reply.error))));
        socket.send(JSON.stringify({ type: "rpc", id, method: "callTool", args: [name, input] }));
      }),
  };
}
