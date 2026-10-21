/**
 * Seeds a local `wrangler dev` deployment with the fictional sample Household.
 * Usage: bun run seed [host], host defaulting to localhost:8787.
 */
import { HOUSEHOLD_AGENT } from "@mise/domain";
import { AgentClient } from "agents/client";
import sampleHousehold from "../../../fixtures/sample-household.json";

const host = process.argv[2] ?? "localhost:8787";
const agent = new AgentClient({ ...HOUSEHOLD_AGENT, host });

try {
  const result = await agent.call("callTool", ["setup_household", sampleHousehold]);
  console.log(JSON.stringify(result, null, 2));
} finally {
  agent.close();
}
