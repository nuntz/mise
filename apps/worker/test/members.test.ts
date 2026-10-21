import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { CALLER_HEADER } from "../src/identity";

function freshHousehold() {
  return env.Household.getByName(crypto.randomUUID());
}

async function setUpHousehold() {
  const household = freshHousehold();
  await household.callTool("setup_household", { name: "The Example Family" });
  return household;
}

describe("Members", () => {
  test("an added Member is part of the Household", async () => {
    const household = await setUpHousehold();

    const added = await household.callTool("add_member", {
      name: "Alex",
      email: "alex@example.com",
      constraints: [{ kind: "allergy", allergen: "peanut" }],
    });

    const alex = {
      id: 1,
      name: "Alex",
      email: "alex@example.com",
      constraints: [{ kind: "allergy", allergen: "peanut" }],
    };
    expect(added).toEqual({ ok: true, value: alex });
    expect(await household.callTool("get_household", {})).toMatchObject({ ok: true, value: { members: [alex] } });
  });

  test("editing a Member changes only the fields given", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Alex", constraints: [{ kind: "dislike", term: "mushrooms" }] });

    const updated = await household.callTool("update_member", { id: 1, name: "Alexandra" });

    const alexandra = { id: 1, name: "Alexandra", email: null, constraints: [{ kind: "dislike", term: "mushrooms" }] };
    expect(updated).toEqual({ ok: true, value: alexandra });
    expect(await household.callTool("get_household", {})).toMatchObject({ value: { members: [alexandra] } });
  });

  test("a Member's email can be set and cleared", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Alex" });

    expect(await household.callTool("update_member", { id: 1, email: "alex@example.com" })).toMatchObject({
      ok: true,
      value: { email: "alex@example.com" },
    });
    expect(await household.callTool("update_member", { id: 1, email: null })).toMatchObject({
      ok: true,
      value: { email: null },
    });
  });

  test("a Member's name, email and Constraints can be edited in one call, all or nothing", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Robin", email: "cook@example.com" });
    await household.callTool("add_member", { name: "Alex" });
    const constraints = [{ kind: "allergy", allergen: "fish" }];

    const refused = await household.callTool("update_member", { id: 2, email: "cook@example.com", constraints });
    const edited = await household.callTool("update_member", { id: 2, email: "alex@example.com", constraints });

    expect(refused).toMatchObject({ ok: false, error: { code: "email_in_use" } });
    expect(edited).toEqual({ ok: true, value: { id: 2, name: "Alex", email: "alex@example.com", constraints } });
  });

  test("editing a Member who doesn't exist is refused", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("update_member", { id: 7, name: "Nobody" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("Member Constraints", () => {
  test("updating a Member's Constraints replaces them", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Alex", constraints: [{ kind: "dislike", term: "mushrooms" }] });

    const constraints = [
      { kind: "allergy", allergen: "sesame" },
      { kind: "intolerance", allergen: "milk", term: "lactose" },
      { kind: "diet", allergen: "wheat", term: "gluten-free" },
    ];
    const updated = await household.callTool("update_member_constraints", { id: 1, constraints });

    expect(updated).toEqual({ ok: true, value: { id: 1, name: "Alex", email: null, constraints } });
    expect(await household.callTool("get_household", {})).toMatchObject({ value: { members: [{ constraints }] } });
  });

  test("a Member's Constraints can be cleared", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Alex", constraints: [{ kind: "allergy", allergen: "egg" }] });

    await household.callTool("update_member_constraints", { id: 1, constraints: [] });

    expect(await household.callTool("get_household", {})).toMatchObject({ value: { members: [{ constraints: [] }] } });
  });

  test("updating the Constraints of a Member who doesn't exist is refused", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("update_member_constraints", { id: 3, constraints: [] })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("removing a Member", () => {
  test("a removed Member and their Constraints leave the Household", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Alex", constraints: [{ kind: "allergy", allergen: "peanut" }] });
    await household.callTool("add_member", { name: "Sam" });

    const removed = await household.callTool("remove_member", { id: 1 });

    expect(removed).toEqual({
      ok: true,
      value: { id: 1, name: "Alex", email: null, constraints: [{ kind: "allergy", allergen: "peanut" }] },
    });
    expect(await household.callTool("get_household", {})).toMatchObject({
      value: { members: [{ id: 2, name: "Sam", constraints: [] }] },
    });
  });

  test("a removed Member's id is not given to the next Member", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Alex" });
    await household.callTool("remove_member", { id: 1 });

    expect(await household.callTool("add_member", { name: "Sam" })).toMatchObject({ value: { id: 2 } });
  });

  test("removing a Member who doesn't exist is refused", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("remove_member", { id: 1 })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("email linking", () => {
  test("two Members cannot sign in with the same email", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Alex", email: "alex@example.com" });
    await household.callTool("add_member", { name: "Sam" });

    expect(await household.callTool("add_member", { name: "Other Alex", email: "Alex@Example.com" })).toMatchObject({
      ok: false,
      error: { code: "email_in_use" },
    });
    expect(await household.callTool("update_member", { id: 2, email: "alex@example.com" })).toMatchObject({
      ok: false,
      error: { code: "email_in_use" },
    });
  });

  test("any number of Members can have no email", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Sam" });

    expect(await household.callTool("add_member", { name: "Robin" })).toMatchObject({ ok: true });
  });
});

describe("the Caller as a Member", () => {
  test("a Caller whose email matches a Member resolves to that Member", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Robin", email: "cook@example.com" });

    const caller = await (await connectAs(household, "cook@example.com")).call("get_caller", {});

    expect(caller).toEqual({
      ok: true,
      value: {
        email: "cook@example.com",
        member: { id: 1, name: "Robin", email: "cook@example.com", constraints: [] },
      },
    });
  });

  test("a Caller no Member signs in as is not a Member", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Sam" });

    const caller = await (await connectAs(household, "guest@example.com")).call("get_caller", {});

    expect(caller).toEqual({ ok: true, value: { email: "guest@example.com", member: null } });
  });

  test("linking a Member's email makes an open connection's Caller that Member", async () => {
    const household = await setUpHousehold();
    await household.callTool("add_member", { name: "Robin" });
    const connection = await connectAs(household, "cook@example.com");

    await household.callTool("update_member", { id: 1, email: "cook@example.com" });

    expect(await connection.call("get_caller", {})).toMatchObject({ value: { member: { id: 1 } } });
  });
});

describe("first-run setup with Members", () => {
  test("setup can add Members with their Constraints", async () => {
    const household = freshHousehold();

    const setup = await household.callTool("setup_household", {
      name: "The Example Family",
      members: [
        { name: "Alex", email: "alex@example.com", constraints: [{ kind: "allergy", allergen: "tree_nut" }] },
        { name: "Sam" },
      ],
    });

    const members = [
      { id: 1, name: "Alex", email: "alex@example.com", constraints: [{ kind: "allergy", allergen: "tree_nut" }] },
      { id: 2, name: "Sam", email: null, constraints: [] },
    ];
    expect(setup).toMatchObject({ ok: true, value: { name: "The Example Family", members } });
    expect(await household.callTool("get_household", {})).toMatchObject({ value: { members } });
  });

  test("a setup that is refused leaves no Household and no Members behind", async () => {
    const household = freshHousehold();

    const setup = await household.callTool("setup_household", {
      name: "The Example Family",
      members: [
        { name: "Alex", email: "alex@example.com" },
        { name: "Also Alex", email: "alex@example.com" },
      ],
    });

    expect(setup).toMatchObject({ ok: false, error: { code: "email_in_use" } });
    expect(await household.callTool("get_household", {})).toEqual({ ok: true, value: null });
    expect(await household.callTool("setup_household", { name: "The Example Family" })).toMatchObject({
      ok: true,
      value: { members: [] },
    });
  });

  test("Members can only be added once the Household is set up", async () => {
    expect(await freshHousehold().callTool("add_member", { name: "Alex" })).toMatchObject({
      ok: false,
      error: { code: "not_set_up" },
    });
  });
});

/**
 * Opens a WebSocket to the household as `email`, stamped as the Worker stamps it after Access
 * (identity.test.ts covers that step), and calls tools over the Agents SDK's RPC protocol.
 */
async function connectAs(household: ReturnType<typeof freshHousehold>, email: string) {
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
