import { env } from "cloudflare:workers";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ChatMessage, ChatWhere, Household, ToolResult } from "@mise/domain";
import { afterEach, describe, expect, test } from "vitest";
import { useAgentModels } from "../src/agent";
import { connectAs } from "./connect";
import { caller, dinnerOn, familyHousehold, type HouseholdStub, scriptModel, textOf } from "./scripted";

// Monday 26 October 2026 to Sunday 1 November.
const MONDAY = "2026-10-26";
const THURSDAY = "2026-10-29";
const FRIDAY = "2026-10-30";

const FOR_ROBIN = [{ who: 1, allergen: "peanut", reason: "We'll make Robin's without the sauce" }];

const ON_THE_WEEK: ChatWhere = { screen: "week", week: MONDAY };

afterEach(() => useAgentModels(undefined));

async function members(household: HouseholdStub) {
  const result = (await household.callTool("get_household", {})) as ToolResult<Household>;
  if (!result.ok) throw new Error(result.error.message);
  return result.value.members;
}

/** The confirmations the chat shows. */
async function confirmations(household: HouseholdStub) {
  const conversation = (await household.conversation()) as ChatMessage[];
  return conversation.filter((message) => message.role === "confirmation");
}

describe("what the agent can't do without a person's tap (ADR 0024)", () => {
  test("deleting a Recipe waits for a tap, changes nothing, and the chat shows what will happen", async () => {
    scriptModel(caller([["delete_recipe", { id: 1, confirm: true }]]));
    const household = await familyHousehold();

    const reply = await household.chat("Delete the Satay", { screen: "recipes" });

    expect(reply).toMatchObject({ ok: true, value: { text: expect.stringMatching(/^Done: /) } });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({ ok: true });
    expect(await confirmations(household)).toEqual([
      { role: "confirmation", id: 1, summary: "Delete “Satay”", status: "pending" },
    ]);
  });

  test("a person's tap runs the call, once, and the chat shows it done", async () => {
    scriptModel(caller([["delete_recipe", { id: 1, confirm: true }]]));
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");
    await robin.rpc("chat", ["Delete the Satay", { screen: "recipes" }]);

    const tapped = await robin.rpc("confirm", [1]);
    const again = await robin.rpc("confirm", [1]);

    expect(tapped).toMatchObject({ ok: true, value: { title: "Satay" } });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(again).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await confirmations(household)).toEqual([
      { role: "confirmation", id: 1, summary: "Delete “Satay”", status: "done" },
    ]);
  });

  test("told “never mind”, the agent withdraws the confirmation, and a tap then runs nothing", async () => {
    const deleter = caller([["delete_recipe", { id: 1, confirm: true }]]);
    const canceller = caller([["cancel_confirmation", { id: 1 }]]);
    scriptModel((context, ...rest) => {
      const asked = [...context.messages].reverse().find((message) => message.role === "user");
      return (textOf(asked).endsWith("Never mind") ? canceller : deleter)(context, ...rest);
    });
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");
    await robin.rpc("chat", ["Delete the Satay", { screen: "recipes" }]);

    await robin.rpc("chat", ["Never mind", { screen: "recipes" }]);
    const tapped = await robin.rpc("confirm", [1]);

    expect(await confirmations(household)).toEqual([
      { role: "confirmation", id: 1, summary: "Delete “Satay”", status: "cancelled" },
    ]);
    expect(tapped).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({ ok: true });
  });

  test("a person can cancel a confirmation from the chat; one no longer waiting can't be", async () => {
    scriptModel(caller([["delete_recipe", { id: 1, confirm: true }]]));
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");
    await robin.rpc("chat", ["Delete the Satay", { screen: "recipes" }]);

    const cancelled = await robin.call("cancel_confirmation", { id: 1 });
    const again = await robin.call("cancel_confirmation", { id: 1 });

    expect(cancelled).toMatchObject({ ok: true, value: { id: 1, summary: "Delete “Satay”" } });
    expect(again).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await confirmations(household)).toMatchObject([{ status: "cancelled" }]);
  });

  test("a confirmation expires when what it describes changes, and its tap is then refused", async () => {
    scriptModel(caller([["delete_recipe", { id: 1, confirm: true }]]));
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");
    await robin.rpc("chat", ["Delete the Satay", { screen: "recipes" }]);
    await household.callTool("update_recipe", { id: 1, title: "Chicken satay" });

    const shown = await confirmations(household);
    const tapped = await robin.rpc("confirm", [1]);

    expect(shown).toEqual([{ role: "confirmation", id: 1, summary: "Delete “Satay”", status: "expired" }]);
    expect(tapped).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({ ok: true });
  });
});

