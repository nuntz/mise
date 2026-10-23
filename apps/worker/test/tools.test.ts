import { env } from "cloudflare:workers";
import { DEFAULT_EFFORT_BUDGETS } from "@mise/domain";
import { describe, expect, test } from "vitest";
import sampleHousehold from "../../../fixtures/sample-household.json";

function freshHousehold() {
  return env.Household.getByName(crypto.randomUUID());
}

describe("first-run Household setup", () => {
  test("a fresh deployment has no Household yet", async () => {
    const household = freshHousehold();

    expect(await household.callTool("get_household", {})).toEqual({ ok: true, value: null });
  });

  test("setting up the Household makes it readable with defaults applied", async () => {
    const household = freshHousehold();

    const setup = await household.callTool("setup_household", { name: "The Example Family" });
    const read = await household.callTool("get_household", {});

    const expected = {
      name: "The Example Family",
      timezone: "America/Vancouver",
      dinnerTime: "18:00",
      weekStartsOn: "monday",
      units: "metric",
      locale: "en-CA",
      members: [],
      effortBudgets: DEFAULT_EFFORT_BUDGETS,
    };
    expect(setup).toEqual({ ok: true, value: expected });
    expect(read).toEqual({ ok: true, value: expected });
  });

  test("the sample Household fixture sets up a Household", async () => {
    const household = freshHousehold();

    await household.callTool("setup_household", sampleHousehold);

    expect(await household.callTool("get_household", {})).toEqual({ ok: true, value: withMemberIds(sampleHousehold) });
  });

  test("setup only works on first run", async () => {
    const household = freshHousehold();
    await household.callTool("setup_household", { name: "The Example Family" });

    const again = await household.callTool("setup_household", { name: "Someone Else" });

    expect(again).toMatchObject({ ok: false, error: { code: "already_set_up" } });
    expect(await household.callTool("get_household", {})).toMatchObject({
      ok: true,
      value: { name: "The Example Family" },
    });
  });
});

describe("callTool", () => {
  test("rejects an unknown tool", async () => {
    const result = await freshHousehold().callTool("drop_table_household", {});

    expect(result).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
  });

  test("rejects invalid input without changing anything", async () => {
    const household = freshHousehold();

    const result = await household.callTool("setup_household", { name: "The Example Family", units: "furlongs" });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input", issues: [{ path: "units" }] } });
    expect(await household.callTool("get_household", {})).toEqual({ ok: true, value: null });
  });
});

describe("get_caller", () => {
  test("a call from inside the deployment has no caller", async () => {
    expect(await freshHousehold().callTool("get_caller", {})).toEqual({ ok: true, value: null });
  });
});

describe("change notices", () => {
  test("a connected client is told when the Household changes", async () => {
    const household = freshHousehold();
    const notices = await connect(household);

    await household.callTool("setup_household", { name: "The Example Family" });

    expect(await notices.next()).toEqual({ type: "mise:change", topic: "household", revision: 1 });
  });

  test("a connected client is told when a Member changes", async () => {
    const household = freshHousehold();
    await household.callTool("setup_household", { name: "The Example Family" });
    const notices = await connect(household);

    await household.callTool("add_member", { name: "Sam" });

    expect(await notices.next()).toEqual({ type: "mise:change", topic: "household", revision: 2 });
  });

  test("a rejected mutation neither broadcasts nor advances the revision", async () => {
    const household = freshHousehold();
    const notices = await connect(household);

    await household.callTool("setup_household", { name: "" });
    await household.callTool("setup_household", { name: "The Example Family" });
    await household.callTool("setup_household", { name: "Someone Else" });
    await household.callTool("setup_household", { name: "The Example Family" });

    expect(await notices.next()).toMatchObject({ revision: 1 });
    expect(notices.received()).toEqual([]);
  });
});

/** A Household as set up from `input`: its Members numbered in the order given. */
function withMemberIds<T extends { members: object[] }>(input: T) {
  return {
    ...input,
    members: input.members.map((member, index) => ({ id: index + 1, ...member })),
    effortBudgets: DEFAULT_EFFORT_BUDGETS,
  };
}

/** Opens a WebSocket to the household and collects the change notices it receives. */
async function connect(household: DurableObjectStub<import("../src/household").Household>) {
  const response = await household.fetch("http://mise.example.com/agents/household/household", {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error(`Expected a WebSocket upgrade, got ${response.status}`);
  socket.accept();

  const notices: unknown[] = [];
  const waiting: ((notice: unknown) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type !== "mise:change") return;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else notices.push(message);
  });

  return {
    next: () =>
      notices.length > 0 ? Promise.resolve(notices.shift()) : new Promise((resolve) => waiting.push(resolve)),
    /** Notices received and not yet taken by `next`. */
    received: () => notices,
  };
}
