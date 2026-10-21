import { HOUSEHOLD_AGENT } from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
import { routeAgentRequest } from "agents";
import { sentryOptions } from "./observability";

export { Household } from "./household";

const householdPath = `/agents/${HOUSEHOLD_AGENT.agent.toLowerCase()}/${HOUSEHOLD_AGENT.name}`;

export default Sentry.withSentry(sentryOptions, {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // One household per deployment: refuse any other agent instance.
    if (pathname !== householdPath && !pathname.startsWith(`${householdPath}/`)) {
      return new Response("Not found", { status: 404 });
    }
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>);