/**
 * A call the agent makes that needs a tap: how the Household is set up for it first (on the screens),
 * the button it should show, and what to look at to see whether it ran.
 */
type Guarded = {
  call: [string, JsonObject];
  before?: (household: HouseholdStub) => Promise<unknown>;
  summary: string;
  probe: (household: HouseholdStub) => Promise<unknown>;
};

/** Friday's dinner is Satay, eaten by Alex alone: no Conflict until Robin joins. */
async function satayForAlexOnFriday(household: HouseholdStub) {
  await household.callTool("set_slot", { date: FRIDAY, meal: "dinner", kind: "recipe", recipeId: 1, diners: [2] });
}

const GUARDED: Record<string, Guarded> = {
  "deleting a Recipe": {
    call: ["delete_recipe", { id: 2, confirm: true }],
    summary: "Delete “Rice bowl 2”",
    probe: (household) => household.callTool("get_recipe", { id: 2 }),
  },
  "clearing a Week": {
    call: ["clear_week", { date: MONDAY, confirm: true }],
    before: (household) =>
      household.callTool("set_slot", { date: FRIDAY, meal: "dinner", kind: "recipe", recipeId: 2 }),
    summary: "Clear the Week of Monday, October 26",
    probe: (household) => dinnerOn(household, FRIDAY),
  },
  "planning a Recipe with an Override": {
    call: ["set_slot", { date: FRIDAY, meal: "dinner", kind: "recipe", recipeId: 1, overrides: FOR_ROBIN }],
    summary: "Plan “Satay” for dinner on Friday, October 30 although Robin is allergic to peanut",
    probe: (household) => dinnerOn(household, FRIDAY),
  },
  "choosing Diners with an Override": {
    call: ["set_diners", { date: FRIDAY, meal: "dinner", diners: [1, 2], overrides: FOR_ROBIN }],
    before: satayForAlexOnFriday,
    summary: "Have Robin and Alex eat dinner on Friday, October 30 although Robin is allergic to peanut",
    probe: (household) => dinnerOn(household, FRIDAY),
  },
  "having Guests with an Override": {
    call: [
      "set_guests",
      {
        date: FRIDAY,
        meal: "dinner",
        guests: 2,
        guestConstraints: [{ kind: "allergy", allergen: "peanut" }],
        overrides: [{ who: "guests", allergen: "peanut", reason: "They'll bring their own" }],
      },
    ],
    before: satayForAlexOnFriday,
    summary:
      "Have 2 Guests, with a peanut allergy, at dinner on Friday, October 30 although the Guests are allergic to peanut",
    probe: (household) => dinnerOn(household, FRIDAY),
  },
  "linking Leftovers with an Override": {
    call: [
      "link_leftovers",
      { date: FRIDAY, meal: "dinner", of: { date: THURSDAY, meal: "dinner" }, overrides: FOR_ROBIN },
    ],
    before: async (household) => {
      await household.callTool("set_slot", {
        date: THURSDAY,
        meal: "dinner",
        kind: "recipe",
        recipeId: 1,
        diners: [2],
      });
      await household.callTool("set_slot", { date: FRIDAY, meal: "dinner", kind: "leftovers" });
    },
    summary:
      "Make dinner on Friday, October 30 Leftovers of dinner on Thursday, October 29 although Robin is allergic to peanut",
    probe: (household) => dinnerOn(household, FRIDAY),
  },
  "removing a Hard Constraint": {
    call: ["update_member_constraints", { id: 1, constraints: [] }],
    summary: "Remove Robin's peanut allergy",
    probe: members,
  },
  "making a Hard Constraint a dislike": {
    call: ["update_member_constraints", { id: 1, constraints: [{ kind: "dislike", allergen: "peanut" }] }],
    summary: "Make Robin's peanut allergy a dislike",
    probe: members,
  },
  "removing a Hard Constraint while editing a Member": {
    call: ["update_member", { id: 1, constraints: [] }],
    summary: "Remove Robin's peanut allergy",
    probe: members,
  },
  "removing a Member who has a Hard Constraint": {
    call: ["remove_member", { id: 1 }],
    summary: "Remove Robin and their peanut allergy",
    probe: members,
  },
  "removing the Guests' Hard Constraint": {
    call: ["set_guests", { date: FRIDAY, meal: "dinner", guests: 2, guestConstraints: [] }],
    before: (household) =>
      household.callTool("set_guests", {
        date: FRIDAY,
        meal: "dinner",
        guests: 2,
        guestConstraints: [{ kind: "allergy", allergen: "peanut" }],
      }),
    summary: "Have 2 Guests, with no Hard Constraint, at dinner on Friday, October 30, dropping their peanut allergy",
    probe: (household) => dinnerOn(household, FRIDAY),
  },
  "renaming a Member": {
    call: ["update_member", { id: 2, name: "Alexis" }],
    summary: "Rename Alex to Alexis",
    probe: members,
  },
  "changing a Member's sign-in email": {
    call: ["update_member", { id: 2, email: "alexis@example.com" }],
    summary: "Change Alex's sign-in email to alexis@example.com",
    probe: members,
  },
  "taking away a Member's sign-in": {
    call: ["update_member", { id: 2, email: null }],
    summary: "Stop Alex signing in as alex@example.com",
    probe: members,
  },
  "renaming a Member, changing their email and removing a Hard Constraint at once": {
    call: ["update_member", { id: 1, name: "Robyn", email: "robyn@example.com", constraints: [] }],
    summary: "Rename Robin to Robyn, change their sign-in email to robyn@example.com and remove their peanut allergy",
    probe: members,
  },
};

