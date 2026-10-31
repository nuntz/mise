// PROTOTYPE (voice spike): what the household holds, as the agent's tools see it.
import { HOUSEHOLD_AGENT } from "@mise/domain";
import { AgentClient } from "agents/client";

const agent = new AgentClient({ ...HOUSEHOLD_AGENT, host: "localhost:8787" });
const call = (name: string, input: unknown) => agent.call("callTool", [name, input]);
try {
  for (const query of ["stir fry", "stir-fry", "broccoli"]) {
    const found = (await call("search_recipes", { query })) as { ok: boolean; value?: { title: string }[] };
    console.log(query, "→", JSON.stringify(found.ok ? found.value?.map((r) => r.title) : found));
  }
  const week = (await call("get_week", {})) as {
    ok: boolean;
    value?: { start?: string; slots: { date: string; kind: string }[] };
  };
  console.log("week", JSON.stringify(week.value?.slots.map((s) => `${s.date}:${s.kind}`)));
} finally {
  agent.close();
}
