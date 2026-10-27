import { env, exports } from "cloudflare:workers";
import type { NewKitchenDisplay, ToolResult } from "@mise/domain";
import { expect, test } from "vitest";

// Its own file, so the household starts out not set up.
const household = env.Household.getByName("household");

test("a paired Kitchen Display is told, in JSON, when the Household isn't set up yet", async () => {
  const paired = (await household.callTool("add_kitchen_display", {
    label: "Kitchen counter",
  })) as ToolResult<NewKitchenDisplay>;
  if (!paired.ok) throw new Error(paired.error.message);

  const response = await exports.default.fetch("https://mise.example.com/kitchen-display/v1/day-sheet", {
    headers: { Authorization: `Bearer ${paired.value.token}` },
    redirect: "manual",
  });

  expect(response.status).toBe(409);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(await response.json()).toEqual({ error: "not_set_up" });
});