describe.each(Object.entries(GUARDED))("%s", (_, guarded) => {
  test("from the agent, waits for a tap and changes nothing; the tap runs it", async () => {
    scriptModel(caller([guarded.call]));
    const household = await familyHousehold();
    await guarded.before?.(household);
    const alex = await connectAs(household, "alex@example.com");
    const before = await guarded.probe(household);

    const reply = await alex.rpc("chat", ["Please do it", ON_THE_WEEK]);

    expect(reply).toMatchObject({ ok: true, value: { text: expect.stringMatching(/^Done: Nothing is changed yet/) } });
    expect(await guarded.probe(household)).toEqual(before);
    expect(await confirmations(household)).toEqual([
      { role: "confirmation", id: 1, summary: guarded.summary, status: "pending" },
    ]);

    expect(await alex.rpc("confirm", [1])).toMatchObject({ ok: true });
    expect(await guarded.probe(household)).not.toEqual(before);
    expect(await confirmations(household)).toMatchObject([{ status: "done" }]);
  });
});

test("an Override's confirmation expires when the Constraint it overrides changes", async () => {
  scriptModel(caller([GUARDED["planning a Recipe with an Override"]?.call as [string, JsonObject]]));
  const household = await familyHousehold();
  const alex = await connectAs(household, "alex@example.com");
  await alex.rpc("chat", ["Plan Satay Friday anyway", ON_THE_WEEK]);
  await household.callTool("update_member_constraints", {
    id: 1,
    constraints: [{ kind: "allergy", allergen: "peanut", term: "all nuts" }],
  });

  expect(await alex.rpc("confirm", [1])).toMatchObject({ ok: false, error: { code: "expired" } });
  expect(await dinnerOn(household, FRIDAY)).toMatchObject({ recipe: null });
});

