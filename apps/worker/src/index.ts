import { HOUSEHOLD_AGENT } from "@mise/domain";
import { routeAgentRequest } from "agents";

export { Household } from "./household";

const householdPath = `/agents/${HOUSEHOLD_AGENT.agent.toLowerCase()}/${HOUSEHOLD_AGENT.name}`;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // One household per deployment: refuse any other agent instance.
    if (pathname !== householdPath && !pathname.startsWith(`${householdPath}/`)) {
      return new Response("Not found", { status: 404 });
    }
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
