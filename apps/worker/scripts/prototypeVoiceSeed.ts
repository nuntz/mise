// PROTOTYPE (voice spike): seeds a fresh `wrangler dev` with the sample Household, its Recipes and
// this Week's dinners, as `bun run screenshot` does. Usage: bun scripts/prototypeVoiceSeed.ts
import { HOUSEHOLD_AGENT, type Week } from "@mise/domain";
import { AgentClient } from "agents/client";
import sampleHousehold from "../../../fixtures/sample-household.json";
import sampleWeek from "../../../fixtures/sample-week.json";

const agent = new AgentClient({ ...HOUSEHOLD_AGENT, host: "localhost:8787" });
async function call(name: string, input: unknown) {
  const result = (await agent.call("callTool", [name, input])) as
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string } };
  if (!result.ok) throw new Error(`${name}: ${result.error.code}: ${result.error.message}`);
  return result.value;
}
try {
  await call("setup_household", sampleHousehold);
  const ids = new Map<string, number>();
  for (const recipe of sampleWeek.recipes)
    ids.set(recipe.title, ((await call("create_recipe", recipe)) as { id: number }).id);
  const week = (await call("get_week", {})) as Week;
  const dates = [...new Set(week.slots.map((slot) => slot.date))];
  for (const dinner of sampleWeek.dinners) {
    const slot = { date: dates[dinner.day], meal: "dinner" };
    if (dinner.recipe) await call("set_slot", { ...slot, kind: "recipe", recipeId: ids.get(dinner.recipe) });
    else if (dinner.eatOut) await call("set_slot", { ...slot, kind: "eat_out", note: dinner.eatOut });
    else if (dinner.leftovers !== undefined) {
      await call("set_slot", { ...slot, kind: "leftovers" });
      await call("link_leftovers", { ...slot, of: { date: dates[dinner.leftovers], meal: "dinner" } });
    }
  }
  console.log(`Seeded ${ids.size} Recipes: ${[...ids.keys()].join(", ")}`);
} finally {
  agent.close();
}