test.each<[string, [string, JsonObject]]>([
  [
    "Diners with an Override on a planned Recipe",
    ["set_slot", { date: FRIDAY, meal: "dinner", kind: "recipe", recipeId: 1, diners: [1], overrides: FOR_ROBIN }],
  ],
])("the agent can't fold another change into one that waits for a tap: %s", async (_, call) => {
  scriptModel(caller([call]));
  const household = await familyHousehold();
  const before = [await members(household), await dinnerOn(household, FRIDAY)];

  const reply = await household.chat("Please do it", ON_THE_WEEK);

  expect(reply).toMatchObject({ ok: true, value: { text: expect.stringMatching(/^Refused: .*separate call/s) } });
  expect([await members(household), await dinnerOn(household, FRIDAY)]).toEqual(before);
  expect(await confirmations(household)).toEqual([]);
});

test("the agent changes the Guests' Constraints with set_guests, whose button says what is dropped", async () => {
  scriptModel(caller([["set_slot", { date: FRIDAY, meal: "dinner", kind: "eat_out", guestConstraints: [] }]]));
  const household = await familyHousehold();
  await household.callTool("set_guests", {
    date: FRIDAY,
    meal: "dinner",
    guests: 2,
    guestConstraints: [{ kind: "allergy", allergen: "peanut" }],
  });
  const before = await dinnerOn(household, FRIDAY);

  const reply = await household.chat("We're eating out Friday, and the Guests aren't allergic after all", ON_THE_WEEK);

  expect(reply).toMatchObject({ ok: true, value: { text: expect.stringMatching(/^Refused: .*set_guests/s) } });
  expect(await dinnerOn(household, FRIDAY)).toEqual(before);
  expect(await confirmations(household)).toEqual([]);
});

describe("what the agent does without a tap", () => {
  test.each<[string, [string, JsonObject]]>([
    [
      "adding a Constraint",
      ["update_member_constraints", { id: 2, constraints: [{ kind: "allergy", allergen: "milk" }] }],
    ],
    [
      "adding a dislike beside a Hard Constraint",
      [
        "update_member_constraints",
        {
          id: 1,
          constraints: [
            { kind: "allergy", allergen: "peanut" },
            { kind: "dislike", term: "mushrooms" },
          ],
        },
      ],
    ],
    [
      "an edit to a Member that changes nothing guarded",
      [
        "update_member",
        {
          id: 1,
          name: "Robin",
          email: "robin@example.com",
          constraints: [
            { kind: "dislike", term: "olives" },
            { kind: "allergy", allergen: "peanut" },
          ],
        },
      ],
    ],
    ["removing a Member with no Hard Constraint", ["remove_member", { id: 3 }]],
    ["planning a Recipe with no Conflict", ["set_slot", { date: FRIDAY, meal: "dinner", kind: "recipe", recipeId: 2 }]],
    ["choosing Diners with no Override", ["set_diners", { date: FRIDAY, diners: [1, 2], overrides: [] }]],
    [
      "giving Guests a Hard Constraint",
      [
        "set_guests",
        { date: FRIDAY, meal: "dinner", guests: 2, guestConstraints: [{ kind: "allergy", allergen: "milk" }] },
      ],
    ],
    ["seeing the Guests off", ["set_guests", { date: FRIDAY, meal: "dinner", guests: 0 }]],
  ])("%s runs at once", async (_, call) => {
    scriptModel(caller([call]));
    const household = await familyHousehold();

    const reply = await household.chat("Please do it", ON_THE_WEEK);

    expect(reply).toMatchObject({ ok: true, value: { text: expect.not.stringContaining("Nothing is changed") } });
    expect(reply).toMatchObject({ ok: true, value: { text: expect.stringMatching(/^Done: /) } });
    expect(await confirmations(household)).toEqual([]);
  });
});

test("confirmations are left out of the export, as the conversation that shows them is", async () => {
  const householdUrl = "http://mise.example.com/agents/household/household";
  scriptModel(caller([["delete_recipe", { id: 1, confirm: true }]]));
  const household = await familyHousehold();
  await household.chat("Delete the Satay", { screen: "recipes" });

  const exported = await (await household.fetch(`${householdUrl}/export`)).text();
  const restored = await env.Household.getByName(crypto.randomUUID()).fetch(`${householdUrl}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: exported,
  });

  expect(Object.keys(JSON.parse(exported).tables)).not.toContain("pending_confirmation");
  expect(restored.status).toBe(200);
});
